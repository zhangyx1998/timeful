/**
 * The app's one typed JSON client. Requests always send cookies; non-2xx
 * throws `ApiError`. Paths are written out in full — `/api/*` is global,
 * `/<slug>/…` is event-scoped — and the server imports the response types
 * back from here so the wire format cannot drift.
 */
import type { EventType, LastEdit } from "./event";

/** Admin-only elaboration beside the public `error`; a guest never receives it. */
export interface ErrorDetail {
  message: string;
  /** An errno-style code — `EACCES`, `ENOSPC` — when the cause carried one. */
  code?: string;
  /** The file involved, on the operator's own disk. Never an event slug. */
  path?: string;
}

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
  /**
   * Let the request outlive its page (the autosave flush on pagehide).
   * Best-effort: bodies over the keepalive quota go as a plain fetch.
   */
  keepalive?: boolean;
}

export type CallOptions = Omit<RequestOptions, "method" | "body">;

export async function request<T>(
  path: string,
  { method = "GET", body, signal, keepalive }: RequestOptions = {},
): Promise<T> {
  const serialized = body === undefined ? undefined : JSON.stringify(body);
  // `keepalive` caps the body at 64 KB; a plain fetch is strictly better than a throw.
  const survives = keepalive === true && (serialized?.length ?? 0) <= 60_000;
  const res = await fetch(path, {
    method,
    credentials: "include",
    signal,
    ...(survives ? { keepalive: true } : {}),
    ...(serialized === undefined
      ? {}
      : {
          headers: { "Content-Type": "application/json" },
          body: serialized,
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

// Event-scoped paths hang off the event's own URL, because that URL is the
// capability granting access (ARCHITECTURE.md § API). Each takes uuid or slug;
// the uuid survives a rename.

/** `GET /<idOrSlug>/data` — the whole event document, public. */
export function eventDataPath(idOrSlug: string): string {
  return `/${encodeURIComponent(idOrSlug)}/data`;
}

/** `PATCH`/`DELETE /<idOrSlug>/settings` — the owner's controls. */
export function eventSettingsPath(idOrSlug: string): string {
  return `/${encodeURIComponent(idOrSlug)}/settings`;
}

/** `GET /<idOrSlug>/details` — the one event-scoped route behind the session cookie. */
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

/** `GET /<idOrSlug>/logs` — admin-only WebSocket upgrade; a plain GET is a 404. */
export function eventLogsPath(idOrSlug: string): string {
  return `/${encodeURIComponent(idOrSlug)}/logs`;
}

/** Message plus status from a caught error; `detail` is always `""` for guests. */
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

/** `GET /api/status` */
export interface StatusResponse {
  needsSetup: boolean;
  authed: boolean;
  email?: string;
  login?: LoginMethods;
}

/** Which sign-in paths the server offers; `oidc` is the provider's display name. */
export interface LoginMethods {
  password: boolean;
  oidc?: string;
}

/** Password only, which is what a server that predates OIDC means. */
export const PASSWORD_ONLY: LoginMethods = { password: true };

/** A full-page navigation, not a fetch: the provider's pages need the top-level window. */
export function oidcStartUrl(options: { persist?: boolean; returnTo?: string } = {}): string {
  const params = new URLSearchParams();
  if (options.persist) params.set("persist", "1");
  if (options.returnTo && options.returnTo !== "/") params.set("return", options.returnTo);
  const query = params.toString();
  return `/api/auth/oidc/start${query ? `?${query}` : ""}`;
}

/** Only an explicit `authed: true` counts; anything else reads as "no". */
export function isAuthedStatus(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  return (value as { authed?: unknown }).authed === true;
}

/** Fails closed: any failure resolves false. The server enforces the real boundary. */
export async function fetchIsAdmin(options?: CallOptions): Promise<boolean> {
  return (await fetchAdminStatus(options)).authed;
}

/** `authed` fails closed; `login` falls back to password-only on any failure. */
export async function fetchAdminStatus(
  options?: CallOptions,
): Promise<{ authed: boolean; login: LoginMethods }> {
  try {
    const status = await api.get<unknown>("/api/status", options);
    return { authed: isAuthedStatus(status), login: loginMethodsOf(status) };
  } catch {
    return { authed: false, login: PASSWORD_ONLY };
  }
}

export function loginMethodsOf(status: unknown): LoginMethods {
  if (typeof status !== "object" || status === null) return PASSWORD_ONLY;
  const login = (status as { login?: unknown }).login;
  if (typeof login !== "object" || login === null) return PASSWORD_ONLY;
  const { password, oidc } = login as { password?: unknown; oidc?: unknown };
  const methods: LoginMethods = { password: password !== false };
  if (typeof oidc === "string" && oidc) methods.oidc = oidc;
  // A server that offers neither is misreporting; the password form is the safe fallback.
  return methods.password || methods.oidc ? methods : PASSWORD_ONLY;
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
 * `slug` omitted on create means the server mints one; never derive it from
 * the name (ARCHITECTURE.md § Security).
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

/** Creating an event with the leased slug consumes the lease; anything else should release it. */
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
 * `GET /api/update-check` — admin only; requested only on an explicit button
 * press (ARCHITECTURE.md § The update check).
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
  /** The operator's own webroot, shown to the owner only; the one path here. */
  webroot: string;
  /** True when `current` is the source-checkout fallback rather than a release. */
  development: boolean;
}

/**
 * Owner: notified when responses change; requires the admin session.
 * Respondent: notified when the event changes; carries the user key it claims.
 */
export type PushRole = "owner" | "respondent";

/** The two keys a browser mints per push subscription, base64url. */
export interface PushSubscriptionKeys {
  /** 65-byte uncompressed P-256 point — the browser's public key. */
  p256dh: string;
  /** 16-byte shared secret. */
  auth: string;
}

/** `GET /api/push/public-key` — public: a respondent has no session to present. */
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
