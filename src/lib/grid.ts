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
import type { AvailabilityType, EventDoc, EventResponse } from "./event";

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
// undoing a drag
// ---------------------------------------------------------------------------
//
// A drag is committed the instant it lands, so the way back is not a mode the
// grid stays in but a record of what the slots it touched used to be. The
// rectangle is only known once the drag ends, and nothing the guest owns changes
// while it runs — the marks move when the commit is emitted, not before — so the
// record is taken at commit time, immediately before the emit, and describes the
// state the press started from.
//
// Three buckets, because a mark is one of exactly three things: available,
// if-needed, or nothing. A mixed rectangle is the case that matters — erasing
// across cells that were some of each has to put each one back as it was, not
// blanket-restore the majority.

export interface SlotSnapshot {
  /** Slots that were marked available before the drag. */
  available: number[];
  /** Slots that were marked if-needed before the drag. */
  ifNeeded: number[];
  /** Slots that carried no mark at all. */
  empty: number[];
}

/** What the given slots were, before whatever is about to happen to them. */
export function snapshotSlots(
  slots: Iterable<number>,
  availability: ReadonlySet<number>,
  ifNeeded: ReadonlySet<number>,
): SlotSnapshot {
  const snapshot: SlotSnapshot = { available: [], ifNeeded: [], empty: [] };
  for (const slot of new Set(slots)) {
    // Available wins a slot that somehow sits in both sets, the same way the
    // grid itself paints one: the two marks are exclusive by construction.
    if (availability.has(slot)) snapshot.available.push(slot);
    else if (ifNeeded.has(slot)) snapshot.ifNeeded.push(slot);
    else snapshot.empty.push(slot);
  }
  return snapshot;
}

/** Every slot a record covers, whatever it says about them. */
export function snapshotSlotList(snapshot: SlotSnapshot): number[] {
  return [...snapshot.available, ...snapshot.ifNeeded, ...snapshot.empty];
}

/**
 * A revert expressed in the grid's own two emits, rather than as a private
 * channel back to the parent. `paint` clears, `flip` marks, and the parent's
 * handler for either already queues the autosave — so undoing a drag travels the
 * path a drag travels and reaches the server the same way, with nothing on
 * either side that exists only for undo.
 *
 * Buckets that would move nothing are dropped, so a revert of an untouched
 * rectangle emits nothing at all.
 */
export type RevertOp =
  | { emit: "paint"; type: "remove"; slots: number[] }
  | { emit: "flip"; type: AvailabilityType; slots: number[] };

export function revertOperations(snapshot: SlotSnapshot): RevertOp[] {
  const ops: RevertOp[] = [];
  if (snapshot.empty.length > 0) {
    ops.push({ emit: "paint", type: "remove", slots: snapshot.empty });
  }
  if (snapshot.available.length > 0) {
    ops.push({ emit: "flip", type: "available", slots: snapshot.available });
  }
  if (snapshot.ifNeeded.length > 0) {
    ops.push({ emit: "flip", type: "if_needed", slots: snapshot.ifNeeded });
  }
  return ops;
}

// ---------------------------------------------------------------------------
// resizing a selection that has already landed
// ---------------------------------------------------------------------------
//
// A drag commits once, on release, and the record above is enough to undo it. A
// selection with handles on it commits over and over: every cell the handle
// crosses has to be painted as it arrives and put back as it leaves, and the way
// back has to remain the state before the *first* of those steps rather than the
// state before the last one.
//
// So the record grows instead of being retaken. A cell entering the rectangle is
// recorded the first time it is seen and never again — by then what it holds is
// this selection's own doing, and remembering that would make the undo undo only
// half of itself.

/** Which slots a rectangle has taken in, and which it has let go of. */
export function selectionDelta(
  previous: Iterable<number>,
  next: Iterable<number>,
): { entering: number[]; leaving: number[] } {
  const before = new Set(previous);
  const after = new Set(next);
  const entering: number[] = [];
  const leaving: number[] = [];
  for (const slot of after) if (!before.has(slot)) entering.push(slot);
  for (const slot of before) if (!after.has(slot)) leaving.push(slot);
  return { entering, leaving };
}

