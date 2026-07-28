/**
 * Optional per-event realtime: a read-only push channel over WebSocket.
 *
 * A page holding an event open connects to `GET /api/events/:idOrSlug/ws` and
 * joins that event's room. Every successful mutation in `routes/events.ts`
 * broadcasts a **full hydrated snapshot** to the room, so a second browser sees
 * an answer land without reloading. Deletion broadcasts `{ type: "gone" }`.
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
 * adds no write capability and no new authentication surface.
 *
 * **It is optional.** With realtime off no upgrade listener is registered at
 * all, and Node's default handling closes any upgrade attempt. Everything the
 * app does still works: the page falls back to the behaviour it had before this
 * file existed — REST for every read and every write, with zero feature loss.
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

/** `/api/events/:idOrSlug/ws`, and nothing else. */
const WS_PATH = /^\/api\/events\/([^/?#]+)\/ws$/;

// ---------------------------------------------------------------------------
// the room registry
// ---------------------------------------------------------------------------

/**
 * Rooms are keyed by the event's **uuid**, never its slug: a rename moves the
 * slug and must not orphan the subscribers who joined under the old one.
 */
const rooms = new Map<string, Set<WebSocket>>();

/** Sockets that have answered the most recent heartbeat ping. */
const alive = new WeakSet<WebSocket>();

function join(eventId: string, socket: WebSocket): void {
  let room = rooms.get(eventId);
  if (!room) {
    room = new Set();
    rooms.set(eventId, room);
  }
  room.add(socket);
}

/** Removes a socket, and the room with it once the last member leaves. */
function leave(eventId: string, socket: WebSocket): void {
  const room = rooms.get(eventId);
  if (!room) return;
  room.delete(socket);
  if (room.size === 0) rooms.delete(eventId);
}

function send(eventId: string, message: RealtimeMessage): void {
  const room = rooms.get(eventId);
  if (!room || room.size === 0) return;
  // Serialised once for the whole room: the snapshot is the largest thing this
  // server sends, and a busy event has every subscriber getting the same bytes.
  const payload = JSON.stringify(message);
  for (const socket of room) {
    if (socket.readyState !== socket.OPEN) continue;
    socket.send(payload);
  }
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
  send(event.id, { type: "event", event: event as EventDoc });
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
  for (const socket of room) socket.close(1000, "Event deleted");
}

/** Test hook: how many events currently have subscribers. */
export function roomCount(): number {
  return rooms.size;
}

/** Test hook: how many sockets are watching one event. */
export function clientCount(eventId: string): number {
  return rooms.get(eventId)?.size ?? 0;
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
    void accept(req, socket, head, decodeParam(match[1]));
  }

  async function accept(
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    idOrSlug: string | null,
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

    wss.handleUpgrade(req, socket, head, (ws) => {
      subscribe(ws, event.id);
    });
  }

  function subscribe(ws: WebSocket, eventId: string): void {
    join(eventId, ws);
    alive.add(ws);

    // No `message` listener, deliberately and permanently: this socket is a
    // read-only channel and a client's bytes must never reach any state. See
    // the module header — every write goes through the REST API.
    ws.on("pong", () => {
      alive.add(ws);
    });
    ws.on("close", () => {
      alive.delete(ws);
      leave(eventId, ws);
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
      for (const ws of room) {
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
      for (const room of rooms.values()) for (const ws of room) ws.terminate();
      rooms.clear();
      return new Promise<void>((resolve) => wss.close(() => resolve()));
    },
  };
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
