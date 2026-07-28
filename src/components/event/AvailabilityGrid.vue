<script setup lang="ts">
/**
 * The scheduling grid.
 *
 * Interaction is one delegated pointer handler on the grid body: positions are
 * hit-tested to (row, col) against measured geometry, and a drag paints the
 * whole rectangle between the press and release cells in one commit. Pointer
 * events cover mouse and touch with the same code path; `touch-action: none`
 * while editing keeps a touch drag from scrolling the chart underneath it.
 *
 * Scrolling
 * ---------
 * Every column of the event is rendered once, in a track inside a **native
 * scroll container**, and the track may rest anywhere on it. Native rather than
 * a transform, because everything a hand-rolled version would have to
 * reimplement badly comes free: momentum and rubber-banding on touch, shift +
 * wheel on the desktop, keyboard scrolling for a focused region, and — the part
 * that matters most here — `getBoundingClientRect()` already carries the scroll
 * offset, so pixel hit-testing needs no arithmetic about where the track is and
 * stays correct mid-momentum, mid-glide and mid-smooth-scroll alike.
 *
 * The time gutter and the day headers live *inside* that container, pinned with
 * `position: sticky` on their own axis. One scrollport rather than three
 * elements kept in sync, and it is what lets the chart become a spreadsheet on a
 * phone: bounded height, both axes scrolling, headings that stay.
 *
 * The controls are knobs laid *over* the chart at its clipped edges, centred on
 * the body, rather than rails beside it: the chart is the widest thing on the
 * page and every pixel spent on a gutter is a pixel of column. Only the knob
 * itself takes the pointer — the fade it sits in does not — so a cell under the
 * fade is painted like any other, and while a paint drag is running the knobs go
 * inert entirely, so a sweep that crosses one paints straight through it instead
 * of scrolling. The columns run under the fade with the next one peeking past
 * it: together they say the grid continues that way.
 *
 * Two ways to move it by hand. A mouse drag anywhere the drag does not already
 * mean something — the whole chart in the group view, the headings and the
 * gutter while editing — grabs the track and pans it, and a movement threshold
 * separates that from the click that pins a slot. Touch is left entirely to the
 * platform.
 *
 * A paint drag held at either clipped edge pulls the track along with it, so a
 * selection can run past the columns that happen to be on screen. It glides
 * continuously now that a resting position need not be aligned to anything;
 * under `prefers-reduced-motion` the same travel is quantised to whole columns,
 * so the track steps rather than drifts. Either way the container clamps itself
 * at its own ends, and every scroll — glide, momentum or chevron — re-hit-tests
 * the held pointer, so the rectangle picks up each column as it arrives rather
 * than jumping when the movement stops.
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import {
  columnOffsets as columnOffsetsOf,
  columnWidthFor,
  edgeGlideStep,
  edgeScrollDirection,
  geometryFor,
  heatmapColor,
  hitTest,
  inRectangle,
  isBestTime,
  rectangleSlots,
  scrollEdges,
  scrollStepFor,
  slotAt,
  type Cell,
  type EdgeDirection,
  type GridModel,
  type ResponseIndex,
} from "../../lib/grid";
import { useSlotBaseColor } from "../../lib/colors";
import { formatSlotRange } from "../../lib/dates";
import IconChevronLeft from "../../assets/icons/chevron-left.svg";
import IconChevronRight from "../../assets/icons/chevron-right.svg";
import IconCheck from "../../assets/icons/check.svg";
import IconHourglass from "../../assets/icons/hourglass.svg";
import type { AvailabilityType, EventDoc } from "../../lib/event";

const props = defineProps<{
  event: EventDoc;
  model: GridModel;
  /** Day columns a viewport holds once the event is wider than one. */
  perView: number;
  editable: boolean;
  availability: Set<number>;
  ifNeeded: Set<number>;
  responseIndex: ResponseIndex;
  maxCount: number;
  totalRespondents: number;
  showBestTimes: boolean;
  highlightRespondent: string | null;
  /** Hovered or pinned slot, outlined in the grid. */
  activeSlot: number | null;
  hour12: boolean;
}>();

const emit = defineEmits<{
  paint: [change: { type: "add" | "remove"; slots: number[] }];
  /** The just-painted rectangle, told what it means. */
  flip: [change: { type: AvailabilityType; slots: number[] }];
  hover: [slot: number | null];
  pin: [slot: number | null];
}>();

defineSlots<{
  /**
   * A row under the chart, laid out to the chart body's exact box: it starts
   * where the day columns start (past the time gutter) and ends where the last
   * column ends. Anything that annotates the chart — the legend, the control
   * that wipes it — belongs to that box rather than to the page's width.
   */
  foot?: () => unknown;
}>();

const HOUR_HEIGHT = 60;
const GAP_WIDTH = 16;
const GAP_HEIGHT = 28;
const MIN_COL_WIDTH = 34;
/** Height reserved for the column headers; the gutter's spacer matches it. */
const HEADER_HEIGHT = 42;
/** Matches `.tooltip { max-width }`; used to keep the bubble on screen. */
const TOOLTIP_MAX_WIDTH = 180;
/**
 * The menu that follows a paint. Its width and height are what the layout is
 * measured against — it is placed before it is drawn, so the numbers have to
 * come from here rather than from the box.
 */
const MENU_WIDTH = 200;
const MENU_WIDTH_TOUCH = 230;
const MENU_HEIGHT = 38;
const MENU_HEIGHT_TOUCH = 50;
/** Clearance between the menu and the rectangle it belongs to. */
const MENU_GAP = 8;
/** How long it waits to be used before it takes itself away. */
const MENU_LINGER_MS = 5000;
/** How much of the neighbouring column shows past the clipped edge. */
const PEEK = 15;
/** How far a mouse has to travel before it is panning rather than clicking. */
const PAN_THRESHOLD = 5;
/**
 * How deep into the chart a drag has to reach for the track to start coming by
 * itself. Roughly the fade's own width, so the zone is the part of the chart
 * that already reads as "the edge" — wider for a finger, which covers more than
 * it points at.
 */
const EDGE_ZONE = 30;
const EDGE_ZONE_TOUCH = 44;
/** Extra depth the engaged zone keeps, so its boundary cannot flutter. */
const EDGE_HYSTERESIS = 14;
/** A pause this long inside the zone means it, rather than passing through. */
const EDGE_DWELL_MS = 200;
/** How fast the track comes while a drag leans on an edge, in px per second. */
const EDGE_SPEED = 620;

