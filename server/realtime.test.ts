/**
 * The realtime channel over a real socket, nothing mocked: broadcasts, the
 * snapshot-on-join, the read-only browse socket, one write session per key,
 * tarpitted misses, and the REST fallback with realtime off.
 */
import http from "node:http";
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
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

import { CLOSE_OCCUPIED, CLOSE_REPLACED } from "../src/lib/realtime.ts";
import {
  attachRealtime,
  clientCount,
  presencePeople,
  roomCount,
  sessionKeys,
  type RealtimeServer,
} from "./realtime.ts";
import { resolveEvent, writeResponse } from "./routes/events.ts";
import { readEvent, updateEvent } from "./storage.ts";
import { missTarpit } from "./tarpit.ts";
import {
  adminCookie,
  apiCall,
  createTestEvent,
  eventFixture,
  makeVarDir,
  removeVarDir,
  startTestServer,
  type CallFn,
} from "./test-support.ts";
import type { PresenceEntry, RealtimeMessage, StoredEvent } from "./types.ts";

let server: Server;
let hub: RealtimeServer | null = null;
let base: string;
let wsBase: string;
let closeServer: () => Promise<void>;
let varDir: string;
const clients: WebSocket[] = [];

beforeEach(async () => {
  // The temp `VAR_DIR` and the app are made together, in this order: the app
  // must never observe the previous test's directory.
  varDir = await makeVarDir("timeful-realtime-");
  ({ server, base, wsBase, close: closeServer } = await startTestServer());
});

