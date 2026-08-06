/** The availability grid model: turning an event document into columns, rows and slot instants, and back from pixels. */
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

  // Ending exactly at midnight does not count as a crossing.
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

/** The absolute instant of a cell, or null when the cell is outside the event. */
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

/** Geometry for the whole track; the first column never draws a leading gap. */
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

/** Pixel position to a cell; coordinates outside the body clamp to the nearest one, so dragging past the edge works. */
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
    // The gap belongs to the bottom block, never back up to a lesser row.
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
    // Available wins a slot in both sets; the two marks are exclusive by construction.
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

/** A revert in the grid's own two emits: `paint` clears, `flip` marks. Empty buckets are dropped. */
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

/** Adds slots the record has not seen, reading what they hold now; slots already in it are never re-read. */
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

/** One step of a resize: what to put back, what to paint, and what to remember. */
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

/** `moving` is the corner the named handle sits on, `anchor` its opposite; order-insensitive, so a handle dragged past its anchor keeps working. */
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

/** `use` — the selection's own controls; `select` — an ordinary press, free to paint; `deselect` — puts the selection away and does nothing else. */
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
  /** Whether the box prefers the space above the point: touch wants above (a finger covers what it touches), a mouse below. */
  above: boolean;
}

/** Centred on the anchor and clamped into the field; `left` is the box's centre (callers translate by -50%). */
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

/** The horizontal half of `placeOverlay`, for boxes whose width is a known constant (the tooltip's max-width). */
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

/** The event's answers, inverted. Everything here is by user key, never by the name a guest typed. */
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

/** Inverts responses into slot -> respondents maps. `override` swaps in the guest's unsaved edits; an empty override is no response at all (ARCHITECTURE.md § API). */
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

export type SlotStance = "available" | "if_needed" | "unavailable";

/** One spelling and one wording wherever a stance is printed. */
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
  /** Ordered available, then if-needed, then unavailable; alphabetical inside each group. */
  people: SlotOpinion[];
  /** How many respondents it did not name. */
  hidden: number;
  /** Available and if-needed together, as the heatmap counts them. */
  free: number;
  total: number;
}

/** What every respondent said about one slot: the one-cell case of `regionDigest`. */
export function slotDigest(
  slot: number,
  index: ResponseIndex,
  options: { cap?: number } = {},
): SlotDigest {
  return regionDigest([slot], index, options);
}

/** One stance per person: the worst thing they said anywhere in the region. Over the cap only the people who can make it are named; presence never enters this. */
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

/** How a fraction of free people reads at a glance; the respondents header and the region card share it. */
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

/** Legacy alpha curve: scaled across 225 of 255 steps so one respondent is visible; a slot everyone answered goes opaque. */
export function heatmapAlpha255(count: number, max: number, totalRespondents: number): number {
  if (count <= 0 || max <= 0) return 0;
  const fraction = Math.min(count / max, 1);
  if (fraction === 1 && max === totalRespondents) return 255;
  return Math.floor(fraction * 225);
}

/** The fill for a slot, or null. `base` is the theme's `--color-slot-available`, so the heatmap re-tints on a theme flip (ARCHITECTURE.md § Theming). */
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

// Chart dimensions, shared by the live grid and the SSR preview so the two
// cannot drift apart (ARCHITECTURE.md § Routing / SSR).
export const HOUR_HEIGHT = 60;
export const GAP_WIDTH = 16;
export const GAP_HEIGHT = 28;
export const MIN_COL_WIDTH = 34;
/** Height reserved for the column headers; the gutter's spacer matches it. */
export const HEADER_HEIGHT = 42;
/** How much of the neighbouring column shows past the clipped edge. */
export const PEEK = 15;

/** A slot row's height, floored so tiny increments stay visible. */
export function rowHeightFor(slotMinutes: number): number {
  return Math.max(14, Math.round((HOUR_HEIGHT * slotMinutes) / 60));
}

/** The width below which the event page stops being a document and becomes an app. */
export const COMPACT_MAX_WIDTH = 820;

/** Columns a desktop viewport holds: a week, which is what the layout is for. */
export const DESKTOP_PER_VIEW = 7;

/** What the widest column heading needs — "Aug 30" at the compact size is 38px — plus room to breathe. */
export const TARGET_COL_WIDTH = 48;

/** The pinned time gutter and the page's padding; the peek belongs to the columns, not the chrome. */
const COMPACT_CHROME = 76;

/** Columns a viewport holds, which on a phone is a question about its width. */
export function perViewFor(viewportWidth: number, compact: boolean): number {
  if (!compact) return DESKTOP_PER_VIEW;
  // Three is a floor for viewports narrower than any real phone.
  return Math.max(
    3,
    Math.floor((viewportWidth - COMPACT_CHROME) / TARGET_COL_WIDTH),
  );
}

/** A fitting event spends the whole viewport; an overflowing one is sized against `perView` less the peek, ignoring gap spacers — a gap lengthens the track, not the columns. */
export function columnWidthFor(options: ColumnWidthOptions): number {
  const { availableWidth, columnCount, perView, gapCount, gapWidth, peek, minWidth } = options;
  if (columnCount <= 0) return 0;
  if (perView > 0 && columnCount <= perView) {
    return Math.max(minWidth, Math.floor((availableWidth - gapCount * gapWidth) / columnCount));
  }
  return Math.max(minWidth, Math.floor((availableWidth - peek) / Math.max(perView, 1)));
}

/** One chevron press: a viewport less the peek, so the half-shown column lands fully in view; never less than a column. */
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

/** Which ends are clipped; the tolerance absorbs sub-pixel layout and touch overscroll past either end. */
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

/** The drag-to-the-edge scroll: silent at the track's ends, a deeper zone while engaged (hysteresis), zones capped at half the viewport, and past the edge counts as inside it. */
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
  /** Quantise the travel to this step: the column width under `prefers-reduced-motion`. */
  snap?: number;
  /** Longest frame the glide will honour, so a stalled tab cannot lurch. */
  maxFrameMs?: number;
}

/** This frame's travel and the remainder to carry. Time-based, so the speed matches on 60Hz and 120Hz displays. */
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
