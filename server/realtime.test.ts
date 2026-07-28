/**
 * The realtime channel, over a real socket.
 *
 * Everything here runs against a listening HTTP server with the upgrade
 * listener attached, and connects to it with Node's own global `WebSocket` —
 * no client library, and nothing about the transport mocked. The properties
 * under test are the ones the feature is only worth having if it holds:
 *
 * - a mutation through the REST API reaches everyone watching that event;
 * - **the socket is read-only** — a client can send whatever it likes and
 *   change nothing, and the REST API stays the sole write path;
 * - an upgrade naming an event that does not exist is tarpitted exactly like
 *   an HTTP miss, so subscribing is no cheaper to scan than fetching;
 * - with realtime off, nothing is registered at all;
 * - rooms do not outlive their subscribers.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The tarpit reads its delay once, when `missTarpit` is constructed at import
// time, so a short value has to be in the environment before that import runs.
// `vi.hoisted` is the only thing that happens earlier than a hoisted import.
const { MISS_DELAY_MS } = vi.hoisted(() => {
  process.env.MISS_DELAY_MS = "60";
  return { MISS_DELAY_MS: 60 };
});

import { createApp, type Renderer } from "./app.ts";
import { createSession, setCredential } from "./auth.ts";
import { attachRealtime, clientCount, roomCount, type RealtimeServer } from "./realtime.ts";
import { resolveEvent } from "./routes/events.ts";
import { missTarpit } from "./tarpit.ts";
import type { RealtimeMessage, StoredEvent } from "./types.ts";

/** No page is rendered in these tests; only `/api` and the upgrade path. */
const renderer: Renderer = {
  loadTemplate: () => Promise.resolve("<!doctype html><div id=\"app\"></div>"),
  loadRender: () => Promise.reject(new Error("SSR is not used in these tests")),
};

let server: Server;
let hub: RealtimeServer | null = null;
let base: string;
let wsBase: string;
let varDir: string;
const originalVarDir = process.env.VAR_DIR;
const clients: WebSocket[] = [];

beforeEach(async () => {
  varDir = await fs.mkdtemp(path.join(os.tmpdir(), "timeful-realtime-"));
  process.env.VAR_DIR = varDir;
  const app = createApp({ trustProxy: false, renderer });
  server = await new Promise<Server>((resolve, reject) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
    listening.on("error", reject);
  });
  const { port } = server.address() as AddressInfo;
  base = `http://127.0.0.1:${port}`;
  wsBase = `ws://127.0.0.1:${port}`;
});

afterEach(async () => {
  for (const socket of clients.splice(0)) socket.close();
  await hub?.close();
  hub = null;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (originalVarDir === undefined) delete process.env.VAR_DIR;
  else process.env.VAR_DIR = originalVarDir;
  await fs.rm(varDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Registers the upgrade listener. Left to each test: some want it absent. */
function attach(heartbeatMs?: number): RealtimeServer {
  hub = attachRealtime(server, { resolveEvent, heartbeatMs });
  return hub;
}

async function call(
  method: string,
  route: string,
  { body, cookie }: { body?: unknown; cookie?: string } = {},
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${base}${route}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(cookie ? { Cookie: cookie } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  return { status: res.status, body: parsed };
}

async function adminCookie(): Promise<string> {
  await setCredential({ email: "owner@example.com", password: "hunter2hunter2" });
  return `session=${await createSession({})}`;
}

async function createEvent(cookie: string): Promise<StoredEvent> {
  const res = await call("POST", "/api/events", {
    cookie,
    body: {
      name: "Team Offsite",
      type: "specific_dates",
      dates: ["2026-08-03T00:00:00.000Z", "2026-08-04T00:00:00.000Z"],
      duration: 8,
      timeIncrement: 30,
      startOnMonday: true,
    },
  });
  expect(res.status).toBe(201);
  return res.body as StoredEvent;
}

interface Subscriber {
  socket: WebSocket;
  /** Everything received, in order. */
  received: RealtimeMessage[];
  /** Resolves once at least `count` messages have arrived. */
  take(count: number): Promise<RealtimeMessage[]>;
}

/** Opens a subscription and resolves once the socket is actually open. */
function subscribe(idOrSlug: string): Promise<Subscriber> {
  const socket = new WebSocket(
    `${wsBase}/api/events/${encodeURIComponent(idOrSlug)}/ws`,
  );
  clients.push(socket);
  const received: RealtimeMessage[] = [];
  let notify: (() => void) | null = null;

  socket.addEventListener("message", (event: MessageEvent) => {
    received.push(JSON.parse(String(event.data)) as RealtimeMessage);
    notify?.();
  });

  const take = (count: number): Promise<RealtimeMessage[]> =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`only ${received.length} of ${count} messages arrived`)),
        3000,
      );
      const check = () => {
        if (received.length < count) return;
        clearTimeout(timer);
        notify = null;
        resolve(received);
      };
      notify = check;
      check();
    });

  return new Promise((resolve, reject) => {
    socket.addEventListener("open", () => resolve({ socket, received, take }));
    socket.addEventListener("error", () => reject(new Error("upgrade refused")));
  });
}

