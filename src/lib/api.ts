/**
 * The typed JSON client for the `/api` surface — the only one in the app.
 * Used by the admin panel and by the public event page alike.
 *
 * Requests always send cookies (the session lives in an httpOnly cookie) and
 * always resolve to parsed JSON; anything non-2xx throws an `ApiError`
 * carrying the HTTP status and the server's `{ error }` message.
 *
 * The response types below describe the wire format of `server/routes/*`; the
 * server imports them back from here so the two halves cannot drift.
 */
import type { EventType } from "./event";

export class ApiError extends Error {
  status: number;
  body: unknown;

  constructor(message: string, status: number, body: unknown = null) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
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
  const url = path.startsWith("/api") ? path : `/api${path}`;
  const res = await fetch(url, {
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

/** Extracts a human-readable message plus HTTP status from a caught error. */
export function apiError(
  err: unknown,
  fallback: string,
): { message: string; status: number } {
  if (err instanceof ApiError) return { message: err.message, status: err.status };
  if (err instanceof Error && err.message) return { message: err.message, status: 0 };
  return { message: fallback, status: 0 };
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
    return isAuthedStatus(await api.get<unknown>("/status", options));
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
 * Payload accepted by `POST /api/events` and `PATCH /api/events/:id`.
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
  return api.post<SlugLease>("/slug-leases", undefined, options);
}

/** Releases a lease early. Idempotent — a lapsed lease is not an error. */
export function releaseSlugLease(slug: string, options?: CallOptions): Promise<void> {
  return api.del<void>(`/slug-leases/${encodeURIComponent(slug)}`, options);
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