const viewport = ref<HTMLElement | null>(null);
const sheet = ref<HTMLElement | null>(null);
const gutter = ref<HTMLElement | null>(null);
const body = ref<HTMLElement | null>(null);

/** The scroll container's own box, and where it sits inside the wrap. */
const viewportWidth = ref(0);
const viewportHeight = ref(0);
const viewportLeft = ref(0);
const gutterWidth = ref(0);
const scrollLeft = ref(0);
const scrollTop = ref(0);
const scrollWidth = ref(0);

/** Width the day columns actually get: the viewport past the pinned gutter. */
const chartWidth = computed(() => Math.max(0, viewportWidth.value - gutterWidth.value));
/** Where the columns begin, relative to the wrap the tooltip is placed in. */
const chartLeft = computed(() => viewportLeft.value + gutterWidth.value);

const reducedMotion = ref(false);
/** Whether the pointer is a finger: the menu is sized for one if it is. */
const coarsePointer = ref(false);

const rowHeight = computed(() =>
  Math.max(14, Math.round((HOUR_HEIGHT * props.model.slotMinutes) / 60)),
);

const columns = computed(() => props.model.columns);

const gapCount = computed(
  () => columns.value.filter((column, index) => index > 0 && !column.isConsecutive).length,
);

// --- layout ---------------------------------------------------------------

const colWidth = computed(() =>
  columnWidthFor({
    availableWidth: chartWidth.value,
    columnCount: columns.value.length,
    perView: props.perView,
    gapCount: gapCount.value,
    gapWidth: GAP_WIDTH,
    peek: PEEK,
    minWidth: MIN_COL_WIDTH,
  }),
);

const geometry = computed(() =>
  geometryFor(props.model, columns.value, {
    colWidth: colWidth.value,
    rowHeight: rowHeight.value,
    gapWidth: GAP_WIDTH,
    gapHeight: GAP_HEIGHT,
  }),
);

const offsets = computed(() => columnOffsetsOf(geometry.value));

const trackWidth = computed(
  () => columns.value.length * colWidth.value + gapCount.value * GAP_WIDTH,
);

/** Which ends are clipped — what the fades draw and the chevrons report. */
const edges = computed(() =>
  scrollEdges(scrollLeft.value, scrollWidth.value, viewportWidth.value),
);
const scrollable = computed(() => edges.value.overflowing);
const moreBefore = computed(() => scrollable.value && !edges.value.atStart);
const moreAfter = computed(() => scrollable.value && !edges.value.atEnd);

function rowTop(row: number): number {
  const { topRowCount } = props.model;
  if (row < topRowCount) return row * rowHeight.value;
  return topRowCount * rowHeight.value + GAP_HEIGHT + (row - topRowCount) * rowHeight.value;
}

// --- measurement ----------------------------------------------------------

let observer: ResizeObserver | null = null;

function readScroll() {
  const element = viewport.value;
  if (!element) return;
  scrollLeft.value = element.scrollLeft;
  scrollTop.value = element.scrollTop;
  scrollWidth.value = element.scrollWidth;
}

/**
 * The scroll container is what the columns have to fit, less whatever the
 * pinned gutter takes off the front of it. Both are read back rather than
 * assumed, so a change to either cannot silently put the columns and the
 * hit-testing out of step.
 */
function measure() {
  const element = viewport.value;
  if (!element) return;
  viewportWidth.value = element.clientWidth;
  viewportHeight.value = element.clientHeight;
  viewportLeft.value = element.offsetLeft;
  gutterWidth.value = gutter.value?.offsetWidth ?? 0;
  readScroll();
}

/**
 * Every scroll re-hit-tests a held pointer. That one line is what keeps a paint
 * drag correct through momentum, a chevron's smooth scroll and the edge glide
 * alike, without any of them having to know about the drag.
 */
function onScroll() {
  readScroll();
  if (dragging.value && lastPointer) {
    const cell = cellFromPoint(lastPointer.x, lastPointer.y);
    if (cell) dragCur.value = cell;
  }
}

onMounted(() => {
  reducedMotion.value = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  coarsePointer.value = window.matchMedia?.("(pointer: coarse)").matches ?? false;
  measure();
  if (typeof ResizeObserver !== "undefined") {
    observer = new ResizeObserver(measure);
    if (viewport.value) observer.observe(viewport.value);
    // The track's own width decides how far there is to scroll.
    if (sheet.value) observer.observe(sheet.value);
  }
  window.addEventListener("resize", measure);
});

onBeforeUnmount(() => {
  observer?.disconnect();
  stopEdgeScroll();
  endPan();
  window.removeEventListener("resize", measure);
  window.removeEventListener("pointerup", endDrag);
});

// A narrower column means a shorter track, which may leave the resting position
// past its own end; the container corrects itself, and this reads it back.
watch([colWidth, () => columns.value.length], () => void nextTick(readScroll));

// --- chevrons -------------------------------------------------------------

/**
 * One viewport per press, smoothly, clamped by the container itself. Instant
 * under `prefers-reduced-motion`: the destination is the point, the travel is
 * not.
 */
function scrollByStep(direction: -1 | 1) {
  const element = viewport.value;
  if (!element) return;
  const step = scrollStepFor(chartWidth.value, colWidth.value, PEEK);
  element.scrollBy({
    left: direction * step,
    behavior: reducedMotion.value ? "auto" : "smooth",
  });
}

// --- panning by mouse ------------------------------------------------------
//
// Touch is the platform's: native scrolling already has the momentum and the
// rubber-banding, and no hand-rolled version of either would be as good. A
// mouse has no such gesture, so it gets one — but only where a drag does not
// already mean something else. In the group view that is the whole chart; while
// editing it is the headings and the gutter, and the body keeps painting.

const panning = ref(false);
let panFrom: { x: number; scroll: number } | null = null;
/** Whether this press has travelled far enough to be a pan and not a click. */
let panMoved = false;

function startPan(event: PointerEvent) {
  const element = viewport.value;
  if (!element || event.pointerType !== "mouse" || !scrollable.value) return;
  panFrom = { x: event.clientX, scroll: element.scrollLeft };
  panMoved = false;
  window.addEventListener("pointermove", onPanMove);
  window.addEventListener("pointerup", endPan);
  window.addEventListener("pointercancel", endPan);
}

