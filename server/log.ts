/**
 * The in-memory server log: what the owner can see about their own server.
 *
 * Two kinds of ring buffer, and nothing else. A **global** buffer of the last
 * `GLOBAL_LOG_CAPACITY` entries, and a **per-event** buffer of the last
 * `EVENT_LOG_CAPACITY` for each event that has had something logged against it
 * (dropped when the event is deleted). Nothing is persisted to disk, and
 * nothing new is written to stdout or the journal — the buffers are a richer,
 * admin-only view beside whatever the existing `console` output already says.
 *
 * **Redaction rules** (ARCHITECTURE.md § Security):
 *
 * - An event **slug never enters the global buffer** — a slug is the
 *   capability that protects its event, and the global log must be safe to
 *   read aloud. Uuids are fine; an entry about one event is tagged with its
 *   uuid and the per-event buffer holds a copy.
 * - A **push endpoint is never logged at all**, in either buffer — it is a
 *   capability to message somebody's browser, treated exactly like a session
 *   token. Callers log the endpoint's **host** only (`endpointHost`).
 * - A client **IP is redacted to a coarse prefix** (`redactIp`) wherever one
 *   is worth mentioning — enough to see a pattern, not enough to name a guest.
 * - A **request path is redacted** (`redactPath`) before it is logged: the
 *   first segment of an event-scoped path is the slug unless it is a uuid,
 *   so anything that is not `/api/*` or a uuid is replaced with `:event`.
 *
 * This module deliberately imports nothing from the rest of the server, so
 * anything — storage, routes, the realtime layer — can log without a cycle.
 */
import type { LogEntry, LogLevel } from "../src/lib/logs.ts";

/** Entries the global buffer holds before the oldest is dropped. */
export const GLOBAL_LOG_CAPACITY = 500;

/** Entries each per-event buffer holds before its oldest is dropped. */
export const EVENT_LOG_CAPACITY = 200;

/** Optional structure on an entry, beyond the level and the sentence. */
export interface LogFields {
  /** Tags the entry with an event **uuid** — never a slug. */
  eventId?: string;
  code?: string;
  path?: string;
  stack?: string;
}

// ---------------------------------------------------------------------------
// the buffers
// ---------------------------------------------------------------------------

const globalBuffer: LogEntry[] = [];
const eventBuffers = new Map<string, LogEntry[]>();

interface LogListener {
  onEntry: (entry: LogEntry) => void;
  /** The event whose log this watches was deleted; the stream is over. */
  onDrop?: () => void;
}

const globalListeners = new Set<LogListener>();
const eventListeners = new Map<string, Set<LogListener>>();

function push(buffer: LogEntry[], capacity: number, entry: LogEntry): void {
  buffer.push(entry);
  if (buffer.length > capacity) buffer.splice(0, buffer.length - capacity);
}

/** Records one entry. The workhorse behind the three level helpers. */
export function log(level: LogLevel, message: string, fields: LogFields = {}): void {
  const entry: LogEntry = {
    at: new Date().toISOString(),
    level,
    message,
    ...(fields.eventId ? { eventId: fields.eventId } : {}),
    ...(fields.code ? { code: fields.code } : {}),
    ...(fields.path ? { path: fields.path } : {}),
    ...(fields.stack ? { stack: fields.stack } : {}),
  };
  push(globalBuffer, GLOBAL_LOG_CAPACITY, entry);
  for (const listener of globalListeners) listener.onEntry(entry);
  if (entry.eventId) {
    let buffer = eventBuffers.get(entry.eventId);
    if (!buffer) {
      buffer = [];
      eventBuffers.set(entry.eventId, buffer);
    }
    push(buffer, EVENT_LOG_CAPACITY, entry);
    for (const listener of eventListeners.get(entry.eventId) ?? [])
      listener.onEntry(entry);
  }
}

export const logError = (message: string, fields?: LogFields): void =>
  log("error", message, fields);
export const logWarn = (message: string, fields?: LogFields): void =>
  log("warn", message, fields);
export const logInfo = (message: string, fields?: LogFields): void =>
  log("info", message, fields);

