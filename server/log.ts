/**
 * In-memory ring buffers, global and per-event; nothing persisted. Redaction
 * (ARCHITECTURE.md § Security): slugs never enter the global buffer, push
 * endpoints are logged as host only, IPs and paths are redacted. Leaf module —
 * imports nothing from the server, so anything can log without a cycle.
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

/** Called on event deletion; a buffer for a deleted event is a leak. */
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

// Local copy of storage.ts's rule: this module must stay a leaf.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Coarse prefix — enough to see a repeat offender, not to identify a guest. */
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

/** Host only: the full endpoint URL is a capability, treated like a session token. */
export function endpointHost(endpoint: string): string {
  try {
    return new URL(endpoint).host || "invalid-endpoint";
  } catch {
    return "invalid-endpoint";
  }
}

/** The first segment of a non-/api path is a slug unless it is a uuid; slugs become ":event". */
export function redactPath(path: string): string {
  if (path === "/" || path === "/api" || path.startsWith("/api/")) return path;
  const segments = path.split("/");
  if (segments.length >= 2 && segments[1] && !UUID_RE.test(segments[1]))
    segments[1] = ":event";
  return segments.join("/");
}

/** First "at " line: `err.stack`'s first line only restates the message. */
export function stackHead(stack: string | undefined): string | undefined {
  if (!stack) return undefined;
  const site = stack
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.startsWith("at "));
  return site || undefined;
}
