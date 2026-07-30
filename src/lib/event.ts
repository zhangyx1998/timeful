/**
 * Domain types for the public event page.
 *
 * These mirror `var/events/<uuid>.json` exactly (see ARCHITECTURE.md § Storage).
 * The event document arrives fully hydrated — responses inline — either through
 * SSR (`window.__EVENT__`, provided to the app as `initialEvent`) or from
 * `GET /<slug>/data`.
 */
// The `.ts` is load-bearing. This module is imported at runtime by the server
// (`storage.ts`, for the legacy read), which runs as `.ts` under Node's own
// type stripping and resolves relative specifiers literally — an extensionless
// specifier here is a crash on startup for the packaged CLI, not a warning.
import { legacyUserKey } from "./user-key.ts";

export type EventType = "specific_dates" | "dow";

/**
 * Where a response was last written from.
 *
 * **Private.** It is the one thing in an event document that is not public to
 * everyone holding the capability URL, and the login wall is what keeps it
 * that way: it is stripped from `GET /<slug>/data`, from the document the page
 * is server-rendered around, and from every realtime snapshot, and the only
 * way to read it is `GET /<slug>/details`, which requires a session.
 *
 * `ip` is trust-proxy-aware, `userAgent` is whatever the client claimed, and
 * `at` is when that write landed — which is the same instant as the record's
 * own `updatedAt`, since it is written by the same save.
 */
export interface LastEdit {
  ip: string;
  userAgent: string;
  at: string;
}

/**
 * One guest's answer, filed under their [user key](./user-key.ts).
 *
 * `displayName` is what they typed and the only spelling anything renders; the
 * key it is filed under is `userKey(displayName)`. Timestamps are ISO
 * slot-start instants.
 */
export interface EventResponse {
  displayName: string;
  availability: string[];
  ifNeeded: string[];
  updatedAt: string;
  /**
   * Stored, never served. Present on disk from the first write a record takes
   * after this existed, absent on every record written before it — and absent
   * from every copy of this document that leaves the server by a public route.
   * See `publicEvent` below, which is how that is made true in one place.
   */
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
   * Whether this event pushes live updates to open pages.
   *
   * **Optional, and absent means on.** Every event file written before the
   * realtime channel existed lacks the field, and none of them are rewritten
   * to add it — so "not there" has to read the same as `true`. Ask
   * `realtimeAllowed()` rather than testing the field, or an old event
   * silently loses the feature.
   */
  realtime?: boolean;
  createdAt: string;
  updatedAt: string;
  /** Keyed by `userKey(displayName)`, never by the display name itself. */
  responses: Record<string, EventResponse>;
}

/**
 * Brings an event's responses up to the keyed format, in place of a migration.
 *
 * There are no migration scripts and no schema version (ARCHITECTURE.md §
 * Storage), so an old file has to be readable as it stands. An old file is
 * keyed by the raw name the guest typed — dashes and all — and its records
 * carry no `displayName`. That missing field is the marker: a record that has
 * one is already keyed, and is left exactly alone.
 *
 * A legacy record is re-filed under `legacyUserKey(rawName)`, which reads its
 * dashes as the spaces they stood in for, and keeps the raw name as its
 * display name. Grandfathering the spelling matters: the name on the row is
 * the one the group recognises, and re-deriving it from the key would rewrite
 * somebody's capitalisation on their behalf.
 *
 * Two legacy names can normalize to one key — "Ada Lovelace" and
 * "ada-lovelace" both land on `ada-lovelace` — and only one record can survive
 * that. The newer `updatedAt` wins, because it is the answer the group has
 * been looking at, and `onWarn` says so. Nothing is logged about *who*: a
 * warning is not a place to put a guest's name.
 *
 * Returns the responses to use and whether anything moved. Nothing is written
 * here — the caller reads through this, and the next ordinary write persists
 * the result.
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
      // Already keyed. Nothing about it is ours to second-guess.
      out[rawKey] = record;
      continue;
    }

    changed = true;
    // An all-dash or all-space legacy name normalizes to nothing; keeping the
    // raw string as its own key is lossless and stays idempotent, since
    // `userKey` of a key is that key.
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

/**
 * One response with its private half removed.
 *
 * Returns the record itself when there is nothing to remove, so the common
 * case — every record written before last-edit tracking existed — costs
 * nothing and the identity of the object is preserved.
 */
export function publicResponse(response: EventResponse): EventResponse {
  if (response?.lastEdit === undefined) return response;
  const { lastEdit: _private, ...rest } = response;
  return rest;
}

/**
 * The event document as everyone holding the link may see it.
 *
 * The whole document is public to a link-holder — it is inlined into the
 * server-rendered page, byte for byte (ARCHITECTURE.md § Routing/SSR) — with
 * exactly one exception, so the exception needs exactly one gate. Every route
 * and every broadcast that hands an event outward goes through here, and the
 * only caller that does not is `GET /<slug>/details`, which sits behind the
 * login wall and exists precisely to serve what this takes out.
 *
 * Shallow-copied rather than mutated: the argument is the in-memory document
 * the storage layer just read, and stripping it in place would delete the
 * field from the next write.
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

/**
 * Does this event push live updates?
 *
 * The one place the default lives, shared by both halves: the server consults
 * it before admitting a subscriber or broadcasting, and the admin form shows
 * it as a checkbox. Only an explicit `false` turns it off.
 */
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

export function isEventType(value: unknown): value is EventType {
  return value === "specific_dates" || value === "dow";
}

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