function onPanMove(event: PointerEvent) {
  const element = viewport.value;
  if (!element || !panFrom) return;
  const dx = event.clientX - panFrom.x;
  if (!panMoved && Math.abs(dx) < PAN_THRESHOLD) return;
  panMoved = true;
  panning.value = true;
  element.scrollLeft = panFrom.scroll - dx;
  // A tooltip that follows the grid past the pointer is noise, not information.
  if (hoverCell.value) setHover(null);
}

function endPan() {
  window.removeEventListener("pointermove", onPanMove);
  window.removeEventListener("pointerup", endPan);
  window.removeEventListener("pointercancel", endPan);
  panFrom = null;
  panning.value = false;
}

function onViewportPointerDown(event: PointerEvent) {
  if (event.button !== 0 && event.pointerType === "mouse") return;
  if (!event.isPrimary) return;
  // Over the paint surface while editing, the drag belongs to the paint.
  if (props.editable && body.value?.contains(event.target as Node)) return;
  startPan(event);
}

/**
 * Shift + wheel is horizontal scrolling everywhere else, and Chromium gives it
 * to a scroll container for free. Firefox does not deliver it to a container
 * that only overflows on one axis, so it is translated here — and only when
 * there is somewhere to go, leaving the page's own scroll alone otherwise.
 */
function onWheel(event: WheelEvent) {
  const element = viewport.value;
  if (!element || !event.shiftKey || event.deltaX !== 0 || event.deltaY === 0) return;
  if (!scrollable.value) return;
  const before = element.scrollLeft;
  element.scrollLeft = before + event.deltaY;
  if (element.scrollLeft !== before) event.preventDefault();
}

// --- drag -----------------------------------------------------------------

const dragging = ref(false);
const dragType = ref<"add" | "remove">("add");
const dragStart = ref<Cell | null>(null);
const dragCur = ref<Cell | null>(null);
const pressCell = ref<Cell | null>(null);
const hoverCell = ref<Cell | null>(null);

function slotFor(cell: Cell | null): number | null {
  if (!cell) return null;
  return slotAt(props.model, cell.row, cell.col);
}

/**
 * The body's client rect already includes the scroll offset, so pointer
 * coordinates translate into track space without knowing where the track is —
 * mid-glide and mid-momentum as well as at rest.
 */
function cellFromPoint(clientX: number, clientY: number): Cell | null {
  const element = body.value;
  if (!element) return null;
  const rect = element.getBoundingClientRect();
  return hitTest(clientX - rect.left, clientY - rect.top, geometry.value);
}

function cellFromEvent(event: PointerEvent): Cell | null {
  return cellFromPoint(event.clientX, event.clientY);
}

// --- dragging at the edge --------------------------------------------------

/** Which edge the drag is currently leaning on, if any. */
const edgeDir = ref<EdgeDirection>(0);
let edgeTimer: ReturnType<typeof setTimeout> | undefined;
let edgeFrame = 0;
let edgeLast = 0;
/** Travel accumulated but not yet applied — a whole column, under reduced motion. */
let edgeCarry = 0;
/** Where the pointer was last seen, in client coordinates. */
let lastPointer: { x: number; y: number } | null = null;

function cancelEdgeFrame() {
  if (edgeFrame !== 0 && typeof cancelAnimationFrame === "function") {
    cancelAnimationFrame(edgeFrame);
  }
  edgeFrame = 0;
}

function stopEdgeScroll() {
  clearTimeout(edgeTimer);
  edgeTimer = undefined;
  cancelEdgeFrame();
  edgeDir.value = 0;
  edgeCarry = 0;
}

function glide(now: number) {
  edgeFrame = 0;
  const element = viewport.value;
  if (!dragging.value || edgeDir.value === 0 || !element) return;

  const elapsed = edgeLast === 0 ? 0 : now - edgeLast;
  edgeLast = now;
  const step = edgeGlideStep(edgeDir.value, elapsed, {
    speed: EDGE_SPEED,
    carry: edgeCarry,
    snap: reducedMotion.value ? colWidth.value : 0,
  });
  edgeCarry = step.carry;
  // The container clamps at its own ends, so there is nothing else to clamp.
  if (step.delta !== 0) element.scrollLeft += step.delta;

  readScroll();
  // A frame that moved nothing still has to re-hit-test: `onScroll` only fires
  // when the position actually changed, and a held finger sends no moves.
  if (lastPointer) {
    const cell = cellFromPoint(lastPointer.x, lastPointer.y);
    if (cell) dragCur.value = cell;
  }

  const done = edgeDir.value < 0 ? edges.value.atStart : edges.value.atEnd;
  if (done) {
    stopEdgeScroll();
    return;
  }
  edgeFrame = requestAnimationFrame(glide);
}

function startGlide() {
  if (edgeFrame !== 0 || !dragging.value || typeof requestAnimationFrame !== "function") return;
  edgeLast = 0;
  edgeCarry = 0;
  edgeFrame = requestAnimationFrame(glide);
}

function updateEdgeScroll(event: PointerEvent) {
  const element = viewport.value;
  if (!dragging.value || !scrollable.value || !element) {
    stopEdgeScroll();
    return;
  }
  const rect = element.getBoundingClientRect();
  // Measured from where the columns begin: the gutter is pinned over the track
  // and is not part of the field a drag scrolls.
  const direction = edgeScrollDirection(
    event.clientX - rect.left - gutterWidth.value,
    chartWidth.value,
    {
      zone: event.pointerType === "mouse" ? EDGE_ZONE : EDGE_ZONE_TOUCH,
      canScrollBack: moreBefore.value,
      canScrollForward: moreAfter.value,
      active: edgeDir.value,
      hysteresis: EDGE_HYSTERESIS,
    },
  );
  if (direction === edgeDir.value) return;

  clearTimeout(edgeTimer);
  cancelEdgeFrame();
  edgeDir.value = direction;
  edgeCarry = 0;
  if (direction === 0) return;
  edgeTimer = setTimeout(startGlide, EDGE_DWELL_MS);
}

