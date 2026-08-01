/**
 * The typed JSON client — the only one in the app. Used by the admin panel and
 * by the public event page alike.
 *
 * Requests always send cookies (the session lives in an httpOnly cookie) and
 * always resolve to parsed JSON; anything non-2xx throws an `ApiError`
 * carrying the HTTP status and the server's `{ error }` message.
 *
 * **Paths are written out in full.** There are two namespaces now — `/api/*`
 * for what is global (status, auth, sessions, slug leases, the event list) and
 * `/<slug>/…` for what belongs to one event — so a client that quietly
 * prefixed `/api` would be guessing between them. The event-scoped paths have
 * builders below rather than being spelled at each call site.
 *
 * The response types below describe the wire format of `server/routes/*`; the
 * server imports them back from here so the two halves cannot drift.
 */
import type { EventType, LastEdit } from "./event";

/**
 * The admin-only elaboration an error response may carry beside its public
 * `error` message: the underlying cause, and — for an errno — its code and the
 * path involved. **A guest never receives this field**: the server includes it
 * only when the request carried a valid admin session, so a body holding one
 * is by construction the owner reading about their own server.
 */
export interface ErrorDetail {
  message: string;
  /** An errno-style code — `EACCES`, `ENOSPC` — when the cause carried one. */
  code?: string;
  /** The file involved, on the operator's own disk. Never an event slug. */
  path?: string;
}

/** The `detail` of an error body, when the shape holds a usable one. */
export function errorDetailOf(body: unknown): ErrorDetail | null {
  if (typeof body !== "object" || body === null) return null;
  const detail = (body as { detail?: unknown }).detail;
  if (typeof detail !== "object" || detail === null) return null;
  const { message, code, path } = detail as Record<string, unknown>;
  if (typeof message !== "string" || !message) return null;
  return {
    message,
    ...(typeof code === "string" && code ? { code } : {}),
    ...(typeof path === "string" && path ? { path } : {}),
  };
}

/** One line for a detail, for the muted print under a generic message. */
export function formatErrorDetail(detail: ErrorDetail): string {
  const parts = [detail.message];
  if (detail.code && !detail.message.includes(detail.code))
    parts.push(`[${detail.code}]`);
  if (detail.path && !detail.message.includes(detail.path)) parts.push(detail.path);
  return parts.join(" ");
}

export class ApiError extends Error {
  status: number;
  body: unknown;
  /** Present only on responses to the authenticated admin. */
  detail: ErrorDetail | null;

  constructor(message: string, status: number, body: unknown = null) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
    this.detail = errorDetailOf(body);
  }
}

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface RequestOptions {
  method?: HttpMethod;
  body?: unknown;
  signal?: AbortSignal;
}

/** Options accepted by the per-verb helpers, which supply the method. */
export type CallOptions = Omit<RequestOptions, "method" | "body">;

export async function request<T>(
  path: string,
  { method = "GET", body, signal }: RequestOptions = {},
): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: "include",
    signal,
    ...(body === undefined
      ? {}
      : {
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
  });

  const text = await res.text();
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
  }

  if (!res.ok) {
    const message =
      (parsed as { error?: string } | null)?.error ??
      `Request failed with status ${res.status}`;
    throw new ApiError(message, res.status, parsed);
  }
  return parsed as T;
}

export const api = {
  get: <T>(path: string, options?: CallOptions) =>
    request<T>(path, { ...options, method: "GET" }),
  post: <T>(path: string, body?: unknown, options?: CallOptions) =>
    request<T>(path, { ...options, method: "POST", body }),
  put: <T>(path: string, body?: unknown, options?: CallOptions) =>
    request<T>(path, { ...options, method: "PUT", body }),
  patch: <T>(path: string, body?: unknown, options?: CallOptions) =>
    request<T>(path, { ...options, method: "PATCH", body }),
  del: <T>(path: string, options?: CallOptions) =>
    request<T>(path, { ...options, method: "DELETE" }),
};