/** The part of a record that is about these slots, and no other. */
function pickSnapshot(snapshot: SlotSnapshot, slots: Iterable<number>): SlotSnapshot {
  const wanted = new Set(slots);
  return {
    available: snapshot.available.filter((slot) => wanted.has(slot)),
    ifNeeded: snapshot.ifNeeded.filter((slot) => wanted.has(slot)),
    empty: snapshot.empty.filter((slot) => wanted.has(slot)),
  };
}

/**
 * Adds slots the record has not seen before, reading what they hold now.
 *
 * Slots already in it are left exactly as they are. A cell that was taken in,
 * let go of and taken in again has already been put back to what this remembers,
 * so re-reading it would record the selection's own paint as the state to
 * restore — and the undo would stop halfway.
 */
function growSnapshot(
  snapshot: SlotSnapshot,
  slots: Iterable<number>,
  availability: ReadonlySet<number>,
  ifNeeded: ReadonlySet<number>,
): SlotSnapshot {
  const known = new Set([...snapshot.available, ...snapshot.ifNeeded, ...snapshot.empty]);
  const fresh = [...new Set(slots)].filter((slot) => !known.has(slot));
  if (fresh.length === 0) return snapshot;
  const added = snapshotSlots(fresh, availability, ifNeeded);
  return {
    available: [...snapshot.available, ...added.available],
    ifNeeded: [...snapshot.ifNeeded, ...added.ifNeeded],
    empty: [...snapshot.empty, ...added.empty],
  };
}

export interface SelectionStep {
  /** Emits that put the cells the rectangle has left back as they were. */
  restore: RevertOp[];
  /** Cells it has just taken in, for the caller to paint as it means to. */
  entering: number[];
  /** The record, grown to cover them. */
  snapshot: SlotSnapshot;
  /** Every slot the rectangle now covers. */
  slots: number[];
}

/**
 * One step of a resize: what to put back, what to paint, and what to remember.
 *
 * The caller decides what "paint" means — a creation's chosen type, or a
 * deletion's clearing — because that is the one thing the rectangle's geometry
 * cannot say.
 */
export function selectionStep(options: {
  previous: Iterable<number>;
  next: Iterable<number>;
  snapshot: SlotSnapshot;
  availability: ReadonlySet<number>;
  ifNeeded: ReadonlySet<number>;
}): SelectionStep {
  const { previous, next, snapshot, availability, ifNeeded } = options;
  const { entering, leaving } = selectionDelta(previous, next);
  return {
    restore: revertOperations(pickSnapshot(snapshot, leaving)),
    entering,
    snapshot: growSnapshot(snapshot, entering, availability, ifNeeded),
    slots: [...new Set(next)],
  };
}

/**
 * The rectangle's two opposite corners, as the pair a resize works in: the one
 * being dragged, and the one it is pinned to.
 *
 * A rectangle is a span, so which corner is stored where means nothing to it —
 * which is exactly what lets a handle dragged past its anchor keep working
 * rather than collapsing. `moving` is the corner the named handle sits on: the
 * top-left one, or the bottom-right.
 */
export function selectionCorners(
  a: Cell,
  b: Cell,
  handle: "from" | "to",
): { moving: Cell; anchor: Cell } {
  const minRow = Math.min(a.row, b.row);
  const maxRow = Math.max(a.row, b.row);
  const minCol = Math.min(a.col, b.col);
  const maxCol = Math.max(a.col, b.col);
  const first = { row: minRow, col: minCol };
  const last = { row: maxRow, col: maxCol };
  return handle === "from" ? { moving: first, anchor: last } : { moving: last, anchor: first };
}

// ---------------------------------------------------------------------------
// what a press means while a selection is on the chart
// ---------------------------------------------------------------------------
//
// A selection with handles is not the end of a gesture but the middle of one: it
// sits on the chart waiting to be resized, relabelled or taken back. That makes
// the next press ambiguous in a way a drag's is not, and the ambiguity is worth
// one rule stated in one place.
//
// The rule is that a press outside the selection is spent on putting it away.
// Only that: the marks it left stand, and the press itself paints nothing. A
// selection is something a tap raised, and a tap that both dismissed one thing
// and created another would leave the visitor unable to dismiss without also
// drawing — so the second tap, on an empty chart, is the one that draws.

