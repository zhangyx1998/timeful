/**
 * The availability grid model: turning an event document into columns, rows and
 * slot instants, and back again from pixels.
 *
 * Layout, in legacy terms
 * -----------------------
 * Each event date defines a window of `duration` hours starting at that
 * instant. Rendered in the viewer's timezone, a window may spill past local
 * midnight, so the grid is drawn as two stacked blocks separated by a gap:
 *
 *   top block    — the *tail* of the previous day's window (00:00 -> local end)
 *   bottom block — the *head* of this day's window (local start -> 24:00)
 *
 * Every column is one local calendar day. A column's top block resolves against
 * the event date of the day before; its bottom block against its own day. So the
 * first column has a dead top block, and one extra spillover column is appended
 * after each date whose window crosses midnight. When the window does not cross
 * midnight there is a single block and no gap.
 *
 * Instead of legacy's whole-hour iteration plus a `-0.5` fudge for half-hour
 * timezones, rows here are laid out directly in `timeIncrement` steps: the block
 * boundary is the first slot boundary at or after local midnight, so the split
 * stays aligned to the slot grid in every timezone.
 */
import {
  MS_PER_DAY,
  MS_PER_HOUR,
  civilDateFromDayIndex,
  dateToDowDate,
  dateToTimeNum,
  localDayIndex,
  timeNumToTimeText,
  utcTimeToLocalTime,
  WEEKDAY_LABELS,
  MONTH_LABELS,
} from "./dates";
import { FALLBACK_SLOT_AVAILABLE } from "./colors";
import type { Rgb } from "./colors";
import type { EventDoc, EventResponse } from "./event";

export interface GridRow {
  /** Hours from the owning event date's start instant. */
  hoursOffset: number;
  /** Local hour float at the slot start, e.g. 13.25. */
  localTimeNum: number;
  /** Which block the row belongs to: 0 = top, 1 = bottom. */
  block: 0 | 1;
  /** Rows that start an hour carry the label and a solid gridline. */
  isHourStart: boolean;
  /** Rows on a half hour get a dashed gridline. */
  isHalfHour: boolean;
  label: string;
}

export interface GridColumn {
  /** Local calendar day, as a day count since the epoch. */
  dayIndex: number;
  /** Event date the top block resolves against, if any. */
  topDateMs: number | null;
  /** Event date the bottom block resolves against, if any. */
  bottomDateMs: number | null;
  weekday: string;
  dateLabel: string;
  /** False when the previous column is not the previous calendar day; the grid
   *  draws a gap before such columns. */
  isConsecutive: boolean;
}

export interface GridModel {
  rows: GridRow[];
  columns: GridColumn[];
  topRowCount: number;
  bottomRowCount: number;
  crossesMidnight: boolean;
  slotMinutes: number;
  stepHours: number;
  durationHours: number;
  /** UTC hour float the daily window starts at. */
  startTimeUtc: number;
  timezoneOffset: number;
  /** Weekly events label their columns by weekday only. */
  showDates: boolean;
}

export interface BuildGridOptions {
  timezoneOffset: number;
  hour12?: boolean;
  weekOffset?: number;
  now?: Date;
}

