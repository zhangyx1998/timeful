/** The SSR availability preview's pure model: event document -> group heatmap cells (ARCHITECTURE.md § Routing / SSR). */
import {
  buildGrid,
  buildResponseIndex,
  columnWidthFor,
  GAP_WIDTH,
  heatmapAlpha255,
  maxRespondents,
  MIN_COL_WIDTH,
  PEEK,
  perViewFor,
  rowHeightFor,
  slotAt,
  type GridModel,
} from "./grid";
import type { EventDoc } from "./event";

/** Nominal viewports for the server's layout guess; a wrong one costs a reflow at mount. */
export const PREVIEW_VIEWPORT_COMPACT = 390;
export const PREVIEW_VIEWPORT_DESKTOP = 1280;

// Mirrors tokens.css (--page-max 64rem, --page-pad 1rem), the scheduler's
// 14rem side column and 1rem layout gap, and the grid's --gutter per mode.
const PAGE_MAX = 1024;
const PAGE_PAD = 16;
const SIDE_WIDTH = 224;
const LAYOUT_GAP = 16;
const GUTTER_DESKTOP = 56;
const GUTTER_COMPACT = 44;

export interface PreviewCell {
  kind: "disabled" | "empty" | "if_needed" | "heat";
  /** color-mix() share of `--color-slot-available`, e.g. "42.0%". */
  heat?: string;
}

export interface PreviewModel {
  model: GridModel;
  /** One array per column, one cell per row — the template's iteration order. */
  cells: PreviewCell[][];
  colWidth: number;
  rowHeight: number;
  trackWidth: number;
}

/** Width the day columns get inside the nominal viewport, past the pinned gutter. */
export function previewChartWidth(compact: boolean): number {
  if (compact) return PREVIEW_VIEWPORT_COMPACT - 2 * PAGE_PAD - GUTTER_COMPACT;
  return (
    Math.min(PREVIEW_VIEWPORT_DESKTOP, PAGE_MAX) -
    2 * PAGE_PAD -
    SIDE_WIDTH -
    LAYOUT_GAP -
    GUTTER_DESKTOP
  );
}

/**
 * The group heatmap as data. Timezone offset 0 and a 12-hour clock, both
 * deterministic — the same on the server and during hydration — matching the
 * SSR subtitle's UTC rendering; the mounted grid re-lays out in the viewer's
 * own zone and clock.
 */
export function buildPreview(event: EventDoc, compact: boolean): PreviewModel {
  const model = buildGrid(event, { timezoneOffset: 0, hour12: true });
  const index = buildResponseIndex(event);
  const max = maxRespondents(model, index);
  const total = index.keys.length;

  const gapCount = model.columns.filter(
    (column, i) => i > 0 && !column.isConsecutive,
  ).length;
  const colWidth = columnWidthFor({
    availableWidth: previewChartWidth(compact),
    columnCount: model.columns.length,
    perView: perViewFor(
      compact ? PREVIEW_VIEWPORT_COMPACT : PREVIEW_VIEWPORT_DESKTOP,
      compact,
    ),
    gapCount,
    gapWidth: GAP_WIDTH,
    peek: PEEK,
    minWidth: MIN_COL_WIDTH,
  });

  const cells = model.columns.map((_column, col) =>
    model.rows.map((_row, row): PreviewCell => {
      const slot = slotAt(model, row, col);
      if (slot === null) return { kind: "disabled" };
      const count = index.available.get(slot)?.size ?? 0;
      if (count === 0) return { kind: "empty" };
      // One respondent has no gradient; their if-needed slots tint instead.
      if (total === 1 && (index.ifNeeded.get(slot)?.size ?? 0) > 0) {
        return { kind: "if_needed" };
      }
      const alpha = heatmapAlpha255(count, max, total);
      if (alpha <= 0) return { kind: "empty" };
      return { kind: "heat", heat: `${((alpha / 255) * 100).toFixed(1)}%` };
    }),
  );

  return {
    model,
    cells,
    colWidth,
    rowHeight: rowHeightFor(model.slotMinutes),
    trackWidth: model.columns.length * colWidth + gapCount * GAP_WIDTH,
  };
}

declare global {
  interface Window {
    /** The server's layout guess, inlined beside `__EVENT__` so hydration renders the same preview. */
    __PREVIEW__?: { compact: boolean };
  }
}
