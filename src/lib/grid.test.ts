import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  allSlots,
  buildGrid,
  buildResponseIndex,
  COMPACT_MAX_WIDTH,
  columnOffsets,
  columnWidthFor,
  DESKTOP_PER_VIEW,
  edgeGlideStep,
  edgeScrollDirection,
  geometryFor,
  gridSize,
  heatmapAlpha255,
  heatmapColor,
  hitTest,
  inRectangle,
  isBestTime,
  maxRespondents,
  perViewFor,
  placeOverlay,
  rectangleSlots,
  regionDigest,
  revertOperations,
  scrollEdges,
  scrollStepFor,
  selectionCorners,
  selectionDelta,
  selectionPress,
  selectionStep,
  slotAt as slot,
  slotDigest,
  snapshotSlots,
  type GridGeometry,
  type OverlayField,
} from "./grid";
import type { EventDoc } from "./event";
import { userKey } from "./user-key";

/** Los Angeles in August: 420 minutes west of UTC. */
const PDT = 420;

function makeEvent(overrides: Partial<EventDoc> = {}): EventDoc {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    slug: "test",
    name: "Test",
    type: "specific_dates",
    dates: ["2026-08-01T16:00:00.000Z", "2026-08-02T16:00:00.000Z"],
    duration: 8,
    timeIncrement: 30,
    startOnMonday: false,
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    responses: {},
    ...overrides,
  };
}

const iso = (value: string) => Date.parse(value);

describe("buildGrid — a window inside one local day", () => {
  const model = buildGrid(makeEvent(), { timezoneOffset: PDT });

  it("derives the daily window from dates[0] and duration", () => {
    expect(model.startTimeUtc).toBe(16);
    expect(model.crossesMidnight).toBe(false);
    expect(model.rows).toHaveLength(16); // 8 hours at 30 minutes
    expect(model.topRowCount).toBe(16);
    expect(model.bottomRowCount).toBe(0);
  });

  it("labels rows in the selected timezone", () => {
    expect(model.rows[0].localTimeNum).toBe(9);
    expect(model.rows[0].label).toBe("9 am");
    expect(model.rows[0].isHourStart).toBe(true);
    expect(model.rows[1].label).toBe("9:30 am");
    expect(model.rows[1].isHourStart).toBe(false);
    expect(model.rows[1].isHalfHour).toBe(true);
    expect(model.rows[15].label).toBe("4:30 pm");
  });

  it("makes one column per date, with no spillover column", () => {
    expect(model.columns).toHaveLength(2);
    expect(model.columns.map((c) => c.weekday)).toEqual(["Sat", "Sun"]);
    expect(model.columns.map((c) => c.dateLabel)).toEqual(["Aug 1", "Aug 2"]);
    expect(model.columns.every((c) => c.isConsecutive)).toBe(true);
    expect(model.columns.every((c) => c.bottomDateMs === null)).toBe(true);
  });

  it("maps cells to absolute instants", () => {
    expect(allSlots(model)).toHaveLength(32);
    expect(model.rows[0].hoursOffset).toBe(0);
    expect(slot(model, 0, 0)).toBe(iso("2026-08-01T16:00:00.000Z"));
    expect(slot(model, 1, 0)).toBe(iso("2026-08-01T16:30:00.000Z"));
    expect(slot(model, 15, 0)).toBe(iso("2026-08-01T23:30:00.000Z"));
    expect(slot(model, 0, 1)).toBe(iso("2026-08-02T16:00:00.000Z"));
  });

  it("returns the same instants regardless of the viewing timezone", () => {
    const tokyo = buildGrid(makeEvent(), { timezoneOffset: -540 });
    expect(slot(tokyo, 0, 0)).toBe(slot(model, 0, 0));
    // 09:00 in Los Angeles is 01:00 the next morning in Tokyo.
    expect(tokyo.rows[0].localTimeNum).toBe(1);
    expect(tokyo.crossesMidnight).toBe(false);
  });

  it("has no cell outside the grid", () => {
    expect(slot(model, 16, 0)).toBeNull();
    expect(slot(model, 0, 2)).toBeNull();
    expect(slot(model, -1, 0)).toBeNull();
  });
});

describe("buildGrid — a window crossing local midnight", () => {
  // 21:00 -> 03:00 in Los Angeles.
  const event = makeEvent({
    dates: ["2026-08-01T04:00:00.000Z"],
    duration: 6,
    timeIncrement: 60,
  });
  const model = buildGrid(event, { timezoneOffset: PDT });

  it("splits the window into a top and a bottom block", () => {
    expect(model.crossesMidnight).toBe(true);
    expect(model.topRowCount).toBe(3); // 00:00, 01:00, 02:00
    expect(model.bottomRowCount).toBe(3); // 21:00, 22:00, 23:00
    expect(model.rows.map((r) => r.localTimeNum)).toEqual([0, 1, 2, 21, 22, 23]);
    expect(model.rows.map((r) => r.hoursOffset)).toEqual([3, 4, 5, 0, 1, 2]);
    expect(model.rows.map((r) => r.block)).toEqual([0, 0, 0, 1, 1, 1]);
  });

  it("appends a spillover column for the tail of the last day", () => {
    expect(model.columns).toHaveLength(2);
    expect(model.columns.map((c) => c.dateLabel)).toEqual(["Jul 31", "Aug 1"]);
  });

  it("resolves the top block against the previous day's window", () => {
    // The first column has no preceding day, so its top block is dead.
    expect(slot(model, 0, 0)).toBeNull();
    // Its bottom block is the head of the window: 21:00 local.
    expect(slot(model, 3, 0)).toBe(iso("2026-08-01T04:00:00.000Z"));
    expect(slot(model, 5, 0)).toBe(iso("2026-08-01T06:00:00.000Z"));

    // The spillover column carries the tail: midnight to 03:00 local.
    expect(slot(model, 0, 1)).toBe(iso("2026-08-01T07:00:00.000Z"));
    expect(slot(model, 2, 1)).toBe(iso("2026-08-01T09:00:00.000Z"));
    // ...and has no window of its own.
    expect(slot(model, 3, 1)).toBeNull();
  });

  it("covers every slot of the window exactly once", () => {
    const slots = allSlots(model).sort((a, b) => a - b);
    expect(slots).toHaveLength(6);
    expect(slots[0]).toBe(iso("2026-08-01T04:00:00.000Z"));
    expect(slots[5]).toBe(iso("2026-08-01T09:00:00.000Z"));
  });

  it("shares the spillover column with the next day when dates are consecutive", () => {
    const consecutive = buildGrid(
      makeEvent({
        dates: ["2026-08-01T04:00:00.000Z", "2026-08-02T04:00:00.000Z"],
        duration: 6,
        timeIncrement: 60,
      }),
      { timezoneOffset: PDT },
    );
    // Jul 31, Aug 1 (both a tail and a head), Aug 2 (tail only).
    expect(consecutive.columns.map((c) => c.dateLabel)).toEqual(["Jul 31", "Aug 1", "Aug 2"]);
    expect(consecutive.columns[1].topDateMs).not.toBeNull();
    expect(consecutive.columns[1].bottomDateMs).not.toBeNull();
    expect(allSlots(consecutive)).toHaveLength(12);
  });

  it("does not split a window that ends exactly at midnight", () => {
    const untilMidnight = buildGrid(
      makeEvent({ dates: ["2026-08-01T04:00:00.000Z"], duration: 3, timeIncrement: 60 }),
      { timezoneOffset: PDT },
    );
    expect(untilMidnight.crossesMidnight).toBe(false);
    expect(untilMidnight.columns).toHaveLength(1);
    expect(untilMidnight.rows.map((r) => r.localTimeNum)).toEqual([21, 22, 23]);
  });

  it("splits on a slot boundary in half-hour timezones", () => {
    // Asia/Kolkata is 330 minutes east: 21:30 -> 03:30 local.
    const kolkata = buildGrid(
      makeEvent({ dates: ["2026-08-01T16:00:00.000Z"], duration: 6, timeIncrement: 30 }),
      { timezoneOffset: -330 },
    );
    expect(kolkata.crossesMidnight).toBe(true);
    expect(kolkata.rows[0].localTimeNum).toBe(0);
    expect(kolkata.bottomRowCount).toBe(5); // 21:30 .. 23:30
    expect(kolkata.topRowCount).toBe(7); // 00:00 .. 03:00
    expect(allSlots(kolkata)).toHaveLength(12);
  });
});

