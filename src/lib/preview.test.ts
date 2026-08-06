import { describe, expect, it } from "vitest";
import {
  buildPreview,
  previewChartWidth,
  PREVIEW_VIEWPORT_COMPACT,
  PREVIEW_VIEWPORT_DESKTOP,
} from "./preview";
import { DESKTOP_PER_VIEW, heatmapAlpha255, perViewFor } from "./grid";
import type { EventDoc } from "./event";

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

const answer = (availability: string[], ifNeeded: string[] = []) => ({
  displayName: "X",
  availability,
  ifNeeded,
  updatedAt: "2026-07-01T00:00:00.000Z",
});

describe("buildPreview — the grid model", () => {
  it("lays the grid out at UTC with a 12-hour clock", () => {
    const preview = buildPreview(makeEvent(), false);
    expect(preview.model.timezoneOffset).toBe(0);
    expect(preview.model.rows[0].localTimeNum).toBe(16);
    expect(preview.model.rows[0].label).toBe("4 pm");
    expect(preview.model.columns).toHaveLength(2);
  });

  it("is deterministic: two builds render the same cells", () => {
    const event = makeEvent({
      responses: { ada: answer(["2026-08-01T16:00:00.000Z"]) },
    });
    expect(buildPreview(event, true)).toEqual(buildPreview(event, true));
  });
});

describe("buildPreview — cell tones", () => {
  const slots = ["2026-08-01T16:00:00.000Z", "2026-08-01T16:30:00.000Z"];
  const event = makeEvent({
    responses: {
      ada: answer([slots[0], slots[1]]),
      grace: answer([slots[0]]),
    },
  });

  it("scales the heat share exactly as the live heatmap alpha", () => {
    const preview = buildPreview(event, false);
    const [full, half] = preview.cells[0];
    expect(full).toEqual({
      kind: "heat",
      heat: `${((heatmapAlpha255(2, 2, 2) / 255) * 100).toFixed(1)}%`,
    });
    expect(full.heat).toBe("100.0%");
    expect(half).toEqual({
      kind: "heat",
      heat: `${((heatmapAlpha255(1, 2, 2) / 255) * 100).toFixed(1)}%`,
    });
  });

  it("leaves unanswered slots empty", () => {
    const preview = buildPreview(event, false);
    expect(preview.cells[0][2]).toEqual({ kind: "empty" });
    expect(preview.cells[1].every((cell) => cell.kind === "empty")).toBe(true);
  });

  it("tints a single respondent's if-needed slots instead of counting them", () => {
    const preview = buildPreview(
      makeEvent({ responses: { ada: answer([slots[0]], [slots[1]]) } }),
      false,
    );
    expect(preview.cells[0][0].kind).toBe("heat");
    expect(preview.cells[0][1]).toEqual({ kind: "if_needed" });
  });

  it("marks cells outside the event disabled", () => {
    // 20:00 UTC + 8h crosses midnight: the first column's top block is dead.
    const preview = buildPreview(
      makeEvent({ dates: ["2026-08-01T20:00:00.000Z"], duration: 8 }),
      false,
    );
    expect(preview.model.crossesMidnight).toBe(true);
    expect(preview.cells[0][0]).toEqual({ kind: "disabled" });
    expect(preview.cells[0][preview.model.rows.length - 1].kind).toBe("empty");
  });
});

describe("buildPreview — geometry per mode", () => {
  it("sizes a fitting event to fill the nominal chart width", () => {
    const preview = buildPreview(makeEvent(), false);
    expect(preview.colWidth).toBe(Math.floor(previewChartWidth(false) / 2));
    expect(preview.trackWidth).toBe(preview.colWidth * 2);
  });

  it("sizes an overflowing event against the mode's perView", () => {
    const dates = Array.from(
      { length: 10 },
      (_, i) => `2026-08-${String(i + 1).padStart(2, "0")}T16:00:00.000Z`,
    );
    const desktop = buildPreview(makeEvent({ dates }), false);
    expect(desktop.colWidth).toBe(
      Math.floor((previewChartWidth(false) - 15) / DESKTOP_PER_VIEW),
    );

    const compact = buildPreview(makeEvent({ dates }), true);
    const perView = perViewFor(PREVIEW_VIEWPORT_COMPACT, true);
    expect(perView).toBeLessThan(10);
    expect(compact.colWidth).toBe(
      Math.floor((previewChartWidth(true) - 15) / perView),
    );
    expect(compact.colWidth).toBeLessThan(desktop.colWidth);
  });

  it("matches the live grid's row height", () => {
    expect(buildPreview(makeEvent(), false).rowHeight).toBe(30);
    expect(buildPreview(makeEvent({ timeIncrement: 15 }), false).rowHeight).toBe(15);
    expect(buildPreview(makeEvent({ timeIncrement: 5 }), false).rowHeight).toBe(14);
  });

  it("keeps the nominal widths a superset check honest", () => {
    expect(previewChartWidth(true)).toBeLessThan(previewChartWidth(false));
    expect(PREVIEW_VIEWPORT_COMPACT).toBeLessThan(PREVIEW_VIEWPORT_DESKTOP);
  });
});
