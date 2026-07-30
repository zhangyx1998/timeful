/**
 * Date / timezone helpers for the event page.
 *
 * Ported from the legacy `frontend/src/utils/date_utils.js`, keeping the
 * conventions the data model depends on:
 *
 * - A slot's identity is an absolute epoch-ms instant (`event.dates[i]` plus an
 *   hours offset). It never depends on the viewer's timezone; the timezone only
 *   decides which cell renders it and what label the row gets.
 * - `timezoneOffset` is expressed the way `Date.prototype.getTimezoneOffset`
 *   does: **minutes west of UTC** (America/Los_Angeles in winter is +480).
 * - Days-of-week events store their dates in the hardcoded reference week
 *   2018-06-17 … 2018-06-24 and are mapped onto the viewed week for display.
 *
 * Deliberate deviation from legacy: instant arithmetic here is pure epoch
 * math. The legacy helpers used `setHours`/`setMinutes`, which are
 * browser-local and DST-aware, so slot keys silently drifted by an hour across
 * the viewer's own DST boundary. Storage here is new, so there is no legacy
 * data to stay bug-compatible with.
 */
import dayjs from "dayjs";
import utcPlugin from "dayjs/plugin/utc";
import timezonePlugin from "dayjs/plugin/timezone";

dayjs.extend(utcPlugin);
dayjs.extend(timezonePlugin);

import type { EventDoc } from "./event";

export const MS_PER_MINUTE = 60_000;
export const MS_PER_HOUR = 3_600_000;
export const MS_PER_DAY = 86_400_000;

export type DateLike = Date | string | number;

export const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

export const MONTH_LABELS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
] as const;

// ---------------------------------------------------------------------------
// time numbers ("timeNum" = an hour float, e.g. 9.5 is 09:30)
// ---------------------------------------------------------------------------

export function splitTimeNum(timeNum: number): { hours: number; minutes: number } {
  const hours = Math.floor(timeNum);
  const minutes = Math.round((timeNum - hours) * 60);
  return { hours, minutes };
}

/** "9.5" -> "9:30 am" (12h) or "09:30" (24h). */
export function timeNumToTimeText(timeNum: number, hour12 = true): string {
  const normalized = ((timeNum % 24) + 24) % 24;
  const { hours, minutes } = splitTimeNum(normalized);

  if (!hour12) {
    return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
  }

  const suffix = hours < 12 ? "am" : "pm";
  let hour12Value = hours % 12;
  if (hour12Value === 0) hour12Value = 12;
  return minutes === 0
    ? `${hour12Value} ${suffix}`
    : `${hour12Value}:${String(minutes).padStart(2, "0")} ${suffix}`;
}

/** The hour float of a date, in UTC or in the browser's own timezone. */
export function dateToTimeNum(date: DateLike, utc = false): number {
  const d = new Date(date);
  return utc
    ? d.getUTCHours() + d.getUTCMinutes() / 60
    : d.getHours() + d.getMinutes() / 60;
}

/** Shifts a UTC hour float into the given timezone, wrapped to [0, 24). */
export function utcTimeToLocalTime(timeNum: number, timezoneOffset: number): number {
  let local = timeNum - timezoneOffset / 60;
  local %= 24;
  if (local < 0) local += 24;
  return local;
}

// ---------------------------------------------------------------------------
// instant arithmetic
// ---------------------------------------------------------------------------

/**
 * The local calendar day an instant falls on, as a day number since the epoch.
 * Multiplying it back by MS_PER_DAY yields that civil date at 00:00 UTC, which
 * is what the UTC getters should be read from when building labels.
 */
export function localDayIndex(instant: DateLike, timezoneOffset: number): number {
  const ms = new Date(instant).getTime() - timezoneOffset * MS_PER_MINUTE;
  return Math.floor(ms / MS_PER_DAY);
}

/** The civil date for a local day index, expressed at 00:00 UTC. */
export function civilDateFromDayIndex(dayIndex: number): Date {
  return new Date(dayIndex * MS_PER_DAY);
}

// ---------------------------------------------------------------------------
// timezones
// ---------------------------------------------------------------------------

/**
 * The date the grid samples its timezone offset at. Weekly events follow the
 * week being viewed (so DST is applied as of that week); dated events pin to
 * their first date.
 */