afterEach(async () => {
  for (const socket of clients.splice(0)) socket.close();
  await hub?.close();
  hub = null;
  await closeServer();
  await removeVarDir(varDir);
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Registers the upgrade listener. Left to each test: some want it absent. */
function attach(heartbeatMs?: number): RealtimeServer {
  hub = attachRealtime(server, { resolveEvent, writeResponse, heartbeatMs });
  return hub;
}

/** `apiCall` against this test's server of the moment. */
const call: CallFn = (method, route, options) => apiCall(base, method, route, options);

const createEvent = (cookie: string, extra: Record<string, unknown> = {}) =>
  createTestEvent(call, cookie, extra);

/** The common opener: a signed-in owner and one event of theirs. */
const fixture = (extra?: Record<string, unknown>) => eventFixture(call, extra);

/** The REST write, as the page makes it when there is no session. */
function put(
  idOrSlug: string,
  key: string,
  displayName: string,
  body: Record<string, unknown> = { availability: SLOTS },
) {
  return call("PUT", `/${idOrSlug}/users/${key}`, { body: { displayName, ...body } });
}

interface Subscriber {
  socket: WebSocket;
  /**
   * Everything but presence — snapshots, acks, refusals, `gone`, `replaced` —
   * with the join snapshot already lifted out into `joinSnapshot`, so every
   * count a test asserts on is a count of what happened *after* the join.
   */
  received: RealtimeMessage[];
  /** Every presence list this socket has been sent, in order. */
  presence: PresenceEntry[][];
  /** The message type of every frame, in arrival order, presence included. */
  frames: string[];
  /**
   * The snapshot the server answers a join with, or null when it hung up
   * without one — a refused claim never joins, so it is never handed one.
   * Filled in by `subscribe`/`session`; raw `openSocket` callers read frames.
   */
  joinSnapshot: RealtimeMessage | null;
  /** Waits for the join snapshot and lifts it out of `received`. */
  joined(): Promise<RealtimeMessage | null>;
  /** Resolves once at least `count` non-presence messages have arrived. */
  take(count: number): Promise<RealtimeMessage[]>;
  /** Resolves once at least `count` presence lists have arrived. */
  takePresence(count: number): Promise<PresenceEntry[][]>;
  /** The most recent presence list, or an empty one before the first. */
  people(): PresenceEntry[];
  /** The close code and reason, once the server hangs up. */
  closed(): Promise<{ code: number; reason: string }>;
}

/** Opens a socket at an arbitrary path and resolves once it is actually open. */
function openSocket(url: string): Promise<Subscriber> {
  const socket = new WebSocket(url);
  clients.push(socket);
  const received: RealtimeMessage[] = [];
  const presence: PresenceEntry[][] = [];
  const frames: string[] = [];
  const waiting = new Set<() => void>();

  socket.addEventListener("message", (event: MessageEvent) => {
    const message = JSON.parse(String(event.data)) as RealtimeMessage;
    frames.push(message.type);
    if (message.type === "presence") presence.push(message.people);
    else received.push(message);
    for (const notify of [...waiting]) notify();
  });

  const closeEvent = new Promise<{ code: number; reason: string }>((resolve) => {
    socket.addEventListener("close", (event: Event) => {
      const close = event as CloseEvent;
      resolve({ code: close.code, reason: close.reason });
    });
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
      `${count} messages (${received.length} arrived)`,
    );
  const takePresence = (count: number) =>
    waitFor(
      () => (presence.length >= count ? presence : null),
      `${count} presence lists (${presence.length} arrived)`,
    );

  const joined = (): Promise<RealtimeMessage | null> => {
    const snapshot = waitFor(
      () => (received[0]?.type === "event" ? (received.shift() as RealtimeMessage) : null),
      "the join snapshot",
    );
    // A refused claim is hung up on without one; the loser of the race below
    // must not surface its timeout as an unhandled rejection.
    snapshot.catch(() => {});
    return Promise.race([snapshot, closeEvent.then(() => null)]);
  };

  return new Promise((resolve, reject) => {
    socket.addEventListener("open", () =>
      resolve({
        socket,
        received,
        presence,
        frames,
        joinSnapshot: null,
        joined,
        take,
        takePresence,
        people: () => presence[presence.length - 1] ?? [],
        closed: () => closeEvent,
      }),
    );
    socket.addEventListener("error", () => reject(new Error("upgrade refused")));
  });
}

/** The browse socket: watching, claiming nothing, sending nothing. */
async function subscribe(idOrSlug: string): Promise<Subscriber> {
  const subscriber = await openSocket(`${wsBase}/${encodeURIComponent(idOrSlug)}/ws`);
  subscriber.joinSnapshot = await subscriber.joined();
  return subscriber;
}

/**
 * The named write session. `name` is the spelling the room should render; a
 * takeover is only ever asked for after a `4409`.
 */
async function session(
  idOrSlug: string,
  key: string,
  options: { name?: string; takeover?: boolean } = {},
): Promise<Subscriber> {
  const query = new URLSearchParams();
  if (options.name !== undefined) query.set("name", options.name);
  if (options.takeover) query.set("takeover", "1");
  const suffix = query.toString() ? `?${query.toString()}` : "";
  const subscriber = await openSocket(
    `${wsBase}/${encodeURIComponent(idOrSlug)}/users/${encodeURIComponent(key)}${suffix}`,
  );
  subscriber.joinSnapshot = await subscriber.joined();
  return subscriber;
}

/** One save frame, as the client's connector sends it. */
function save(
  subscriber: Subscriber,
  displayName: string,
  body: Record<string, unknown> = { availability: SLOTS, ifNeeded: [] },
): void {
  subscriber.socket.send(JSON.stringify({ type: "save", displayName, ...body }));
}

/** Resolves to how long an upgrade took to fail, in ms. */
async function refusedAfter(idOrSlug: string): Promise<number> {
  const started = Date.now();
  await expect(subscribe(idOrSlug)).rejects.toThrow("upgrade refused");
  return Date.now() - started;
}

/**
 * A hand-rolled upgrade request, for handshakes `WebSocket` cannot make —
 * an arbitrary subprotocol against a listener expected to answer with plain
 * HTTP. Resolves with the response status; rejects if the socket is destroyed
 * without one.
 */
function rawUpgradeStatus(route: string, protocol: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request(`${base}${route}`, {
      headers: {
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Version": "13",
        "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
        "Sec-WebSocket-Protocol": protocol,
      },
    });
    req.on("response", (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    // A 101 would arrive here rather than as a 'response'.
    req.on("upgrade", (res) => resolve(res.statusCode ?? 0));
    req.on("error", reject);
    req.end();
  });
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

/** The names in a presence list, for the assertions that only care about those. */
const names = (people: PresenceEntry[]) => people.map((p) => p.displayName);
const keysOf = (people: PresenceEntry[]) => people.map((p) => p.key);

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

describe("the realtime channel", () => {
  it("pushes a full snapshot after a guest saves an answer", async () => {
    attach();
    const event = await createEvent(await adminCookie());
    // By slug, the way a page reaches it: the capability URL is the address.
    const watcher = await subscribe(event.slug);

    expect((await put(event.id, "alice", "Alice")).status).toBe(200);

    const [message] = await watcher.take(1);
    expect(message.type).toBe("event");
    if (message.type !== "event") throw new Error("unreachable");
    // The whole document, responses inline — the same bytes a GET returns.
    expect(message.event.id).toBe(event.id);
    expect(message.event.responses.alice.availability).toEqual(SLOTS);
    expect(message.event.responses.alice.displayName).toBe("Alice");
  });

  it("reaches every subscriber watching the same event", async () => {
    attach();
    const event = await createEvent(await adminCookie());
    const first = await subscribe(event.slug);
    // The second joins by uuid: both addresses resolve to the same room.
    const second = await subscribe(event.id);
    expect(clientCount(event.id)).toBe(2);

    await put(event.id, "bob", "Bob");

    for (const messages of [await first.take(1), await second.take(1)]) {
      const [message] = messages;
      if (message.type !== "event") throw new Error("expected a snapshot");
      expect(Object.keys(message.event.responses)).toEqual(["bob"]);
    }
  });

  it("announces a deleted response, and a deleted event", async () => {
    attach();
    const { cookie, event } = await fixture();
    await put(event.id, "carol", "Carol");
    const watcher = await subscribe(event.slug);

    await call("DELETE", `/${event.id}/users/carol`);
    await call("DELETE", `/${event.id}/settings`, { cookie });

    const [removed, gone] = await watcher.take(2);
    if (removed.type !== "event") throw new Error("expected a snapshot");
    expect(Object.keys(removed.event.responses)).toEqual([]);
    expect(gone.type).toBe("gone");
    // A deleted event takes its room with it.
    await until(() => clientCount(event.id) === 0, "the room to close");
  });

  it("carries the new slug when the event is renamed", async () => {
    attach();
    const { cookie, event } = await fixture();
    const watcher = await subscribe(event.slug);

    expect(
      (await call("PATCH", `/${event.id}/settings`, {
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
  // the join snapshot
  // -------------------------------------------------------------------------

  describe("the join snapshot", () => {
    it("hands a joining browse socket the document, ahead of presence", async () => {
      attach();
      const event = await createEvent(await adminCookie());
      expect((await put(event.id, "alice", "Alice")).status).toBe(200);

      // Raw, so the arrival order is on the record rather than absorbed by the
      // helper: the snapshot must come first — a presence list for a document
      // the page has not been given yet would be an answer out of order.
      const watcher = await openSocket(`${wsBase}/${encodeURIComponent(event.slug)}/ws`);
      const [snapshot] = await watcher.take(1);
      await watcher.takePresence(1);

      expect(watcher.frames.slice(0, 2)).toEqual(["event", "presence"]);
      if (snapshot.type !== "event") throw new Error("expected a snapshot");
      expect(snapshot.event.id).toBe(event.id);
      expect(snapshot.event.responses.alice).toMatchObject({
        displayName: "Alice",
        availability: SLOTS,
      });
      // The same public copy a broadcast is: the strip is at the door here too.
      expect(JSON.stringify(snapshot)).not.toContain("lastEdit");
      expect((await readEvent(event.id))?.responses.alice.lastEdit).toBeDefined();
    });

    it("hands a joining write session the document too", async () => {
      attach();
      const event = await createEvent(await adminCookie());
      await put(event.id, "alice", "Alice");

      const bob = await session(event.slug, "bob", { name: "Bob" });
      await bob.takePresence(1);

      expect(bob.frames.slice(0, 2)).toEqual(["event", "presence"]);
      if (bob.joinSnapshot?.type !== "event") throw new Error("expected a snapshot");
      expect(bob.joinSnapshot.event.responses.alice.availability).toEqual(SLOTS);
    });

    it("catches a reconnecting page up on the save it missed", async () => {
      // The case the snapshot exists for: a laptop lid closed through somebody
      // else's save reconnects successfully — and, without this, would show
      // the group's availability as of the disconnect until the next save.
      attach();
      const event = await createEvent(await adminCookie());
      const before = await subscribe(event.slug);
      if (before.joinSnapshot?.type !== "event") throw new Error("expected a snapshot");
      expect(before.joinSnapshot.event.responses).toEqual({});

      before.socket.close();
      await until(() => clientCount(event.id) === 0, "the watcher to leave");
      // The save lands while nobody is watching: no broadcast reaches anyone.
      await put(event.id, "carol", "Carol");

      const again = await subscribe(event.slug);
      if (again.joinSnapshot?.type !== "event") throw new Error("expected a snapshot");
      expect(again.joinSnapshot.event.responses.carol.availability).toEqual(SLOTS);
      // And nothing further is owed: the page is current, not replaying.
      expect(again.received).toEqual([]);
    });

    it("sends no snapshot to a claim it refuses", async () => {
      attach();
      const event = await createEvent(await adminCookie());
      await session(event.slug, "ada-lovelace", { name: "Ada Lovelace" });

      // A refused claim never joins the room, so it is told nothing at all —
      // the close code carries the whole answer.
      const second = await session(event.slug, "ada-lovelace", { name: "Ada Lovelace" });
      expect((await second.closed()).code).toBe(CLOSE_OCCUPIED);
      expect(second.joinSnapshot).toBeNull();
      expect(second.received).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // the browse socket is read-only
  // -------------------------------------------------------------------------

  it("ignores everything a browsing client sends, and stays connected", async () => {
    attach();
    const event = await createEvent(await adminCookie());
    const watcher = await subscribe(event.slug);

    // A forged snapshot, a save frame in exactly the shape the write session
    // accepts, and rubbish. None is parsed, let alone acted on: this socket has
    // no `message` listener at all.
    watcher.socket.send(
      JSON.stringify({
        type: "event",
        event: { ...event, name: "Pwned", responses: { mallory: { availability: SLOTS } } },
      }),
    );
    watcher.socket.send(
      JSON.stringify({ type: "save", displayName: "Mallory", availability: SLOTS }),
    );
    watcher.socket.send("not json at all");

    // Give the server every chance to have done something with it.
    await new Promise((resolve) => setTimeout(resolve, 100));

    const stored = (await call("GET", `/${event.id}/data`)).body as StoredEvent;
    expect(stored.name).toBe("Team Offsite");
    expect(stored.responses).toEqual({});
    expect(watcher.received).toEqual([]);

    // Ignoring is friendlier than closing: the socket is still healthy and
    // still delivers the next real update.
    expect(watcher.socket.readyState).toBe(WebSocket.OPEN);
    await put(event.id, "dan", "Dan");
    const [message] = await watcher.take(1);
    if (message.type !== "event") throw new Error("expected a snapshot");
    expect(Object.keys(message.event.responses)).toEqual(["dan"]);
  });

  // -------------------------------------------------------------------------
  // the named write session
  // -------------------------------------------------------------------------

  describe("a write session", () => {
    it("acknowledges a save and broadcasts it to the room", async () => {
      attach();
      const event = await createEvent(await adminCookie());
      const watcher = await subscribe(event.slug);
      const ada = await session(event.slug, "ada-lovelace", { name: "Ada Lovelace" });

      save(ada, "Ada Lovelace");

      // The writer gets an ack — the autosave engine's success signal …
      const [ack] = await ada.take(1);
      expect(ack).toEqual({ type: "saved" });
      // … and the room gets the snapshot, the writer included.
      const [broadcast] = await watcher.take(1);
      if (broadcast.type !== "event") throw new Error("expected a snapshot");
      expect(broadcast.event.responses["ada-lovelace"]).toMatchObject({
        displayName: "Ada Lovelace",
        availability: SLOTS,
      });

      // And it is on disk, not just on the wire.
      const stored = (await call("GET", `/${event.id}/data`)).body as StoredEvent;
      expect(stored.responses["ada-lovelace"].availability).toEqual(SLOTS);
    });

    it("validates a save exactly as the REST PUT does", async () => {
      attach();
      const event = await createEvent(await adminCookie());
      const ada = await session(event.slug, "ada-lovelace", { name: "Ada Lovelace" });

      // Every one of these is a 400 over REST. Over the socket it is a refusal
      // carrying the same words, because it is the same validator that wrote
      // them — and never a closed connection.
      const bad: Array<[Record<string, unknown>, string]> = [
        [{ displayName: "Ada-Lovelace" }, "A name may not contain a dash — use spaces instead"],
        [{ displayName: "   " }, "A name is required"],
        [{ displayName: "Grace Hopper" }, "The name does not match the key in the path"],
        [
          { displayName: "Ada Lovelace", availability: ["not a date"] },
          "availability must be an array of ISO date strings",
        ],
      ];
      for (const [body, message] of bad) {
        ada.socket.send(JSON.stringify({ type: "save", ...body }));
        const seen = await ada.take(ada.received.length + 1);
        expect(seen[seen.length - 1]).toEqual({ type: "save-failed", message });

        const rest = await call("PUT", `/${event.id}/users/ada-lovelace`, { body });
        expect(rest.status).toBe(400);
        expect((rest.body as { error: string }).error).toBe(message);
      }

      expect(ada.socket.readyState).toBe(WebSocket.OPEN);
      expect(((await call("GET", `/${event.id}/data`)).body as StoredEvent).responses)
        .toEqual({});
    });

    it("ignores a frame that is not a save, without hanging up", async () => {
      attach();
      const event = await createEvent(await adminCookie());
      const ada = await session(event.slug, "ada-lovelace", { name: "Ada Lovelace" });

      // A message type from a newer client is not an attack, and closing on it
      // would punish a page for speaking a word this server has not learned.
      for (const frame of [
        "not json",
        JSON.stringify({ type: "presence", people: [] }),
        JSON.stringify({ type: "save" }),
        JSON.stringify({ type: "save", displayName: 7 }),
      ]) {
        ada.socket.send(frame);
      }
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(ada.received).toEqual([]);
      expect(ada.socket.readyState).toBe(WebSocket.OPEN);
      // Still a working session afterwards.
      save(ada, "Ada Lovelace");
      expect((await ada.take(1))[0]).toEqual({ type: "saved" });
    });

    it("clears an answer with an empty save, keeping the zero-record rule", async () => {
      attach();
      const event = await createEvent(await adminCookie());
      const ada = await session(event.slug, "ada-lovelace", { name: "Ada Lovelace" });
      save(ada, "Ada Lovelace");
      // The writer is in the room too, so its own save comes back as a
      // snapshot as well as an ack: two messages per save, not one.
      await ada.take(2);

      save(ada, "Ada Lovelace", { availability: [], ifNeeded: [] });

      await ada.take(4);
      expect(ada.received.filter((m) => m.type === "saved")).toHaveLength(2);
      // Not a hollow record: the guest is off the event entirely.
      const stored = (await call("GET", `/${event.id}/data`)).body as StoredEvent;
      expect(stored.responses).toEqual({});
    });

    it("says nothing to the room for a clear that cleared nothing", async () => {
      attach();
      const event = await createEvent(await adminCookie());
      const watcher = await subscribe(event.slug);
      const ada = await session(event.slug, "ada-lovelace", { name: "Ada Lovelace" });

      save(ada, "Ada Lovelace", { availability: [], ifNeeded: [] });

      // Acknowledged, because the save did land — and no snapshot, because
      // nothing about the event changed.
      expect((await ada.take(1))[0]).toEqual({ type: "saved" });
      await new Promise((resolve) => setTimeout(resolve, 80));
      expect(watcher.received).toEqual([]);
    });

    it("normalizes the key in the path", async () => {
      attach();
      const event = await createEvent(await adminCookie());
      // A page would send the key; a hand-written URL may not. Both are the
      // same person, and the same session.
      const ada = await session(event.slug, "Ada Lovelace", { name: "Ada Lovelace" });
      expect(sessionKeys(event.id)).toEqual(["ada-lovelace"]);

      save(ada, "Ada Lovelace");
      await ada.take(1);
      const stored = (await call("GET", `/${event.id}/data`)).body as StoredEvent;
      expect(Object.keys(stored.responses)).toEqual(["ada-lovelace"]);
    });

    it("still writes over REST while a session is open", async () => {
      // The socket is an addition, not a replacement: the REST PUT is the write
      // API whenever there is no session, and it never stops working.
      attach();
      const event = await createEvent(await adminCookie());
      const ada = await session(event.slug, "ada-lovelace", { name: "Ada Lovelace" });

      expect((await put(event.id, "grace-hopper", "Grace Hopper")).status).toBe(200);

      const [message] = await ada.take(1);
      if (message.type !== "event") throw new Error("expected a snapshot");
      expect(Object.keys(message.event.responses)).toEqual(["grace-hopper"]);
    });
  });

  // -------------------------------------------------------------------------
  // one session per key
  // -------------------------------------------------------------------------

  describe("exclusivity", () => {
    it("refuses a second session for the same key", async () => {
      attach();
      const event = await createEvent(await adminCookie());
      const first = await session(event.slug, "ada-lovelace", { name: "Ada Lovelace" });

      // A different spelling of the same name is the same key, and so the same
      // session — which is the whole point of normalizing it.
      const second = await session(event.slug, "ada  LOVELACE", { name: "ada  LOVELACE" });

      const closed = await second.closed();
      expect(closed.code).toBe(CLOSE_OCCUPIED);
      expect(closed.reason).toBe("occupied");
      // The incumbent is untouched: not told anything, and still the holder.
      expect(first.socket.readyState).toBe(WebSocket.OPEN);
      expect(first.received).toEqual([]);
      expect(sessionKeys(event.id)).toEqual(["ada-lovelace"]);
      expect(clientCount(event.id)).toBe(1);

      save(first, "Ada Lovelace");
      expect((await first.take(1))[0]).toEqual({ type: "saved" });
    });

    it("lets a different key in beside it", async () => {
      attach();
      const event = await createEvent(await adminCookie());
      await session(event.slug, "ada-lovelace", { name: "Ada Lovelace" });
      const grace = await session(event.slug, "grace-hopper", { name: "Grace Hopper" });

      expect(grace.socket.readyState).toBe(WebSocket.OPEN);
      expect(sessionKeys(event.id)).toEqual(["ada-lovelace", "grace-hopper"]);
    });

    it("hands the session over when the newcomer asks to take it", async () => {
      attach();
      const event = await createEvent(await adminCookie());
      const first = await session(event.slug, "ada-lovelace", { name: "Ada Lovelace" });

      const second = await session(event.slug, "ada-lovelace", {
        name: "Ada Lovelace",
        takeover: true,
      });

      // The incumbent is told in words before it is hung up on, so its page can
      // say what happened rather than showing a dropped connection.
      const [replaced] = await first.take(1);
      expect(replaced).toEqual({ type: "replaced" });
      const closed = await first.closed();
      expect(closed.code).toBe(CLOSE_REPLACED);

      // And the newcomer holds a working session.
      expect(second.socket.readyState).toBe(WebSocket.OPEN);
      await until(() => clientCount(event.id) === 1, "the old session to go");
      expect(sessionKeys(event.id)).toEqual(["ada-lovelace"]);
      save(second, "Ada Lovelace");
      expect((await second.take(1))[0]).toEqual({ type: "saved" });
    });

    it("does not let the evicted session's close evict the newcomer", async () => {
      attach();
      const event = await createEvent(await adminCookie());
      const first = await session(event.slug, "ada-lovelace", { name: "Ada Lovelace" });
      const second = await session(event.slug, "ada-lovelace", {
        name: "Ada Lovelace",
        takeover: true,
      });
      await first.closed();
      await until(() => clientCount(event.id) === 1, "the old session to go");

      // The claim belongs to whoever holds it now, not to whoever held it last.
      expect(sessionKeys(event.id)).toEqual(["ada-lovelace"]);
      save(second, "Ada Lovelace");
      expect((await second.take(1))[0]).toEqual({ type: "saved" });
    });

    it("refuses a save from a session that has been taken over", async () => {
      attach();
      const event = await createEvent(await adminCookie());
      const first = await session(event.slug, "ada-lovelace", { name: "Ada Lovelace" });
      await session(event.slug, "ada-lovelace", { name: "Ada Lovelace", takeover: true });

      // A frame already on the wire when the takeover landed writes nothing:
      // the session is not this socket's any more.
      save(first, "Ada Lovelace");
      await new Promise((resolve) => setTimeout(resolve, 100));

      const stored = (await call("GET", `/${event.id}/data`)).body as StoredEvent;
      expect(stored.responses).toEqual({});
    });

    it("frees the key once the session closes", async () => {
      attach();
      const event = await createEvent(await adminCookie());
      const first = await session(event.slug, "ada-lovelace", { name: "Ada Lovelace" });

      first.socket.close();
      await until(() => sessionKeys(event.id).length === 0, "the session to be freed");

      // No takeover needed: nobody holds it.
      const second = await session(event.slug, "ada-lovelace", { name: "Ada Lovelace" });
      expect(second.socket.readyState).toBe(WebSocket.OPEN);
      expect(sessionKeys(event.id)).toEqual(["ada-lovelace"]);
    });

    it("does not enforce anything when realtime is off", async () => {
      // No sessions exist, so there is nothing to be exclusive about. Two
      // browsers editing as one person is exactly the behaviour the app had
      // before write sessions, and the REST PUT is how they both do it.
      const event = await createEvent(await adminCookie(), { realtime: false });

      await expect(
        session(event.slug, "ada-lovelace", { name: "Ada Lovelace" }),
      ).rejects.toThrow("upgrade refused");

      expect((await put(event.id, "ada-lovelace", "Ada Lovelace")).status).toBe(200);
      expect(
        (await put(event.id, "ada-lovelace", "Ada Lovelace", {
          availability: ["2026-08-04T13:00:00.000Z"],
        })).status,
      ).toBe(200);
      const stored = (await call("GET", `/${event.id}/data`)).body as StoredEvent;
      expect(stored.responses["ada-lovelace"].availability).toEqual([
        "2026-08-04T13:00:00.000Z",
      ]);
    });

    it("does not let a browse socket claim or block anything", async () => {
      attach();
      const event = await createEvent(await adminCookie());
      await subscribe(event.slug);
      await subscribe(event.slug);

      expect(sessionKeys(event.id)).toEqual([]);
      const ada = await session(event.slug, "ada-lovelace", { name: "Ada Lovelace" });
      expect(ada.socket.readyState).toBe(WebSocket.OPEN);
      expect(sessionKeys(event.id)).toEqual(["ada-lovelace"]);
    });
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

  it("tarpits a write-session upgrade that names no event", async () => {
    attach();
    await createEvent(await adminCookie());

    const started = Date.now();
    await expect(
      session("Nx7Kq2mWx9Az", "ada-lovelace", { name: "Ada Lovelace" }),
    ).rejects.toThrow("upgrade refused");

    // A session URL must be no cheaper to scan than the browse one beside it.
    expect(Date.now() - started).toBeGreaterThanOrEqual(MISS_DELAY_MS - 15);
    expect(roomCount()).toBe(0);
  });

  it("registers nothing at all when realtime is off", async () => {
    // No attach(): this is what `serve()` does with realtime disabled.
    const event = await createEvent(await adminCookie());

    await expect(subscribe(event.slug)).rejects.toThrow("upgrade refused");
    expect(roomCount()).toBe(0);

    // And the page it would have enhanced is untouched: REST still answers.
    const res = await call("GET", `/${event.slug}/data`);
    expect(res.status).toBe(200);
    expect((res.body as StoredEvent).id).toBe(event.id);
  });

  it("leaves an upgrade for any other path alone", async () => {
    attach();
    const event = await createEvent(await adminCookie());
    // A plain GET of either socket path is not an upgrade, and falls through to
    // the event-scoped catch-all rather than to anything realtime owns. The
    // slug resolved, so it is a plain 404 with no delay behind it.
    expect((await call("GET", `/${event.slug}/ws`)).status).toBe(404);
    expect((await call("GET", `/${event.slug}/users/ada-lovelace`)).status).toBe(404);
  });

  it("leaves a vite-hmr upgrade to the listener that owns it", async () => {
    attach();
    const event = await createEvent(await adminCookie());

    // Stand in for Vite: a second upgrade listener sharing the server, which
    // is exactly the dev-mode shape (`server.hmr.server` in server/dev.ts).
    // Like Vite's, it answers only upgrades carrying its subprotocol.
    const answered: string[] = [];
    const hmrListener = (req: IncomingMessage, socket: Duplex) => {
      const protocols = String(req.headers["sec-websocket-protocol"] ?? "");
      if (!protocols.split(",").some((p) => p.trim() === "vite-hmr")) return;
      answered.push(req.url ?? "");
      socket.end("HTTP/1.1 501 Not Implemented\r\nConnection: close\r\n\r\n");
    };
    server.on("upgrade", hmrListener);
    try {
      // Even on a URL the realtime listener would otherwise claim, the
      // subprotocol decides: the upgrade reaches the HMR listener untouched
      // instead of joining a room (or, for a miss, the tarpit).
      const status = await rawUpgradeStatus(`/${event.slug}/ws`, "vite-hmr");
      expect(status).toBe(501);
      expect(answered).toEqual([`/${event.slug}/ws`]);
      expect(roomCount()).toBe(0);

      // And without the token, the same URL is still realtime's to serve.
      const subscriber = await subscribe(event.slug);
      expect(clientCount(event.id)).toBe(1);
      subscriber.socket.close();
    } finally {
      server.off("upgrade", hmrListener);
    }
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
      expect((await call("GET", `/${event.slug}/data`)).status).toBe(200);
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
      await put(event.id, "frank", "Frank");
      expect((await watcher.take(1))[0].type).toBe("event");
    });

    it("hangs up on the room when the owner switches it off", async () => {
      attach();
      const { cookie, event } = await fixture();
      const watcher = await subscribe(event.slug);

      expect(
        (await call("PATCH", `/${event.id}/settings`, {
          cookie,
          body: { realtime: false },
        })).status,
      ).toBe(200);

      await watcher.closed();
      // Hung up on, not told the event is gone — it is still there, and still
      // answerable over REST.
      expect(watcher.received.some((m) => m.type === "gone")).toBe(false);
      await until(() => roomCount() === 0, "the room to close");

      // Nothing is broadcast for it afterwards, and reconnecting is refused.
      await put(event.id, "gina", "Gina");
      expect(roomCount()).toBe(0);
      await expect(subscribe(event.slug)).rejects.toThrow("upgrade refused");
    });

    it("starts pushing again when the owner switches it back on", async () => {
      attach();
      const { cookie, event } = await fixture({ realtime: false });
      await expect(subscribe(event.slug)).rejects.toThrow("upgrade refused");

      await call("PATCH", `/${event.id}/settings`, {
        cookie,
        body: { realtime: true },
      });

      const watcher = await subscribe(event.slug);
      await put(event.id, "hank", "Hank");
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

      const alice = await session(event.slug, "alice", { name: "Alice" });
      // Her own entry is in her first list: she is one of the people here.
      expect(await alice.takePresence(1)).toEqual([[{ key: "alice", displayName: "Alice" }]]);

      const bob = await session(event.slug, "bob", { name: "Bob" });
      // The newcomer is told the whole room, not just himself …
      expect(names((await bob.takePresence(1))[0])).toEqual(["Alice", "Bob"]);
      // … and the room is told about him, ordered by name rather than arrival.
      await alice.takePresence(2);
      expect(names(alice.people())).toEqual(["Alice", "Bob"]);
      expect(keysOf(presencePeople(event.id))).toEqual(["alice", "bob"]);

      // Presence is not an answer: nobody has responded to this event at all.
      const doc = (await call("GET", `/${event.id}/data`)).body as StoredEvent;
      expect(Object.keys(doc)).not.toContain("presence");
      expect(doc.responses).toEqual({});
    });

    it("carries the spelling the session announced", async () => {
      attach();
      const event = await createEvent(await adminCookie());
      // The key is what matches; the display name is what a row renders.
      const ada = await session(event.slug, "ada-lovelace", { name: "ada  LOVELACE" });
      expect((await ada.takePresence(1))[0]).toEqual([
        { key: "ada-lovelace", displayName: "ada  LOVELACE" },
      ]);
    });

    it("falls back to the key when the announced name is not one", async () => {
      attach();
      const event = await createEvent(await adminCookie());

      // Whitespace, empty, and over the guest-name limit. A name silently
      // shortened would put a stranger's spelling in the list, so the key —
      // which is load-bearing and already normalized — is shown instead.
      for (const name of ["   ", "", "\t\n", "L".repeat(101)]) {
        const watcher = await session(event.slug, "ada-lovelace", { name });
        expect((await watcher.takePresence(1))[0]).toEqual([
          { key: "ada-lovelace", displayName: "ada-lovelace" },
        ]);
        watcher.socket.close();
        await until(() => sessionKeys(event.id).length === 0, "the session to close");
      }

      // Right up to the limit is a name, and it is trimmed on the way in.
      const long = "L".repeat(100);
      const watcher = await session(event.slug, "ada-lovelace", { name: `  ${long}  ` });
      expect(names((await watcher.takePresence(1))[0])).toEqual([long]);
    });

    it("takes somebody off the list when their session goes", async () => {
      attach();
      const event = await createEvent(await adminCookie());
      const alice = await session(event.slug, "alice", { name: "Alice" });
      const bob = await session(event.slug, "bob", { name: "Bob" });
      await alice.takePresence(2);

      bob.socket.close();

      expect(names((await alice.takePresence(3))[2])).toEqual(["Alice"]);
      expect(keysOf(presencePeople(event.id))).toEqual(["alice"]);
    });

    it("sends a browsing page the list without putting it on one", async () => {
      attach();
      const event = await createEvent(await adminCookie());
      const alice = await session(event.slug, "alice", { name: "Alice" });
      await alice.takePresence(1);

      // The browse socket claims nothing: this page is reading, not answering.
      const browsing = await subscribe(event.slug);

      expect(names((await browsing.takePresence(1))[0])).toEqual(["Alice"]);
      expect(keysOf(presencePeople(event.id))).toEqual(["alice"]);
      // And nobody was told anything, because nothing changed.
      expect(alice.presence).toHaveLength(1);

      browsing.socket.close();
      await until(() => clientCount(event.id) === 1, "the browsing page to go");
      expect(alice.presence).toHaveLength(1);
    });

    it("keeps the room's own list out of what a client can set", async () => {
      attach();
      const event = await createEvent(await adminCookie());
      const alice = await session(event.slug, "alice", { name: "Alice" });
      const watcher = await subscribe(event.slug);
      await watcher.takePresence(1);

      // A forged presence frame, in exactly the shape the server sends. On the
      // browse socket nothing reads it at all; on a write session it is not a
      // save and is dropped.
      const forged = JSON.stringify({
        type: "presence",
        people: [{ key: "mallory", displayName: "Mallory" }],
      });
      watcher.socket.send(forged);
      alice.socket.send(forged);
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(keysOf(presencePeople(event.id))).toEqual(["alice"]);
      expect(watcher.presence).toHaveLength(1);
      expect(alice.presence).toHaveLength(1);
      expect(watcher.socket.readyState).toBe(WebSocket.OPEN);
      expect(alice.socket.readyState).toBe(WebSocket.OPEN);
    });

    it("drops somebody whose socket the heartbeat reaped", async () => {
      attach(30);
      const event = await createEvent(await adminCookie());
      const alice = await session(event.slug, "alice", { name: "Alice" });

      // A client that has stopped answering — the case the heartbeat exists
      // for: a connection through a proxy that quietly went away looks exactly
      // like an idle one, and the name behind it must not linger on the list.
      const mute = new WsClient(
        `${wsBase}/${encodeURIComponent(event.slug)}/users/zoe?name=Zoe`,
      );
      mute.pong = (() => {}) as typeof mute.pong;
      await new Promise<void>((resolve, reject) => {
        mute.on("open", () => resolve());
        mute.on("error", reject);
      });
      await alice.takePresence(2);
      expect(names(alice.people())).toEqual(["Alice", "Zoe"]);

      // One round pings it, the next terminates it, and the close it triggers
      // is the same exit any other departure takes.
      expect(names((await alice.takePresence(3))[2])).toEqual(["Alice"]);
      expect(keysOf(presencePeople(event.id))).toEqual(["alice"]);
      expect(clientCount(event.id)).toBe(1);
      mute.terminate();
    });

    it("has nobody at all when the event's live updates are off", async () => {
      attach();
      const event = await createEvent(await adminCookie(), { realtime: false });

      await expect(session(event.slug, "alice", { name: "Alice" })).rejects.toThrow(
        "upgrade refused",
      );

      // No socket means no room, and no room means no presence to leak.
      expect(presencePeople(event.id)).toEqual([]);
      expect(roomCount()).toBe(0);
    });

    it("has nobody at all when realtime is off server-wide", async () => {
      // No attach(): the kill switch is the absence of the listener.
      const event = await createEvent(await adminCookie());

      await expect(session(event.slug, "alice", { name: "Alice" })).rejects.toThrow(
        "upgrade refused",
      );

      expect(presencePeople(event.id)).toEqual([]);
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
    await put(event.id, "erin", "Erin");
    expect((await watcher.take(1))[0].type).toBe("event");
  });

  // -------------------------------------------------------------------------
  // last-edit tracking
  // -------------------------------------------------------------------------

  /**
   * A save over a write session is a write like any other, so it records where
   * it came from like any other — from what the *handshake* saw, since by the
   * time a frame arrives there is no request left to read.
   *
   * And the snapshot that follows it is a public copy: a browse socket is open
   * to anyone holding the link, so the field the login wall exists for may not
   * ride out on one.
   */
  describe("last-edit tracking", () => {
    /** A write session opened with a user agent of its own to be remembered by. */
    function sessionWithAgent(idOrSlug: string, key: string, userAgent: string) {
      const socket = new WsClient(
        `${wsBase}/${encodeURIComponent(idOrSlug)}/users/${encodeURIComponent(key)}?name=${key}`,
        { headers: { "user-agent": userAgent } },
      );
      return new Promise<WsClient>((resolve, reject) => {
        socket.on("open", () => resolve(socket));
        socket.on("error", reject);
      });
    }

    it("records the upgrade's own origin against a save frame", async () => {
      attach();
      const event = await createEvent(await adminCookie());
      const socket = await sessionWithAgent(event.slug, "alice", "SocketAgent/9.9");
      // The ack, not a poll: `saved` is sent after the write has been persisted.
      const acked = new Promise<void>((resolve) => {
        socket.on("message", (data) => {
          if ((JSON.parse(String(data)) as { type: string }).type === "saved") resolve();
        });
      });

      socket.send(
        JSON.stringify({ type: "save", displayName: "alice", availability: SLOTS, ifNeeded: [] }),
      );
      await acked;

      const stored = (await readEvent(event.id))?.responses.alice;
      expect(stored?.lastEdit?.userAgent).toBe("SocketAgent/9.9");
      expect(stored?.lastEdit?.ip).toMatch(/127\.0\.0\.1|::1|::ffff:127\.0\.0\.1/);
      expect(stored?.lastEdit?.at).toBe(stored?.updatedAt);
      socket.close();
    });

    it("strips the origin from the snapshot the room is sent", async () => {
      attach();
      const event = await createEvent(await adminCookie());
      // A browse socket: read-only, carries no identity, and open to anybody
      // with the link. Exactly who must not see this.
      const watcher = await subscribe(event.slug);

      expect((await put(event.id, "alice", "Alice")).status).toBe(200);

      const [message] = await watcher.take(1);
      if (message.type !== "event") throw new Error("expected a snapshot");
      expect(message.event.responses.alice.availability).toEqual(SLOTS);
      expect(message.event.responses.alice).not.toHaveProperty("lastEdit");
      expect(JSON.stringify(message)).not.toContain("lastEdit");
      // Still on disk: the strip is at the door, not at the write.
      expect((await readEvent(event.id))?.responses.alice.lastEdit).toBeDefined();
    });
  });
});