/**
 * The three things a press can be while a selection is live.
 *
 * - `use` — it landed on the options strip or a handle: the selection's own
 *   controls, which mean what they say.
 * - `select` — an ordinary press on the cells, free to paint: either there is no
 *   selection to protect, or the press landed inside the one there is.
 * - `deselect` — anywhere else: it puts the selection away and does nothing.
 */
export type SelectionPress = "use" | "select" | "deselect";

export function selectionPress(press: {
  /** Corners of the live selection, or null when the chart carries none. */
  selection: { start: Cell; end: Cell } | null;
  /** Whether the press landed on the options strip or on one of the handles. */
  onControls: boolean;
  /** Whether it landed on the cells at all — the page around them is not them. */
  onCells: boolean;
  /** The cell under it, as hit-tested; meaningless unless `onCells`. */
  cell: Cell | null;
}): SelectionPress {
  const { selection, onControls, onCells, cell } = press;
  if (onControls) return "use";
  if (!selection) return onCells ? "select" : "deselect";
  if (onCells && cell && inRectangle(cell.row, cell.col, selection.start, selection.end)) {
    return "select";
  }
  return "deselect";
}

// ---------------------------------------------------------------------------
// placing something over the chart
// ---------------------------------------------------------------------------
//
// Two things float above the grid and both want the same arithmetic: be beside
// the point you are about, and never off the chart. The chart is the widest
// thing on the page and on a phone it is nearly the tallest, so "off the chart"
// is a real risk in both directions rather than a theoretical one.

/** Where a floating box may go: the columns' box, and the scrollport's. */
export interface OverlayField {
  /** Left edge of the day columns, and their width — not the gutter's. */
  left: number;
  width: number;
  /** The scrollport's top edge and height, in the same coordinates. */
  top: number;
  height: number;
}

export interface OverlayAnchor {
  /** The point being annotated. */
  x: number;
  y: number;
  /** How far the box keeps off that point. */
  clearance: number;
  /** How close the box may come to the field's own edges. */
  gap: number;
  /**
   * Whether the box prefers the space *above* the point. A finger covers what
   * it touches and a few millimetres round it, so touch wants above; a cursor
   * hides almost nothing, so a mouse wants below.
   */
  above: boolean;
}

/**
 * Centred on the anchor horizontally and clamped into the columns; above or
 * below it vertically, taking the other side when the preferred one would fall
 * outside the scrollport and clamping when neither fits.
 *
 * `left` is the box's centre — callers translate by -50% — and `top` its top
 * edge. A field narrower than the box has no room to clamp in, so the box is
 * centred on the field and left to overhang symmetrically.
 */
export function placeOverlay(
  size: { width: number; height: number },
  field: OverlayField,
  anchor: OverlayAnchor,
): { left: number; top: number } {
  const left = overlayCenterX(size.width, field, anchor.x);

  const below = anchor.y + anchor.clearance;
  const above = anchor.y - anchor.clearance - size.height;
  const floor = field.top + anchor.gap;
  const ceiling = Math.max(floor, field.top + field.height - size.height - anchor.gap);
  const preferred = anchor.above ? above : below;
  const alternate = anchor.above ? below : above;
  const fits = (value: number) => value >= floor && value <= ceiling;
  const top = fits(preferred)
    ? preferred
    : fits(alternate)
      ? alternate
      : clamp(preferred, floor, ceiling);

  return { left, top };
}

/**
 * The horizontal half of `placeOverlay`, on its own for boxes whose width is a
 * known constant rather than a measurement — the tooltip, whose `max-width` is
 * the number this is called with. One rule for "centred but on the chart",
 * however the caller learned the width.
 */
export function overlayCenterX(
  width: number,
  field: Pick<OverlayField, "left" | "width">,
  x: number,
): number {
  const half = width / 2;
  return field.width <= width
    ? field.left + field.width / 2
    : clamp(x, field.left + half, field.left + field.width - half);
}

// ---------------------------------------------------------------------------
// responses and heatmap
// ---------------------------------------------------------------------------

/**
 * The event's answers, inverted.
 *
 * Everything in here is by **user key**, never by the name a guest typed:
 * matching one person across a response, a presence entry and the visitor's own
 * identity is exactly what a key is for. `labels` is the other half — the
 * spelling each key is rendered as — and nothing outside this module should be
 * deriving one from the other.
 */
