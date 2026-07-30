/**
 * Server-side shapes: what lives on disk under `var/`, plus the Express
 * request augmentation used by the auth middleware.
 *
 * The event document and the JSON the API hands back are shared with the
 * client, so they are imported from `src/lib/` rather than restated here —
 * the two halves can never drift. These imports are type-only and therefore
 * erased before Node ever sees them.
 */
import type {
  EventDoc,
  EventResponse,
  EventType,
  LastEdit,
} from "../src/lib/event.ts";
import type { EventDetails, EventSummary, SessionInfo } from "../src/lib/api.ts";
import type {
  PresenceEntry,
  RealtimeMessage,
  SaveMessage,
} from "../src/lib/realtime.ts";
// The one server-side shape re-exported *from* the server: the realtime module
// takes the write path as an injected function and needs its signature without
// importing the route layer it lives in.
import type { EditOrigin, ResponseInput, ResponseWrite } from "./routes/events.ts";

export type {
  EditOrigin,
  EventDetails,
  EventDoc,
  EventResponse,
  EventType,
  EventSummary,
  LastEdit,
  SessionInfo,
  PresenceEntry,
  RealtimeMessage,
  ResponseInput,
  ResponseWrite,
  SaveMessage,
};

/** An event exactly as stored in `var/events/<uuid>.json`. */
export type StoredEvent = EventDoc;

/** One guest's answer, as stored under `StoredEvent.responses[name]`. */
export type ResponseRecord = EventResponse;

/** `var/credential.json` — the single owner account. */
export interface Credential {
  email: string;
  /** scrypt-derived key, hex. */
  password: string;
  /** scrypt salt, hex. */
  salt: string;
}

/** One entry of `var/sessions.json`, keyed by session token. */
export interface SessionRecord {
  createdAt: string;
  lastSeenAt: string;
  userAgent: string;
  persistent: boolean;
}

/** `var/sessions.json` — token -> session. */
export type SessionsMap = Record<string, SessionRecord>;

/** `var/links.json` — public slug -> event id. */
export type LinksMap = Record<string, string>;

/**
 * A JSON file mutation: return the next value, or `undefined` to leave the
 * file untouched.
 */
export type Mutator<T> = (current: T) => T | undefined | Promise<T | undefined>;

declare module "express-serve-static-core" {
  interface Request {
    /** Filled in by `loadSession`; `null` means "resolved, not signed in". */
    session?: SessionRecord | null;
    sessionToken?: string | null;
  }
}