/** Builds the full grid: every column of the event, every row of the window. */
export function buildGrid(event: EventDoc, options: BuildGridOptions): GridModel {
  const { timezoneOffset, hour12 = true, weekOffset = 0, now = new Date() } = options;

  const slotMinutes = event.timeIncrement > 0 ? event.timeIncrement : 15;
  const stepHours = slotMinutes / 60;
  const durationHours = event.duration;

  const dates = [...(event.dates ?? [])]
    .map((iso) => Date.parse(iso))
    .filter((ms) => !Number.isNaN(ms))
    .sort((a, b) => a - b);

  const empty: GridModel = {
    rows: [],
    columns: [],
    topRowCount: 0,
    bottomRowCount: 0,
    crossesMidnight: false,
    slotMinutes,
    stepHours,
    durationHours,
    startTimeUtc: 0,
    timezoneOffset,
    showDates: event.type !== "dow",
  };
  if (dates.length === 0 || durationHours <= 0) return empty;

  const startTimeUtc = dateToTimeNum(dates[0], true);
  const localStart = utcTimeToLocalTime(startTimeUtc, timezoneOffset);

  // The window crosses local midnight when it runs past 24:00. Ending exactly at
  // midnight does not count as a crossing.
  const crossesMidnight = localStart + durationHours > 24 + 1e-9;

  const totalRows = Math.round((durationHours * 60) / slotMinutes);
  const bottomRowCount = crossesMidnight
    ? Math.min(totalRows - 1, Math.max(1, Math.ceil(((24 - localStart) * 60) / slotMinutes)))
    : 0;
  const topRowCount = totalRows - bottomRowCount;

  const rowsPerHour = 60 / slotMinutes;
  const makeRow = (offsetIndex: number, block: 0 | 1, indexInBlock: number): GridRow => {
    const hoursOffset = offsetIndex * stepHours;
    const localTimeNum = utcTimeToLocalTime(startTimeUtc + hoursOffset, timezoneOffset);
    const isHourStart =
      rowsPerHour <= 1 || indexInBlock % Math.round(rowsPerHour) === 0;
    const minuteOfHour = Math.round((localTimeNum % 1) * 60);
    return {
      hoursOffset,
      localTimeNum,
      block,
      isHourStart,
      isHalfHour: !isHourStart && minuteOfHour === 30,
      label: timeNumToTimeText(localTimeNum, hour12),
    };
  };

  const rows: GridRow[] = [];
  // Top block renders first: it holds the tail of the offsets sequence.
  for (let i = 0; i < topRowCount; i += 1) {
    rows.push(makeRow(bottomRowCount + i, 0, i));
  }
  for (let i = 0; i < bottomRowCount; i += 1) {
    rows.push(makeRow(i, 1, i));
  }

  // --- columns -------------------------------------------------------------

  const dateByDay = new Map<number, number>();
  const dayIndexes = new Set<number>();
  for (const ms of dates) {
    const day = localDayIndex(ms, timezoneOffset);
    dateByDay.set(day, ms);
    dayIndexes.add(day);
    if (crossesMidnight) dayIndexes.add(day + 1);
  }

  const sortedDays = [...dayIndexes].sort((a, b) => a - b);
  const columns: GridColumn[] = sortedDays.map((dayIndex, index) => {
    const civil = civilDateFromDayIndex(dayIndex);
    const labelDate =
      event.type === "dow"
        ? dateToDowDate(event.dates, civil, weekOffset, true, event.startOnMonday, now)
        : civil;
    return {
      dayIndex,
      topDateMs: crossesMidnight
        ? dateByDay.get(dayIndex - 1) ?? null
        : dateByDay.get(dayIndex) ?? null,
      bottomDateMs: crossesMidnight ? dateByDay.get(dayIndex) ?? null : null,
      weekday: WEEKDAY_LABELS[labelDate.getUTCDay()],
      dateLabel: `${MONTH_LABELS[labelDate.getUTCMonth()]} ${labelDate.getUTCDate()}`,
      isConsecutive: index === 0 || sortedDays[index - 1] === dayIndex - 1,
    };
  });

  return {
    rows,
    columns,
    topRowCount,
    bottomRowCount,
    crossesMidnight,
    slotMinutes,
    stepHours,
    durationHours,
    startTimeUtc,
    timezoneOffset,
    showDates: event.type !== "dow",
  };
}

/**
 * The absolute instant of a cell, or null when the cell is outside the event
 * (the dead top block of the first column, or the dead bottom block of a
 * trailing spillover column).
 */
export function slotAt(model: GridModel, row: number, col: number): number | null {
  const gridRow = model.rows[row];
  const column = model.columns[col];
  if (!gridRow || !column) return null;
  const base = gridRow.block === 0 ? column.topDateMs : column.bottomDateMs;
  if (base === null) return null;
  return base + gridRow.hoursOffset * MS_PER_HOUR;
}

