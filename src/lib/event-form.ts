/**
 * Helpers behind the create/edit event form: time options and the conversion
 * between the form model (local wall-clock days + times) and the event
 * document's `dates[]` / `duration` pair.
 *
 * `dates` are UTC instants: one per selected day, at the event's start time in
 * the admin's local timezone. `duration` is the window length in hours
 * (end - start, +24 when the window crosses midnight).
 *
 * There is deliberately no `slugify` here: default slugs are capability URLs
 * minted by the server, never derived from the event name.
 */
import type { EventDoc, EventType } from "./event";

// ---------------------------------------------------------------------------
// times
// ---------------------------------------------------------------------------

/** Formats an hour float (e.g. 13.5) as "1:30 PM". */
export function timeLabel(value: number): string {
  const hours = Math.floor(value);
  const minutes = Math.round((value - hours) * 60);
  const suffix = hours < 12 ? "AM" : "PM";
  const hour12 = hours % 12 === 0 ? 12 : hours % 12;
  return `${hour12}:${String(minutes).padStart(2, "0")} ${suffix}`;
}

export interface Option<T> {
  value: T;
  label: string;
}

/** Half-hour options covering a full day. */
export const TIME_OPTIONS: Option<number>[] = Array.from({ length: 48 }, (_, i) => {
  const value = i / 2;
  return { value, label: timeLabel(value) };
});

export const TIME_INCREMENTS: Option<number>[] = [
  { value: 15, label: "15 minutes" },
  { value: 30, label: "30 minutes" },
  { value: 60, label: "60 minutes" },
];

/** end <= start means the window runs into the next day. */
export function durationFromTimes(startTime: number, endTime: number): number {
  let duration = endTime - startTime;
  if (duration <= 0) duration += 24;
  return duration;
}

export function endTimeFromDuration(startTime: number, duration: number): number {
  return (((startTime + duration) % 24) + 24) % 24;
}

// ---------------------------------------------------------------------------
// days of week (legacy reference week: 2018-06-17 Sun .. 2018-06-24 Sun)
// ---------------------------------------------------------------------------

/** Legacy reference week; index 7 is the Sunday used when weeks start Monday. */
export const DOW_REFERENCE_DATES: readonly string[] = [
  "2018-06-17", // Sunday
  "2018-06-18", // Monday
  "2018-06-19", // Tuesday
  "2018-06-20", // Wednesday
  "2018-06-21", // Thursday
  "2018-06-22", // Friday
  "2018-06-23", // Saturday
  "2018-06-24", // Sunday
];

export const WEEKDAY_LABELS: readonly string[] = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

export const WEEKDAY_SHORT: readonly string[] = [
  "Sun",
  "Mon",
  "Tue",
  "Wed",
  "Thu",
  "Fri",
  "Sat",
];

/** Minutes east of UTC for the admin's current local offset. */
function currentOffsetMinutes(): number {
  return -new Date().getTimezoneOffset();
}

// ---------------------------------------------------------------------------
// day keys ("YYYY-MM-DD", always local wall-clock)
// ---------------------------------------------------------------------------

export function dayKey(year: number, month: number, day: number): string {
  return `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function parseDayKey(key: string): { year: number; month: number; day: number } {
  const [year, month, day] = key.split("-").map(Number);
  return { year, month: month - 1, day };
}

/** "2026-08-01" -> "Sat, Aug 1, 2026" */
export function formatDayKey(key: string): string {
  const { year, month, day } = parseDayKey(key);
  return new Date(year, month, day).toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

// ---------------------------------------------------------------------------
// form model -> dates[]
// ---------------------------------------------------------------------------

/** Local wall-clock day + hour float -> UTC ISO instant. */
function localDateToIso(
  year: number,
  month: number,
  day: number,
  startTime: number,
): string {
  const hours = Math.floor(startTime);
  const minutes = Math.round((startTime - hours) * 60);
  return new Date(year, month, day, hours, minutes, 0, 0).toISOString();
}

export function specificDates(dayKeys: string[], startTime: number): string[] {
  return [...dayKeys]
    .sort()
    .map((key) => {
      const { year, month, day } = parseDayKey(key);
      return localDateToIso(year, month, day, startTime);
    })
    .sort();
}

/**
 * Days-of-week dates, built on the legacy June-2018 reference week.
 * The reference week may sit in a different DST period than today, so the
 * instant is derived from the *current* UTC offset — matching legacy
 * NewEvent.vue, which subtracts `currentOffset - refOffset`.
 */
export function dowDates(
  dayIndexes: number[],
  startTime: number,
  startOnMonday = false,
): string[] {
  const offsetMs = currentOffsetMinutes() * 60000;
  const hours = Math.floor(startTime);
  const minutes = Math.round((startTime - hours) * 60);
  return [...dayIndexes]
    .map((index) => {
      if (startOnMonday && index === 0) return 7;
      if (!startOnMonday && index === 7) return 0;
      return index;
    })
    .filter((index, i, all) => all.indexOf(index) === i)
    .sort((a, b) => a - b)
    .map((index) =>
      new Date(
        Date.UTC(2018, 5, 17 + index, hours, minutes, 0, 0) - offsetMs,
      ).toISOString(),
    )
    .sort();
}

export interface DatesInput {
  type: EventType;
  dayKeys: string[];
  dayIndexes: number[];
  startTime: number;
  startOnMonday: boolean;
}

export function buildDates(input: DatesInput): string[] {
  return input.type === "dow"
    ? dowDates(input.dayIndexes, input.startTime, input.startOnMonday)
    : specificDates(input.dayKeys, input.startTime);
}

// ---------------------------------------------------------------------------
// dates[] -> form model (editing)
// ---------------------------------------------------------------------------

/** Reads the start time (local hour float) back out of an event. */
export function startTimeFromEvent(event: EventDoc | null): number {
  const first = event?.dates?.[0];
  if (!first) return 9;
  if (event?.type === "dow") {
    const shifted = new Date(Date.parse(first) + currentOffsetMinutes() * 60000);
    return shifted.getUTCHours() + shifted.getUTCMinutes() / 60;
  }
  const local = new Date(first);
  return local.getHours() + local.getMinutes() / 60;
}

export function dayKeysFromEvent(event: EventDoc | null): string[] {
  if (!event?.dates || event.type === "dow") return [];
  return event.dates
    .map((iso) => {
      const local = new Date(iso);
      return dayKey(local.getFullYear(), local.getMonth(), local.getDate());
    })
    .filter((key, i, all) => all.indexOf(key) === i)
    .sort();
}

export function dayIndexesFromEvent(event: EventDoc | null): number[] {
  if (!event?.dates || event.type !== "dow") return [];
  const offsetMs = currentOffsetMinutes() * 60000;
  return event.dates
    .map((iso) => {
      const shifted = new Date(Date.parse(iso) + offsetMs);
      return Math.min(7, Math.max(0, shifted.getUTCDate() - 17));
    })
    .filter((index, i, all) => all.indexOf(index) === i)
    .sort((a, b) => a - b);
}

// ---------------------------------------------------------------------------
// misc formatting
// ---------------------------------------------------------------------------

export function eventTypeLabel(type: EventType | string): string {
  return type === "dow" ? "Days of week" : "Specific dates";
}