// ---------------------------------------------------------------------------
// event-scoped paths
// ---------------------------------------------------------------------------
//
// An event's endpoints hang off the event's own URL, because the event's URL is
// the capability that grants access to them (ARCHITECTURE.md § API). Each takes
// the uuid or the slug; the uuid is the safer choice from a page that might be
// open across a rename.

/** `GET /<idOrSlug>/data` — the whole event document, public. */
export function eventDataPath(idOrSlug: string): string {
  return `/${encodeURIComponent(idOrSlug)}/data`;
}

/** `PATCH`/`DELETE /<idOrSlug>/settings` — the owner's controls. */
export function eventSettingsPath(idOrSlug: string): string {
  return `/${encodeURIComponent(idOrSlug)}/settings`;
}

/**
 * `GET /<idOrSlug>/details` — where each answer was last written from.
 *
 * The one event-scoped route that is **not** public: it serves the only field
 * the capability URL does not entitle you to, so it is behind the session
 * cookie and answers `401` without one.
 */
export function eventDetailsPath(idOrSlug: string): string {
  return `/${encodeURIComponent(idOrSlug)}/details`;
}

/** `PUT`/`DELETE /<idOrSlug>/users/<userKey>` — one guest's answer, public. */
export function userPath(idOrSlug: string, userKey: string): string {
  return `/${encodeURIComponent(idOrSlug)}/users/${encodeURIComponent(userKey)}`;
}

/** `PUT`/`DELETE /<idOrSlug>/push` — this browser's notification subscription. */
export function eventPushPath(idOrSlug: string): string {
  return `/${encodeURIComponent(idOrSlug)}/push`;
}

/**
 * Extracts a human-readable message plus HTTP status from a caught error.
 * `detail` is the formatted admin-only elaboration when the response carried
 * one, and `""` otherwise — a guest's errors always come out with it empty.
 */
export function apiError(
  err: unknown,
  fallback: string,
): { message: string; status: number; detail: string } {
  if (err instanceof ApiError)
    return {
      message: err.message,
      status: err.status,
      detail: err.detail ? formatErrorDetail(err.detail) : "",
    };
  if (err instanceof Error && err.message)
    return { message: err.message, status: 0, detail: "" };
  return { message: fallback, status: 0, detail: "" };
}

// ---------------------------------------------------------------------------
// response shapes
// ---------------------------------------------------------------------------

/** `GET /api/status` */
export interface StatusResponse {
  needsSetup: boolean;
  authed: boolean;
  email?: string;
}

/**
 * Is this response an admin session? Only an explicit `authed: true` counts —
 * a missing field, a truthy stand-in like `"yes"` or `1`, or a body that is not
 * an object at all all read as "no".
 */
export function isAuthedStatus(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  return (value as { authed?: unknown }).authed === true;
}

/**
 * Whether the visitor is the signed-in owner, for deciding what to render.
 *
 * **Fails closed.** A 401, a network failure, a proxy's error page, anything —
 * it all resolves to false, never a throw and never a maybe. Admin-only
 * affordances on the public event page hang off this, so the wrong answer has
 * to be the harmless one. The server enforces the real boundary regardless.
 */
export async function fetchIsAdmin(options?: CallOptions): Promise<boolean> {
  try {
    return isAuthedStatus(await api.get<unknown>("/api/status", options));
  } catch {
    return false;
  }
}

/** `POST /api/auth/setup` and `POST /api/auth/login` */
export interface AuthResponse {
  ok: boolean;
  email: string;
}