describe("buildGrid — non-consecutive dates", () => {
  it("flags the gap so the grid can draw a spacer", () => {
    const model = buildGrid(
      makeEvent({
        dates: [
          "2026-08-01T16:00:00.000Z",
          "2026-08-02T16:00:00.000Z",
          "2026-08-06T16:00:00.000Z",
        ],
      }),
      { timezoneOffset: PDT },
    );
    expect(model.columns.map((c) => c.isConsecutive)).toEqual([true, true, false]);
  });
});

describe("buildGrid — days-of-week events", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-15T12:00:00Z")); // a Wednesday
    return () => vi.useRealTimers();
  });

  const event = makeEvent({
    type: "dow",
    // Monday and Wednesday of the 2018 reference week, 09:00 Los Angeles.
    dates: ["2018-06-18T16:00:00.000Z", "2018-06-20T16:00:00.000Z"],
    duration: 4,
    timeIncrement: 60,
  });

  it("keeps slot instants in the stored reference week", () => {
    const model = buildGrid(event, { timezoneOffset: PDT });
    expect(slot(model, 0, 0)).toBe(iso("2018-06-18T16:00:00.000Z"));
    expect(slot(model, 0, 1)).toBe(iso("2018-06-20T16:00:00.000Z"));
  });

  it("labels columns with the weekday of the viewed week", () => {
    const model = buildGrid(event, { timezoneOffset: PDT });
    expect(model.columns.map((c) => c.weekday)).toEqual(["Mon", "Wed"]);
    expect(model.columns.map((c) => c.dateLabel)).toEqual(["Jul 13", "Jul 15"]);
    expect(model.showDates).toBe(false);
    expect(model.columns.map((c) => c.isConsecutive)).toEqual([true, false]);
  });

  it("follows the week offset", () => {
    const model = buildGrid(event, { timezoneOffset: PDT, weekOffset: 1 });
    expect(model.columns.map((c) => c.dateLabel)).toEqual(["Jul 20", "Jul 22"]);
    // The instants themselves never move.
    expect(slot(model, 0, 0)).toBe(iso("2018-06-18T16:00:00.000Z"));
  });
});

describe("geometry and hit-testing", () => {
  const geometry: GridGeometry = {
    colWidth: 100,
    rowHeight: 20,
    gapWidth: 20,
    gapHeight: 40,
    columnGaps: [false, false, true],
    topRowCount: 3,
    bottomRowCount: 3,
  };

  it("places columns after their leading gaps", () => {
    expect(columnOffsets(geometry)).toEqual([0, 100, 220]);
    expect(gridSize(geometry)).toEqual({ width: 320, height: 160 });
  });

  it("maps pixels to cells", () => {
    expect(hitTest(0, 0, geometry)).toEqual({ row: 0, col: 0 });
    expect(hitTest(99, 19, geometry)).toEqual({ row: 0, col: 0 });
    expect(hitTest(100, 20, geometry)).toEqual({ row: 1, col: 1 });
    expect(hitTest(150, 59, geometry)).toEqual({ row: 2, col: 1 });
    expect(hitTest(230, 0, geometry)).toEqual({ row: 0, col: 2 });
  });

  it("keeps the block gap from selecting a lesser row", () => {
    // The gap spans y = 60..100; everything at or past it is the bottom block.
    expect(hitTest(0, 60, geometry)).toEqual({ row: 3, col: 0 });
    expect(hitTest(0, 99, geometry)).toEqual({ row: 3, col: 0 });
    expect(hitTest(0, 100, geometry)).toEqual({ row: 3, col: 0 });
    expect(hitTest(0, 120, geometry)).toEqual({ row: 4, col: 0 });
    expect(hitTest(0, 159, geometry)).toEqual({ row: 5, col: 0 });
  });

  it("clamps coordinates outside the grid so dragging past the edge works", () => {
    expect(hitTest(-40, -40, geometry)).toEqual({ row: 0, col: 0 });
    expect(hitTest(9999, 9999, geometry)).toEqual({ row: 5, col: 2 });
    // Inside a column gap: stays on the column before it.
    expect(hitTest(210, 0, geometry)).toEqual({ row: 0, col: 1 });
  });

  it("has no cell when the grid is empty or unmeasured", () => {
    expect(hitTest(0, 0, { ...geometry, columnGaps: [] })).toBeNull();
    expect(hitTest(0, 0, { ...geometry, colWidth: 0 })).toBeNull();
  });

  it("builds geometry from the visible columns only", () => {
    const model = buildGrid(
      makeEvent({
        dates: [
          "2026-08-01T16:00:00.000Z",
          "2026-08-05T16:00:00.000Z",
          "2026-08-06T16:00:00.000Z",
        ],
      }),
      { timezoneOffset: PDT },
    );
    const sizes = { colWidth: 100, rowHeight: 20, gapWidth: 20, gapHeight: 40 };
    expect(geometryFor(model, model.columns, sizes).columnGaps).toEqual([false, true, false]);
    // Paging past the gap: the first visible column never draws a leading gap.
    expect(geometryFor(model, model.columns.slice(1), sizes).columnGaps).toEqual([
      false,
      false,
    ]);
  });
});

describe("drag rectangles", () => {
  const model = buildGrid(
    makeEvent({ duration: 2, timeIncrement: 60 }),
    { timezoneOffset: PDT },
  );

  it("covers both corners in any drag direction", () => {
    const forward = rectangleSlots(model, { row: 0, col: 0 }, { row: 1, col: 1 });
    const backward = rectangleSlots(model, { row: 1, col: 1 }, { row: 0, col: 0 });
    expect(forward).toHaveLength(4);
    expect(new Set(backward)).toEqual(new Set(forward));
  });

  it("treats a click as a one-cell rectangle", () => {
    expect(rectangleSlots(model, { row: 0, col: 0 }, { row: 0, col: 0 })).toEqual([
      iso("2026-08-01T16:00:00.000Z"),
    ]);
  });

  it("skips cells that are outside the event", () => {
    const crossing = buildGrid(
      makeEvent({ dates: ["2026-08-01T04:00:00.000Z"], duration: 6, timeIncrement: 60 }),
      { timezoneOffset: PDT },
    );
    // The whole grid: 12 cells, but only 6 are live.
    expect(rectangleSlots(crossing, { row: 0, col: 0 }, { row: 5, col: 1 })).toHaveLength(6);
  });

  it("reports cells inside the live drag preview", () => {
    expect(inRectangle(1, 1, { row: 0, col: 0 }, { row: 2, col: 2 })).toBe(true);
    expect(inRectangle(1, 1, { row: 2, col: 2 }, { row: 0, col: 0 })).toBe(true);
    expect(inRectangle(3, 1, { row: 0, col: 0 }, { row: 2, col: 2 })).toBe(false);
  });
});