/** Every live slot instant in the grid. Used for heatmap maxima. */
export function allSlots(model: GridModel): number[] {
  const slots: number[] = [];
  for (let col = 0; col < model.columns.length; col += 1) {
    for (let row = 0; row < model.rows.length; row += 1) {
      const slot = slotAt(model, row, col);
      if (slot !== null) slots.push(slot);
    }
  }
  return slots;
}

// ---------------------------------------------------------------------------
// geometry: pixels <-> cells
// ---------------------------------------------------------------------------

export interface GridGeometry {
  colWidth: number;
  rowHeight: number;
  /** Horizontal spacer drawn before non-consecutive columns. */
  gapWidth: number;
  /** Vertical spacer between the two row blocks. */
  gapHeight: number;
  /** One flag per column: does a gap precede it? */
  columnGaps: boolean[];
  topRowCount: number;
  bottomRowCount: number;
}

export interface Cell {
  row: number;
  col: number;
}

/**
 * Geometry for the whole track: every column of the event is laid out and
 * scrolled through, so this is handed all of them. The first column never draws
 * a leading gap — there is nothing before it to be separated from.
 */
export function geometryFor(
  model: Pick<GridModel, "topRowCount" | "bottomRowCount">,
  columns: GridColumn[],
  sizes: { colWidth: number; rowHeight: number; gapWidth: number; gapHeight: number },
): GridGeometry {
  return {
    ...sizes,
    columnGaps: columns.map((column, index) => index > 0 && !column.isConsecutive),
    topRowCount: model.topRowCount,
    bottomRowCount: model.bottomRowCount,
  };
}

/** Left edge of each column, including the gaps drawn before them. */
export function columnOffsets(geometry: GridGeometry): number[] {
  const offsets: number[] = [];
  let accumulated = 0;
  for (let i = 0; i < geometry.columnGaps.length; i += 1) {
    if (geometry.columnGaps[i]) accumulated += geometry.gapWidth;
    offsets.push(accumulated);
    accumulated += geometry.colWidth;
  }
  return offsets;
}

/** Total rendered width and height of the grid body. */
export function gridSize(geometry: GridGeometry): { width: number; height: number } {
  const gaps = geometry.columnGaps.filter(Boolean).length;
  const rows = geometry.topRowCount + geometry.bottomRowCount;
  return {
    width: geometry.columnGaps.length * geometry.colWidth + gaps * geometry.gapWidth,
    height:
      rows * geometry.rowHeight + (geometry.bottomRowCount > 0 ? geometry.gapHeight : 0),
  };
}

function clamp(value: number, lower: number, upper: number): number {
  if (value < lower) return lower;
  if (value > upper) return upper;
  return value;
}

/**
 * Pixel position (relative to the grid body's top-left) to a cell. Always
 * returns a cell: coordinates outside the body clamp to the nearest one, which
 * is what makes dragging past the edge behave.
 */
export function hitTest(x: number, y: number, geometry: GridGeometry): Cell | null {
  const columnCount = geometry.columnGaps.length;
  const rowCount = geometry.topRowCount + geometry.bottomRowCount;
  if (columnCount === 0 || rowCount === 0) return null;
  if (geometry.colWidth <= 0 || geometry.rowHeight <= 0) return null;

  const offsets = columnOffsets(geometry);
  let col = 0;
  for (let i = 0; i < offsets.length; i += 1) {
    if (x >= offsets[i]) col = i;
    else break;
  }

  const topHeight = geometry.topRowCount * geometry.rowHeight;
  let row: number;
  if (geometry.bottomRowCount === 0 || y < topHeight) {
    row = clamp(Math.floor(y / geometry.rowHeight), 0, geometry.topRowCount - 1);
  } else {
    // Anything at or past the top block — including the gap itself — belongs to
    // the bottom block, never back up to a lesser row.
    const offsetY = y - topHeight - geometry.gapHeight;
    row = clamp(
      geometry.topRowCount + Math.floor(offsetY / geometry.rowHeight),
      geometry.topRowCount,
      rowCount - 1,
    );
  }

  return { row, col: clamp(col, 0, columnCount - 1) };
}