export interface ResponseIndex {
  /** Everyone with a stored answer, ordered by the name they are shown under. */
  keys: string[];
  /** Key -> the display name to render for it. */
  labels: Map<string, string>;
  /** Slot -> every key counted as available there (includes if-needed). */
  available: Map<number, Set<string>>;
  /** Slot -> every key that marked it if-needed. */
  ifNeeded: Map<number, Set<string>>;
}

export interface ResponseOverride {
  key: string;
  displayName: string;
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
  const labels = new Map<string, string>();
  const keys: string[] = [];

  const add = (map: Map<number, Set<string>>, slot: number, key: string) => {
    let set = map.get(slot);
    if (!set) {
      set = new Set<string>();
      map.set(slot, set);
    }
    set.add(key);
  };

  const record = (
    key: string,
    displayName: string,
    availability: Iterable<number>,
    needed: Iterable<number>,
  ) => {
    keys.push(key);
    labels.set(key, displayName);
    for (const slot of availability) add(available, slot, key);
    for (const slot of needed) {
      add(available, slot, key);
      add(ifNeeded, slot, key);
    }
  };

  const parse = (values: string[] | undefined) =>
    (values ?? [])
      .map((iso) => Date.parse(iso))
      .filter((ms): ms is number => !Number.isNaN(ms));

  for (const [key, response] of Object.entries(event.responses ?? {})) {
    if (override && override.key === key) continue;
    const typed = response as EventResponse;
    record(key, typed?.displayName || key, parse(typed?.availability), parse(typed?.ifNeeded));
  }
  if (override && (override.availability.size > 0 || override.ifNeeded.size > 0)) {
    record(override.key, override.displayName, override.availability, override.ifNeeded);
  }

  keys.sort((a, b) => (labels.get(a) ?? a).localeCompare(labels.get(b) ?? b) || a.localeCompare(b));
  return { keys, labels, available, ifNeeded };
}

// ---------------------------------------------------------------------------
// one region, per person
// ---------------------------------------------------------------------------
//
// The respondents list answers "who is free here?" beside the chart. On a phone
// it is behind a drawer, which is the wrong place for the answer to the question
// a tap on a cell *is* — so the same reading is composed here and shown over the
// chart, and this is the part of it that is not markup.
//
// A cell is the small case of a region, and the question a region asks is the
// same one in the plural: not "who is free at some point in here" but "who can
// make the whole of it". So a person's stance over a region is the *worst* thing
// they said anywhere inside it — one clash rules them out however free they are
// either side of it, and an if-needed anywhere makes the whole span an if-needed
// for them. Only somebody available in every cell is available for the region.

export type SlotStance = "available" | "if_needed" | "unavailable";

/** What each stance glyph says, for anyone who is not looking at it — one
 *  spelling and one wording wherever a stance is printed. */
export const STANCE_LABELS: Record<SlotStance, string> = {
  available: "Available",
  if_needed: "If needed",
  unavailable: "Unavailable",
};

export interface SlotOpinion {
  /** The respondent's user key, for matching. */
  key: string;
  /** The name to print on the chip. */
  label: string;
  stance: SlotStance;
}

export interface SlotDigest {
  /**
   * The people the digest names, ordered by what they said — available, then
   * if-needed, then unavailable — and alphabetically inside each group, because
   * that is the order the names arrive in.
   */
  people: SlotOpinion[];
  /** How many respondents it did not name. */
  hidden: number;
  /** How many are counted as free: available and if-needed together, as the
   *  heatmap counts them. */
  free: number;
  total: number;
}

/**
 * What every respondent said about one slot, in as many names as will fit. The
 * one-cell case of `regionDigest`, and the whole of what a tooltip or a pinned
 * cell reports.
 */
export function slotDigest(
  slot: number,
  index: ResponseIndex,
  options: { cap?: number } = {},
): SlotDigest {
  return regionDigest([slot], index, options);
}

