/**
 * Optional per-event realtime: a read-only push channel over WebSocket.
 *
 * A page holding an event open connects to `GET /api/events/:idOrSlug/ws` and
 * joins that event's room. Every successful mutation in `routes/events.ts`
 * broadcasts a **full hydrated snapshot** to the room, so a second browser sees
 * an answer land without reloading. Deletion broadcasts `{ type: "gone" }`.
 *
 * The room also knows who is in it. A page that has adopted a name says so in
 * the upgrade URL (`?name=…`), and any change to the set of names in a room —
 * somebody arrived, somebody's last tab closed, a socket was reaped by the
 * heartbeat — broadcasts `{ type: "presence", names }` to it. The names are
 * connection metadata, held only for as long as the connection is: presence is
 * never written to disk and there is nothing to clean up after a restart.
 *
 * Three properties are worth stating plainly, because everything here is built
 * to hold them.
 *
 * **The socket is read-only.** It is a server→client notification channel and
 * nothing else. No `message` listener is ever registered on an accepted socket,
 * so no byte a client sends reaches any state: inbound data frames are read off
 * the wire by the protocol layer and dropped on the floor. The only inbound
 * traffic that means anything is protocol-level — pong frames answering the
 * heartbeat, and close. The REST API remains the sole write path; this module
 * adds no write capability and no new authentication surface. Presence does not
 * bend that: a name arrives once, in the handshake the connection is made of,
 * and no frame sent afterwards can change it or anything else.
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
 * an HTTP miss (`missTarpit`, not a second copy of it) so the socket is no
 * cheaper to scan than the endpoint beside it. Nothing here can enumerate
 * events, and no slug is ever logged.
 */
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
// The one runtime import the server takes from `src/lib`, and a deliberate
// exception to the type-only rule in `server/types.ts`: "absent means on" is a
// default that must have exactly one definition, and this is it.
import { realtimeAllowed } from "../src/lib/event.ts";
import { missTarpit } from "./tarpit.ts";
import type { EventDoc, RealtimeMessage, StoredEvent } from "./types.ts";

/** How often the server pings an idle socket. */
export const HEARTBEAT_MS = 30_000;

/**
 * Largest frame accepted from a client before the connection is closed.
 *
 * Nothing a client sends is ever read, so this is not a protocol limit — it is
 * simply how much of a hostile frame we are willing to buffer before hanging
 * up. A kilobyte is more than the zero bytes a well-behaved client sends.
 */
export const MAX_CLIENT_PAYLOAD = 1024;