function onPointerDown(event: PointerEvent) {
  // Ignore secondary buttons, and the extra contacts of a multi-touch gesture
  // (a two-finger pinch must not start painting).
  if (event.button !== 0 && event.pointerType === "mouse") return;
  if (!event.isPrimary) return;
  // Whatever the last paint was about, this press is about something else.
  closeMenu();
  const cell = cellFromEvent(event);
  if (!cell) return;
  pressCell.value = cell;
  lastPointer = { x: event.clientX, y: event.clientY };

  if (!props.editable) return;
  const slot = slotFor(cell);
  if (slot === null) return;

  // Marked is marked, whichever of the two it is: pressing a cell you have
  // already claimed gives it back, and pressing an unclaimed one takes it.
  const marked = props.availability.has(slot) || props.ifNeeded.has(slot);
  dragType.value = marked ? "remove" : "add";
  dragging.value = true;
  dragStart.value = cell;
  dragCur.value = cell;

  body.value?.setPointerCapture?.(event.pointerId);
  window.addEventListener("pointerup", endDrag);
  event.preventDefault();
}

function onPointerMove(event: PointerEvent) {
  const cell = cellFromEvent(event);
  if (dragging.value) {
    if (cell) dragCur.value = cell;
    lastPointer = { x: event.clientX, y: event.clientY };
    updateEdgeScroll(event);
    event.preventDefault();
    return;
  }
  if (event.pointerType !== "mouse" || panning.value) return;
  setHover(cell);
}

function setHover(cell: Cell | null) {
  hoverCell.value = cell;
  emit("hover", slotFor(cell));
}

function onPointerLeave() {
  if (dragging.value) return;
  setHover(null);
}

function endDrag(event?: PointerEvent) {
  window.removeEventListener("pointerup", endDrag);
  stopEdgeScroll();

  if (dragging.value && dragStart.value && dragCur.value) {
    const slots = rectangleSlots(props.model, dragStart.value, dragCur.value);
    if (slots.length > 0) {
      emit("paint", { type: dragType.value, slots });
      // Only a rectangle that was just claimed has a meaning to choose; one
      // that was just given up has none.
      if (dragType.value === "add") openMenu(dragStart.value, dragCur.value, slots);
    }
  } else if (!props.editable && pressCell.value && event && !panMoved) {
    // A tap or click in the group view pins the slot under the pointer — unless
    // the press turned out to be a pan, which is a different gesture entirely.
    const cell = cellFromEvent(event) ?? pressCell.value;
    if (cell.row === pressCell.value.row && cell.col === pressCell.value.col) {
      const slot = slotFor(cell);
      hoverCell.value = cell;
      emit("pin", slot);
    }
  }

  dragging.value = false;
  dragStart.value = null;
  dragCur.value = null;
  pressCell.value = null;
}

function onPointerCancel() {
  window.removeEventListener("pointerup", endDrag);
  stopEdgeScroll();
  dragging.value = false;
  dragStart.value = null;
  dragCur.value = null;
  pressCell.value = null;
}

// Leaving edit mode mid-drag must not commit a stale rectangle.
watch(
  () => props.editable,
  () => {
    onPointerCancel();
    closeMenu();
  },
);

// --- what the rectangle means ---------------------------------------------
//
// A paint used to be committed in a mode chosen beforehand, from a switch that
// sat above the chart for the whole session to be read once. The choice belongs
// to the rectangle, not to the session: it arrives with one, attached to it, and
// leaves with it. Every drag paints an available time — the answer nine times in
// ten — and the menu is the tenth.

/** The rectangle a paint just committed, until it is chosen for or forgotten. */
const menuRect = ref<{ start: Cell; end: Cell; slots: number[] } | null>(null);
let menuTimer: ReturnType<typeof setTimeout> | undefined;

function closeMenu() {
  clearTimeout(menuTimer);
  menuTimer = undefined;
  menuRect.value = null;
}

/** Restarted on every use: five seconds of *inattention*, not of existence. */
function holdMenu() {
  clearTimeout(menuTimer);
  menuTimer = setTimeout(closeMenu, MENU_LINGER_MS);
}

// A pointer resting on the menu is attention, not inattention: the countdown
// pauses for as long as it hovers and starts over when it leaves. Touch gets
// no enter/leave pairing worth trusting, so only hovering pointers pause it.
function pauseMenu(event: PointerEvent) {
  if (event.pointerType === "touch") return;
  clearTimeout(menuTimer);
  menuTimer = undefined;
}

function resumeMenu(event: PointerEvent) {
  if (event.pointerType === "touch") return;
  holdMenu();
}

function openMenu(start: Cell, end: Cell, slots: number[]) {
  menuRect.value = { start, end, slots };
  holdMenu();
}

function chooseType(type: AvailabilityType) {
  const rect = menuRect.value;
  if (!rect) return;
  emit("flip", { type, slots: rect.slots });
  // It stays: having just changed their mind once, the visitor may change it
  // back, and the menu that let them do it should not vanish for having worked.
  holdMenu();
}

// A finger's menu is bigger in both directions, and both numbers are what its
// placement is worked out against.
const menuWidth = computed(() => (coarsePointer.value ? MENU_WIDTH_TOUCH : MENU_WIDTH));
const menuHeight = computed(() => (coarsePointer.value ? MENU_HEIGHT_TOUCH : MENU_HEIGHT));

/**
 * Under the rectangle, or over it where there is no room under — never on it,
 * so the thing being described stays visible while it is described. Both axes
 * subtract the scroll, like the tooltip: the menu belongs to a rectangle of the
 * track, so it travels with it.
 */
const menu = computed(() => {
  const rect = menuRect.value;
  if (!rect || !props.editable) return null;

  const minCol = Math.min(rect.start.col, rect.end.col);
  const maxCol = Math.max(rect.start.col, rect.end.col);
  const minRow = Math.min(rect.start.row, rect.end.row);
  const maxRow = Math.max(rect.start.row, rect.end.row);

  const centre =
    chartLeft.value +
    (offsets.value[minCol] + offsets.value[maxCol] + colWidth.value) / 2 -
    scrollLeft.value;
  const half = menuWidth.value / 2;
  const left =
    chartWidth.value <= menuWidth.value
      ? chartLeft.value + chartWidth.value / 2
      : Math.min(
          Math.max(centre, chartLeft.value + half),
          chartLeft.value + chartWidth.value - half,
        );

  const under = HEADER_HEIGHT + rowTop(maxRow) + rowHeight.value + MENU_GAP - scrollTop.value;
  const over = HEADER_HEIGHT + rowTop(minRow) - MENU_GAP - menuHeight.value - scrollTop.value;
  const floor = MENU_GAP;
  const ceiling = Math.max(floor, viewportHeight.value - menuHeight.value - MENU_GAP);
  const top =
    under <= ceiling ? under : over >= floor ? over : Math.min(Math.max(under, floor), ceiling);

  // Which of the two it currently is, read off the answer itself rather than
  // remembered here: a flip is applied by the parent, and this follows it.
  const type: AvailabilityType = rect.slots.some((slot) => props.ifNeeded.has(slot))
    ? "if_needed"
    : "available";

  return { left, top, type };
});