/** Whether a cell falls inside the rectangle spanned by two corners. */
export function inRectangle(row: number, col: number, start: Cell, end: Cell): boolean {
  const withinRows = row >= Math.min(start.row, end.row) && row <= Math.max(start.row, end.row);
  const withinCols = col >= Math.min(start.col, end.col) && col <= Math.max(start.col, end.col);
  return withinRows && withinCols;
}

/** The live slot instants inside a drag rectangle; dead cells are skipped. */
export function rectangleSlots(model: GridModel, start: Cell, end: Cell): number[] {
  const slots: number[] = [];
  const rowFrom = Math.min(start.row, end.row);
  const rowTo = Math.max(start.row, end.row);
  const colFrom = Math.min(start.col, end.col);
  const colTo = Math.max(start.col, end.col);
  for (let col = colFrom; col <= colTo; col += 1) {
    for (let row = rowFrom; row <= rowTo; row += 1) {
      const slot = slotAt(model, row, col);
      if (slot !== null) slots.push(slot);
    }
  }
  return slots;
}

// ---------------------------------------------------------------------------
// responses and heatmap
// ---------------------------------------------------------------------------

export interface ResponseIndex {
  names: string[];
  /** Slot -> everyone counted as available there (includes if-needed). */
  available: Map<number, Set<string>>;
  /** Slot -> everyone who marked it if-needed. */
  ifNeeded: Map<number, Set<string>>;
}

export interface ResponseOverride {
  name: string;
  availability: Set<number>;
  ifNeeded: Set<number>;
}

/**
 * Inverts the event's responses into slot -> respondents maps.
 *
 * `override` swaps in the current guest's unsaved edits so their own drags show
 * up in the group view immediately. An override with nothing marked is not a
 * response at all — the same zero-record invariant the server enforces
 * (ARCHITECTURE.md § API) — so the guest drops out of the respondents list the
 * moment they clear, rather than lingering as a phantom with no availability
 * until the next refresh.
 */
export function buildResponseIndex(
  event: Pick<EventDoc, "responses">,
  override?: ResponseOverride | null,
): ResponseIndex {
  const available = new Map<number, Set<string>>();
  const ifNeeded = new Map<number, Set<string>>();
  const names: string[] = [];

  const add = (map: Map<number, Set<string>>, slot: number, name: string) => {
    let set = map.get(slot);
    if (!set) {
      set = new Set<string>();
      map.set(slot, set);
    }
    set.add(name);
  };

  const record = (name: string, availability: Iterable<number>, needed: Iterable<number>) => {
    names.push(name);
    for (const slot of availability) add(available, slot, name);
    for (const slot of needed) {
      add(available, slot, name);
      add(ifNeeded, slot, name);
    }
  };

  const parse = (values: string[] | undefined) =>
    (values ?? [])
      .map((iso) => Date.parse(iso))
      .filter((ms): ms is number => !Number.isNaN(ms));

  for (const [name, response] of Object.entries(event.responses ?? {})) {
    if (override && override.name === name) continue;
    const typed = response as EventResponse;
    record(name, parse(typed?.availability), parse(typed?.ifNeeded));
  }
  if (override && (override.availability.size > 0 || override.ifNeeded.size > 0)) {
    record(override.name, override.availability, override.ifNeeded);
  }

  names.sort((a, b) => a.localeCompare(b));
  return { names, available, ifNeeded };
}

/** The highest respondent count on any live slot. */
export function maxRespondents(model: GridModel, index: ResponseIndex): number {
  let max = 0;
  for (const slot of allSlots(model)) {
    const count = index.available.get(slot)?.size ?? 0;
    if (count > max) max = count;
  }
  return max;
}

/**
 * Legacy alpha curve: the count is scaled across 225 of the 255 alpha steps so
 * even a single respondent is visible, and a slot everyone answered goes fully
 * opaque.
 */
