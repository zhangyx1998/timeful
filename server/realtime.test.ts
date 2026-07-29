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
// Node's own global `WebSocket` answers pings by itself, which is the one thing
// the reap test needs a client not to do; `ws` lets that be switched off.
import { WebSocket as WsClient } from "ws";

// The tarpit reads its delay once, when `missTarpit` is constructed at import
// time, so a short value has to be in the environment before that import runs.
// `vi.hoisted` is the only thing that happens earlier than a hoisted import.
const { MISS_DELAY_MS } = vi.hoisted(() => {
  process.env.MISS_DELAY_MS = "60";
  return { MISS_DELAY_MS: 60 };
});

import { createApp, type Renderer } from "./app.ts";
import { createSession, setCredential } from "./auth.ts";
import {
  attachRealtime,
  clientCount,
  presenceNames,
  roomCount,
  type RealtimeServer,
} from "./realtime.ts";
import { resolveEvent } from "./routes/events.ts";
import { updateEvent } from "./storage.ts";
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
  // Retried for the same reason as in routes/events.test.ts: an authenticated
  // request refreshes `lastSeenAt` fire-and-forget, so a write can still be
  // landing here after the response that triggered it has been read.
  await fs.rm(varDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
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

async function createEvent(
  cookie: string,
  extra: Record<string, unknown> = {},
): Promise<StoredEvent> {
  const res = await call("POST", "/api/events", {
    cookie,
    body: {
      name: "Team Offsite",
      type: "specific_dates",
      dates: ["2026-08-03T00:00:00.000Z", "2026-08-04T00:00:00.000Z"],
      duration: 8,
      timeIncrement: 30,
      startOnMonday: true,
      ...extra,
    },
  });
  expect(res.status).toBe(201);
  return res.body as StoredEvent;
}

interface Subscriber {
  socket: WebSocket;
  /** Snapshots and `gone`, in order. Presence is kept separately. */
  received: RealtimeMessage[];
  /** Every presence list this socket has been sent, in order. */
  presence: string[][];
  /** Resolves once at least `count` snapshots or `gone`s have arrived. */
  take(count: number): Promise<RealtimeMessage[]>;
  /** Resolves once at least `count` presence lists have arrived. */
  takePresence(count: number): Promise<string[][]>;
  /** The most recent presence list, or an empty one before the first. */
  names(): string[];
}

/**
 * Opens a subscription and resolves once the socket is actually open.
 *
 * A `name` is announced the way the client announces one: in the upgrade URL,
 * because there is no inbound frame that could carry it.
 */
function subscribe(idOrSlug: string, name?: string): Promise<Subscriber> {
  const query = name === undefined ? "" : `?name=${encodeURIComponent(name)}`;
  const socket = new WebSocket(
    `${wsBase}/api/events/${encodeURIComponent(idOrSlug)}/ws${query}`,
  );
  clients.push(socket);
  const received: RealtimeMessage[] = [];
  const presence: string[][] = [];
  const waiting = new Set<() => void>();

  socket.addEventListener("message", (event: MessageEvent) => {
    const message = JSON.parse(String(event.data)) as RealtimeMessage;
    if (message.type === "presence") presence.push(message.names);
    else received.push(message);
    for (const notify of [...waiting]) notify();
  });

  const waitFor = <T,>(ready: () => T | null, label: string): Promise<T> =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiting.delete(check);
        reject(new Error(`timed out waiting for ${label}`));
      }, 3000);
      function check() {
        const value = ready();
        if (value === null) return;
        clearTimeout(timer);
        waiting.delete(check);
        resolve(value);
      }
      waiting.add(check);
      check();
    });

  const take = (count: number) =>
    waitFor(
      () => (received.length >= count ? received : null),
      `${count} snapshots (${received.length} arrived)`,
    );
  const takePresence = (count: number) =>
    waitFor(
      () => (presence.length >= count ? presence : null),
      `${count} presence lists (${presence.length} arrived)`,
    );

  return new Promise((resolve, reject) => {
    socket.addEventListener("open", () =>
      resolve({
        socket,
        received,
        presence,
        take,
        takePresence,
        names: () => presence[presence.length - 1] ?? [],
      }),
    );
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

  // -------------------------------------------------------------------------
  // the per-event switch
  // -------------------------------------------------------------------------

  describe("with live updates off for the event", () => {
    it("stores the flag, and defaults it on", async () => {
      const cookie = await adminCookie();
      expect((await createEvent(cookie)).realtime).toBe(true);
      expect((await createEvent(cookie, { realtime: false })).realtime).toBe(false);

      // Strict where startOnMonday coerces: this one decides whether a channel
      // is served, and "false" the string must not read as true.
      const bad = await call("POST", "/api/events", {
        cookie,
        body: {
          name: "Nope",
          type: "specific_dates",
          dates: ["2026-08-03T00:00:00.000Z"],
          duration: 8,
          timeIncrement: 30,
          realtime: "false",
        },
      });
      expect(bad.status).toBe(400);
    });

    it("refuses the upgrade, without spending a tarpit delay on it", async () => {
      attach();
      const event = await createEvent(await adminCookie(), { realtime: false });

      const elapsed = await refusedAfter(event.slug);

      // Whoever asked already proved they hold the capability URL, so this is
      // not a scan and must not be queued behind one.
      expect(elapsed).toBeLessThan(MISS_DELAY_MS);
      expect(roomCount()).toBe(0);

      // And the event itself is entirely unaffected: REST still serves it.
      expect((await call("GET", `/api/events/${event.slug}`)).status).toBe(200);
    });

    it("treats an event written before the flag existed as on", async () => {
      attach();
      const event = await createEvent(await adminCookie());
      // Old files have no `realtime` key and are never rewritten to add one.
      await updateEvent(event.id, (current) => {
        delete current.realtime;
        return current;
      });

      const watcher = await subscribe(event.slug);
      await call("PUT", `/api/events/${event.id}/responses/Frank`, {
        body: { availability: SLOTS },
      });
      expect((await watcher.take(1))[0].type).toBe("event");
    });

    it("hangs up on the room when the owner switches it off", async () => {
      attach();
      const cookie = await adminCookie();
      const event = await createEvent(cookie);
      const watcher = await subscribe(event.slug);
      const closed = new Promise<CloseEvent>((resolve) => {
        watcher.socket.addEventListener("close", (e: Event) => resolve(e as CloseEvent));
      });

      expect(
        (await call("PATCH", `/api/events/${event.id}`, {
          cookie,
          body: { realtime: false },
        })).status,
      ).toBe(200);

      await closed;
      // Hung up on, not told the event is gone — it is still there, and still
      // answerable over REST.
      expect(watcher.received.some((m) => m.type === "gone")).toBe(false);
      await until(() => roomCount() === 0, "the room to close");

      // Nothing is broadcast for it afterwards, and reconnecting is refused.
      await call("PUT", `/api/events/${event.id}/responses/Gina`, {
        body: { availability: SLOTS },
      });
      expect(roomCount()).toBe(0);
      await expect(subscribe(event.slug)).rejects.toThrow("upgrade refused");
    });

    it("starts pushing again when the owner switches it back on", async () => {
      attach();
      const cookie = await adminCookie();
      const event = await createEvent(cookie, { realtime: false });
      await expect(subscribe(event.slug)).rejects.toThrow("upgrade refused");

      await call("PATCH", `/api/events/${event.id}`, {
        cookie,
        body: { realtime: true },
      });

      const watcher = await subscribe(event.slug);
      await call("PUT", `/api/events/${event.id}/responses/Hank`, {
        body: { availability: SLOTS },
      });
      expect((await watcher.take(1))[0].type).toBe("event");
    });
  });

  // -------------------------------------------------------------------------
  // presence
  // -------------------------------------------------------------------------

  describe("presence", () => {
    it("tells a newcomer who is here, and the room that somebody arrived", async () => {
      attach();
      const event = await createEvent(await adminCookie());

      const alice = await subscribe(event.slug, "Alice");
      // Her own name is in her first list: she is one of the people here.
      expect(await alice.takePresence(1)).toEqual([["Alice"]]);

      const bob = await subscribe(event.slug, "Bob");
      // The newcomer is told the whole room, not just himself …
      expect((await bob.takePresence(1))[0]).toEqual(["Alice", "Bob"]);
      // … and the room is told about him, sorted rather than in arrival order.
      await alice.takePresence(2);
      expect(alice.names()).toEqual(["Alice", "Bob"]);
      expect(presenceNames(event.id)).toEqual(["Alice", "Bob"]);

      // Presence is not an answer: nobody has responded to this event at all.
      expect(Object.keys((await call("GET", `/api/events/${event.id}`)).body as never))
        .not.toContain("presence");
      expect(((await call("GET", `/api/events/${event.id}`)).body as StoredEvent).responses)
        .toEqual({});
    });

    it("counts a name once however many connections it has", async () => {
      attach();
      const event = await createEvent(await adminCookie());
      const watcher = await subscribe(event.slug, "Alice");
      await watcher.takePresence(1);

      // A second tab under the same name: the same list, so nothing is sent.
      const secondTab = await subscribe(event.slug, "Alice");
      expect((await secondTab.takePresence(1))[0]).toEqual(["Alice"]);
      expect(presenceNames(event.id)).toEqual(["Alice"]);
      expect(watcher.presence).toHaveLength(1);

      // One tab closing leaves the other holding the name.
      secondTab.socket.close();
      await until(() => clientCount(event.id) === 1, "the second tab to go");
      expect(presenceNames(event.id)).toEqual(["Alice"]);
      expect(watcher.presence).toHaveLength(1);
    });

    it("takes a name off the list when its last connection goes", async () => {
      attach();
      const event = await createEvent(await adminCookie());
      const alice = await subscribe(event.slug, "Alice");
      const bob = await subscribe(event.slug, "Bob");
      await alice.takePresence(2);

      bob.socket.close();

      expect((await alice.takePresence(3))[2]).toEqual(["Alice"]);
      expect(presenceNames(event.id)).toEqual(["Alice"]);
    });

    it("sends a browsing page the list without putting it on one", async () => {
      attach();
      const event = await createEvent(await adminCookie());
      const alice = await subscribe(event.slug, "Alice");
      await alice.takePresence(1);

      // No `name` at all: this page is reading, not answering.
      const browsing = await subscribe(event.slug);

      expect((await browsing.takePresence(1))[0]).toEqual(["Alice"]);
      expect(presenceNames(event.id)).toEqual(["Alice"]);
      // And nobody was told anything, because nothing changed.
      expect(alice.presence).toHaveLength(1);

      browsing.socket.close();
      await until(() => clientCount(event.id) === 1, "the browsing page to go");
      expect(alice.presence).toHaveLength(1);
    });

    it("treats a name that is not one as no name at all", async () => {
      attach();
      const event = await createEvent(await adminCookie());

      // Whitespace, an empty value, and one over the guest-name limit. Every
      // one of them is a connection that simply has no name.
      for (const name of ["   ", "", "\t\n", "L".repeat(101)]) {
        const watcher = await subscribe(event.slug, name);
        expect((await watcher.takePresence(1))[0]).toEqual([]);
        expect(presenceNames(event.id)).toEqual([]);
        watcher.socket.close();
      }

      // Right up to the limit is a name, and it is trimmed on the way in.
      const long = "L".repeat(100);
      const watcher = await subscribe(event.slug, `  ${long}  `);
      expect((await watcher.takePresence(1))[0]).toEqual([long]);
    });

    it("keeps the room's own name list out of what a client can set", async () => {
      attach();
      const event = await createEvent(await adminCookie());
      const alice = await subscribe(event.slug, "Alice");
      const watcher = await subscribe(event.slug);
      await watcher.takePresence(1);

      // A forged presence frame, in exactly the shape the server sends: still
      // read off the wire and dropped, because no `message` listener exists.
      watcher.socket.send(JSON.stringify({ type: "presence", names: ["Mallory", "Alice"] }));
      watcher.socket.send(JSON.stringify({ type: "presence", names: [] }));
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(presenceNames(event.id)).toEqual(["Alice"]);
      expect(watcher.presence).toEqual([["Alice"]]);
      expect(alice.presence).toEqual([["Alice"]]);
      expect(watcher.socket.readyState).toBe(WebSocket.OPEN);
    });

    it("drops a name whose socket the heartbeat reaped", async () => {
      attach(30);
      const event = await createEvent(await adminCookie());
      const alice = await subscribe(event.slug, "Alice");

      // A client that has stopped answering — the case the heartbeat exists
      // for: a connection through a proxy that quietly went away looks exactly
      // like an idle one, and the name behind it must not linger on the list.
      const mute = new WsClient(
        `${wsBase}/api/events/${encodeURIComponent(event.slug)}/ws?name=Zoe`,
      );
      mute.pong = (() => {}) as typeof mute.pong;
      await new Promise<void>((resolve, reject) => {
        mute.on("open", () => resolve());
        mute.on("error", reject);
      });
      await alice.takePresence(2);
      expect(alice.names()).toEqual(["Alice", "Zoe"]);

      // One round pings it, the next terminates it, and the close it triggers
      // is the same exit any other departure takes.
      expect((await alice.takePresence(3))[2]).toEqual(["Alice"]);
      expect(presenceNames(event.id)).toEqual(["Alice"]);
      expect(clientCount(event.id)).toBe(1);
      mute.terminate();
    });

    it("has nobody at all when the event's live updates are off", async () => {
      attach();
      const event = await createEvent(await adminCookie(), { realtime: false });

      await expect(subscribe(event.slug, "Alice")).rejects.toThrow("upgrade refused");

      // No socket means no room, and no room means no presence to leak.
      expect(presenceNames(event.id)).toEqual([]);
      expect(roomCount()).toBe(0);
    });

    it("has nobody at all when realtime is off server-wide", async () => {
      // No attach(): the kill switch is the absence of the listener.
      const event = await createEvent(await adminCookie());

      await expect(subscribe(event.slug, "Alice")).rejects.toThrow("upgrade refused");

      expect(presenceNames(event.id)).toEqual([]);
      expect(roomCount()).toBe(0);
    });
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