onBeforeUnmount(closeMenu);

// --- painting -------------------------------------------------------------

interface PaintedCell {
  row: number;
  slot: number | null;
  color: string | null;
  kind: "disabled" | "empty" | "available" | "if-needed" | "erasing";
}

/** Heatmap base for the current theme; flipping the theme repaints the grid. */
const slotBase = useSlotBaseColor();

/**
 * The whole event, not just what is on screen — scrolling must not have to
 * rebuild it. The active slot is deliberately not part of this: it changes on
 * every pointer move, and it is a class on one cell, not a repaint.
 */
const cells = computed<PaintedCell[][]>(() => {
  const {
    model,
    editable,
    availability,
    ifNeeded,
    responseIndex,
    maxCount,
    totalRespondents,
    showBestTimes,
    highlightRespondent,
  } = props;

  const start = dragStart.value;
  const current = dragCur.value;
  const previewing = dragging.value && start && current;

  return model.columns.map((_column, colIndex) =>
    model.rows.map((_row, rowIndex): PaintedCell => {
      const slot = slotAt(model, rowIndex, colIndex);
      if (slot === null) {
        return { row: rowIndex, slot: null, color: null, kind: "disabled" };
      }

      if (editable) {
        const inPreview = previewing && inRectangle(rowIndex, colIndex, start, current);
        if (inPreview) {
          if (dragType.value === "remove") {
            return { row: rowIndex, slot, color: null, kind: "erasing" };
          }
          // A drag paints an available time; what it turns out to mean is asked
          // once it lands, not while it is being drawn.
          return { row: rowIndex, slot, color: null, kind: "available" };
        }
        if (availability.has(slot)) {
          return { row: rowIndex, slot, color: null, kind: "available" };
        }
        if (ifNeeded.has(slot)) {
          return { row: rowIndex, slot, color: null, kind: "if-needed" };
        }
        return { row: rowIndex, slot, color: null, kind: "empty" };
      }

      // --- group view ---
      const respondents = responseIndex.available.get(slot);

      if (highlightRespondent) {
        if (!respondents?.has(highlightRespondent)) {
          return { row: rowIndex, slot, color: null, kind: "empty" };
        }
        const kind = responseIndex.ifNeeded.get(slot)?.has(highlightRespondent)
          ? "if-needed"
          : "available";
        return { row: rowIndex, slot, color: null, kind };
      }

      const count = respondents?.size ?? 0;
      if (count === 0) {
        return { row: rowIndex, slot, color: null, kind: "empty" };
      }

      if (showBestTimes) {
        return isBestTime(count, maxCount)
          ? { row: rowIndex, slot, color: null, kind: "available" }
          : { row: rowIndex, slot, color: null, kind: "empty" };
      }

      // With a single respondent there is no gradient to show, so their
      // if-needed slots are tinted instead of counted.
      if (totalRespondents === 1 && (responseIndex.ifNeeded.get(slot)?.size ?? 0) > 0) {
        return { row: rowIndex, slot, color: null, kind: "if-needed" };
      }

      return {
        row: rowIndex,
        slot,
        color: heatmapColor(count, maxCount, totalRespondents, slotBase.value),
        kind: "empty",
      };
    }),
  );
});

// --- tooltip --------------------------------------------------------------

const tooltip = computed(() => {
  const cell = hoverCell.value;
  if (!cell || dragging.value || panning.value) return null;
  const slot = slotFor(cell);
  if (slot === null) return null;
  // Keep the bubble inside the chart: centred on the cell it describes, but
  // nudged in at the edges so it cannot spill off a narrow screen. Both axes
  // subtract the scroll, since the cell it points at moves with the track.
  const centre =
    chartLeft.value + offsets.value[cell.col] + colWidth.value / 2 - scrollLeft.value;
  const half = TOOLTIP_MAX_WIDTH / 2;
  const left =
    chartWidth.value <= TOOLTIP_MAX_WIDTH
      ? chartLeft.value + chartWidth.value / 2
      : Math.min(
          Math.max(centre, chartLeft.value + half),
          chartLeft.value + chartWidth.value - half,
        );
  return {
    text: formatSlotRange(slot, props.model.slotMinutes, props.model.timezoneOffset, props.hour12, {
      withDate: props.model.showDates,
      dowDates: props.event.type === "dow" ? props.event.dates : undefined,
      startOnMonday: props.event.startOnMonday,
    }),
    left,
    top: HEADER_HEIGHT + rowTop(cell.row) - scrollTop.value,
  };
});

defineExpose({ measure });
</script>

