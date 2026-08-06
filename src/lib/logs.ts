/**
 * Wire shapes of the admin log streams (`/api/logs`, `/<slug>/logs`); the
 * server imports them type-only so the two halves cannot drift. The buffers
 * are in-memory, capped, and served only behind the admin session.
 */

export type LogLevel = "error" | "warn" | "info";

/** One line of the owner's log. */
export interface LogEntry {
  /** ISO timestamp of the moment it was recorded. */
  at: string;
  level: LogLevel;
  /** One sentence. Never an event slug in the global buffer; uuids are fine. */
  message: string;
  /** The event this belongs to, when it belongs to one — always the uuid. */
  eventId?: string;
  /** An errno-style code (`EACCES`, `ENOSPC`), when the cause carried one. */
  code?: string;
  /** A path — a redacted request path, or a file inside the data directory. */
  path?: string;
  /** The first meaningful line of a stack trace, for a thrown error. */
  stack?: string;
}

/**
 * Server-to-client frames on a log stream socket. The buffer is replayed in
 * one frame on connect, then each new entry follows as its own. `gone` is
 * terminal: the event whose log this was has been deleted.
 */
export type LogStreamMessage =
  | { type: "replay"; entries: LogEntry[] }
  | { type: "entry"; entry: LogEntry }
  | { type: "gone" };
