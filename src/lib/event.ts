/**
 * Domain types for the public event page. These mirror
 * `var/events/<uuid>.json` exactly (ARCHITECTURE.md § Storage); the document
 * arrives fully hydrated via SSR (`window.__EVENT__`) or `GET /<slug>/data`.
 */
// The `.ts` is load-bearing: the server imports this module at runtime under
// Node's type stripping, which resolves relative specifiers literally.
import { legacyUserKey } from "./user-key.ts";

export type EventType = "specific_dates" | "dow";

/**
 * Where a response was last written from. Private: stripped from every public
 * route and realtime snapshot; only the session-gated `GET /<slug>/details`
 * serves it.
 */
export interface LastEdit {
  ip: string;
  userAgent: string;
  at: string;
}

/** One guest's answer, filed under `userKey(displayName)`. ISO slot-start instants. */
export interface EventResponse {
  displayName: string;
  availability: string[];
  ifNeeded: string[];
  updatedAt: string;
  /** Stored, never served by a public route; see `publicEvent` below. */
  lastEdit?: LastEdit;
}

export interface EventDoc {
  id: string;
  slug: string;
  name: string;
  type: EventType;
  /** Day-start instants, one per column. UTC, ISO. */
  dates: string[];
  /** Length of each day's window, in hours. */
  duration: number;
  /** Slot granularity, in minutes. */
  timeIncrement: number;
  startOnMonday: boolean;
  /**
   * Absent means on — pre-realtime event files lack the field and are never
   * rewritten. Ask `realtimeAllowed()`, never test the field directly.
   */
  realtime?: boolean;
  createdAt: string;
  updatedAt: string;
  /** Keyed by `userKey(displayName)`, never by the display name itself. */
  responses: Record<string, EventResponse>;
}

/**
 * Reads legacy raw-name-keyed responses into the keyed format, in place of a
 * migration (no schema version — ARCHITECTURE.md § Storage). A missing
 * `displayName` is the legacy marker; a key clash keeps the newer `updatedAt`.
 * Nothing is written here, and warnings never carry a guest's name.
 */
export function normalizeResponses(
  responses: Record<string, EventResponse> | null | undefined,
  onWarn?: (message: string) => void,
): { responses: Record<string, EventResponse>; changed: boolean } {
  const source = responses ?? {};
  const out: Record<string, EventResponse> = {};
  let changed = false;

  for (const [rawKey, record] of Object.entries(source)) {
    const stored = (record ?? {}) as Partial<EventResponse>;
    if (typeof stored.displayName === "string") {
      out[rawKey] = record;
      continue;
    }

    changed = true;
    // An all-dash or all-space legacy name normalizes to nothing; keeping the
    // raw string as its own key is lossless and idempotent.
    const key = legacyUserKey(rawKey) || rawKey;
    const migrated: EventResponse = {
      displayName: rawKey,
      availability: Array.isArray(stored.availability) ? stored.availability : [],
      ifNeeded: Array.isArray(stored.ifNeeded) ? stored.ifNeeded : [],
      updatedAt: typeof stored.updatedAt === "string" ? stored.updatedAt : "",
    };

    const clash = out[key];
    if (!clash) {
      out[key] = migrated;
      continue;
    }
    onWarn?.(
      "Two legacy responses on one event normalize to the same guest key; keeping the more recently updated one.",
    );
    if (migrated.updatedAt > clash.updatedAt) out[key] = migrated;
  }

  return { responses: out, changed };
}

/** Removes the private half; returns the same object when there is nothing to remove. */
export function publicResponse(response: EventResponse): EventResponse {
  if (response?.lastEdit === undefined) return response;
  const { lastEdit: _private, ...rest } = response;
  return rest;
}

/**
 * The one gate stripping `lastEdit` from every copy that leaves by a public
 * route (ARCHITECTURE.md § Routing/SSR). Copies rather than mutates: stripping
 * the in-memory document in place would delete the field from the next write.
 */
export function publicEvent<T extends Pick<EventDoc, "responses">>(event: T): T {
  const responses: Record<string, EventResponse> = {};
  let changed = false;
  for (const [key, response] of Object.entries(event.responses ?? {})) {
    const stripped = publicResponse(response);
    if (stripped !== response) changed = true;
    responses[key] = stripped;
  }
  if (!changed) return event;
  return { ...event, responses };
}

/** The one place the default lives; only an explicit `false` turns realtime off. */
export function realtimeAllowed(event: Pick<EventDoc, "realtime">): boolean {
  return event.realtime !== false;
}

/** In-memory form of a response: slot-start instants as epoch milliseconds. */
export interface AvailabilitySets {
  availability: Set<number>;
  ifNeeded: Set<number>;
}

/** Which set a drag paints into. The two are mutually exclusive. */
export type AvailabilityType = "available" | "if_needed";

/** How the grid colours itself. */
export type GridMode = "group" | "edit";

/** Parses a stored response into epoch-ms sets. Unknown names yield empty sets. */
export function toAvailabilitySets(response?: EventResponse | null): AvailabilitySets {
  const availability = new Set<number>();
  const ifNeeded = new Set<number>();
  for (const iso of response?.availability ?? []) {
    const ms = Date.parse(iso);
    if (!Number.isNaN(ms)) availability.add(ms);
  }
  for (const iso of response?.ifNeeded ?? []) {
    const ms = Date.parse(iso);
    // availability wins: the two sets are mutually exclusive.
    if (!Number.isNaN(ms) && !availability.has(ms)) ifNeeded.add(ms);
  }
  return { availability, ifNeeded };
}

/** Serialises epoch-ms sets back to the sorted ISO arrays the API expects. */
export function toIsoArray(slots: Iterable<number>): string[] {
  return [...slots].sort((a, b) => a - b).map((ms) => new Date(ms).toISOString());
}

declare global {
  interface Window {
    __EVENT__?: EventDoc;
  }
}
