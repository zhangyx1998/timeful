import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  civilDateFromDayIndex,
  dateToDowDate,
  formatEventDateRange,
  formatSlotRange,
  getScheduleTimezoneOffset,
  getTimezoneOffsetForDate,
  getTimezoneReferenceDateForEvent,
  localDayIndex,
  splitTimeNum,
  timeNumToTimeText,
  timezoneGmtString,
  utcTimeToLocalTime,
} from "./dates";
import type { EventDoc } from "./event";

const dowEvent = {
  type: "dow",
  dates: ["2018-06-17T09:00:00.000Z"],
  startOnMonday: false,
} satisfies Pick<EventDoc, "type" | "dates" | "startOnMonday">;

/** Adapted from the legacy `frontend/src/utils/date_utils.test.js`. */
describe("DST timezone regression", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-18T12:00:00Z"));
    return () => vi.useRealTimers();
  });

  it("uses the viewed week as the reference date for weekly events", () => {
    const referenceDate = getTimezoneReferenceDateForEvent(dowEvent, 3);

    // Three weeks on from "now", at local noon. Asserted relative to the faked
    // clock so the test does not depend on the machine's timezone.
    const expected = new Date();
    expected.setDate(expected.getDate() + 21);
    expected.setHours(12, 0, 0, 0);
    expect(referenceDate.getTime()).toBe(expected.getTime());
    expect(referenceDate.getHours()).toBe(12);
  });

  it("uses the first event date as the reference date for specific dates", () => {
    const datedEvent = {
      type: "specific_dates",
      dates: ["2026-11-02T09:00:00.000Z", "2026-11-03T09:00:00.000Z"],
    } satisfies Pick<EventDoc, "type" | "dates">;

    expect(getTimezoneReferenceDateForEvent(datedEvent).toISOString()).toBe(
      "2026-11-02T09:00:00.000Z",
    );
  });

  it("calculates timezone offsets from the provided reference date", () => {
    expect(
      getTimezoneOffsetForDate("Europe/Vienna", new Date("2026-04-08T12:00:00Z")),
    ).toBe(-120);
  });

  it("keeps the standard offset during non-DST viewed weeks", () => {
    expect(getScheduleTimezoneOffset(dowEvent, "Europe/Vienna", -10)).toBe(-60);
  });

  it("falls back to the browser timezone when no timezone is selected", () => {
    const reference = new Date("2026-04-08T12:00:00Z");
    expect(getTimezoneOffsetForDate(null, reference)).toBe(reference.getTimezoneOffset());
  });

  it("shows the viewed event week using that week's timezone offset", () => {
    expect(getScheduleTimezoneOffset(dowEvent, "Europe/Vienna", 3)).toBe(-120);
  });

  it("shows the viewed event week using the new offset after fall-back DST changes", () => {
    vi.setSystemTime(new Date("2026-10-20T12:00:00Z"));
    expect(getScheduleTimezoneOffset(dowEvent, "Europe/Vienna", 2)).toBe(-60);
  });

  it("tracks DST for dated events from their own first date", () => {
    const winter = {
      type: "specific_dates",
      dates: ["2026-01-15T09:00:00.000Z"],
    } satisfies Pick<EventDoc, "type" | "dates">;
    const summer = {
      type: "specific_dates",
      dates: ["2026-07-15T09:00:00.000Z"],
    } satisfies Pick<EventDoc, "type" | "dates">;

    expect(getScheduleTimezoneOffset(winter, "America/Los_Angeles")).toBe(480);
    expect(getScheduleTimezoneOffset(summer, "America/Los_Angeles")).toBe(420);
  });
});

describe("time numbers", () => {
  it("splits an hour float into hours and minutes", () => {
    expect(splitTimeNum(9.5)).toEqual({ hours: 9, minutes: 30 });
    expect(splitTimeNum(13.25)).toEqual({ hours: 13, minutes: 15 });
    expect(splitTimeNum(0)).toEqual({ hours: 0, minutes: 0 });
  });

  it("formats 12-hour labels the way the legacy grid did", () => {
    expect(timeNumToTimeText(0)).toBe("12 am");
    expect(timeNumToTimeText(0.5)).toBe("12:30 am");
    expect(timeNumToTimeText(9)).toBe("9 am");
    expect(timeNumToTimeText(12)).toBe("12 pm");
    expect(timeNumToTimeText(12.25)).toBe("12:15 pm");
    expect(timeNumToTimeText(13.5)).toBe("1:30 pm");
    expect(timeNumToTimeText(23.75)).toBe("11:45 pm");
  });

  it("formats 24-hour labels zero-padded", () => {
    expect(timeNumToTimeText(0, false)).toBe("00:00");
    expect(timeNumToTimeText(9.5, false)).toBe("09:30");
    expect(timeNumToTimeText(23.75, false)).toBe("23:45");
  });

  it("wraps UTC hours into the selected timezone", () => {
    // 480 minutes west of UTC = America/Los_Angeles in winter.
    expect(utcTimeToLocalTime(17, 480)).toBe(9);
    expect(utcTimeToLocalTime(2, 480)).toBe(18);
    expect(utcTimeToLocalTime(9, -330)).toBe(14.5); // Asia/Kolkata
  });

  it("renders GMT strings for half-hour zones", () => {
    const reference = new Date("2026-01-15T12:00:00Z");
    expect(timezoneGmtString("Asia/Kolkata", reference)).toBe("(GMT+05:30)");
    expect(timezoneGmtString("America/Los_Angeles", reference)).toBe("(GMT-08:00)");
    expect(timezoneGmtString("UTC", reference)).toBe("(GMT+00:00)");
  });
});

