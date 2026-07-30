/**
 * Optional per-event realtime: two sockets, one room.
 *
 * A page holding an event open joins that event's room over one of two
 * upgrades, and every successful mutation broadcasts a **full hydrated
 * snapshot** to the room, so a second browser sees an answer land without
 * reloading. Deletion broadcasts `{ type: "gone" }`.
 *
 * **`GET /<slug>/ws` — the browse socket.** Read-only in the strictest sense
 * available: no `message` listener is ever registered on it, so no byte a
 * client sends reaches any state. Inbound data frames are read off the wire by
 * the protocol layer and dropped on the floor. It carries no identity, claims
 * nothing, and appears in no presence list. This invariant is not weakened by
 * anything below — the write path lives on a *different* socket, with a
 * different URL, that the server admits deliberately and one at a time.
 *
 * **`GET /<slug>/users/<userKey>` — the named write session.** This socket *is*
 * the edit session for that key. It accepts exactly one kind of frame,
 * `{ type: "save", displayName, availability, ifNeeded }`, and runs it through
 * `writeResponse` — the same function, not a copy of it, that the REST `PUT`
 * runs. Anything else inbound is ignored without closing the connection. The
 * key is also the room's presence identity, and the display name that rides in
 * the query is what a list renders beside it.
 *
 * **One session per key.** A second upgrade for a key that is already held is
 * accepted and then closed with `4409`; with `?takeover=1` the *incumbent* is
 * sent `{ type: "replaced" }`, closed with `4410`, and the newcomer takes its
 * place. There is no automatic reclaim. Exclusivity is a property of sessions,
 * so with realtime switched off — at either level — there are no sessions and
 * it is not enforced: the REST `PUT` is the write path, exactly as before.
 *
 * **It is optional, at two levels.** Each event carries a `realtime` flag the
 * owner sets in the edit dialog — absent means on, so no existing event file
 * has to be rewritten — and an event with it off is refused at the upgrade and
 * never broadcast to. Above that sits a server-wide kill switch
 * (`TIMEFUL_REALTIME`, config key `realtime`): with it off no upgrade listener
 * is registered at all and Node's default handling closes any upgrade attempt,
 * whatever the individual events say. Either way everything the app does still
 * works — the page falls back to the behaviour it had before this file
 * existed, REST for every read and every write, with zero feature loss.
 *
 * **The capability URL is still the whole of the auth boundary.** Subscribing
 * requires resolving the event's uuid or slug, exactly as `GET` does, and an
 * upgrade that fails to resolve goes through the *same* per-IP miss tarpit as
 * an HTTP miss (`missTarpit`, not a second copy of it) so neither socket is any
 * cheaper to scan than the endpoint beside it. Nothing here can enumerate
 * events, and no slug is ever logged.
 */
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
// Runtime imports from `src/lib`, and deliberate exceptions to the type-only
// rule in `server/types.ts`: "absent means on", what a client frame looks like,
// and what a user key is are each a definition both halves must share exactly.
import { publicEvent, realtimeAllowed } from "../src/lib/event.ts";
import {
  CLOSE_OCCUPIED,
  CLOSE_REPLACED,
  parseSaveMessage,
} from "../src/lib/realtime.ts";
import { userKeyFromParam } from "../src/lib/user-key.ts";
import { statusOf } from "./http.ts";
import { missTarpit } from "./tarpit.ts";
import type {
  EditOrigin,
  EventDoc,
  PresenceEntry,
  RealtimeMessage,
  ResponseInput,
  ResponseWrite,
  StoredEvent,
} from "./types.ts";

/** How often the server pings an idle socket. */
export const HEARTBEAT_MS = 30_000;

/**
 * Largest frame accepted from a client before the connection is closed.
 *
 * A browse socket never reads a byte of it, so for that socket this is not a
 * protocol limit — only how much of a hostile frame is buffered before hanging
 * up. A write session does read its frames, and a save carrying two arrays of
 * up to 20000 ISO timestamps is far bigger than a kilobyte, so the cap is the
 * body limit the REST route already accepts: 2 MB, and no more generous.
 */