export function heatmapAlpha255(count: number, max: number, totalRespondents: number): number {
  if (count <= 0 || max <= 0) return 0;
  const fraction = Math.min(count / max, 1);
  if (fraction === 1 && max === totalRespondents) return 255;
  return Math.floor(fraction * 225);
}

/**
 * The fill for a slot, or null when nobody is available.
 *
 * `base` is the theme's `--color-slot-available`, resolved from the DOM by
 * lib/colors.ts — never a hardcoded hex, so the heatmap re-tints when the theme
 * flips (ARCHITECTURE.md § Theming).
 */
export function heatmapColor(
  count: number,
  max: number,
  totalRespondents: number,
  base: Rgb = FALLBACK_SLOT_AVAILABLE,
): string | null {
  const alpha = heatmapAlpha255(count, max, totalRespondents);
  if (alpha <= 0) return null;
  return `rgba(${base.r}, ${base.g}, ${base.b}, ${(alpha / 255).toFixed(3)})`;
}

/** Best-times view is binary: only the joint maxima are painted. */
export function isBestTime(count: number, max: number): boolean {
  return max > 0 && count === max;
}

// ---------------------------------------------------------------------------
// scrolling
// ---------------------------------------------------------------------------
//
// Every column of the event is laid out in one track inside a scroll container,
// and the track can rest anywhere on it. There are no pages: what used to be a
// page is now just the width of the viewport, used to size the columns and to
// step the chevrons. The helpers here are the arithmetic around that — how wide
// a column is, how far a chevron moves, which ends are clipped, and how fast a
// drag held at an edge drags the track along with it.

export interface ColumnWidthOptions {
  /** Inner width of the scroll viewport, past the time gutter. */
  availableWidth: number;
  columnCount: number;
  /** How many columns a viewport holds once the event overflows it. */
  perView: number;
  /** Gap spacers drawn between non-consecutive columns, across the whole track. */
  gapCount: number;
  gapWidth: number;
  /** Sliver of the next column left showing, so the track reads as continuing. */
  peek: number;
  minWidth: number;
}

/**
 * One width for every column, whatever the scroll position.
 *
 * An event small enough to fit spends the whole viewport on its columns and
 * shows no peek: there is nothing past the last column to hint at. Anything
 * larger is sized against `perView`, less the peek — so a column and a sliver of
 * its neighbour fill the viewport exactly.
 *
 * The scrolling case ignores the gap spacers on purpose. Under paging they had
 * to be budgeted for, because a page that straddled a break in the dates would
 * otherwise squeeze its columns narrower than the rest; free scrolling has no
 * pages to keep in step, so a gap simply makes the track a little longer and
 * every column keeps the same width regardless of where the breaks fall.
 */
export function columnWidthFor(options: ColumnWidthOptions): number {
  const { availableWidth, columnCount, perView, gapCount, gapWidth, peek, minWidth } = options;
  if (columnCount <= 0) return 0;
  if (perView > 0 && columnCount <= perView) {
    return Math.max(minWidth, Math.floor((availableWidth - gapCount * gapWidth) / columnCount));
  }
  return Math.max(minWidth, Math.floor((availableWidth - peek) / Math.max(perView, 1)));
}

/**
 * How far one chevron press moves the track: a viewport, less the peek, so the
 * column that was half-showing at the edge lands fully in view rather than
 * being stepped straight over. Never less than a single column, so the button
 * still does something on a viewport barely wider than one.
 */
export function scrollStepFor(viewportWidth: number, colWidth: number, peek: number): number {
  return Math.max(1, colWidth, viewportWidth - peek);
}

export interface ScrollEdges {
  /** Nothing is clipped off the leading edge. */
  atStart: boolean;
  atEnd: boolean;
  /** The track is longer than the viewport, so there is scrolling to be done. */
  overflowing: boolean;
}

/**
 * Which ends of the track are clipped — what the fades draw and what the
 * chevrons' disabled state reports. The tolerance absorbs both sub-pixel
 * layout and the overscroll a touch platform allows past either end.
 */