<template>
  <div class="grid" :class="{ scrollable }">
    <div class="wrap">
      <div class="stage" :class="{ dragging }">
        <!-- One scrollport for the whole chart. The gutter and the headings are
             inside it, pinned on their own axis, rather than beside it. -->
        <div
          ref="viewport"
          class="viewport"
          :class="{ scrollable, panning }"
          :tabindex="scrollable ? 0 : undefined"
          :role="scrollable ? 'region' : undefined"
          :aria-label="scrollable ? 'Availability grid, scrolls sideways' : undefined"
          @scroll.passive="onScroll"
          @pointerdown="onViewportPointerDown"
          @wheel="onWheel"
        >
          <div ref="sheet" class="sheet">
            <div ref="gutter" class="gutter">
              <div class="gutter-head" :style="{ height: `${HEADER_HEIGHT}px` }" />
              <template v-for="(row, index) in model.rows" :key="`label-${index}`">
                <div
                  v-if="index === model.topRowCount && model.bottomRowCount > 0"
                  class="gutter-gap"
                  :style="{ height: `${GAP_HEIGHT}px` }"
                />
                <div
                  class="gutter-label"
                  :class="{ hour: row.isHourStart, first: index === 0 }"
                  :style="{ height: `${rowHeight}px` }"
                >
                  <span v-if="row.isHourStart">{{ row.label }}</span>
                </div>
              </template>
            </div>

            <div class="track" :style="{ width: `${trackWidth}px` }">
              <div class="header">
                <template v-for="(column, index) in columns" :key="`head-${column.dayIndex}`">
                  <div
                    v-if="index > 0 && !column.isConsecutive"
                    class="col-gap"
                    :style="{ width: `${GAP_WIDTH}px` }"
                  />
                  <div class="head-cell" :style="{ width: `${colWidth}px` }">
                    <span class="weekday">{{ column.weekday }}</span>
                    <span v-if="model.showDates" class="date">{{ column.dateLabel }}</span>
                  </div>
                </template>
              </div>

              <div
                ref="body"
                class="body"
                :class="{ editing: editable, dragging }"
                :style="{ touchAction: editable ? 'none' : undefined }"
                @pointerdown="onPointerDown"
                @pointermove="onPointerMove"
                @pointerup="endDrag"
                @pointercancel="onPointerCancel"
                @pointerleave="onPointerLeave"
              >
                <template v-for="(column, colIndex) in columns" :key="`col-${column.dayIndex}`">
                  <div
                    v-if="colIndex > 0 && !column.isConsecutive"
                    class="col-gap"
                    :style="{ width: `${GAP_WIDTH}px` }"
                  />
                  <div class="col" :style="{ width: `${colWidth}px` }">
                    <template v-for="cell in cells[colIndex]" :key="cell.row">
                      <div
                        v-if="cell.row === model.topRowCount && model.bottomRowCount > 0"
                        class="block-gap"
                        :style="{ height: `${GAP_HEIGHT}px` }"
                      />
                      <div
                        class="cell"
                        :class="[
                          `is-${cell.kind}`,
                          {
                            active: cell.slot !== null && cell.slot === activeSlot,
                            hour: model.rows[cell.row].isHourStart,
                            half: model.rows[cell.row].isHalfHour,
                          },
                        ]"
                        :style="{
                          height: `${rowHeight}px`,
                          backgroundColor: cell.color ?? undefined,
                        }"
                      />
                    </template>
                  </div>
                </template>
              </div>
            </div>
          </div>
        </div>

        <!-- Over the chart, not beside it: the fades and the knobs live outside
             the scrollport so they stay put while the track runs under them. -->
        <div v-if="moreBefore" class="edge edge--start" aria-hidden="true" />
        <div v-if="moreAfter" class="edge edge--end" aria-hidden="true" />

        <button
          v-if="scrollable"
          type="button"
          class="knob knob--prev"
          :class="{ armed: edgeDir < 0 }"
          :disabled="!moreBefore"
          aria-label="Earlier dates"
          title="Earlier dates"
          @click="scrollByStep(-1)"
        >
          <span class="knob__glyph" aria-hidden="true">
            <IconChevronLeft />
          </span>
        </button>

        <button
          v-if="scrollable"
          type="button"
          class="knob knob--next"
          :class="{ armed: edgeDir > 0 }"
          :disabled="!moreAfter"
          aria-label="Later dates"
          title="Later dates"
          @click="scrollByStep(1)"
        >
          <span class="knob__glyph" aria-hidden="true">
            <IconChevronRight />
          </span>
        </button>
      </div>

      <div
        v-if="$slots.foot"
        class="foot"
        :style="{ width: scrollable ? undefined : `${trackWidth}px` }"
      >
        <slot name="foot" />
      </div>

      <div
        v-if="tooltip"
        class="tooltip"
        :style="{ left: `${tooltip.left}px`, top: `${tooltip.top}px` }"
      >
        {{ tooltip.text }}
      </div>

      <!-- What the rectangle that was just painted means. Laid over the chart
           beside the rectangle itself, and inert apart from its two buttons, so
           the cells it floats above can still be painted straight through. -->
      <div
        v-if="menu"
        class="meaning"
        :style="{ left: `${menu.left}px`, top: `${menu.top}px` }"
        role="group"
        aria-label="What the times you just marked mean"
        @pointerenter="pauseMenu"
        @pointerleave="resumeMenu"
      >
        <button
          type="button"
          class="meaning__option"
          :class="{ 'meaning__option--on': menu.type === 'available' }"
          :aria-pressed="menu.type === 'available'"
          @click="chooseType('available')"
        >
          <IconCheck aria-hidden="true" />
          Available
        </button>

        <button
          type="button"
          class="meaning__option"
          :class="{ 'meaning__option--on': menu.type === 'if_needed' }"
          :aria-pressed="menu.type === 'if_needed'"
          @click="chooseType('if_needed')"
        >
          <IconHourglass aria-hidden="true" />
          If needed
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.grid {
  /* How wide the dissolved edge is; the knob sits inside it. */
  --fade: 2rem;
  /* Mirrors HEADER_HEIGHT in the script: the gutter's spacer matches it and the
     knobs skip past it so they centre on the body rather than on the headings. */
  --head: 42px;
  /* The time gutter's width, referred to by everything that has to start where
     the columns do: the fades, the prev knob, the foot. */
  --gutter: 3.5rem;

  user-select: none;
  -webkit-user-select: none;
  -webkit-touch-callout: none;
}

.wrap {
  position: relative;
  min-width: 0;
}

.stage {
  position: relative;
  display: flex;
  align-items: stretch;
}

/* The one scrollport. Horizontal only here: the chart stands at its full
   natural height and the page scrolls past it. On a phone the chart is given a
   bounded height instead and this scrolls both ways, like a spreadsheet.

   Containment is per axis, and deliberately so. On the horizontal one it keeps
   a swipe that runs off the end of the track from turning into the browser's
   back gesture. Applied to both, it would also swallow a vertical wheel:
   `overflow-y: hidden` still makes this a scroll container on that axis, and a
   contained one refuses to hand the scroll on to the page — so a wheel over the
   chart would do nothing at all. Vertical chains to the page, which is whose
   gesture it is. */
.viewport {
  position: relative;
  flex: 1 1 auto;
  min-width: 0;
  overflow-x: auto;
  overflow-y: hidden;
  overscroll-behavior-x: contain;
  scrollbar-width: none;
}

