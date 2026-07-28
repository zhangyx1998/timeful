/**
 * Domain types for the public event page.
 *
 * These mirror `var/events/<uuid>.json` exactly (see ARCHITECTURE.md § Storage).
 * The event document arrives fully hydrated — responses inline — either through
 * SSR (`window.__EVENT__`, provided to the app as `initialEvent`) or from
 * `GET /api/events/:slug`.
 */

export type EventType = "specific_dates" | "dow";

/** One guest's answer. Timestamps are ISO slot-start instants. */
export interface EventResponse {
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
  createdAt: string;
  updatedAt: string;
  responses: Record<string, EventResponse>;
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