/** A `GET /api/events` row. */
export interface EventSummary {
  id: string;
  slug: string;
  name: string;
  type: EventType;
  responseCount: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * Payload accepted by `POST /api/events` and `PATCH /<slug>/settings`.
 *
 * `slug` is optional on create and omitting it is meaningful: the server then
 * mints a fresh capability slug. Never fill it in with something derived from
 * the name — that would make the URL guessable (ARCHITECTURE.md § Security).
 */
export interface EventPayload {
  name: string;
  type: EventType;
  dates: string[];
  duration: number;
  timeIncrement: number;
  startOnMonday: boolean;
  /** Live updates for this event. Omitted on create means on. */
  realtime?: boolean;
  slug?: string;
}

/** `POST /api/slug-leases` — a reservation on a not-yet-created slug. */
export interface SlugLease {
  slug: string;
  /** ISO timestamp; the reservation lapses on its own after this. */
  expiresAt: string;
}

/**
 * Reserves a random capability slug so the create form can show the final URL
 * before the event exists. Creating an event with that exact slug consumes the
 * lease; anything else should release it.
 */
export function createSlugLease(options?: CallOptions): Promise<SlugLease> {
  return api.post<SlugLease>("/api/slug-leases", undefined, options);
}

/** Releases a lease early. Idempotent — a lapsed lease is not an error. */
export function releaseSlugLease(slug: string, options?: CallOptions): Promise<void> {
  return api.del<void>(`/api/slug-leases/${encodeURIComponent(slug)}`, options);
}

/** One row of `GET /<slug>/details`. */
export interface EventDetailsUser {
  key: string;
  displayName: string;
  /** Null for a record written before last-edit tracking existed. */
  lastEdit: LastEdit | null;
}

/** `GET /<slug>/details` — admin only. */
export interface EventDetails {
  users: EventDetailsUser[];
}

/**
 * `GET /api/update-check` — admin only.
 *
 * The one response in the app that is answered from off the machine. It is
 * never requested on its own: the panel asks only when the owner presses the
 * button, so a Timeful with no route to the internet behaves exactly as it did
 * before this existed (see ARCHITECTURE.md § The update check).
 */
export interface UpdateCheck {
  /** The running version. `0.0.0-dev` when running from a source checkout. */
  current: string;
  /** The newest published version, or null when the registry could not be read. */
  latest: string | null;
  /** True only when `latest` is strictly newer than `current`. */
  updateAvailable: boolean;
  /** Why `latest` is null. Present only then, and safe to display verbatim. */
  problem?: string;
  /**
   * The server's working directory — the webroot the upgrade is run from. It
   * is the operator's own path, shown to the authenticated owner only, and it
   * is the one path in this response: no event ever appears here.
   */
  webroot: string;
  /** True when `current` is the source-checkout fallback rather than a release. */
  development: boolean;
}

/**
 * Who a push subscription is for, which decides what it is told about.
 *
 * The **owner** is notified when responses change; a **respondent** is
 * notified when the event itself changes (details edited, event deleted).
 * Subscribing as the owner requires the admin session; a respondent
 * subscription carries the user key it claims.
 */
export type PushRole = "owner" | "respondent";

/** The two keys a browser mints per push subscription, base64url. */
export interface PushSubscriptionKeys {
  /** 65-byte uncompressed P-256 point — the browser's public key. */
  p256dh: string;
  /** 16-byte shared secret. */
  auth: string;
}

/**
 * `GET /api/push/public-key` — the server's VAPID public key, minted on first
 * ask and stable from then on. Public: it is, literally, a public key, and a
 * respondent subscribing from an event page has no session to present.
 */
export interface PushPublicKey {
  /** base64url, suitable for `applicationServerKey` as it stands. */
  key: string;
}

/** Payload accepted by `PUT /<idOrSlug>/push`. */
export interface PushSubscribePayload {
  role: PushRole;
  /** Required when `role` is `"respondent"`; refused for the owner. */
  userKey?: string;
  /** The push service URL, exactly as the browser handed it out. */
  endpoint: string;
  keys: PushSubscriptionKeys;
}

/** Payload accepted by `DELETE /<idOrSlug>/push`. */
export interface PushUnsubscribePayload {
  role: PushRole;
  endpoint: string;
}

/** A `GET /api/sessions` row. */
export interface SessionInfo {
  token: string;
  createdAt: string;
  lastSeenAt: string;
  userAgent: string;
  persistent: boolean;
  current: boolean;
}

/** Payload accepted by `PUT /api/auth/credentials`. */
export interface CredentialsPayload {
  currentPassword: string;
  email?: string;
  password?: string;
}