/* The chart carries its own continuation cues — the fades, the peeked column
   and the chevrons — so the bar underneath would only cost a strip of grid. */
.viewport::-webkit-scrollbar {
  display: none;
}

.viewport:focus-visible {
  outline: var(--focus-ring);
  outline-offset: calc(var(--focus-ring-offset) * -1);
}

.viewport.scrollable {
  cursor: grab;
}

.viewport.panning,
.viewport.panning .header {
  cursor: grabbing;
}

/* Gutter and track side by side, as wide as they need to be. The gutter is
   stretched rather than left at its content height because it is what the
   columns pass behind: a gutter even a pixel short of the track lets the body's
   bottom border show under it as the track scrolls by. */
.sheet {
  display: flex;
  align-items: stretch;
  width: max-content;
  min-width: 100%;
}

/* Pinned across the horizontal scroll: the hours stay readable however far
   along the dates you are. Opaque, so the columns pass behind rather than
   through. */
.gutter {
  position: sticky;
  left: 0;
  z-index: 3;
  flex: none;
  width: var(--gutter);
  text-align: right;
  background: var(--color-bg);
}

/* The corner. Pinned on the other axis too, so a vertical scroll cannot slide
   the hour labels up into the headings' band. */
.gutter-head {
  position: sticky;
  top: 0;
  z-index: 1;
  background: var(--color-bg);
}

.gutter-label {
  position: relative;
  font-size: 0.6875rem;
  line-height: 1;
  color: var(--color-text-muted);
}

.gutter-label.hour span {
  position: absolute;
  top: 0;
  right: 0.4rem;
  transform: translateY(-50%);
  white-space: nowrap;
}

/* Every label straddles its own gridline except the first, which would have to
   straddle the top of the chart — and would be sliced in half by the pinned
   headings' band the moment the chart scrolled under them. It hangs below its
   line instead. */
.gutter-label.hour.first span {
  transform: none;
}

.track {
  flex: none;
}

/* --- scroll controls ----------------------------------------------------- */

/* Laid over the chart's own edges: the columns run under them and continue past
   them, so the button is where the thing it does is, and the chart keeps the
   full width of the page. Positioned past the header so it centres on the body,
   and no wider than it needs to be — everything around it stays paintable. */
.knob {
  position: absolute;
  top: calc(var(--head) + (100% - var(--head)) / 2);
  z-index: 5;
  display: grid;
  place-items: center;
  width: 1.75rem;
  height: 1.75rem;
  padding: 0;
  transform: translateY(-50%);
  background: none;
  border: none;
  cursor: pointer;
  transition: opacity var(--transition-fast);
}

.knob--prev {
  left: calc(var(--gutter) + 0.15rem);
}

.knob--next {
  right: 0.15rem;
}

/* Translucent over its own backdrop, so the cells it covers still read as grid
   rather than as a hole punched in it — in either theme, since both the fill
   and the blur come off the surface token. */
.knob__glyph {
  display: grid;
  place-items: center;
  width: 1.55rem;
  height: 1.55rem;
  color: var(--color-text-muted);
  background: color-mix(in srgb, var(--color-surface) 86%, transparent);
  backdrop-filter: blur(3px);
  border: 1px solid var(--color-border-strong);
  border-radius: var(--radius-pill);
  box-shadow: var(--shadow-md);
  transition: color var(--transition-fast), background var(--transition-fast),
    border-color var(--transition-fast), transform var(--transition-fast);
}

.knob__glyph svg {
  width: 0.85rem;
  height: 0.85rem;
}

/* Only where a pointer can actually hover: a tap must not leave the knob stuck
   in its hover state on a phone. */
@media (hover: hover) {
  .knob:hover:not(:disabled) .knob__glyph {
    color: var(--color-accent-contrast);
    background: var(--color-accent);
    border-color: var(--color-accent);
  }

  .knob--prev:hover:not(:disabled) .knob__glyph {
    transform: translateX(-1px);
  }

  .knob--next:hover:not(:disabled) .knob__glyph {
    transform: translateX(1px);
  }
}

/* Nowhere to go that way: gone, and out of the way of the cells under it. */
.knob:disabled {
  pointer-events: none;
  cursor: default;
}

.knob:disabled .knob__glyph {
  opacity: 0;
}

/* A paint drag owns the whole surface. The knobs stop taking the pointer for
   its duration, so a sweep that crosses one — or ends on it — paints through
   and cannot scroll; they fade to say so. */
.stage.dragging .knob {
  pointer-events: none;
  opacity: 0.3;
}

/* Except the one the drag is leaning on: the track is about to come by itself,
   and what brings it is the thing this button does, so it is this button that
   says so — lit as though pressed, and leaning the way it is taking the grid.
   Still inert; it is reporting, not offering. */
.stage.dragging .knob.armed {
  opacity: 1;
}

.stage.dragging .knob.armed .knob__glyph {
  color: var(--color-accent-contrast);
  background: var(--color-accent);
  border-color: var(--color-accent);
}

.stage.dragging .knob--prev.armed .knob__glyph {
  transform: translateX(-2px);
}

.stage.dragging .knob--next.armed .knob__glyph {
  transform: translateX(2px);
}

.knob:focus-visible {
  outline: var(--focus-ring);
  outline-offset: var(--focus-ring-offset);
  border-radius: var(--radius-pill);
}

/* The clipped edge, dissolved rather than cut: with the peeked column showing
   through it, the grid reads as continuing under the knob instead of ending.
   Inert — the cells beneath it take the pointer. */
.edge {
  position: absolute;
  top: 0;
  bottom: 0;
  z-index: 4;
  width: var(--fade);
  pointer-events: none;
}

.edge--start {
  left: var(--gutter);
  background: linear-gradient(to right, var(--color-bg), transparent);
}

.edge--end {
  right: 0;
  background: linear-gradient(to left, var(--color-bg), transparent);
}

/* --- chart --------------------------------------------------------------- */

/* Pinned across the vertical scroll, so the dates stay overhead however far
   down the day you are. Opaque for the same reason the gutter is. */
.header {
  position: sticky;
  top: 0;
  z-index: 2;
  display: flex;
  height: var(--head);
  align-items: flex-end;
  padding-bottom: 0.35rem;
  background: var(--color-bg);
}