export function scrollEdges(
  scrollLeft: number,
  scrollWidth: number,
  clientWidth: number,
  epsilon = 1,
): ScrollEdges {
  const furthest = Math.max(0, scrollWidth - clientWidth);
  const position = clamp(scrollLeft, 0, furthest);
  return {
    atStart: position <= epsilon,
    atEnd: position >= furthest - epsilon,
    overflowing: furthest > epsilon,
  };
}

/** Which way a drag held at the edge wants the track to go. */
export type EdgeDirection = -1 | 0 | 1;

export interface EdgeScrollOptions {
  /** How deep into the viewport the trigger zone reaches, in pixels. */
  zone: number;
  /** Is there track left behind / ahead of what is on screen? */
  canScrollBack: boolean;
  canScrollForward: boolean;
  /** The direction already engaged, whose zone is the deeper one. */
  active?: EdgeDirection;
  /** How much deeper an engaged zone reaches before it lets go. */
  hysteresis?: number;
}

/**
 * Whether a pointer at `x` (relative to the viewport's left edge) is asking the
 * track to keep coming — the drag-to-the-edge scroll.
 *
 * Three things keep it from firing when it is not wanted. It reports nothing at
 * an end of the track, so a drag pinned against the last column does not sit
 * there straining. The engaged direction gets a deeper zone, so a pointer
 * resting on the boundary cannot flicker between scrolling and not. And the two
 * zones never meet: on a viewport narrower than two zones each gets half, so
 * there is always somewhere to paint that stands still.
 *
 * Past the edge counts as inside it — dragging clean off the chart is the
 * strongest possible way of asking for more of it, and it matches the way
 * `hitTest` clamps rather than gives up out there.
 */
export function edgeScrollDirection(
  x: number,
  viewportWidth: number,
  options: EdgeScrollOptions,
): EdgeDirection {
  const { zone, canScrollBack, canScrollForward, active = 0, hysteresis = 0 } = options;
  if (viewportWidth <= 0 || zone <= 0) return 0;

  const half = viewportWidth / 2;
  const depth = (direction: EdgeDirection) =>
    Math.min(zone + (active === direction ? Math.max(hysteresis, 0) : 0), half);

  if (canScrollBack && x <= depth(-1)) return -1;
  if (canScrollForward && x >= viewportWidth - depth(1)) return 1;
  return 0;
}

export interface EdgeGlideOptions {
  /** Pixels per second the track travels while the edge is engaged. */
  speed: number;
  /** Distance left over from the last frame, too small to have been applied. */
  carry: number;
  /**
   * Quantise the travel to this step instead of gliding. Set to the column
   * width under `prefers-reduced-motion`, where continuous drift is exactly the
   * kind of motion being asked for less of: the track jumps a column at a time.
   */
  snap?: number;
  /** Longest frame the glide will honour, so a stalled tab cannot lurch. */
  maxFrameMs?: number;
}

/**
 * How far the auto-scroll moves this frame, and what is left to carry into the
 * next one. Time-based rather than per-frame, so the speed is the same on a
 * 60Hz and a 120Hz display; the caller clamps the result to the track by
 * handing it to `scrollLeft`, which cannot go past its own ends.
 */
export function edgeGlideStep(
  direction: EdgeDirection,
  elapsedMs: number,
  options: EdgeGlideOptions,
): { delta: number; carry: number } {
  const { speed, carry, snap = 0, maxFrameMs = 100 } = options;
  if (direction === 0 || speed <= 0) return { delta: 0, carry: 0 };

  const frame = clamp(elapsedMs, 0, Math.max(maxFrameMs, 0));
  const travelled = carry + direction * speed * (frame / 1000);
  if (snap <= 0) return { delta: travelled, carry: 0 };

  const steps = Math.trunc(travelled / snap);
  const delta = steps === 0 ? 0 : steps * snap;
  return { delta, carry: travelled - delta };
}

export { MS_PER_DAY };
