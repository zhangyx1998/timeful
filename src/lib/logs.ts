/**
 * The wire shapes of the admin log streams.
 *
 * The server keeps short in-memory ring buffers of what it has been doing —
 * one global, one per event — and streams them to the signed-in owner over a
 * disposable WebSocket (`/api/logs` for the server, `/<slug>/logs` for one
 * event). These are the frames that socket carries and the entries inside
 * them, defined here so the viewer and the server cannot drift; `server/log.ts`
 * and `server/types.ts` import them type-only.
 *
 * Nothing here is persisted and nothing here is public: the buffers live in
 * process memory, are capped, and are served only behind the admin session.
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
