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
