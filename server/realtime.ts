/**
 * Per-event realtime rooms (ARCHITECTURE.md § Realtime). The browse socket is
 * read-only — no `message` listener, ever; writes ride the per-key session
 * socket through the REST PUT's own `writeResponse`. A failed slug resolution
 * joins the same miss tarpit as HTTP, and no slug is ever logged.
 */
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
// Runtime imports from `src/lib`: deliberate exceptions to the type-only rule in `server/types.ts`.
import { publicEvent, realtimeAllowed } from "../src/lib/event.ts";
import {
  CLOSE_OCCUPIED,
  CLOSE_REPLACED,
  parseSaveMessage,
} from "../src/lib/realtime.ts";
import { userKeyFromParam } from "../src/lib/user-key.ts";
import { statusOf } from "./http.ts";
import {
  eventLogEntries,
  globalLogEntries,
  logInfo,
  logWarn,
  redactIp,
  subscribeEventLog,
  subscribeGlobalLog,
} from "./log.ts";
import { missTarpit } from "./tarpit.ts";
import type {
  EditOrigin,
  EventDoc,
  LogStreamMessage,
  PresenceEntry,
  RealtimeMessage,
  ResponseInput,
  ResponseWrite,
  StoredEvent,
} from "./types.ts";

/** How often the server pings an idle socket. */
export const HEARTBEAT_MS = 30_000;

/** Largest client frame: the REST body limit, and no more generous. */
export const MAX_CLIENT_PAYLOAD = 2 * 1024 * 1024;