export function getTimezoneReferenceDateForEvent(
  event: Pick<EventDoc, "type" | "dates">,
  weekOffset = 0,
  now: Date = new Date(),
): Date {
  if (event.type === "dow") {
    const referenceDate = new Date(now);
    referenceDate.setDate(referenceDate.getDate() + weekOffset * 7);
    referenceDate.setHours(12, 0, 0, 0);
    return referenceDate;
  }

  if (event.dates?.length > 0) {
    return new Date(event.dates[0]);
  }

  return new Date(now);
}

/**
 * Offset of an IANA timezone at a given instant, in minutes west of UTC.
 * A null/empty timezone means "whatever the browser is set to".
 */
export function getTimezoneOffsetForDate(
  timezone: string | null | undefined,
  referenceDate: DateLike,
): number {
  if (!timezone) {
    return new Date(referenceDate).getTimezoneOffset();
  }
  return dayjs(new Date(referenceDate)).tz(timezone).utcOffset() * -1;
}

/** The single offset the whole grid is laid out with. */
export function getScheduleTimezoneOffset(
  event: Pick<EventDoc, "type" | "dates">,
  timezone: string | null | undefined,
  weekOffset = 0,
  now: Date = new Date(),
): number {
  return getTimezoneOffsetForDate(
    timezone,
    getTimezoneReferenceDateForEvent(event, weekOffset, now),
  );
}

/** The browser's IANA timezone, e.g. "America/Los_Angeles". */
export function getLocalTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/** Every IANA zone the runtime knows about, with a small guaranteed fallback. */
export function listTimezones(): string[] {
  const intl = Intl as unknown as { supportedValuesOf?: (key: string) => string[] };
  try {
    const zones = intl.supportedValuesOf?.("timeZone");
    if (zones && zones.length > 0) return zones;
  } catch {
    // fall through
  }
  const local = getLocalTimezone();
  const fallback = [
    "UTC", "America/Los_Angeles", "America/Denver", "America/Chicago",
    "America/New_York", "America/Sao_Paulo", "Europe/London", "Europe/Berlin",
    "Europe/Athens", "Africa/Johannesburg", "Asia/Dubai", "Asia/Kolkata",
    "Asia/Shanghai", "Asia/Tokyo", "Australia/Sydney", "Pacific/Auckland",
  ];
  return fallback.includes(local) ? fallback : [local, ...fallback].sort();
}

/** "(GMT-07:00)" for a zone at an instant. */
export function timezoneGmtString(timezone: string, referenceDate: DateLike): string {
  const minutesEastOfUtc = -getTimezoneOffsetForDate(timezone, referenceDate);
  const sign = minutesEastOfUtc < 0 ? "-" : "+";
  const absolute = Math.abs(minutesEastOfUtc);
  const hours = String(Math.floor(absolute / 60)).padStart(2, "0");
  const minutes = String(absolute % 60).padStart(2, "0");
  return `(GMT${sign}${hours}:${minutes})`;
}

/** Whether the viewer's locale prefers a 12-hour clock. */
export function prefers12Hour(): boolean {
  try {
    return Boolean(
      Intl.DateTimeFormat(undefined, { hour: "numeric" }).resolvedOptions().hour12,
    );
  } catch {
    return true;
  }
}

// ---------------------------------------------------------------------------
// days of week
// ---------------------------------------------------------------------------

/**
 * Maps a date between the stored reference week and the week being viewed.
 *
 * `reverse: false` — a real date -> its slot in the 2018 reference week.
 * `reverse: true`  — a 2018 reference date -> the equivalent day of the viewed
 *                    week. This is the direction the grid uses for labels.
 */
export function dateToDowDate(
  dows: readonly DateLike[],
  date: DateLike,
  weekOffset: number,
  reverse = false,
  startOnMonday = false,
  now: Date = new Date(),
): Date {
  // Sort so the first entry is not a Saturday when a timezone shift rotated the
  // stored days; otherwise the day offset lands on the wrong week.
  const sorted = [...dows].sort((date1, date2) => {
    let day1 = new Date(date1).getUTCDay();
    let day2 = new Date(date2).getUTCDay();
    if (startOnMonday) {
      if (day1 === 0) day1 = 7;
      if (day2 === 0) day2 = 7;
    }
    return day1 - day2;
  });

  // Sunday of the week containing the stored days.
  const dowSunday = new Date(sorted[0]);
  dowSunday.setUTCDate(dowSunday.getUTCDate() - dowSunday.getUTCDay());

  // Sunday of the viewed week, carrying the stored time of day.
  const curSunday = new Date(now);
  curSunday.setUTCDate(curSunday.getUTCDate() - curSunday.getUTCDay());
  curSunday.setUTCDate(curSunday.getUTCDate() + 7 * weekOffset);
  curSunday.setUTCHours(dowSunday.getUTCHours());
  curSunday.setUTCMinutes(dowSunday.getUTCMinutes());
  curSunday.setUTCSeconds(dowSunday.getUTCSeconds());
  curSunday.setUTCMilliseconds(dowSunday.getUTCMilliseconds());

  let dayOffset = Math.round((curSunday.getTime() - dowSunday.getTime()) / MS_PER_DAY);
  if (reverse) dayOffset *= -1;

  const result = new Date(date);
  result.setUTCDate(result.getUTCDate() - dayOffset);
  return result;
}