/** The global buffer, oldest first. A copy — the caller may keep it. */
export function globalLogEntries(): LogEntry[] {
  return [...globalBuffer];
}

/** One event's buffer, oldest first. Empty when nothing was ever logged. */
export function eventLogEntries(eventId: string): LogEntry[] {
  return [...(eventBuffers.get(eventId) ?? [])];
}

/**
 * Forgets an event's buffer and tells its watchers the stream is over. Called
 * when the event is deleted: a buffer for a document that no longer exists is
 * not history, it is a leak with a timer on it.
 */
export function dropEventLog(eventId: string): void {
  eventBuffers.delete(eventId);
  const listeners = eventListeners.get(eventId);
  if (!listeners) return;
  eventListeners.delete(eventId);
  for (const listener of listeners) listener.onDrop?.();
}

/** Live entries as they land in the global buffer. Returns the unsubscribe. */
export function subscribeGlobalLog(onEntry: (entry: LogEntry) => void): () => void {
  const listener: LogListener = { onEntry };
  globalListeners.add(listener);
  return () => globalListeners.delete(listener);
}

/** Live entries for one event, and the moment its log is dropped. */
export function subscribeEventLog(
  eventId: string,
  onEntry: (entry: LogEntry) => void,
  onDrop?: () => void,
): () => void {
  const listener: LogListener = { onEntry, onDrop };
  let listeners = eventListeners.get(eventId);
  if (!listeners) {
    listeners = new Set();
    eventListeners.set(eventId, listeners);
  }
  listeners.add(listener);
  return () => {
    const current = eventListeners.get(eventId);
    if (!current) return;
    current.delete(listener);
    if (current.size === 0) eventListeners.delete(eventId);
  };
}

/** Test hook: clears every buffer and listener. */
export function resetLog(): void {
  globalBuffer.length = 0;
  eventBuffers.clear();
  globalListeners.clear();
  eventListeners.clear();
}

// ---------------------------------------------------------------------------
// redaction
// ---------------------------------------------------------------------------

// Local copy of storage.ts's rule, so this module can stay a leaf: storage
// logs its own write failures through here, and an import back the other way
// would be a cycle.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A client address reduced to a coarse prefix — enough to see one address
 * misbehaving repeatedly, not enough to identify a guest from the log.
 */
export function redactIp(ip: string): string {
  if (!ip) return "unknown";
  if (ip.includes(".")) {
    // IPv4, possibly IPv6-mapped (`::ffff:1.2.3.4`): keep the first two octets.
    const v4 = ip.slice(ip.lastIndexOf(":") + 1);
    const [a, b] = v4.split(".");
    return `${a}.${b ?? "x"}.x.x`;
  }
  const groups = ip.split(":").filter((group) => group !== "");
  return `${groups[0] ?? "x"}:${groups[1] ?? "x"}:…`;
}

/**
 * The host of a push endpoint, and never more of it: the full URL is a
 * capability to message somebody's browser, treated like a session token.
 */
export function endpointHost(endpoint: string): string {
  try {
    return new URL(endpoint).host || "invalid-endpoint";
  } catch {
    return "invalid-endpoint";
  }
}

/**
 * A request path made safe for the global buffer. `/api/*` and `/` pass
 * through; anything else starts with a slug-or-uuid segment, and a slug must
 * not be logged — it is replaced with `:event`, while a uuid (harmless without
 * the login it already requires) is kept, since it is what ties the entry to
 * its event.
 */
export function redactPath(path: string): string {
  if (path === "/" || path === "/api" || path.startsWith("/api/")) return path;
  const segments = path.split("/");
  if (segments.length >= 2 && segments[1] && !UUID_RE.test(segments[1]))
    segments[1] = ":event";
  return segments.join("/");
}

/**
 * The first line of a stack trace that names a call site. The first line of
 * `err.stack` restates the message; the one after it says where.
 */
export function stackHead(stack: string | undefined): string | undefined {
  if (!stack) return undefined;
  const site = stack
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.startsWith("at "));
  return site || undefined;
}