/**
 * What every respondent said about a whole rectangle of cells, aggregated to one
 * stance each.
 *
 * The aggregation is a floor, not a vote: `unavailable` the moment a person
 * misses a single cell, `if_needed` when they are free throughout but qualified
 * it somewhere, and `available` only when every cell is an unqualified yes. The
 * count beside the names reads the same way, so "4 of 9 free" over a two-hour
 * block means four people can make *all* of it rather than some of it.
 *
 * A one-cell region is the ordinary slot reading, which is why `slotDigest` is
 * this function with one slot in it: there is one definition of what a chip
 * says, and the card cannot drift from the tooltip as the selection grows. A
 * region with no live cells in it at all asks nothing of anybody, so everyone
 * clears it vacuously — the same answer the loop below gives for free.
 *
 * The cap is not a truncation of one list but a choice between two readings.
 * Under it, the digest names everybody — and "who cannot make it" is worth
 * reading when it is three people. Over it, naming an arbitrary six of sixteen
 * crosses says nothing at all, so it names only the people who *can* make it and
 * counts the rest: that is the question the selection asks, and the fraction
 * beside the names already reports the other side of it.
 *
 * Presence never enters this. Somebody who is merely on the page has marked
 * nothing, and "unavailable" would be a lie about them — the same rule the
 * respondents list follows.
 */
export function regionDigest(
  slots: Iterable<number>,
  index: ResponseIndex,
  options: { cap?: number } = {},
): SlotDigest {
  const { cap } = options;
  const cells = [...new Set(slots)];

  const yes: SlotOpinion[] = [];
  const maybe: SlotOpinion[] = [];
  const no: SlotOpinion[] = [];
  for (const key of index.keys) {
    const label = index.labels.get(key) ?? key;
    let stance: SlotStance = "available";
    for (const slot of cells) {
      if (!index.available.get(slot)?.has(key)) {
        stance = "unavailable";
        break;
      }
      if (index.ifNeeded.get(slot)?.has(key)) stance = "if_needed";
    }
    if (stance === "unavailable") no.push({ key, label, stance });
    else if (stance === "if_needed") maybe.push({ key, label, stance });
    else yes.push({ key, label, stance });
  }

  const total = index.keys.length;
  const free = [...yes, ...maybe];
  const everyone = [...free, ...no];
  const limit = cap === undefined || cap < 0 ? everyone.length : cap;
  const people = limit >= everyone.length ? everyone : free.slice(0, limit);

  return {
    people,
    hidden: total - people.length,
    free: free.length,
    total,
  };
}

/**
 * How a fraction of free people reads at a glance: everyone free is the answer
 * you are looking for, nobody free rules the span out, and anything between is
 * a compromise to weigh. The respondents list's header and the region card
 * print the same fraction, so the decision lives once, beside the digest they
 * are both a reading of.
 */
export function toneFor(free: number, total: number): "all" | "some" | "none" {
  return free === 0 ? "none" : free === total ? "all" : "some";
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
 * The width below which the event page stops being a document and becomes an
 * app: the page itself no longer scrolls, and the respondents and the view
 * settings move into drawers.
 */
export const COMPACT_MAX_WIDTH = 820;

/** Columns a desktop viewport holds: a week, which is what the layout is for. */
export const DESKTOP_PER_VIEW = 7;

/**
 * How wide a column wants to be on a phone.
 *
 * Measured against the widest thing a column has to carry: "Aug 30" at the
 * compact heading size is 38 pixels, so this is that plus room to breathe. The
 * heading is what sets the floor rather than an arbitrary count — a column
 * narrow enough to fold its own date in half is not one worth showing, and the
 * header's height is fixed, so folding it hides the weekday above it.
 */
export const TARGET_COL_WIDTH = 44;

/**
 * What the chart never gets: the pinned time gutter, and the page's padding
 * either side of it. The peek is deliberately *not* in here — it is the sliver
 * of the next column, so it belongs to the columns rather than to the chrome.
 */
const COMPACT_CHROME = 76;

/** Columns a viewport holds, which on a phone is a question about its width. */
export function perViewFor(viewportWidth: number, compact: boolean): number {
  if (!compact) return DESKTOP_PER_VIEW;
  // Three is the floor rather than a step: at any width a phone actually has,
  // the division wins — this is for the fold-open-sideways cases and for a
  // viewport nobody has reported yet.
  return Math.max(
    3,
    Math.floor((viewportWidth - COMPACT_CHROME) / TARGET_COL_WIDTH),
  );
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