// ---------------------------------------------------------------------------
// formatting
// ---------------------------------------------------------------------------

/** "Wed, Aug 5" (dated events) or "Wed" (weekly events), read in UTC. */
export function formatCivilDate(civilDate: Date, withDate: boolean): string {
  const weekday = WEEKDAY_LABELS[civilDate.getUTCDay()];
  if (!withDate) return weekday;
  return `${weekday}, ${MONTH_LABELS[civilDate.getUTCMonth()]} ${civilDate.getUTCDate()}`;
}

/**
 * The page subtitle: a date range for dated events, a weekday list for weekly
 * ones. Rendered during SSR with `timezoneOffset = 0`, then recomputed with the
 * viewer's timezone once mounted.
 */
export function formatEventDateRange(
  event: Pick<EventDoc, "type" | "dates" | "startOnMonday">,
  timezoneOffset = 0,
  now: Date = new Date(),
): string {
  const dates = [...(event.dates ?? [])].sort();
  if (dates.length === 0) return "";

  if (event.type === "dow") {
    const days = dates.map((iso) => {
      const civil = civilDateFromDayIndex(localDayIndex(iso, timezoneOffset));
      return WEEKDAY_LABELS[
        dateToDowDate(dates, civil, 0, true, event.startOnMonday, now).getUTCDay()
      ];
    });
    return [...new Set(days)].join(", ");
  }

  const first = civilDateFromDayIndex(localDayIndex(dates[0], timezoneOffset));
  const last = civilDateFromDayIndex(
    localDayIndex(dates[dates.length - 1], timezoneOffset),
  );
  const format = (d: Date) => `${MONTH_LABELS[d.getUTCMonth()]} ${d.getUTCDate()}`;
  if (first.getTime() === last.getTime()) {
    return `${WEEKDAY_LABELS[first.getUTCDay()]}, ${format(first)}`;
  }
  return `${format(first)} – ${format(last)}`;
}

/**
 * Tooltip / respondents-panel heading for one slot, e.g.
 * "Wed, Aug 5 · 2:15 – 2:30 pm" (dated) or "Wed · 14:15 – 14:30" (weekly).
 */
export function formatSlotRange(
  slotMs: number,
  slotMinutes: number,
  timezoneOffset: number,
  hour12: boolean,
  options: { withDate: boolean; dowDates?: readonly DateLike[]; startOnMonday?: boolean; now?: Date },
): string {
  const civil = civilDateFromDayIndex(localDayIndex(slotMs, timezoneOffset));
  const dayLabel = options.dowDates
    ? formatCivilDate(
        dateToDowDate(options.dowDates, civil, 0, true, options.startOnMonday ?? false, options.now),
        options.withDate,
      )
    : formatCivilDate(civil, options.withDate);

  const startTimeNum = localTimeNumOfInstant(slotMs, timezoneOffset);
  const endTimeNum = localTimeNumOfInstant(slotMs + slotMinutes * MS_PER_MINUTE, timezoneOffset);
  return `${dayLabel} · ${timeNumToTimeText(startTimeNum, hour12)} – ${timeNumToTimeText(endTimeNum, hour12)}`;
}

/** The local hour float an instant falls on. */
export function localTimeNumOfInstant(instant: DateLike, timezoneOffset: number): number {
  const shifted = new Date(new Date(instant).getTime() - timezoneOffset * MS_PER_MINUTE);
  return shifted.getUTCHours() + shifted.getUTCMinutes() / 60;
}

/** An absolute timestamp in the reader's own locale and timezone. */
export function formatDateTime(iso: string | undefined | null): string {
  if (!iso) return "—";
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return "—";
  return new Date(ms).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