/** `/api/events/:idOrSlug/ws`, with an optional query, and nothing else. */
const WS_PATH = /^\/api\/events\/([^/?#]+)\/ws(?:\?([^#]*))?$/;

/**
 * Longest name accepted from the upgrade URL, matching the guest-name limit the
 * response routes enforce. Anything longer is treated as absent rather than
 * truncated: a name that does not match a respondent is no use to anybody, and
 * silently shortening one would put a stranger's row in the list.
 */
const MAX_NAME_LENGTH = 100;

// ---------------------------------------------------------------------------
// the room registry
// ---------------------------------------------------------------------------

interface Room {
  sockets: Set<WebSocket>;
  /**
   * Who is here, and how many connections say so.
   *
   * A multiset rather than a set because one person is routinely several
   * sockets — two tabs, a phone beside a laptop, a reconnect that overlaps the
   * drop it is replacing — and one of them closing must not take the name off
   * everyone else's list while the others are still open.
   */
  names: Map<string, number>;
}

/**
 * Rooms are keyed by the event's **uuid**, never its slug: a rename moves the
 * slug and must not orphan the subscribers who joined under the old one.
 */
const rooms = new Map<string, Room>();

/** Sockets that have answered the most recent heartbeat ping. */
const alive = new WeakSet<WebSocket>();

/** The name a socket asserted at the handshake, for the one that gave one. */
const asserted = new WeakMap<WebSocket, string>();

/** True when the room's set of names changed, i.e. somebody should be told. */
function join(eventId: string, socket: WebSocket, name: string | null): boolean {
  let room = rooms.get(eventId);
  if (!room) {
    room = { sockets: new Set(), names: new Map() };
    rooms.set(eventId, room);
  }
  room.sockets.add(socket);
  if (name === null) return false;
  asserted.set(socket, name);
  const count = room.names.get(name) ?? 0;
  room.names.set(name, count + 1);
  // A second tab under a name already in the list changes nothing anyone can
  // see, so it is not a presence change.
  return count === 0;
}

/**
 * Removes a socket, and the room with it once the last member leaves. True when
 * that took a name off the list.
 */
function leave(eventId: string, socket: WebSocket): boolean {
  const room = rooms.get(eventId);
  if (!room) return false;
  room.sockets.delete(socket);
  const name = asserted.get(socket);
  asserted.delete(socket);
  let changed = false;
  if (name !== undefined) {
    const count = (room.names.get(name) ?? 0) - 1;
    if (count > 0) room.names.set(name, count);
    else {
      changed = room.names.delete(name);
    }
  }
  if (room.sockets.size === 0) {
    rooms.delete(eventId);
    // Nobody is left to be told, so there is no change to announce.
    return false;
  }
  return changed;
}

/** Who a room currently holds, in the order a list would show them. */
export function presenceNames(eventId: string): string[] {
  const room = rooms.get(eventId);
  if (!room) return [];
  return [...room.names.keys()].sort((a, b) => a.localeCompare(b));
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
  send(eventId, { type: "presence", names: presenceNames(eventId) });
}

/**
 * Publishes the current state of an event to everyone watching it.
 *
 * Called after a mutation has been persisted, never before: subscribers must
 * not be told about a write that could still fail. The whole document goes out
 * — the same bytes `GET /api/events/:idOrSlug` would return — so the client has
 * one code path for "the event changed" rather than one per kind of change.
 */
export function broadcastEvent(event: StoredEvent): void {
  // An event with live updates switched off has no room to talk to — the
  // check is here rather than at each of the four call sites so there is no
  // way to add a fifth that forgets it.
  if (!realtimeAllowed(event)) return;
  send(event.id, { type: "event", event: event as EventDoc });
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
    const match = WS_PATH.exec(req.url ?? "");
    if (!match) {
      // Not ours. Claiming it would break anything else that shares this
      // server — Vite's HMR socket attaches to the HTTP server whenever it is
      // not running one of its own — so only close it when there is provably
      // nobody else who could answer.
      if (server.listenerCount("upgrade") === 1) socket.destroy();
      return;
    }
    void accept(req, socket, head, decodeParam(match[1]), assertedName(match[2]));
  }

  async function accept(
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    idOrSlug: string | null,
    name: string | null,
  ): Promise<void> {
    const event = idOrSlug === null ? null : await options.resolveEvent(idOrSlug);
    if (!event) {
      // The same queue an HTTP miss joins, so subscribing is no cheaper to scan
      // than fetching. Over the per-IP cap, `enter` refuses without spending
      // the delay and the socket goes immediately.
      const waited = await missTarpit.enter(peerAddress(req));
      if (!socket.destroyed) socket.destroy();
      void waited;
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

    wss.handleUpgrade(req, socket, head, (ws) => {
      subscribe(ws, event.id, name);
    });
  }

  function subscribe(ws: WebSocket, eventId: string, name: string | null): void {
    const changed = join(eventId, ws, name);
    alive.add(ws);

    // Whoever just arrived is told who is here, straight away — a list that
    // only fills in when the next person moves would be a list you cannot
    // trust. When their own name is new to the room that is the same message
    // everybody else needs, so it goes to the room and they read it there
    // rather than getting a second copy of it.
    if (changed) broadcastPresence(eventId);
    else sendTo(ws, { type: "presence", names: presenceNames(eventId) });

    // No `message` listener, deliberately and permanently: this socket is a
    // read-only channel and a client's bytes must never reach any state. See
    // the module header — every write goes through the REST API.
    ws.on("pong", () => {
      alive.add(ws);
    });
    ws.on("close", () => {
      alive.delete(ws);
      // Covers being reaped by the heartbeat as well: `terminate()` closes the
      // socket, so there is one path out of a room however the exit was
      // decided.
      if (leave(eventId, ws)) broadcastPresence(eventId);
    });
    ws.on("error", () => {
      // A socket that errors also closes; the room cleanup lives there. This
      // handler exists so the error is not re-thrown as an uncaught exception.
      alive.delete(ws);
    });
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

/**
 * The name this connection is claiming, or null for a page that is browsing.
 *
 * Self-asserted, and nothing rests on it being true: it decides which name gets
 * a pair of dots beside it in a list, and anyone holding the capability URL
 * could already write a response under any name they liked (§ Security — the URL
 * is the trust boundary). So it is validated for shape only — trimmed, and
 * dropped if it is empty or longer than a name may be — and never for identity.
 * A malformed query is simply a connection with no name.
 */
function assertedName(query: string | undefined): string | null {
  if (query === undefined || query === "") return null;
  let raw: string | null;
  try {
    raw = new URLSearchParams(query).get("name");
  } catch {
    return null;
  }
  if (raw === null) return null;
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