/** Resolves to how long an upgrade took to fail, in ms. */
async function refusedAfter(idOrSlug: string): Promise<number> {
  const started = Date.now();
  await expect(subscribe(idOrSlug)).rejects.toThrow("upgrade refused");
  return Date.now() - started;
}

/** Waits for a condition the server reaches on its own, or gives up. */
async function until(predicate: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 100; i += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${label}`);
}

const SLOTS = ["2026-08-03T13:00:00.000Z", "2026-08-03T13:30:00.000Z"];

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

describe("the realtime channel", () => {
  it("pushes a full snapshot after a guest saves an answer", async () => {
    attach();
    const event = await createEvent(await adminCookie());
    // By slug, the way a page reaches it: the capability URL is the address.
    const watcher = await subscribe(event.slug);

    expect(
      (await call("PUT", `/api/events/${event.id}/responses/Alice`, {
        body: { availability: SLOTS, ifNeeded: [] },
      })).status,
    ).toBe(200);

    const [message] = await watcher.take(1);
    expect(message.type).toBe("event");
    if (message.type !== "event") throw new Error("unreachable");
    // The whole document, responses inline — the same bytes a GET returns.
    expect(message.event.id).toBe(event.id);
    expect(message.event.responses.Alice.availability).toEqual(SLOTS);
  });

  it("reaches every subscriber watching the same event", async () => {
    attach();
    const event = await createEvent(await adminCookie());
    const first = await subscribe(event.slug);
    // The second joins by uuid: both addresses resolve to the same room.
    const second = await subscribe(event.id);
    expect(clientCount(event.id)).toBe(2);

    await call("PUT", `/api/events/${event.id}/responses/Bob`, {
      body: { availability: SLOTS },
    });

    for (const messages of [await first.take(1), await second.take(1)]) {
      const [message] = messages;
      if (message.type !== "event") throw new Error("expected a snapshot");
      expect(Object.keys(message.event.responses)).toEqual(["Bob"]);
    }
  });

  it("announces a deleted response, and a deleted event", async () => {
    attach();
    const cookie = await adminCookie();
    const event = await createEvent(cookie);
    await call("PUT", `/api/events/${event.id}/responses/Carol`, {
      body: { availability: SLOTS },
    });
    const watcher = await subscribe(event.slug);

    await call("DELETE", `/api/events/${event.id}/responses/Carol`);
    await call("DELETE", `/api/events/${event.id}`, { cookie });

    const [removed, gone] = await watcher.take(2);
    if (removed.type !== "event") throw new Error("expected a snapshot");
    expect(Object.keys(removed.event.responses)).toEqual([]);
    expect(gone.type).toBe("gone");
    // A deleted event takes its room with it.
    await until(() => clientCount(event.id) === 0, "the room to close");
  });

  it("carries the new slug when the event is renamed", async () => {
    attach();
    const cookie = await adminCookie();
    const event = await createEvent(cookie);
    const watcher = await subscribe(event.slug);

    expect(
      (await call("PATCH", `/api/events/${event.id}`, {
        cookie,
        body: { name: "Offsite, moved", slug: "moved-offsite" },
      })).status,
    ).toBe(200);

    const [message] = await watcher.take(1);
    if (message.type !== "event") throw new Error("expected a snapshot");
    expect(message.event.slug).toBe("moved-offsite");
    expect(message.event.name).toBe("Offsite, moved");
    // The room is keyed by uuid, so a rename cannot orphan its subscribers.
    expect(clientCount(event.id)).toBe(1);
  });

  // -------------------------------------------------------------------------
  // read-only
  // -------------------------------------------------------------------------

  it("ignores everything a client sends, and stays connected", async () => {
    attach();
    const event = await createEvent(await adminCookie());
    const watcher = await subscribe(event.slug);

    // A forged snapshot, and something shaped like the write it is imitating.
    // Neither is parsed, let alone acted on: no `message` listener exists.
    watcher.socket.send(
      JSON.stringify({
        type: "event",
        event: { ...event, name: "Pwned", responses: { Mallory: { availability: SLOTS } } },
      }),
    );
    watcher.socket.send(
      JSON.stringify({
        method: "PUT",
        path: `/api/events/${event.id}/responses/Mallory`,
        body: { availability: SLOTS },
      }),
    );
    watcher.socket.send("not json at all");

    // Give the server every chance to have done something with it.
    await new Promise((resolve) => setTimeout(resolve, 100));

    const stored = (await call("GET", `/api/events/${event.id}`)).body as StoredEvent;
    expect(stored.name).toBe("Team Offsite");
    expect(stored.responses).toEqual({});
    expect(watcher.received).toEqual([]);

    // Ignoring is friendlier than closing: the socket is still healthy and
    // still delivers the next real update.
    expect(watcher.socket.readyState).toBe(WebSocket.OPEN);
    await call("PUT", `/api/events/${event.id}/responses/Dan`, {
      body: { availability: SLOTS },
    });
    const [message] = await watcher.take(1);
    if (message.type !== "event") throw new Error("expected a snapshot");
    expect(Object.keys(message.event.responses)).toEqual(["Dan"]);
  });

  // -------------------------------------------------------------------------
  // scanning, and being switched off
  // -------------------------------------------------------------------------

  it("tarpits an upgrade that names no event, then destroys it", async () => {
    attach();
    await createEvent(await adminCookie());

    const elapsed = await refusedAfter("Nx7Kq2mWx9Az");

    // The same per-IP queue an HTTP miss joins, at the same configured delay.
    expect(missTarpit.delayMs).toBe(MISS_DELAY_MS);
    expect(elapsed).toBeGreaterThanOrEqual(MISS_DELAY_MS - 15);
    // Nothing was admitted to a room on the way out.
    expect(roomCount()).toBe(0);
  });

  it("registers nothing at all when realtime is off", async () => {
    // No attach(): this is what `serve()` does with realtime disabled.
    const event = await createEvent(await adminCookie());

    await expect(subscribe(event.slug)).rejects.toThrow("upgrade refused");
    expect(roomCount()).toBe(0);

    // And the page it would have enhanced is untouched: REST still answers.
    const res = await call("GET", `/api/events/${event.slug}`);
    expect(res.status).toBe(200);
    expect((res.body as StoredEvent).id).toBe(event.id);
  });

  it("leaves an upgrade for any other path alone", async () => {
    attach();
    const event = await createEvent(await adminCookie());
    // A plain GET of the socket path is not an upgrade, and falls through to
    // the events catch-all rather than to anything realtime owns.
    expect((await call("GET", `/api/events/${event.slug}/ws`)).status).toBe(404);
  });

  // -------------------------------------------------------------------------
  // housekeeping
  // -------------------------------------------------------------------------

  it("drops the room once the last subscriber leaves", async () => {
    attach();
    const event = await createEvent(await adminCookie());
    const first = await subscribe(event.slug);
    const second = await subscribe(event.slug);
    expect(roomCount()).toBe(1);
    expect(clientCount(event.id)).toBe(2);

    first.socket.close();
    await until(() => clientCount(event.id) === 1, "one subscriber to leave");
    // One left: the room stays, because somebody is still in it.
    expect(roomCount()).toBe(1);

    second.socket.close();
    await until(() => roomCount() === 0, "the room to be dropped");
    expect(clientCount(event.id)).toBe(0);
  });

  it("keeps a healthy socket through several heartbeats", async () => {
    // The real interval is 30s; this is the same code path, wound on.
    attach(30);
    const event = await createEvent(await adminCookie());
    const watcher = await subscribe(event.slug);

    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(watcher.socket.readyState).toBe(WebSocket.OPEN);
    expect(clientCount(event.id)).toBe(1);
    await call("PUT", `/api/events/${event.id}/responses/Erin`, {
      body: { availability: SLOTS },
    });
    expect((await watcher.take(1))[0].type).toBe("event");
  });
});