/** `/<slug>/ws`, with an optional query, and nothing else. */
const BROWSE_PATH = /^\/([^/?#]+)\/ws(?:\?([^#]*))?$/;

/** `/<slug>/users/<userKey>`, with an optional query, and nothing else. */
const SESSION_PATH = /^\/([^/?#]+)\/users\/([^/?#]+)(?:\?([^#]*))?$/;

/** `/<slug>/logs` — one event's admin log stream. */
const EVENT_LOGS_PATH = /^\/([^/?#]+)\/logs(?:\?[^#]*)?$/;

/** `/api/logs` — the global admin log stream. `/api` is global-only. */
const GLOBAL_LOGS_PATH = /^\/api\/logs(?:\?[^#]*)?$/;

/** Matches the guest-name limit; longer falls back to the key rather than truncating. */
const MAX_NAME_LENGTH = 100;

// ---------------------------------------------------------------------------
// the room registry
// ---------------------------------------------------------------------------

interface Room {
  sockets: Set<WebSocket>;
  /** One live session per (event, key); the entry *is* the claim. Browse sockets never appear. */
  sessions: Map<string, WebSocket>;
  /** The spelling to render for a key, as its session announced it. */
  displayNames: Map<string, string>;
}

/** Keyed by uuid, never slug: a rename must not orphan subscribers. */
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
    // Only when still the holder: a taken-over session belongs to someone else now.
    room.sessions.delete(key);
    room.displayNames.delete(key);
    changed = true;
  }
  if (room.sockets.size === 0) {
    rooms.delete(eventId);
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
  // Serialised once for the whole room.
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

/** Broadcasts the full public document; call only after the mutation has been persisted. */
export function broadcastEvent(event: StoredEvent): void {
  // Checked here rather than at each call site so none can forget it.
  if (!realtimeAllowed(event)) return;
  send(event.id, { type: "event", event: publicEvent(event) as EventDoc });
}

/** For `realtime: false` edits: the event still exists, so no `gone` — subscribers are just hung up on. */
export function closeRoom(eventId: string): void {
  const room = rooms.get(eventId);
  if (!room) return;
  rooms.delete(eventId);
  for (const socket of room.sockets) socket.close(1000, "Live updates disabled");
}

/** Terminal: the client stops reconnecting on `gone`. */
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
// the admin log streams
// ---------------------------------------------------------------------------

/** Admin log-viewer sockets: not rooms — replay then live entries, no reconnect contract. */
const logViewers = new Set<WebSocket>();

/** Test hook: how many log viewers are currently connected. */
export function logViewerCount(): number {
  return logViewers.size;
}

// ---------------------------------------------------------------------------
// the upgrade listener
// ---------------------------------------------------------------------------

export interface RealtimeOptions {
  /** Injected so this module stays under the route layer — the same lookup the public `GET` uses. */
  resolveEvent: (idOrSlug: string) => Promise<StoredEvent | null>;
  /** The REST `PUT`'s own validator and write path — injected, not copied. */
  writeResponse: (
    eventId: string,
    key: string,
    input: ResponseInput,
    origin: EditOrigin | null,
  ) => Promise<ResponseWrite>;
  /** Address recorded on saves — the forwarded one; the tarpit deliberately counts by peer address. */
  clientIp?: (req: IncomingMessage) => string;
  /** Ping interval. Defaults to `HEARTBEAT_MS`; tests wind it on. */
  heartbeatMs?: number;
  /** False serves only the admin log streams; event-channel upgrades are destroyed unresolved. */
  realtime?: boolean;
  /** Checked before the handshake completes; absent means the log streams are off entirely. */
  verifyAdmin?: (req: IncomingMessage) => Promise<boolean>;
}

export interface RealtimeServer {
  /** Stops the heartbeat and closes every open socket. */
  close(): Promise<void>;
}

/** Tarpit accounting wants the unspoofable peer address, not a forwarded one. */
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

export function attachRealtime(server: Server, options: RealtimeOptions): RealtimeServer {
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_CLIENT_PAYLOAD,
    // permessage-deflate stays off: costs memory per connection on attacker-controlled frames.
  });

  server.on("upgrade", handleUpgrade);

  function handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    // Dev-only: Vite's HMR shares this server; defer only when another listener actually exists.
    if (server.listenerCount("upgrade") > 1 && isViteHmr(req)) return;

    // Parsed first: `/api/logs` is not an event path, and `/logs` must never be read as a slug.
    const logs = parseLogsUpgrade(req.url ?? "");
    if (logs) {
      void acceptLogs(req, socket, head, logs);
      return;
    }

    const target = parseUpgrade(req.url ?? "");
    if (!target) {
      // Not ours; only destroy when provably nobody else (dev HMR) could answer.
      if (server.listenerCount("upgrade") === 1) socket.destroy();
      return;
    }
    if (options.realtime === false) {
      // Kill switch: destroyed unresolved, so a scan learns nothing, hit or miss.
      socket.destroy();
      return;
    }
    void accept(req, socket, head, target);
  }

  /** Session verified before the handshake and before the event lookup, so slugs cannot be probed. */
  async function acceptLogs(
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    target: LogsUpgrade,
  ): Promise<void> {
    const authed = options.verifyAdmin ? await options.verifyAdmin(req) : false;
    if (!authed) {
      logWarn(
        `Refused an unauthenticated log-stream upgrade from ${redactIp(peerAddress(req))}`,
      );
      if (!socket.destroyed) socket.destroy();
      return;
    }
    let eventId: string | null = null;
    if (target.scope === "event") {
      const event = await options.resolveEvent(target.idOrSlug);
      if (!event) {
        if (!socket.destroyed) socket.destroy();
        return;
      }
      eventId = event.id;
    }
    if (socket.destroyed) return;
    wss.handleUpgrade(req, socket, head, (ws) => {
      attachLogViewer(ws, eventId);
    });
  }

  /** Replay the buffer, then stream live entries until the viewer hangs up. */
  function attachLogViewer(ws: WebSocket, eventId: string | null): void {
    logViewers.add(ws);
    alive.add(ws);
    ws.on("pong", () => {
      alive.add(ws);
    });
    ws.on("error", () => {
      alive.delete(ws);
    });

    const sendFrame = (message: LogStreamMessage): void => {
      if (ws.readyState !== ws.OPEN) return;
      ws.send(JSON.stringify(message));
    };

    sendFrame({
      type: "replay",
      entries: eventId === null ? globalLogEntries() : eventLogEntries(eventId),
    });
    const unsubscribe =
      eventId === null
        ? subscribeGlobalLog((entry) => sendFrame({ type: "entry", entry }))
        : subscribeEventLog(
            eventId,
            (entry) => sendFrame({ type: "entry", entry }),
            () => {
              sendFrame({ type: "gone" });
              ws.close(1000, "Event deleted");
            },
          );

    // No `message` listener, like the browse socket: a viewer never writes.
    ws.on("close", () => {
      unsubscribe();
      logViewers.delete(ws);
      alive.delete(ws);
    });
  }

  async function accept(
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    target: Upgrade,
  ): Promise<void> {
    const event = await options.resolveEvent(target.idOrSlug);
    if (!event) {
      // Address only, never the URL — its first segment is a guessed slug.
      logWarn(
        `Refused a WebSocket upgrade for an unknown event from ${redactIp(peerAddress(req))}`,
      );
      // The same queue an HTTP miss joins; over the per-IP cap, `enter` refuses without the delay.
      await missTarpit.enter(peerAddress(req));
      if (!socket.destroyed) socket.destroy();
      return;
    }
    // The client may have given up while the lookup or the delay ran.
    if (socket.destroyed) return;

    // Plain 403, no tarpit: naming an event that resolved already proved the capability.
    if (!realtimeAllowed(event)) {
      logInfo("Refused an upgrade: live updates are off for this event", {
        eventId: event.id,
      });
      socket.end(
        "HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
      );
      return;
    }

    // Decided once at open: a later save frame has no request behind it.
    const origin: EditOrigin = {
      ip: options.clientIp?.(req) || peerAddress(req),
      userAgent: headerValue(req, "user-agent"),
    };

    wss.handleUpgrade(req, socket, head, (ws) => {
      subscribe(ws, event, target, origin);
    });
  }

  function subscribe(
    ws: WebSocket,
    event: StoredEvent,
    target: Upgrade,
    origin: EditOrigin,
  ): void {
    const eventId = event.id;
    alive.add(ws);
    ws.on("pong", () => {
      alive.add(ws);
    });
    ws.on("error", () => {
      // Exists so the error is not re-thrown as uncaught; room cleanup lives in `close`.
      alive.delete(ws);
    });

    if (target.key === null) {
      // The browse socket: no `message` listener, deliberately and permanently.
      joinAndWatch(ws, event, null);
      return;
    }

    const room = rooms.get(eventId);
    const incumbent = room?.sessions.get(target.key);
    if (incumbent && incumbent.readyState === incumbent.OPEN) {
      if (!target.takeover) {
        // Closed after the handshake: a close code is readable by the browser where a refused-upgrade status is not.
        logInfo(`Refused a second write session for "${target.key}": occupied`, {
          eventId,
        });
        ws.close(CLOSE_OCCUPIED, "occupied");
        return;
      }
      logInfo(`Write session for "${target.key}" taken over`, { eventId });
      sendTo(incumbent, { type: "replaced" });
      // Dropped from the map first, so the incumbent's `close` handler leaves the newcomer's claim alone.
      room?.sessions.delete(target.key);
      incumbent.close(CLOSE_REPLACED, "replaced");
    }

    joinAndWatch(ws, event, { key: target.key, displayName: target.displayName });

    // The one inbound path: a save, validated by the REST route's own validator.
    ws.on("message", (data) => {
      void onSave(ws, eventId, target.key as string, data, origin);
    });
  }

  function joinAndWatch(
    ws: WebSocket,
    snapshot: StoredEvent,
    session: { key: string; displayName: string } | null,
  ): void {
    const eventId = snapshot.id;
    const changed = join(eventId, ws, session);

    // Joining is answered with the current public snapshot — a reconnect has no other way to catch up.
    sendTo(ws, { type: "event", event: publicEvent(snapshot) as EventDoc });

    // New arrivals get presence immediately; a new claim goes to the whole room instead.
    if (changed) broadcastPresence(eventId);
    else sendTo(ws, { type: "presence", people: presencePeople(eventId) });

    ws.on("close", () => {
      alive.delete(ws);
      // Also covers heartbeat reaping: `terminate()` closes, so there is one path out of a room.
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
    // Non-save frames are dropped in silence — a future client's new word is not a reason to close.
    const message = parseSaveMessage(frameText(data));
    if (!message) return;
    // The claim may have been taken over since the frame was sent.
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
      // A no-op clear must not wake the room.
      if (changed && event) broadcastEvent(event);
    } catch (err) {
      // The REST PUT's own message; 5xx text never travels to a guest.
      const status = statusOf(err) ?? 500;
      const detail = err instanceof Error ? err.message : "";
      sendTo(ws, {
        type: "save-failed",
        message: status >= 500 || !detail ? "Could not save your availability" : detail,
      });
    }
  }

  // A dead proxy looks idle: ping every round, terminate what missed the last. Unref'd.
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
    // Log viewers are reaped by the same rule.
    for (const ws of logViewers) {
      if (!alive.has(ws)) {
        ws.terminate();
        continue;
      }
      alive.delete(ws);
      ws.ping();
    }
  }, options.heartbeatMs ?? HEARTBEAT_MS);
  heartbeat.unref?.();

  return {
    close(): Promise<void> {
      clearInterval(heartbeat);
      server.off("upgrade", handleUpgrade);
      for (const room of rooms.values()) for (const ws of room.sockets) ws.terminate();
      rooms.clear();
      for (const ws of logViewers) ws.terminate();
      logViewers.clear();
      return new Promise<void>((resolve) => wss.close(() => resolve()));
    },
  };
}

/** The header is a comma-separated offer list: compared token by token, never substring-matched. */
function isViteHmr(req: IncomingMessage): boolean {
  return headerValue(req, "sec-websocket-protocol")
    .split(",")
    .some((token) => token.trim() === "vite-hmr");
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

/** What a log-stream upgrade URL is asking for, or null when it is not one. */
type LogsUpgrade = { scope: "global" } | { scope: "event"; idOrSlug: string };

function parseLogsUpgrade(url: string): LogsUpgrade | null {
  if (GLOBAL_LOGS_PATH.test(url)) return { scope: "global" };
  const event = EVENT_LOGS_PATH.exec(url);
  if (!event) return null;
  const idOrSlug = decodeParam(event[1]);
  if (idOrSlug === null) return null;
  // `/api/logs` won the test above; any other `/api/...` is not an event path.
  if (idOrSlug === "api") return null;
  return { scope: "event", idOrSlug };
}

/** The key is re-normalized exactly as the REST route does, so two spellings cannot hold two sessions. */
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

/** Self-asserted display name: validated for shape only, never identity; the load-bearing key comes from the path. */
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