describe("undoing a drag", () => {
  describe("snapshotSlots", () => {
    it("sorts a mixed rectangle into what each slot was", () => {
      const available = new Set([1, 2]);
      const ifNeeded = new Set([3]);
      expect(snapshotSlots([1, 2, 3, 4], available, ifNeeded)).toEqual({
        available: [1, 2],
        ifNeeded: [3],
        empty: [4],
      });
    });

    it("records an untouched rectangle as entirely empty", () => {
      expect(snapshotSlots([7, 8], new Set(), new Set())).toEqual({
        available: [],
        ifNeeded: [],
        empty: [7, 8],
      });
    });

    it("counts a repeated slot once", () => {
      expect(snapshotSlots([5, 5, 5], new Set([5]), new Set())).toEqual({
        available: [5],
        ifNeeded: [],
        empty: [],
      });
    });

    it("resolves a slot in both sets as available, the way the grid paints it", () => {
      expect(snapshotSlots([9], new Set([9]), new Set([9]))).toEqual({
        available: [9],
        ifNeeded: [],
        empty: [],
      });
    });

    it("keeps its own copy, so later edits cannot rewrite the past", () => {
      const available = new Set([1]);
      const snapshot = snapshotSlots([1, 2], available, new Set());
      available.add(2);
      expect(snapshot).toEqual({ available: [1], ifNeeded: [], empty: [2] });
    });
  });

  describe("revertOperations", () => {
    it("clears what was empty and re-marks what was marked", () => {
      expect(
        revertOperations({ available: [1], ifNeeded: [2], empty: [3] }),
      ).toEqual([
        { emit: "paint", type: "remove", slots: [3] },
        { emit: "flip", type: "available", slots: [1] },
        { emit: "flip", type: "if_needed", slots: [2] },
      ]);
    });

    it("emits nothing for a bucket with nothing in it", () => {
      expect(revertOperations({ available: [], ifNeeded: [], empty: [4, 5] })).toEqual([
        { emit: "paint", type: "remove", slots: [4, 5] },
      ]);
      expect(revertOperations({ available: [6], ifNeeded: [], empty: [] })).toEqual([
        { emit: "flip", type: "available", slots: [6] },
      ]);
    });

    it("has nothing to say about a rectangle with no slots", () => {
      expect(revertOperations({ available: [], ifNeeded: [], empty: [] })).toEqual([]);
    });

    it("round-trips a paint back to exactly what was there before", () => {
      const availability = new Set([10]);
      const ifNeeded = new Set([11]);
      const rectangle = [10, 11, 12];

      const snapshot = snapshotSlots(rectangle, availability, ifNeeded);

      // What the parent does with a paint: every slot becomes available.
      const apply = (op: { type: string; slots: number[] }) => {
        for (const s of op.slots) {
          if (op.type === "available") {
            availability.add(s);
            ifNeeded.delete(s);
          } else if (op.type === "if_needed") {
            ifNeeded.add(s);
            availability.delete(s);
          } else {
            availability.delete(s);
            ifNeeded.delete(s);
          }
        }
      };
      apply({ type: "available", slots: rectangle });
      expect([...availability].sort()).toEqual([10, 11, 12]);

      for (const op of revertOperations(snapshot)) apply(op);
      expect([...availability]).toEqual([10]);
      expect([...ifNeeded]).toEqual([11]);
    });

    it("round-trips an erase across a mixed rectangle", () => {
      const availability = new Set([20, 21]);
      const ifNeeded = new Set([22]);
      const rectangle = [20, 21, 22, 23];

      const snapshot = snapshotSlots(rectangle, availability, ifNeeded);
      for (const s of rectangle) {
        availability.delete(s);
        ifNeeded.delete(s);
      }
      expect(availability.size + ifNeeded.size).toBe(0);

      for (const op of revertOperations(snapshot)) {
        for (const s of op.slots) {
          if (op.type === "available") availability.add(s);
          else if (op.type === "if_needed") ifNeeded.add(s);
        }
      }
      expect([...availability].sort()).toEqual([20, 21]);
      expect([...ifNeeded]).toEqual([22]);
    });
  });
});

// ---------------------------------------------------------------------------
// resizing a selection that has already landed
// ---------------------------------------------------------------------------