export const MAX_CLIENT_PAYLOAD = 2 * 1024 * 1024;

/** `/<slug>/ws`, with an optional query, and nothing else. */
const BROWSE_PATH = /^\/([^/?#]+)\/ws(?:\?([^#]*))?$/;

/** `/<slug>/users/<userKey>`, with an optional query, and nothing else. */
const SESSION_PATH = /^\/([^/?#]+)\/users\/([^/?#]+)(?:\?([^#]*))?$/;

/**
 * Longest display name accepted from the upgrade URL, matching the guest-name
 * limit the response routes enforce. Anything longer falls back to the key
 * rather than being truncated: a name silently shortened would put a stranger's
 * spelling in the list.
 */
const MAX_NAME_LENGTH = 100;

// ---------------------------------------------------------------------------
// the room registry
// ---------------------------------------------------------------------------

interface Room {
  sockets: Set<WebSocket>;
  /**
   * Who holds a write session here, by key, and the socket that holds it.
   *
   * A map rather than a multiset, which is the whole of the exclusivity rule:
   * one live session per (event, key), and the entry *is* the claim. A browse
   * socket is in `sockets` and never in here.
   */
  sessions: Map<string, WebSocket>;
  /** The spelling to render for a key, as its session announced it. */
  displayNames: Map<string, string>;
}

/**
 * Rooms are keyed by the event's **uuid**, never its slug: a rename moves the
 * slug and must not orphan the subscribers who joined under the old one.
 */
const rooms = new Map<string, Room>();

/** Sockets that have answered the most recent heartbeat ping. */
const alive = new WeakSet<WebSocket>();

/** The key a socket holds the session for, for the sockets that hold one. */
const claimed = new WeakMap<WebSocket, string>();

function roomFor(eventId: string): Room {
  let room = rooms.get(eventId);
  if (!room) {
    room = { sockets: new Set(), sessions: new Map(), displayNames: new Map() };
    rooms.set(eventId, room);
  }
  return room;
}

/** Adds a socket to a room. True when that changed who is present. */
function join(
  eventId: string,
  socket: WebSocket,
  session: { key: string; displayName: string } | null,
): boolean {
  const room = roomFor(eventId);
  room.sockets.add(socket);
  if (session === null) return false;
  claimed.set(socket, session.key);
  room.sessions.set(session.key, socket);
  room.displayNames.set(session.key, session.displayName);
  return true;
}

/**
 * Removes a socket, and the room with it once the last member leaves. True when
 * that took somebody off the presence list.
 */
function leave(eventId: string, socket: WebSocket): boolean {
  const room = rooms.get(eventId);
  if (!room) return false;
  room.sockets.delete(socket);
  const key = claimed.get(socket);
  claimed.delete(socket);
  let changed = false;
  if (key !== undefined && room.sessions.get(key) === socket) {
    // Only when this socket is still the holder: a session it lost to a
    // takeover belongs to somebody else now, and its close must not evict them.
    room.sessions.delete(key);
    room.displayNames.delete(key);
    changed = true;
  }
  if (room.sockets.size === 0) {
    rooms.delete(eventId);
    // Nobody is left to be told, so there is no change to announce.
    return false;
  }
  return changed;
}

/** Who a room currently holds, in the order a list would show them. */
export function presencePeople(eventId: string): PresenceEntry[] {
  const room = rooms.get(eventId);
  if (!room) return [];
  return [...room.sessions.keys()]
    .map((key) => ({ key, displayName: room.displayNames.get(key) ?? key }))
    .sort((a, b) => a.displayName.localeCompare(b.displayName) || a.key.localeCompare(b.key));
}

function send(eventId: string, message: RealtimeMessage): void {
  const room = rooms.get(eventId);
  if (!room || room.sockets.size === 0) return;
  // Serialised once for the whole room: the snapshot is the largest thing this
  // server sends, and a busy event has every subscriber getting the same bytes.
  const payload = JSON.stringify(message);
  for (const socket of room.sockets) {
    if (socket.readyState !== socket.OPEN) continue;
    socket.send(payload);
  }
}

function sendTo(socket: WebSocket, message: RealtimeMessage): void {
  if (socket.readyState !== socket.OPEN) return;
  socket.send(JSON.stringify(message));
}

/** Tells a room who is in it. Never called for a room that no longer exists. */
function broadcastPresence(eventId: string): void {
  send(eventId, { type: "presence", people: presencePeople(eventId) });
}

/**
 * Publishes the current state of an event to everyone watching it.
 *
 * Called after a mutation has been persisted, never before: subscribers must
 * not be told about a write that could still fail. The whole document goes out
 * — the same bytes `GET /<slug>/data` would return — so the client has one code
 * path for "the event changed" rather than one per kind of change.
 */
export function broadcastEvent(event: StoredEvent): void {
  // An event with live updates switched off has no room to talk to — the
  // check is here rather than at each of the call sites so there is no way to
  // add another that forgets it.
  if (!realtimeAllowed(event)) return;
  // "The same bytes `GET /<slug>/data` would return" includes what that route
  // leaves out: a snapshot is a public copy of the document, and a broadcast
  // reaches every browse socket on the event.
  send(event.id, { type: "event", event: publicEvent(event) as EventDoc });
}

/**
 * Turns an event's room off without saying the event is gone.
 *
 * This is what a `realtime: false` rename means: the event is still there and
 * still answerable over REST, so `gone` would be a lie. The subscribers are
 * simply hung up on; they will try to reconnect, be refused, and give up.
 */
export function closeRoom(eventId: string): void {
  const room = rooms.get(eventId);
  if (!room) return;
  rooms.delete(eventId);
  for (const socket of room.sockets) socket.close(1000, "Live updates disabled");
}

/**
 * Tells an event's subscribers it no longer exists, then closes the room.
 *
 * Terminal in both directions: the client stops reconnecting on `gone`, and
 * there is nothing left here for a reconnect to resolve anyway.
 */
export function broadcastGone(eventId: string): void {
  send(eventId, { type: "gone" });
  const room = rooms.get(eventId);
  if (!room) return;
  rooms.delete(eventId);
  for (const socket of room.sockets) socket.close(1000, "Event deleted");
}

/** Test hook: how many events currently have subscribers. */
export function roomCount(): number {
  return rooms.size;
}

/** Test hook: how many sockets are watching one event. */
export function clientCount(eventId: string): number {
  return rooms.get(eventId)?.sockets.size ?? 0;
}

/** Test hook: which keys currently hold a write session on one event. */
export function sessionKeys(eventId: string): string[] {
  return [...(rooms.get(eventId)?.sessions.keys() ?? [])].sort();
}

// ---------------------------------------------------------------------------
// the upgrade listener
// ---------------------------------------------------------------------------

export interface RealtimeOptions {
  /**
   * Resolves a uuid-or-slug to an event, or null. Injected rather than imported
   * so this module stays underneath the route layer — the same lookup the
   * public `GET` uses, not a second copy of it.
   */
  resolveEvent: (idOrSlug: string) => Promise<StoredEvent | null>;
  /**
   * Applies one guest's answer, validating it exactly as the REST `PUT` does —
   * because it *is* what the REST `PUT` calls. Injected for the same reason as
   * `resolveEvent`: one validator, one write path, no second copy to drift.
   */
  writeResponse: (
    eventId: string,
    key: string,
    input: ResponseInput,
    origin: EditOrigin | null,
  ) => Promise<ResponseWrite>;
  /**
   * The address to record against a save made over this connection.
   *
   * Injected because resolving a forwarded chain is Express's job and an
   * upgrade never reaches Express: `serve()` hands down a resolver built from
   * the app's own `trust proxy` setting, and without one this falls back to
   * the peer address, which is what the tarpit uses.
   *
   * Note that this is deliberately *not* what the tarpit counts by. A miss
   * queue wants the address nobody can spoof; a log of where an answer was
   * edited from wants the address a reverse proxy is forwarding, or every
   * entry behind nginx reads `127.0.0.1`.
   */
  clientIp?: (req: IncomingMessage) => string;
  /** Ping interval. Defaults to `HEARTBEAT_MS`; tests wind it on. */
  heartbeatMs?: number;
}

export interface RealtimeServer {
  /** Stops the heartbeat and closes every open socket. */
  close(): Promise<void>;
}

/**
 * The client address for tarpit accounting.
 *
 * An upgrade never reaches Express, so there is no `req.ip` and no
 * trust-proxy evaluation to lean on: this is the peer on the other end of the
 * socket, full stop. Behind a reverse proxy that groups every client under the
 * proxy's address — which costs a shared 100ms queue on *misses only*, and
 * never slows a subscriber who named a real event. Unspoofable in exchange,
 * which for a scan counter is the better half of the trade.
 */
function peerAddress(req: IncomingMessage): string {
  return req.socket.remoteAddress || "unknown";
}

/** What an upgrade URL turned out to be asking for. */
interface Upgrade {
  idOrSlug: string;
  /** Null for the browse socket. */
  key: string | null;
  displayName: string;
  takeover: boolean;
}

/**
 * Registers the upgrade listener on a running HTTP server.
 *
 * Call it only when realtime is enabled: when it is off, nothing is registered
 * and Node's own default (no `upgrade` listener means close the socket) is what
 * answers, which is exactly the behaviour wanted.
 */
export function attachRealtime(server: Server, options: RealtimeOptions): RealtimeServer {
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_CLIENT_PAYLOAD,
    // permessage-deflate stays off (ws's default): compression on attacker-
    // controlled frames buys nothing here and costs memory per connection.
  });

  server.on("upgrade", handleUpgrade);

  function handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const target = parseUpgrade(req.url ?? "");
    if (!target) {
      // Not ours. Claiming it would break anything else that shares this
      // server — Vite's HMR socket attaches to the HTTP server whenever it is
      // not running one of its own — so only close it when there is provably
      // nobody else who could answer.
      if (server.listenerCount("upgrade") === 1) socket.destroy();
      return;
    }
    void accept(req, socket, head, target);
  }

  async function accept(
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    target: Upgrade,
  ): Promise<void> {
    const event = await options.resolveEvent(target.idOrSlug);
    if (!event) {
      // The same queue an HTTP miss joins, so subscribing is no cheaper to scan
      // than fetching. Over the per-IP cap, `enter` refuses without spending
      // the delay and the socket goes immediately.
      await missTarpit.enter(peerAddress(req));
      if (!socket.destroyed) socket.destroy();
      return;
    }
    // The client may have given up while the lookup or the delay ran.
    if (socket.destroyed) return;

    // Live updates are off for this event. Refused with a plain 403 and *no*
    // tarpit delay: whoever asked has already proved they hold the capability
    // URL by naming an event that resolved, so this is not a scan and queueing
    // it would only punish a page that is behaving. The browser cannot read
    // the status — a failed upgrade is just a close to `WebSocket` — so the
    // client gives up after a few refusals rather than on the code.
    if (!realtimeAllowed(event)) {
      socket.end(
        "HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
      );
      return;
    }

    // Read here and carried for the life of the connection. A `save` frame
    // arriving twenty minutes later has no request behind it — there is no
    // header to read and no socket lookup that would say anything the
    // handshake did not already say — so where the session came from is
    // decided once, when it was opened.
    const origin: EditOrigin = {
      ip: options.clientIp?.(req) || peerAddress(req),
      userAgent: headerValue(req, "user-agent"),
    };

    wss.handleUpgrade(req, socket, head, (ws) => {
      subscribe(ws, event.id, target, origin);
    });
  }

  function subscribe(
    ws: WebSocket,
    eventId: string,
    target: Upgrade,
    origin: EditOrigin,
  ): void {
    alive.add(ws);
    ws.on("pong", () => {
      alive.add(ws);
    });
    ws.on("error", () => {
      // A socket that errors also closes; the room cleanup lives there. This
      // handler exists so the error is not re-thrown as an uncaught exception.
      alive.delete(ws);
    });

    if (target.key === null) {
      // The browse socket. No `message` listener, deliberately and permanently:
      // this one is a read-only channel and a client's bytes must never reach
      // any state. See the module header.
      joinAndWatch(ws, eventId, null);
      return;
    }

    const room = rooms.get(eventId);
    const incumbent = room?.sessions.get(target.key);
    if (incumbent && incumbent.readyState === incumbent.OPEN) {
      if (!target.takeover) {
        // Occupied, and nobody asked to evict anyone. The handshake has already
        // completed, which is the point: a close code is readable by the
        // browser where an HTTP status on a refused upgrade is not. The socket
        // never joins the room, so nothing about the incumbent changes.
        ws.close(CLOSE_OCCUPIED, "occupied");
        return;
      }
      // A takeover the page asked for after being told the key was busy. The
      // incumbent is told in words before it is hung up on, so its own page can
      // say what happened rather than showing a dropped connection.
      sendTo(incumbent, { type: "replaced" });
      // Dropped from the map first: the incumbent's `close` handler then sees a
      // session it no longer holds and leaves the newcomer's claim alone.
      room?.sessions.delete(target.key);
      incumbent.close(CLOSE_REPLACED, "replaced");
    }

    joinAndWatch(ws, eventId, { key: target.key, displayName: target.displayName });

    // The one inbound path in this file, and the only one there will be: a
    // save, validated by the REST route's own validator.
    ws.on("message", (data) => {
      void onSave(ws, eventId, target.key as string, data, origin);
    });
  }

  function joinAndWatch(
    ws: WebSocket,
    eventId: string,
    session: { key: string; displayName: string } | null,
  ): void {
    const changed = join(eventId, ws, session);

    // Whoever just arrived is told who is here, straight away — a list that
    // only fills in when the next person moves would be a list you cannot
    // trust. When their own claim is new to the room that is the same message
    // everybody else needs, so it goes to the room and they read it there
    // rather than getting a second copy of it.
    if (changed) broadcastPresence(eventId);
    else sendTo(ws, { type: "presence", people: presencePeople(eventId) });

    ws.on("close", () => {
      alive.delete(ws);
      // Covers being reaped by the heartbeat as well: `terminate()` closes the
      // socket, so there is one path out of a room however the exit was
      // decided.
      if (leave(eventId, ws)) broadcastPresence(eventId);
    });
  }

  async function onSave(
    ws: WebSocket,
    eventId: string,
    key: string,
    data: unknown,
    origin: EditOrigin,
  ): Promise<void> {
    // A frame that is not a save is dropped in silence. Closing on it would
    // punish a client from a future version of this app for speaking a word
    // this one has not learned yet, and there is nothing to gain by it.
    const message = parseSaveMessage(frameText(data));
    if (!message) return;
    // The claim can have been taken over between the frame being sent and it
    // being read. The session is no longer this socket's to write through.
    if (rooms.get(eventId)?.sessions.get(key) !== ws) return;

    try {
      const { ok, event, changed } = await options.writeResponse(
        eventId,
        key,
        message,
        origin,
      );
      if (!ok) {
        sendTo(ws, { type: "save-failed", message: "Event not found" });
        return;
      }
      sendTo(ws, { type: "saved" });
      // A clear that cleared nothing changed nothing, and a room should only
      // ever be woken for something that actually happened.
      if (changed && event) broadcastEvent(event);
    } catch (err) {
      // The same message the REST PUT would have answered with, because it is
      // the same validator that produced it. A 5xx says nothing useful to a
      // guest, so it does not travel.
      const status = statusOf(err) ?? 500;
      const detail = err instanceof Error ? err.message : "";
      sendTo(ws, {
        type: "save-failed",
        message: status >= 500 || !detail ? "Could not save your availability" : detail,
      });
    }
  }

  // A connection through a proxy that has stopped forwarding looks exactly like
  // an idle one, so the server asks: ping every round, terminate anything that
  // did not answer the previous one. Unref'd — a heartbeat is not a reason for
  // the process to stay alive.
  const heartbeat = setInterval(() => {
    for (const room of rooms.values()) {
      for (const ws of room.sockets) {
        if (!alive.has(ws)) {
          ws.terminate();
          continue;
        }
        alive.delete(ws);
        ws.ping();
      }
    }
  }, options.heartbeatMs ?? HEARTBEAT_MS);
  heartbeat.unref?.();

  return {
    close(): Promise<void> {
      clearInterval(heartbeat);
      server.off("upgrade", handleUpgrade);
      for (const room of rooms.values()) for (const ws of room.sockets) ws.terminate();
      rooms.clear();
      return new Promise<void>((resolve) => wss.close(() => resolve()));
    },
  };
}

/** One request header as a plain string, however Node handed it over. */
function headerValue(req: IncomingMessage, name: string): string {
  const raw = req.headers[name];
  if (Array.isArray(raw)) return raw[0] ?? "";
  return raw ?? "";
}

/** A `ws` message payload as text, whatever shape it arrived in. */
function frameText(data: unknown): string | null {
  if (typeof data === "string") return data;
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (Array.isArray(data) && data.every((part) => Buffer.isBuffer(part)))
    return Buffer.concat(data as Buffer[]).toString("utf8");
  return null;
}

/**
 * What an upgrade URL is asking for, or null when it is not ours.
 *
 * Two shapes and no others: `/<slug>/ws` is the browse socket, and
 * `/<slug>/users/<userKey>` is the write session for that key. The key is
 * re-normalized out of the path exactly as the REST route re-normalizes it, so
 * one person cannot hold two sessions by spelling their own key two ways.
 */
function parseUpgrade(url: string): Upgrade | null {
  const browse = BROWSE_PATH.exec(url);
  if (browse) {
    const idOrSlug = decodeParam(browse[1]);
    if (idOrSlug === null) return null;
    return { idOrSlug, key: null, displayName: "", takeover: false };
  }

  const named = SESSION_PATH.exec(url);
  if (!named) return null;
  const idOrSlug = decodeParam(named[1]);
  const rawKey = decodeParam(named[2]);
  if (idOrSlug === null || rawKey === null) return null;
  const key = userKeyFromParam(rawKey);
  if (key === null) return null;
  const query = parseQuery(named[3]);
  return {
    idOrSlug,
    key,
    displayName: assertedName(query) ?? key,
    takeover: query?.get("takeover") === "1",
  };
}

function parseQuery(query: string | undefined): URLSearchParams | null {
  if (query === undefined || query === "") return null;
  try {
    return new URLSearchParams(query);
  } catch {
    return null;
  }
}

/**
 * The spelling this connection wants shown for its key, or null.
 *
 * Self-asserted, and nothing rests on it being true: it decides which letters
 * appear beside a pair of dots, and anyone holding the capability URL could
 * already write a response under any name they liked (§ Security — the URL is
 * the trust boundary). So it is validated for shape only — trimmed, and dropped
 * if it is empty or longer than a name may be — and never for identity. The key
 * in the path, which *is* load-bearing, is normalized separately and is not
 * taken from here.
 */
function assertedName(query: URLSearchParams | null): string | null {
  const raw = query?.get("name");
  if (raw === null || raw === undefined) return null;
  const name = raw.trim();
  if (name === "" || name.length > MAX_NAME_LENGTH) return null;
  return name;
}

/** A path segment, or null when its percent-encoding is malformed. */
function decodeParam(raw: string | undefined): string | null {
  if (raw === undefined || raw === "") return null;
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}