.grid.scrollable .header {
  cursor: grab;
}

.head-cell {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.05rem;
  overflow: hidden;
}

.weekday {
  font-size: 0.75rem;
  font-weight: 600;
  color: var(--color-text-muted);
  text-transform: uppercase;
  letter-spacing: 0.03em;
}

.date {
  font-size: 0.8125rem;
  font-weight: 600;
  color: var(--color-text);
}

.body {
  position: relative;
  display: flex;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  overflow: hidden;
}

.body.editing {
  cursor: crosshair;
}

.col {
  display: flex;
  flex-direction: column;
  border-right: 1px solid var(--color-border);
}

.col:last-child {
  border-right: none;
}

.col-gap,
.block-gap {
  flex: none;
  background: var(--color-bg);
}

.block-gap {
  border-top: 1px solid var(--color-border);
  border-bottom: 1px solid var(--color-border);
}

.cell {
  position: relative;
  background-color: var(--color-slot-empty);
  transition: background-color 0.12s ease-in-out;
}

.cell.hour {
  border-top: 1px solid var(--color-border);
}

.cell.half {
  border-top: 1px dashed var(--color-border);
}

.cell.is-disabled {
  background-color: var(--color-slot-disabled);
  background-image: repeating-linear-gradient(
    45deg,
    transparent,
    transparent 4px,
    var(--color-border) 4px,
    var(--color-border) 5px
  );
}

.cell.is-available {
  background-color: var(--color-slot-available);
}

.cell.is-if-needed {
  background-color: var(--color-slot-if-needed);
}

.cell.is-erasing {
  background-color: var(--color-danger-soft);
}

.cell.active::after {
  content: "";
  position: absolute;
  inset: 0;
  border: 1px dashed var(--color-text);
  pointer-events: none;
}

/* Same box as the chart body, so whatever the parent puts here lines up with
   the columns above rather than with the page. While the chart scrolls that box
   is the viewport, since that is where the chart now starts and ends. */
.foot {
  max-width: 100%;
  margin-top: 0.45rem;
  margin-left: var(--gutter);
}

/* Centred on the rectangle it belongs to and clamped to the chart's own box, so
   it cannot hang off a narrow screen. Only the buttons take the pointer: the
   strip itself is a hole, and a drag that starts under it paints as usual. */
.meaning {
  position: absolute;
  z-index: 15;
  display: flex;
  align-items: stretch;
  overflow: hidden;
  transform: translateX(-50%);
  background: var(--color-surface);
  border: 1px solid var(--color-border-strong);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-md);
  pointer-events: none;
}

.meaning__option {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  min-height: 2.25rem;
  padding: 0.3rem 0.6rem;
  font: inherit;
  font-size: 0.8125rem;
  white-space: nowrap;
  color: var(--color-text-muted);
  background: none;
  border: none;
  cursor: pointer;
  pointer-events: auto;
  transition: color var(--transition-fast), background var(--transition-fast);
}

.meaning__option + .meaning__option {
  border-left: 1px solid var(--color-border);
}

.meaning__option svg {
  width: 0.85rem;
  height: 0.85rem;
  flex: none;
}

.meaning__option:hover:not(.meaning__option--on) {
  color: var(--color-text);
  background: var(--color-subtle);
}

.meaning__option:focus-visible {
  outline: var(--focus-ring);
  outline-offset: calc(var(--focus-ring-offset) * -1);
}

/* The chosen one is tinted with the colour the cells themselves just took, so
   the menu and the rectangle say the same thing in the same ink. Cut with the
   surface rather than used neat: the slot colours are made to be read as a
   field, not to be read *through*, and at full strength the label on the green
   one falls to 1.6:1 against the dark theme's text. */
.meaning__option--on {
  font-weight: 600;
  color: var(--color-text);
  background: color-mix(in srgb, var(--color-slot-available) 45%, var(--color-surface));
}

.meaning__option--on:last-child {
  background: color-mix(in srgb, var(--color-slot-if-needed) 45%, var(--color-surface));
}

.tooltip {
  position: absolute;
  z-index: 20;
  max-width: 180px;
  transform: translate(-50%, -115%);
  padding: 0.25rem 0.5rem;
  font-size: 0.75rem;
  text-align: center;
  color: var(--color-tooltip-text);
  background: var(--color-tooltip-bg);
  border-radius: var(--radius-sm);
  pointer-events: none;
}

/* Touch: the knob's target grows to the 44px floor while the disc it draws
   stays small, so what a finger can hit is bigger than what a finger covers. */
@media (pointer: coarse) {
  .grid {
    --fade: 2.75rem;
  }

  /* Sized for a finger; `MENU_HEIGHT_TOUCH` is this height, and placement
     depends on the two agreeing. */
  .meaning__option {
    min-height: var(--tap-min);
    padding: 0.3rem 0.85rem;
    font-size: 0.875rem;
  }

  .meaning__option svg {
    width: 0.95rem;
    height: 0.95rem;
  }

  .knob {
    width: var(--tap-min);
    height: var(--tap-min);
  }

  .knob__glyph {
    width: 1.9rem;
    height: 1.9rem;
  }

  .knob__glyph svg {
    width: 1rem;
    height: 1rem;
  }
}

/* The app-like layout: the chart is handed a fixed box between the header bar
   and the identity bar, and scrolls inside it on both axes. The pinned gutter
   and headings are what make that legible — without them a scroll down the day
   would lose the dates and a scroll along the dates would lose the hours. */
@media (max-width: 820px) {
  .grid {
    --gutter: 2.75rem;

    display: flex;
    flex-direction: column;
    min-height: 0;
  }

  .wrap,
  .stage {
    display: flex;
    flex: 1 1 auto;
    flex-direction: column;
    min-height: 0;
  }

  /* Here the pane is the thing that scrolls vertically — the page behind it
     does not — so the vertical axis is contained too: a swipe that reaches the
     first or last row stops there rather than bouncing the whole shell. */
  .viewport {
    overflow-y: auto;
    overscroll-behavior-y: contain;
    /* Room under the last row for the fades' full height and a thumb. */
    padding-bottom: 0.5rem;
  }

  .gutter-label {
    font-size: 0.625rem;
  }
}

@media (prefers-reduced-motion: reduce) {
  .knob,
  .knob__glyph,
  .meaning__option {
    transition: none;
  }
}
</style>