describe("resizing a committed selection", () => {
  describe("selectionDelta", () => {
    it("says what came in and what went out", () => {
      expect(selectionDelta([1, 2, 3], [2, 3, 4])).toEqual({
        entering: [4],
        leaving: [1],
      });
    });

    it("has nothing to report when the rectangle did not move", () => {
      expect(selectionDelta([1, 2], [2, 1])).toEqual({ entering: [], leaving: [] });
    });

    it("reads a repeated slot once, on either side", () => {
      expect(selectionDelta([1, 1], [1, 1, 2, 2])).toEqual({ entering: [2], leaving: [] });
    });

    it("handles a rectangle dragged clean off its old ground", () => {
      expect(selectionDelta([1, 2], [8, 9])).toEqual({
        entering: [8, 9],
        leaving: [1, 2],
      });
    });
  });

  describe("selectionCorners", () => {
    it("gives the named corner and pins the opposite one", () => {
      const a = { row: 2, col: 1 };
      const b = { row: 5, col: 4 };
      expect(selectionCorners(a, b, "from")).toEqual({
        moving: { row: 2, col: 1 },
        anchor: { row: 5, col: 4 },
      });
      expect(selectionCorners(a, b, "to")).toEqual({
        moving: { row: 5, col: 4 },
        anchor: { row: 2, col: 1 },
      });
    });

    it("does not care which way round the corners were stored", () => {
      const forwards = selectionCorners({ row: 1, col: 1 }, { row: 4, col: 3 }, "from");
      const backwards = selectionCorners({ row: 4, col: 3 }, { row: 1, col: 1 }, "from");
      expect(forwards).toEqual(backwards);
    });

    it("reads a single cell as both corners", () => {
      const cell = { row: 3, col: 3 };
      expect(selectionCorners(cell, cell, "from")).toEqual({ moving: cell, anchor: cell });
      expect(selectionCorners(cell, cell, "to")).toEqual({ moving: cell, anchor: cell });
    });
  });

  describe("selectionStep", () => {
    const empty = { available: [], ifNeeded: [], empty: [] };

    it("paints what arrived and puts back what left", () => {
      const step = selectionStep({
        previous: [1, 2],
        next: [2, 3],
        snapshot: { available: [], ifNeeded: [], empty: [1, 2] },
        availability: new Set([1, 2]),
        ifNeeded: new Set(),
      });
      expect(step.entering).toEqual([3]);
      // Slot 1 was empty before the selection ever reached it, so it goes back
      // to empty — and nothing is said about slot 2, which never left.
      expect(step.restore).toEqual([{ emit: "paint", type: "remove", slots: [1] }]);
      expect(step.slots.sort()).toEqual([2, 3]);
    });

    it("remembers a slot as it found it, not as the selection left it", () => {
      // Slot 3 arrives while empty and is painted. It leaves, is restored, and
      // arrives again — and the record must still say "empty", or the undo would
      // leave the selection's own paint behind.
      const first = selectionStep({
        previous: [1],
        next: [1, 3],
        snapshot: { available: [], ifNeeded: [], empty: [1] },
        availability: new Set([1]),
        ifNeeded: new Set(),
      });
      expect(first.snapshot.empty.sort()).toEqual([1, 3]);

      const again = selectionStep({
        previous: [1],
        next: [1, 3],
        snapshot: first.snapshot,
        // Slot 3 is marked at this point: it was painted, then restored, and the
        // grid is mid-flight. Either way the record must not be rewritten.
        availability: new Set([1, 3]),
        ifNeeded: new Set(),
      });
      expect(again.snapshot).toEqual(first.snapshot);
    });

    it("records what a slot actually held, mixed rectangle and all", () => {
      const step = selectionStep({
        previous: [],
        next: [1, 2, 3],
        snapshot: empty,
        availability: new Set([1]),
        ifNeeded: new Set([2]),
      });
      expect(step.snapshot).toEqual({ available: [1], ifNeeded: [2], empty: [3] });
      expect(step.restore).toEqual([]);
      expect(step.entering.sort()).toEqual([1, 2, 3]);
    });

    it("restores each departing slot to its own former state", () => {
      const step = selectionStep({
        previous: [1, 2, 3],
        next: [3],
        snapshot: { available: [1], ifNeeded: [2], empty: [3] },
        availability: new Set([1, 2, 3]),
        ifNeeded: new Set(),
      });
      expect(step.restore).toEqual([
        { emit: "flip", type: "available", slots: [1] },
        { emit: "flip", type: "if_needed", slots: [2] },
      ]);
      // Slot 3 is still in the rectangle, so nothing is said about it.
      expect(step.entering).toEqual([]);
    });

    it("survives a whole resize and undoes it in one go", () => {
      // The grid's own state, and the two emits the parent turns into marks.
      const availability = new Set([200, 201]);
      const ifNeeded = new Set([202]);
      const before = { available: [...availability], ifNeeded: [...ifNeeded] };

      const apply = (type: string, slots: number[]) => {
        for (const s of slots) {
          if (type === "available") {
            availability.add(s);
            ifNeeded.delete(s);
          } else if (type === "if_needed") {
            ifNeeded.add(s);
            availability.delete(s);
          } else {
            availability.delete(s);
            ifNeeded.delete(s);
          }
        }
      };

      // A tap on 100, then a handle dragged out over 101..203 and back in again,
      // crossing slots that were empty, available and if-needed.
      let slots: number[] = [100];
      let snapshot = snapshotSlots(slots, availability, ifNeeded);
      apply("available", slots);

      for (const next of [
        [100, 101],
        [100, 101, 102, 200],
        [100, 101, 102, 200, 201, 202, 203],
        [100, 101, 102],
        [100, 101],
      ]) {
        const step = selectionStep({
          previous: slots,
          next,
          snapshot,
          availability,
          ifNeeded,
        });
        for (const op of step.restore) apply(op.type, op.slots);
        if (step.entering.length > 0) apply("available", step.entering);
        snapshot = step.snapshot;
        slots = step.slots;
      }

      // Everything the handle passed over and let go of is already back.
      expect([...availability].sort()).toEqual([100, 101, 200, 201]);
      expect([...ifNeeded]).toEqual([202]);

      // And the one revert undoes the whole gesture, not just its last step.
      for (const op of revertOperations(snapshot)) apply(op.type, op.slots);
      expect([...availability].sort()).toEqual(before.available.sort());
      expect([...ifNeeded].sort()).toEqual(before.ifNeeded.sort());
    });

    it("undoes a deletion region grown and shrunk the same way", () => {
      const availability = new Set([300, 301, 302]);
      const ifNeeded = new Set([303]);
      const apply = (type: string, slots: number[]) => {
        for (const s of slots) {
          if (type === "available") {
            availability.add(s);
            ifNeeded.delete(s);
          } else if (type === "if_needed") {
            ifNeeded.add(s);
            availability.delete(s);
          } else {
            availability.delete(s);
            ifNeeded.delete(s);
          }
        }
      };

      let slots: number[] = [300];
      let snapshot = snapshotSlots(slots, availability, ifNeeded);
      apply("remove", slots);

      for (const next of [
        [300, 301],
        [300, 301, 302, 303],
        [300, 301],
      ]) {
        const step = selectionStep({ previous: slots, next, snapshot, availability, ifNeeded });
        for (const op of step.restore) apply(op.type, op.slots);
        if (step.entering.length > 0) apply("remove", step.entering);
        snapshot = step.snapshot;
        slots = step.slots;
      }

      // 302 and 303 were let go of, so their marks are back — including the
      // if-needed one, which must not come back as plain available.
      expect([...availability].sort()).toEqual([302]);
      expect([...ifNeeded]).toEqual([303]);

      for (const op of revertOperations(snapshot)) apply(op.type, op.slots);
      expect([...availability].sort()).toEqual([300, 301, 302]);
      expect([...ifNeeded]).toEqual([303]);
    });
  });
});

describe("selectionPress", () => {
  const selection = { start: { row: 2, col: 1 }, end: { row: 4, col: 3 } };
  /** A press on the cells, at the cell given. */
  const onCell = (cell: { row: number; col: number } | null) => ({
    selection,
    onControls: false,
    onCells: true,
    cell,
  });

  it("gives a press on the strip or a handle to the selection itself", () => {
    expect(
      selectionPress({ selection, onControls: true, onCells: false, cell: null }),
    ).toBe("use");
  });

  it("leaves a press inside the rectangle as the ordinary tap it was", () => {
    expect(selectionPress(onCell({ row: 3, col: 2 }))).toBe("select");
    // The corners are inside it too.
    expect(selectionPress(onCell({ row: 2, col: 1 }))).toBe("select");
    expect(selectionPress(onCell({ row: 4, col: 3 }))).toBe("select");
  });

  it("spends a press on the cells around it on the dismissal", () => {
    // One row above, one column left, and far away: all the same answer, and in
    // particular none of them is a new selection.
    expect(selectionPress(onCell({ row: 1, col: 2 }))).toBe("deselect");
    expect(selectionPress(onCell({ row: 3, col: 0 }))).toBe("deselect");
    expect(selectionPress(onCell({ row: 9, col: 9 }))).toBe("deselect");
  });

  it("dismisses on a press that missed the cells altogether", () => {
    expect(
      selectionPress({ selection, onControls: false, onCells: false, cell: { row: 3, col: 2 } }),
    ).toBe("deselect");
    // Nor does a press on the cells that hit-tested to nothing draw anything.
    expect(selectionPress(onCell(null))).toBe("deselect");
  });

  it("lets the tap after it draw, the chart now being clear", () => {
    expect(
      selectionPress({
        selection: null,
        onControls: false,
        onCells: true,
        cell: { row: 1, col: 2 },
      }),
    ).toBe("select");
  });

  it("does not care which way round the selection's corners were stored", () => {
    const flipped = { start: { row: 4, col: 3 }, end: { row: 2, col: 1 } };
    const inside = { onControls: false, onCells: true, cell: { row: 3, col: 2 } };
    expect(selectionPress({ selection: flipped, ...inside })).toBe("select");
    expect(
      selectionPress({ selection: flipped, ...inside, cell: { row: 5, col: 2 } }),
    ).toBe("deselect");
  });
});