describe("local day mapping", () => {
  it("assigns instants to the local calendar day", () => {
    // 2026-08-01T02:00Z is still 2026-07-31 in Los Angeles (UTC-7).
    const instant = "2026-08-01T02:00:00.000Z";
    const civilUtc = civilDateFromDayIndex(localDayIndex(instant, 0));
    const civilPacific = civilDateFromDayIndex(localDayIndex(instant, 420));
    expect(civilUtc.toISOString()).toBe("2026-08-01T00:00:00.000Z");
    expect(civilPacific.toISOString()).toBe("2026-07-31T00:00:00.000Z");
  });
});

describe("days-of-week mapping", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // A Wednesday.
    vi.setSystemTime(new Date("2026-07-15T12:00:00Z"));
    return () => vi.useRealTimers();
  });

  it("maps reference-week dates onto the viewed week, preserving the weekday", () => {
    const dows = ["2018-06-18T16:00:00.000Z", "2018-06-20T16:00:00.000Z"];
    const mapped = dateToDowDate(dows, new Date("2018-06-18T16:00:00.000Z"), 0, true);

    // 2018-06-18 is a Monday; the Monday of the week containing 2026-07-15.
    expect(mapped.getUTCDay()).toBe(1);
    expect(mapped.toISOString()).toBe("2026-07-13T16:00:00.000Z");
  });

  it("moves whole weeks with the week offset", () => {
    const dows = ["2018-06-18T16:00:00.000Z"];
    const next = dateToDowDate(dows, new Date("2018-06-18T16:00:00.000Z"), 1, true);
    expect(next.toISOString()).toBe("2026-07-20T16:00:00.000Z");

    const previous = dateToDowDate(dows, new Date("2018-06-18T16:00:00.000Z"), -1, true);
    expect(previous.toISOString()).toBe("2026-07-06T16:00:00.000Z");
  });

  it("round-trips a real date back to the reference week", () => {
    const dows = ["2018-06-18T16:00:00.000Z"];
    const forward = dateToDowDate(dows, new Date("2018-06-18T16:00:00.000Z"), 0, true);
    const back = dateToDowDate(dows, forward, 0, false);
    expect(back.toISOString()).toBe("2018-06-18T16:00:00.000Z");
  });

  it("sorts stored days so a rotated week still lands on the right week", () => {
    // Created in a timezone that pushed Sunday to the end of the array.
    const dows = ["2018-06-23T22:00:00.000Z", "2018-06-18T22:00:00.000Z"];
    const mapped = dateToDowDate(dows, new Date("2018-06-18T22:00:00.000Z"), 0, true);
    expect(mapped.getUTCDay()).toBe(1);
    expect(mapped.toISOString()).toBe("2026-07-13T22:00:00.000Z");
  });
});

describe("event subtitles", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-15T12:00:00Z"));
    return () => vi.useRealTimers();
  });

  it("renders a date range for dated events", () => {
    const event = {
      type: "specific_dates",
      startOnMonday: false,
      dates: [
        "2026-08-01T16:00:00.000Z",
        "2026-08-02T16:00:00.000Z",
        "2026-08-05T16:00:00.000Z",
      ],
    } satisfies Pick<EventDoc, "type" | "dates" | "startOnMonday">;
    expect(formatEventDateRange(event, 0)).toBe("Aug 1 – Aug 5");
  });

  it("renders a single dated day with its weekday", () => {
    const event = {
      type: "specific_dates",
      startOnMonday: false,
      dates: ["2026-08-01T16:00:00.000Z"],
    } satisfies Pick<EventDoc, "type" | "dates" | "startOnMonday">;
    expect(formatEventDateRange(event, 0)).toBe("Sat, Aug 1");
  });

  it("renders a weekday list for weekly events", () => {
    const event = {
      type: "dow",
      startOnMonday: false,
      dates: ["2018-06-18T16:00:00.000Z", "2018-06-20T16:00:00.000Z"],
    } satisfies Pick<EventDoc, "type" | "dates" | "startOnMonday">;
    expect(formatEventDateRange(event, 0)).toBe("Mon, Wed");
  });

  it("labels a slot with its local time range", () => {
    const slot = Date.parse("2026-08-01T16:15:00.000Z");
    expect(
      formatSlotRange(slot, 15, 420, true, { withDate: true }),
    ).toBe("Sat, Aug 1 · 9:15 am – 9:30 am");
    expect(
      formatSlotRange(slot, 30, 0, false, { withDate: false }),
    ).toBe("Sat · 16:15 – 16:45");
  });
});
