/** Shapes on disk under `var/`; shared wire types come type-only from `src/lib/` so the halves cannot drift. */
import type {
  EventDoc,
  EventResponse,
  EventType,
  LastEdit,
} from "../src/lib/event.ts";
import type {
  ErrorDetail,
  EventDetails,
  EventSummary,
  PushRole,
  PushSubscriptionKeys,
  SessionInfo,
  UpdateCheck,
} from "../src/lib/api.ts";
import type { LogEntry, LogLevel, LogStreamMessage } from "../src/lib/logs.ts";
import type {
  PresenceEntry,
  RealtimeMessage,
  SaveMessage,
} from "../src/lib/realtime.ts";
// The one server-side re-export: realtime needs the injected write path's signature without importing the route layer.
import type { EditOrigin, ResponseInput, ResponseWrite } from "./routes/events.ts";

export type {
  EditOrigin,
  ErrorDetail,
  EventDetails,
  EventDoc,
  EventResponse,
  EventType,
  EventSummary,
  LastEdit,
  LogEntry,
  LogLevel,
  LogStreamMessage,
  PushRole,
  PushSubscriptionKeys,
  SessionInfo,
  PresenceEntry,
  RealtimeMessage,
  ResponseInput,
  ResponseWrite,
  SaveMessage,
  UpdateCheck,
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
  /** Set on sessions opened through the OIDC provider: the verified email it vouched for. */
  oidcEmail?: string;
}

/** `var/sessions.json` — token -> session. */
export type SessionsMap = Record<string, SessionRecord>;

/** `var/vapid.json` — minted once and kept: subscriptions are bound to the public key, regenerating orphans them. */
export interface VapidKeyRecord {
  /** base64url, 65-byte uncompressed P-256 point — served to browsers. */
  publicKey: string;
  /** base64url, 32-byte scalar. Never served, exactly like a session token. */
  privateKey: string;
  createdAt: string;
}

/** One entry of `var/push.json`; `endpoint` is a capability — never logged, never served back out. */
export interface PushSubscriptionRecord {
  /** The event's uuid, never its slug: a rename must not orphan this. */
  eventId: string;
  role: PushRole;
  /** The respondent's user key; absent for the owner's subscriptions. */
  userKey?: string;
  endpoint: string;
  keys: PushSubscriptionKeys;
  createdAt: string;
}

/** `var/push.json` — every push subscription, across all events. */
export interface PushStore {
  subscriptions: PushSubscriptionRecord[];
}

/** `var/links.json` — public slug -> event id. */
export type LinksMap = Record<string, string>;

/** Return the next value, or `undefined` to leave the file untouched. */
export type Mutator<T> = (current: T) => T | undefined | Promise<T | undefined>;

declare module "express-serve-static-core" {
  interface Request {
    /** Filled in by `loadSession`; `null` means "resolved, not signed in". */
    session?: SessionRecord | null;
    sessionToken?: string | null;
  }
}