describe("responses and heatmap", () => {
  const event = makeEvent({
    duration: 2,
    timeIncrement: 60,
    responses: {
      ada: {
        displayName: "Ada",
        availability: ["2026-08-01T16:00:00.000Z", "2026-08-01T17:00:00.000Z"],
        ifNeeded: [],
        updatedAt: "2026-07-02T00:00:00.000Z",
      },
      grace: {
        displayName: "Grace",
        availability: ["2026-08-01T16:00:00.000Z"],
        ifNeeded: ["2026-08-01T17:00:00.000Z"],
        updatedAt: "2026-07-02T00:00:00.000Z",
      },
    },
  });

  it("inverts responses into slot -> respondents", () => {
    const index = buildResponseIndex(event);
    expect(index.keys).toEqual(["ada", "grace"]);
    expect(index.available.get(iso("2026-08-01T16:00:00.000Z"))).toEqual(
      new Set(["ada", "grace"]),
    );
    // If-needed counts towards availability, and is tracked separately for tinting.
    expect(index.available.get(iso("2026-08-01T17:00:00.000Z"))).toEqual(
      new Set(["ada", "grace"]),
    );
    expect(index.ifNeeded.get(iso("2026-08-01T17:00:00.000Z"))).toEqual(new Set(["grace"]));
    expect(index.ifNeeded.get(iso("2026-08-01T16:00:00.000Z"))).toBeUndefined();
  });

  it("keeps the spelling of every key, and orders the list by it", () => {
    // A key is what everything matches on; it is not a name, and nothing may
    // read one off the other. The stored display name is the only spelling.
    const index = buildResponseIndex(
      makeEvent({
        duration: 2,
        timeIncrement: 60,
        responses: {
          zed: {
            displayName: "Zed",
            availability: ["2026-08-01T16:00:00.000Z"],
            ifNeeded: [],
            updatedAt: "",
          },
          "ada-lovelace": {
            displayName: "Ada Lovelace",
            availability: ["2026-08-01T16:00:00.000Z"],
            ifNeeded: [],
            updatedAt: "",
          },
          écureuil: {
            displayName: "Écureuil",
            availability: ["2026-08-01T17:00:00.000Z"],
            ifNeeded: [],
            updatedAt: "",
          },
        },
      }),
    );

    expect(index.labels.get("ada-lovelace")).toBe("Ada Lovelace");
    expect(index.labels.get("écureuil")).toBe("Écureuil");
    expect(index.labels.get("zed")).toBe("Zed");
    expect(index.labels.size).toBe(3);

    // Ordered by the name each is shown under: sorting the keys themselves
    // would file "écureuil" after "zed", which is not where the eye looks.
    expect(index.keys).toEqual(["ada-lovelace", "écureuil", "zed"]);
  });

  it("replaces a respondent's saved answer with their unsaved edits", () => {
    const index = buildResponseIndex(event, {
      key: "grace",
      displayName: "Grace",
      availability: new Set([iso("2026-08-02T16:00:00.000Z")]),
      ifNeeded: new Set(),
    });
    expect(index.keys).toEqual(["ada", "grace"]);
    expect(index.available.get(iso("2026-08-01T16:00:00.000Z"))).toEqual(new Set(["ada"]));
    expect(index.available.get(iso("2026-08-02T16:00:00.000Z"))).toEqual(new Set(["grace"]));
  });

  it("counts a new guest who has not saved yet", () => {
    const index = buildResponseIndex(event, {
      key: "alan",
      displayName: "Alan",
      availability: new Set([iso("2026-08-01T16:00:00.000Z")]),
      ifNeeded: new Set(),
    });
    expect(index.keys).toEqual(["ada", "alan", "grace"]);
    expect(index.labels.get("alan")).toBe("Alan");
    expect(index.available.get(iso("2026-08-01T16:00:00.000Z"))?.size).toBe(3);
  });

  it("drops a respondent whose override is empty, saved answer and all", () => {
    // What the Clear button leaves behind: the server deletes the record, so
    // the list must not keep showing Grace off the stale copy of the event.
    const index = buildResponseIndex(event, {
      key: "grace",
      displayName: "Grace",
      availability: new Set(),
      ifNeeded: new Set(),
    });
    expect(index.keys).toEqual(["ada"]);
    expect(index.available.get(iso("2026-08-01T16:00:00.000Z"))).toEqual(new Set(["ada"]));
    expect(index.ifNeeded.get(iso("2026-08-01T17:00:00.000Z"))).toBeUndefined();
  });

  it("does not list a guest who has identified but marked nothing", () => {
    const index = buildResponseIndex(event, {
      key: "alan",
      displayName: "Alan",
      availability: new Set(),
      ifNeeded: new Set(),
    });
    expect(index.keys).toEqual(["ada", "grace"]);
  });

  it("keeps an override that holds only if-needed slots", () => {
    const index = buildResponseIndex(event, {
      key: "alan",
      displayName: "Alan",
      availability: new Set(),
      ifNeeded: new Set([iso("2026-08-01T16:00:00.000Z")]),
    });
    expect(index.keys).toEqual(["ada", "alan", "grace"]);
    expect(index.ifNeeded.get(iso("2026-08-01T16:00:00.000Z"))).toEqual(new Set(["alan"]));
  });

  it("takes the maximum over live slots only", () => {
    const model = buildGrid(event, { timezoneOffset: PDT });
    expect(maxRespondents(model, buildResponseIndex(event))).toBe(2);

    // A slot left behind by an edit to the event must not inflate the maximum.
    const stale = makeEvent({
      duration: 2,
      timeIncrement: 60,
      responses: {
        ada: {
          displayName: "Ada",
          availability: ["2025-01-01T00:00:00.000Z"],
          ifNeeded: [],
          updatedAt: "2026-07-02T00:00:00.000Z",
        },
      },
    });
    expect(maxRespondents(buildGrid(stale, { timezoneOffset: PDT }), buildResponseIndex(stale))).toBe(0);
  });

  it("scales alpha across 225 steps, saturating when everyone is free", () => {
    expect(heatmapAlpha255(0, 3, 3)).toBe(0);
    expect(heatmapAlpha255(1, 3, 5)).toBe(75);
    expect(heatmapAlpha255(2, 3, 5)).toBe(150);
    expect(heatmapAlpha255(3, 3, 5)).toBe(225);
    // Everyone who responded is available here.
    expect(heatmapAlpha255(3, 3, 3)).toBe(255);
  });

  it("composites the alpha onto the theme's base green", () => {
    expect(heatmapColor(0, 3, 3)).toBeNull();
    // Defaults to the light-theme value of --color-slot-available.
    expect(heatmapColor(3, 3, 5)).toBe("rgba(0, 153, 76, 0.882)");
    expect(heatmapColor(3, 3, 3)).toBe("rgba(0, 153, 76, 1.000)");
    expect(heatmapColor(1, 40, 40)).toBe("rgba(0, 153, 76, 0.020)");
  });

  it("takes the base color from the caller, so dark mode re-tints", () => {
    const dark = { r: 53, g: 208, b: 127 };
    expect(heatmapColor(3, 3, 3, dark)).toBe("rgba(53, 208, 127, 1.000)");
  });

  it("treats best times as the joint maxima", () => {
    expect(isBestTime(3, 3)).toBe(true);
    expect(isBestTime(2, 3)).toBe(false);
    expect(isBestTime(0, 0)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// what one slot says about everybody
// ---------------------------------------------------------------------------

describe("slotDigest", () => {
  const morning = iso("2026-08-01T16:00:00.000Z");
  const noon = iso("2026-08-01T17:00:00.000Z");

  const event = makeEvent({
    duration: 2,
    timeIncrement: 60,
    responses: {
      bo: {
        displayName: "Bo",
        availability: [],
        ifNeeded: ["2026-08-01T16:00:00.000Z"],
        updatedAt: "",
      },
      ada: {
        displayName: "Ada",
        availability: ["2026-08-01T16:00:00.000Z", "2026-08-01T17:00:00.000Z"],
        ifNeeded: [],
        updatedAt: "",
      },
      cy: {
        displayName: "Cy",
        availability: ["2026-08-01T17:00:00.000Z"],
        ifNeeded: [],
        updatedAt: "",
      },
    },
  });
  const index = buildResponseIndex(event);

  it("groups the three answers, keeping names alphabetical inside each", () => {
    expect(slotDigest(morning, index)).toEqual({
      people: [
        { key: "ada", label: "Ada", stance: "available" },
        { key: "bo", label: "Bo", stance: "if_needed" },
        { key: "cy", label: "Cy", stance: "unavailable" },
      ],
      hidden: 0,
      free: 2,
      total: 3,
    });
  });

  it("counts if-needed as free, the way the heatmap counts it", () => {
    // Bo would come to the morning if he had to, so the slot has two takers.
    expect(slotDigest(morning, index).free).toBe(2);
    // Nobody said "if needed" at noon, and Bo said nothing at all.
    const atNoon = slotDigest(noon, index);
    expect(atNoon.free).toBe(2);
    expect(atNoon.people.map((p) => p.stance)).toEqual([
      "available",
      "available",
      "unavailable",
    ]);
  });

  it("reads a slot nobody marked as everybody being unavailable", () => {
    const digest = slotDigest(iso("2026-08-02T16:00:00.000Z"), index);
    expect(digest.free).toBe(0);
    expect(digest.total).toBe(3);
    expect(digest.people.every((p) => p.stance === "unavailable")).toBe(true);
  });

  it("names only the people who can make it once it cannot name everybody", () => {
    const digest = slotDigest(morning, index, { cap: 2 });
    // Not the first two of the whole list — the two who could come. An
    // arbitrary subset of the crosses would say nothing.
    expect(digest.people).toEqual([
      { key: "ada", label: "Ada", stance: "available" },
      { key: "bo", label: "Bo", stance: "if_needed" },
    ]);
    // Everyone unnamed is counted, so the card can say how many were left out.
    expect(digest.hidden).toBe(1);
    expect(digest.free).toBe(2);
    expect(digest.total).toBe(3);
  });

  it("names everybody while they fit, crosses included", () => {
    expect(slotDigest(morning, index, { cap: 9 }).hidden).toBe(0);
    const exact = slotDigest(morning, index, { cap: 3 });
    expect(exact.people).toHaveLength(3);
    expect(exact.people.at(-1)).toEqual({ key: "cy", label: "Cy", stance: "unavailable" });
    expect(exact.hidden).toBe(0);
  });

  it("caps the free list too, when even that is longer than the card", () => {
    const busy = makeEvent({
      duration: 2,
      timeIncrement: 60,
      responses: Object.fromEntries(
        ["Ada", "Bo", "Cy", "Dee"].map((name) => [
          userKey(name),
          {
            displayName: name,
            availability: ["2026-08-01T16:00:00.000Z"],
            ifNeeded: [],
            updatedAt: "",
          },
        ]),
      ),
    });
    const digest = slotDigest(morning, buildResponseIndex(busy), { cap: 2 });
    expect(digest.people.map((p) => p.label)).toEqual(["Ada", "Bo"]);
    expect(digest.hidden).toBe(2);
    expect(digest.free).toBe(4);
  });

  it("names nobody when nobody can make it and the list is over the cap", () => {
    // The fraction is the whole answer here: an arbitrary handful of crosses
    // out of many is not a reading of anything.
    const digest = slotDigest(iso("2026-08-02T16:00:00.000Z"), index, { cap: 2 });
    expect(digest.people).toEqual([]);
    expect(digest.hidden).toBe(3);
    expect(digest.free).toBe(0);
  });

  it("has nothing to say about an event nobody has answered", () => {
    const digest = slotDigest(morning, buildResponseIndex(makeEvent({ responses: {} })));
    expect(digest).toEqual({ people: [], hidden: 0, free: 0, total: 0 });
  });

  it("reads the guest's own unsaved marks, like everything else on the page", () => {
    const withMine = buildResponseIndex(event, {
      key: "zed",
      displayName: "Zed",
      availability: new Set([morning]),
      ifNeeded: new Set(),
    });
    const digest = slotDigest(morning, withMine);
    expect(digest.total).toBe(4);
    expect(digest.free).toBe(3);
    expect(digest.people.map((p) => p.label)).toEqual(["Ada", "Zed", "Bo", "Cy"]);
  });
});

// ---------------------------------------------------------------------------
// what a whole region says about everybody
// ---------------------------------------------------------------------------

describe("regionDigest", () => {
  const at = (hour: number) => iso(`2026-08-01T${String(hour).padStart(2, "0")}:00:00.000Z`);
  const [nine, ten, eleven] = [at(16), at(17), at(18)];

  /**
   * Three hours, and one person for each way an answer can fall across them:
   * free throughout, free but qualified in the middle, and missing the last
   * hour entirely.
   */
  const event = makeEvent({
    duration: 3,
    timeIncrement: 60,
    responses: {
      ada: {
        displayName: "Ada",
        availability: [
          "2026-08-01T16:00:00.000Z",
          "2026-08-01T17:00:00.000Z",
          "2026-08-01T18:00:00.000Z",
        ],
        ifNeeded: [],
        updatedAt: "",
      },
      bo: {
        displayName: "Bo",
        availability: ["2026-08-01T16:00:00.000Z", "2026-08-01T18:00:00.000Z"],
        ifNeeded: ["2026-08-01T17:00:00.000Z"],
        updatedAt: "",
      },
      cy: {
        displayName: "Cy",
        availability: ["2026-08-01T16:00:00.000Z", "2026-08-01T17:00:00.000Z"],
        ifNeeded: [],
        updatedAt: "",
      },
    },
  });
  const index = buildResponseIndex(event);

  it("takes the worst thing each person said anywhere in the region", () => {
    const digest = regionDigest([nine, ten, eleven], index);
    expect(digest.people).toEqual([
      { key: "ada", label: "Ada", stance: "available" },
      { key: "bo", label: "Bo", stance: "if_needed" },
      { key: "cy", label: "Cy", stance: "unavailable" },
    ]);
    // Two of three can make the whole block; Cy can make two thirds of it and
    // that is not what the region asked.
    expect(digest.free).toBe(2);
    expect(digest.total).toBe(3);
  });

  it("keeps somebody available only when every cell is an unqualified yes", () => {
    // Cy is available across the first two hours and so counts as available.
    expect(regionDigest([nine, ten], index).people).toEqual([
      { key: "ada", label: "Ada", stance: "available" },
      { key: "cy", label: "Cy", stance: "available" },
      { key: "bo", label: "Bo", stance: "if_needed" },
    ]);
  });

  it("lets one unavailable cell outweigh any number of if-needed ones", () => {
    const digest = regionDigest([ten, eleven], index);
    const bo = digest.people.find((person) => person.key === "bo");
    const cy = digest.people.find((person) => person.key === "cy");
    expect(bo?.stance).toBe("if_needed");
    expect(cy?.stance).toBe("unavailable");
  });

  it("degenerates to the single-slot reading", () => {
    for (const slotMs of [nine, ten, eleven, at(19)]) {
      expect(regionDigest([slotMs], index)).toEqual(slotDigest(slotMs, index));
    }
    expect(regionDigest([ten], index).people).toEqual([
      { key: "ada", label: "Ada", stance: "available" },
      { key: "cy", label: "Cy", stance: "available" },
      { key: "bo", label: "Bo", stance: "if_needed" },
    ]);
  });

  it("ignores a repeated cell, since a region is a set of them", () => {
    expect(regionDigest([nine, nine, ten, nine], index)).toEqual(
      regionDigest([nine, ten], index),
    );
  });

  it("rules everybody out of a region containing an hour nobody marked", () => {
    const digest = regionDigest([nine, at(19)], index);
    expect(digest.free).toBe(0);
    expect(digest.people.every((person) => person.stance === "unavailable")).toBe(true);
  });

  it("excludes people who are only present, having nothing to aggregate", () => {
    // Presence never reaches the response index, so a region cannot invent an
    // opinion for somebody who has marked nothing.
    expect(regionDigest([nine, ten], index).total).toBe(3);
    expect(
      regionDigest([nine], buildResponseIndex(makeEvent({ responses: {} }))),
    ).toEqual({ people: [], hidden: 0, free: 0, total: 0 });
  });

  it("names the people who can make all of it once it cannot name everybody", () => {
    const digest = regionDigest([nine, ten, eleven], index, { cap: 1 });
    expect(digest.people).toEqual([{ key: "ada", label: "Ada", stance: "available" }]);
    expect(digest.hidden).toBe(2);
    expect(digest.free).toBe(2);
  });

  it("clears everybody vacuously when the region holds no live cells", () => {
    const digest = regionDigest([], index);
    expect(digest.free).toBe(3);
    expect(digest.people.every((person) => person.stance === "available")).toBe(true);
  });

  it("reads the guest's own unsaved marks across the region too", () => {
    const withMine = buildResponseIndex(event, {
      key: "zed",
      displayName: "Zed",
      availability: new Set([nine]),
      ifNeeded: new Set([ten]),
    });
    const digest = regionDigest([nine, ten], withMine);
    expect(digest.people.find((person) => person.key === "zed")?.stance).toBe("if_needed");
    expect(digest.total).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// placing something over the chart
// ---------------------------------------------------------------------------

describe("placeOverlay", () => {
  /** Columns from x=50 to x=350; the scrollport runs y=100..500. */
  const field: OverlayField = { left: 50, width: 300, top: 100, height: 400 };
  const size = { width: 100, height: 60 };
  const anchor = { x: 200, y: 300, clearance: 20, gap: 8, above: false };

  it("centres on the point and sits on the preferred side", () => {
    expect(placeOverlay(size, field, anchor)).toEqual({ left: 200, top: 320 });
    expect(placeOverlay(size, field, { ...anchor, above: true })).toEqual({
      left: 200,
      top: 220,
    });
  });

  it("clamps into the columns rather than hanging off either end", () => {
    expect(placeOverlay(size, field, { ...anchor, x: 55 }).left).toBe(100);
    expect(placeOverlay(size, field, { ...anchor, x: 348 }).left).toBe(300);
  });

  it("centres on a field too narrow to clamp in", () => {
    const narrow: OverlayField = { ...field, left: 10, width: 60 };
    expect(placeOverlay(size, narrow, { ...anchor, x: 12 }).left).toBe(40);
  });

  it("flips to the other side when the preferred one falls outside", () => {
    // Near the top: above would start at 20, past the scrollport's own edge.
    expect(placeOverlay(size, field, { ...anchor, y: 110, above: true }).top).toBe(130);
    // Near the bottom: below would end past it, so it goes above instead.
    expect(placeOverlay(size, field, { ...anchor, y: 495, above: false }).top).toBe(415);
  });

  it("clamps when neither side fits", () => {
    const shallow: OverlayField = { ...field, top: 0, height: 70 };
    const top = placeOverlay(size, shallow, { ...anchor, y: 35 }).top;
    expect(top).toBeGreaterThanOrEqual(8);
    expect(top).toBeLessThanOrEqual(Math.max(8, 70 - 60 - 8));
  });

  it("keeps the gap from the field's edges", () => {
    expect(placeOverlay(size, field, { ...anchor, y: 100, above: true }).top).toBe(120);
    expect(placeOverlay(size, field, { ...anchor, y: 500, above: false }).top).toBe(420);
  });
});

describe("scrolling", () => {
  describe("columnWidthFor", () => {
    const base = { perView: 7, gapCount: 0, gapWidth: 16, peek: 15, minWidth: 34 };

    it("spends the whole viewport on an event that fits", () => {
      expect(columnWidthFor({ ...base, availableWidth: 700, columnCount: 5 })).toBe(140);
      expect(columnWidthFor({ ...base, availableWidth: 700, columnCount: 7 })).toBe(100);
    });

    it("budgets the gap spacers when the columns have to fit", () => {
      expect(
        columnWidthFor({ ...base, availableWidth: 700, columnCount: 5, gapCount: 2 }),
      ).toBe(133);
    });

    it("leaves a peek showing once the track overflows", () => {
      // A viewport of columns plus the sliver of the next one, exactly.
      expect(columnWidthFor({ ...base, availableWidth: 700, columnCount: 20 })).toBe(97);
    });

    it("sizes an overflowing track against perView, not the column count", () => {
      const twenty = columnWidthFor({ ...base, availableWidth: 700, columnCount: 20 });
      const fifty = columnWidthFor({ ...base, availableWidth: 700, columnCount: 50 });
      expect(fifty).toBe(twenty);
    });

    it("does not let a gap narrow the columns of a scrolling track", () => {
      // Free scrolling has no pages to keep in step: a break in the dates makes
      // the track longer rather than the columns thinner.
      expect(
        columnWidthFor({ ...base, availableWidth: 700, columnCount: 20, gapCount: 3 }),
      ).toBe(97);
    });

    it("never goes below the minimum, however narrow the viewport", () => {
      expect(columnWidthFor({ ...base, availableWidth: 100, columnCount: 20 })).toBe(34);
      expect(columnWidthFor({ ...base, availableWidth: 100, columnCount: 5 })).toBe(34);
    });

    it("has no width without columns", () => {
      expect(columnWidthFor({ ...base, availableWidth: 700, columnCount: 0 })).toBe(0);
    });
  });

  /**
   * How many columns a viewport holds. On a desktop it is a week and a fact
   * about the layout; on a phone it is a question about the screen, answered
   * by dividing the width by what a column heading needs.
   */
  describe("perViewFor", () => {
    it("shows a week on the desktop, whatever the width", () => {
      expect(perViewFor(1400, false)).toBe(DESKTOP_PER_VIEW);
      expect(perViewFor(900, false)).toBe(DESKTOP_PER_VIEW);
    });

    it("fills a phone's width with columns a heading still fits in", () => {
      // The old brackets gave 3 here, and spent 90px on a column whose heading
      // needs 38.
      expect(perViewFor(360, true)).toBe(6);
      expect(perViewFor(390, true)).toBe(7);
      expect(perViewFor(430, true)).toBe(8);
      expect(perViewFor(768, true)).toBe(15);
    });

    it("grows with the screen rather than in steps", () => {
      let previous = 0;
      for (let width = 280; width <= COMPACT_MAX_WIDTH; width += 10) {
        const columns = perViewFor(width, true);
        expect(columns).toBeGreaterThanOrEqual(previous);
        previous = columns;
      }
    });

    it("leaves every column wide enough for its own date label", () => {
      for (const width of [320, 360, 390, 414, 430, 520, 768, 820]) {
        // What the chart actually has for its columns, past the gutter, the
        // page padding and the peek. "Aug 30" at the compact size is 38px, and
        // a column narrower than that folds its heading in two — which the
        // fixed header height then clips the weekday out of.
        const forColumns = width - 32 - 44 - 15;
        expect(forColumns / perViewFor(width, true)).toBeGreaterThan(38);
      }
    });

    it("never drops below three, however little there is to divide", () => {
      expect(perViewFor(120, true)).toBe(3);
      expect(perViewFor(0, true)).toBe(3);
    });
  });

  describe("scrollStepFor", () => {
    it("steps a viewport, less the peek, so the half-shown column lands", () => {
      expect(scrollStepFor(700, 97, 15)).toBe(685);
    });

    it("never steps less than a column", () => {
      expect(scrollStepFor(120, 200, 15)).toBe(200);
      expect(scrollStepFor(0, 0, 15)).toBe(1);
    });
  });

  describe("scrollEdges", () => {
    it("clips the far end of a track resting at its start", () => {
      expect(scrollEdges(0, 2000, 700)).toEqual({
        atStart: true,
        atEnd: false,
        overflowing: true,
      });
    });

    it("clips the near end of a track resting at its end", () => {
      expect(scrollEdges(1300, 2000, 700)).toEqual({
        atStart: false,
        atEnd: true,
        overflowing: true,
      });
    });

    it("clips both ends anywhere in between", () => {
      expect(scrollEdges(650, 2000, 700)).toEqual({
        atStart: false,
        atEnd: false,
        overflowing: true,
      });
    });

    it("clips nothing when the track fits", () => {
      expect(scrollEdges(0, 700, 700)).toEqual({
        atStart: true,
        atEnd: true,
        overflowing: false,
      });
    });

    it("absorbs sub-pixel layout and overscroll past either end", () => {
      expect(scrollEdges(0.6, 2000, 700).atStart).toBe(true);
      expect(scrollEdges(1299.4, 2000, 700).atEnd).toBe(true);
      // Touch platforms allow the track past its own ends; that is still an end.
      expect(scrollEdges(-40, 2000, 700).atStart).toBe(true);
      expect(scrollEdges(1420, 2000, 700).atEnd).toBe(true);
    });
  });

  describe("edgeScrollDirection", () => {
    const middle = { zone: 30, canScrollBack: true, canScrollForward: true };

    it("stands still through the middle of the chart", () => {
      expect(edgeScrollDirection(200, 600, middle)).toBe(0);
      expect(edgeScrollDirection(31, 600, middle)).toBe(0);
      expect(edgeScrollDirection(569, 600, middle)).toBe(0);
    });

    it("asks for more track inside either zone", () => {
      expect(edgeScrollDirection(30, 600, middle)).toBe(-1);
      expect(edgeScrollDirection(0, 600, middle)).toBe(-1);
      expect(edgeScrollDirection(570, 600, middle)).toBe(1);
      expect(edgeScrollDirection(600, 600, middle)).toBe(1);
    });

    it("counts a pointer dragged clean off the chart as still asking", () => {
      expect(edgeScrollDirection(-120, 600, middle)).toBe(-1);
      expect(edgeScrollDirection(940, 600, middle)).toBe(1);
    });

    it("says nothing at the ends of the track", () => {
      const first = { ...middle, canScrollBack: false };
      expect(edgeScrollDirection(0, 600, first)).toBe(0);
      expect(edgeScrollDirection(590, 600, first)).toBe(1);

      const last = { ...middle, canScrollForward: false };
      expect(edgeScrollDirection(600, 600, last)).toBe(0);
      expect(edgeScrollDirection(10, 600, last)).toBe(-1);
    });

    it("holds an engaged direction through a wider zone", () => {
      const held = { ...middle, active: 1 as const, hysteresis: 15 };
      // Past the plain zone, but not past the one it keeps while running.
      expect(edgeScrollDirection(560, 600, held)).toBe(1);
      expect(edgeScrollDirection(554, 600, held)).toBe(0);
      // The hysteresis belongs to the engaged direction only.
      expect(edgeScrollDirection(40, 600, held)).toBe(0);
      expect(edgeScrollDirection(40, 600, { ...held, active: -1 })).toBe(-1);
    });

    it("leaves a still centre on a viewport narrower than two zones", () => {
      const narrow = { ...middle, zone: 40, active: -1 as const, hysteresis: 20 };
      expect(edgeScrollDirection(24, 50, narrow)).toBe(-1);
      expect(edgeScrollDirection(26, 50, narrow)).toBe(1);
      expect(edgeScrollDirection(25, 50, narrow)).toBe(-1);
    });

    it("does nothing without a zone or a viewport to measure", () => {
      expect(edgeScrollDirection(0, 0, middle)).toBe(0);
      expect(edgeScrollDirection(0, 600, { ...middle, zone: 0 })).toBe(0);
    });
  });

  describe("edgeGlideStep", () => {
    const glide = { speed: 600, carry: 0 };

    it("travels at the given speed, in the direction asked for", () => {
      expect(edgeGlideStep(1, 16, glide).delta).toBeCloseTo(9.6, 5);
      expect(edgeGlideStep(-1, 16, glide).delta).toBeCloseTo(-9.6, 5);
    });

    it("covers the same ground however the frames fall", () => {
      const long = edgeGlideStep(1, 32, glide).delta;
      const short = edgeGlideStep(1, 16, glide).delta * 2;
      expect(long).toBeCloseTo(short, 5);
    });

    it("carries nothing while gliding freely", () => {
      expect(edgeGlideStep(1, 16, glide).carry).toBe(0);
    });

    it("jumps whole columns under reduced motion, carrying the remainder", () => {
      const first = edgeGlideStep(1, 100, { ...glide, snap: 90 });
      expect(first.delta).toBe(0);
      expect(first.carry).toBeCloseTo(60, 5);

      const second = edgeGlideStep(1, 100, { ...glide, snap: 90, carry: first.carry });
      expect(second.delta).toBe(90);
      expect(second.carry).toBeCloseTo(30, 5);
    });

    it("snaps backwards the same way", () => {
      expect(edgeGlideStep(-1, 100, { ...glide, snap: 90 }).delta).toBe(0);
      expect(edgeGlideStep(-1, 100, { ...glide, snap: 90, carry: -60 }).delta).toBe(-90);
    });

    it("clamps a stalled frame rather than lurching across the track", () => {
      expect(edgeGlideStep(1, 5000, glide).delta).toBeCloseTo(60, 5);
    });

    it("stands still without a direction or a speed", () => {
      expect(edgeGlideStep(0, 16, glide)).toEqual({ delta: 0, carry: 0 });
      expect(edgeGlideStep(1, 16, { speed: 0, carry: 40 })).toEqual({ delta: 0, carry: 0 });
    });
  });
});
