<script setup lang="ts">
/**
 * The scheduling grid.
 *
 * Interaction is one delegated pointer handler on the grid body: positions are
 * hit-tested to (row, col) against measured geometry.
 *
 * Two hands, two gestures
 * -----------------------
 * A mouse paints by dragging: press, sweep, release, and the rectangle between
 * the two cells is committed in one go. Nothing else on a desktop wants that
 * drag, so it can have it.
 *
 * A finger cannot. The same drag is the only way to scroll a chart taller and
 * wider than the screen, and for as long as the body held `touch-action: none`
 * every swipe over the cells was a negotiation: the pane refused to move and a
 * sweep meant to look around painted instead. So on touch the drag goes back to
 * the platform — both axes, native momentum and all — and selecting is done in
 * two beats instead of one. A tap marks the cell it landed on and puts a pair of
 * round handles on the opposite corners of it; dragging a handle grows the
 * rectangle, and the cells it crosses are painted as they arrive and put back as
 * they leave, so what is on screen is always what is saved. Only the handles
 * take `touch-action: none` — 44px of it each — because they are the only place a
 * drag still means something other than scrolling.
 *
 * The two paths meet at the same commit, the same floating options and the same
 * undo: a resize keeps growing one record of what every cell it has ever touched
 * used to be (`selectionStep`), so the undo in the options strip still restores
 * the state the tap interrupted, however far the handles travelled since. The
 * strip's other way out is the cross beside it, which is the dismissal — the
 * marks stand, the handles go, and a press anywhere else on the chart means
 * exactly that and nothing more.
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
 * platform, everywhere and in both modes.
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
  placeOverlay,
  rectangleSlots,
  revertOperations,
  scrollEdges,
  scrollStepFor,
  selectionCorners,
  selectionPress,
  selectionStep,
  slotAt,
  slotDigest,
  snapshotSlots,
  type Cell,
  type EdgeDirection,
  type GridModel,
  type OverlayField,
  type ResponseIndex,
  type SlotSnapshot,
  type SlotStance,
} from "../../lib/grid";
import { useSlotBaseColor } from "../../lib/colors";
import { formatSlotRange } from "../../lib/dates";
import IconChevronLeft from "../../assets/icons/chevron-left.svg";
import IconChevronRight from "../../assets/icons/chevron-right.svg";
import IconCheck from "../../assets/icons/check.svg";
import IconHourglass from "../../assets/icons/hourglass.svg";
import IconClose from "../../assets/icons/close-sm.svg";
import IconUndo from "../../assets/icons/undo.svg";
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
  /**
   * The phone layout: the chart is a fixed pane and the respondents list is
   * behind a drawer, so a tap on a cell has to answer "who is free here?" over
   * the chart itself rather than beside it.
   */
  compact: boolean;
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
 * The menu that rides a drag. Its width and height are what the layout is
 * measured against — it is placed before it is drawn, so the numbers have to
 * come from here rather than from the box. Two widths, because the menu a
 * creation gets carries four controls and the one an erase gets carries two.
 */
const MENU_WIDTH = { create: 256, erase: 114 };
const MENU_WIDTH_TOUCH = { create: 312, erase: 138 };
const MENU_HEIGHT = 38;
const MENU_HEIGHT_TOUCH = 50;
/** Clearance between the menu and the edges of the chart it is clamped into. */
const MENU_GAP = 8;
/**
 * How far the menu keeps off the pointer itself. A cursor points at a spot and
 * hides almost none of it, so the menu sits just below. A finger covers what it
 * touches and everything for a few millimetres around, so the menu goes above
 * it and further out.
 */
const MENU_CURSOR_CLEARANCE = 18;
const MENU_TOUCH_CLEARANCE = 26;
/** How long it waits to be used before it takes itself away. */
const MENU_LINGER_MS = 5000;
/**
 * Longer for a selection with handles on it. A drag's options are read and either
 * used or ignored within a second or two; a tap's are the start of the gesture
 * rather than the end of it, and the handles they arrive with have to be found
 * and aimed at before they can be dragged.
 */
const MENU_LINGER_TOUCH_MS = 12000;
/**
 * How far a finger may travel and still have been a tap. Generous, because it is
 * only a second line of defence: the browser cancels the pointer outright the
 * moment it decides the gesture is a scroll, and that is what usually settles it.
 */
const TAP_SLOP = 12;
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
const viewportTop = ref(0);
const gutterWidth = ref(0);
const scrollLeft = ref(0);
const scrollTop = ref(0);
const scrollWidth = ref(0);

/** Width the day columns actually get: the viewport past the pinned gutter. */
const chartWidth = computed(() => Math.max(0, viewportWidth.value - gutterWidth.value));
/** Where the columns begin, relative to the wrap the tooltip is placed in. */
const chartLeft = computed(() => viewportLeft.value + gutterWidth.value);

/** The box anything floating over the chart is placed inside and clamped to. */
const overlayField = computed<OverlayField>(() => ({
  left: chartLeft.value,
  width: chartWidth.value,
  top: viewportTop.value,
  height: viewportHeight.value,
}));

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
  viewportTop.value = element.offsetTop;
  gutterWidth.value = gutter.value?.offsetWidth ?? 0;
  readScroll();
}

/**
 * Every scroll re-hit-tests a held pointer. That one line is what keeps a paint
 * drag correct through momentum, a chevron's smooth scroll and the edge glide
 * alike, without any of them having to know about the drag.
 */
function onScroll() {
  const wasLeft = scrollLeft.value;
  const wasTop = scrollTop.value;
  readScroll();
  if (gesturing.value) retrack();
  // The card names a cell, and the chart has just moved out from under it.
  if (summaryState.value) dismissSummary();
  // The options are placed over the pane, but what they are about is a rectangle
  // in the track — so when the track moves they move with it, and the ring and
  // the strip that names it never come apart. Only once it is a control: while
  // the drag runs it is following the pointer instead, which is a stronger claim
  // on where it should be.
  const state = menuState.value;
  if (state?.live) {
    state.x -= scrollLeft.value - wasLeft;
    state.y -= scrollTop.value - wasTop;
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
/** Which handle is being dragged, while one is. */
const resizing = ref<"from" | "to" | null>(null);
/**
 * A touch press that has not yet turned out to be either a tap or a scroll. It
 * paints nothing while it is undecided: a release settles it as a tap, and a
 * `pointercancel` — which the browser sends the instant it takes the gesture over
 * for scrolling — or enough travel settles it the other way.
 */
let touchPress: { cell: Cell; x: number; y: number } | null = null;

/**
 * Whether a gesture owns the chart: a mouse painting, or a handle being dragged.
 * Both want the knobs inert, the edge glide running and every scroll re-read
 * against the pointer that is still down.
 */
const gesturing = computed(() => dragging.value || resizing.value !== null);

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

/**
 * Re-reads the cell under a pointer that is still down. The one line that keeps
 * both gestures correct through momentum, a chevron's smooth scroll and the edge
 * glide alike, without any of them having to know which gesture is running.
 */
function retrack() {
  if (!lastPointer) return;
  const cell = cellFromPoint(lastPointer.x, lastPointer.y);
  if (!cell) return;
  if (resizing.value !== null) applyResize(cell);
  else if (dragging.value) dragCur.value = cell;
}

function glide(now: number) {
  edgeFrame = 0;
  const element = viewport.value;
  if (!gesturing.value || edgeDir.value === 0 || !element) return;

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
  retrack();

  const done = edgeDir.value < 0 ? edges.value.atStart : edges.value.atEnd;
  if (done) {
    stopEdgeScroll();
    return;
  }
  edgeFrame = requestAnimationFrame(glide);
}

function startGlide() {
  if (edgeFrame !== 0 || !gesturing.value || typeof requestAnimationFrame !== "function") return;
  edgeLast = 0;
  edgeCarry = 0;
  edgeFrame = requestAnimationFrame(glide);
}

function updateEdgeScroll(event: PointerEvent) {
  const element = viewport.value;
  if (!gesturing.value || !scrollable.value || !element) {
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
  const touch = event.pointerType !== "mouse";
  // Whatever the last paint was about, this press is about something else.
  // Except on touch, where a press may still turn out to be a scroll, and
  // scrolling past a selection is not a reason to lose it — `onScroll` takes it
  // away if the chart actually moves, and a tap replaces it outright.
  if (!touch) closeMenu();
  const cell = cellFromEvent(event);
  if (!cell) return;
  pressCell.value = cell;
  lastPointer = { x: event.clientX, y: event.clientY };

  if (!props.editable) return;
  const slot = slotFor(cell);
  if (slot === null) return;

  if (touch) {
    // Undecided: the platform owns this gesture until it turns out not to want
    // it. Nothing is captured and nothing is prevented, so a swipe scrolls the
    // pane as it does anywhere else on the phone.
    touchPress = { cell, x: event.clientX, y: event.clientY };
    return;
  }

  // Marked is marked, whichever of the two it is: pressing a cell you have
  // already claimed gives it back, and pressing an unclaimed one takes it.
  const marked = props.availability.has(slot) || props.ifNeeded.has(slot);
  dragType.value = marked ? "remove" : "add";
  dragging.value = true;
  dragStart.value = cell;
  dragCur.value = cell;
  openMenu(cell, marked ? "erase" : "create", event);

  body.value?.setPointerCapture?.(event.pointerId);
  window.addEventListener("pointerup", endDrag);
  event.preventDefault();
}

function onPointerMove(event: PointerEvent) {
  const cell = cellFromEvent(event);
  if (dragging.value) {
    if (cell) dragCur.value = cell;
    lastPointer = { x: event.clientX, y: event.clientY };
    followMenu(event);
    updateEdgeScroll(event);
    event.preventDefault();
    return;
  }
  if (touchPress) {
    const travelled = Math.hypot(event.clientX - touchPress.x, event.clientY - touchPress.y);
    if (travelled > TAP_SLOP) touchPress = null;
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

/**
 * A tap on a cell, which is what a touch selection begins as: it marks that one
 * cell exactly as a single-cell drag would, and hands back a rectangle with
 * handles on it to be made bigger.
 */
function commitTap(press: { cell: Cell }, event: PointerEvent): boolean {
  const { cell } = press;
  const slot = slotFor(cell);
  if (slot === null) return false;

  const marked = props.availability.has(slot) || props.ifNeeded.has(slot);
  dragType.value = marked ? "remove" : "add";
  const slots = [slot];
  // Read before the emit, so the record is the state the tap interrupted — the
  // same order the drag path takes, for the same reason.
  const snapshot = snapshotSlots(slots, props.availability, props.ifNeeded);
  openMenu(cell, marked ? "erase" : "create", event, true);
  emit("paint", { type: dragType.value, slots });
  commitMenu(cell, cell, slots, snapshot);
  return true;
}

function endDrag(event?: PointerEvent) {
  window.removeEventListener("pointerup", endDrag);
  stopEdgeScroll();

  let committed = false;
  if (props.editable && touchPress && event) {
    committed = commitTap(touchPress, event);
    touchPress = null;
  } else if (dragging.value && dragStart.value && dragCur.value) {
    const slots = rectangleSlots(props.model, dragStart.value, dragCur.value);
    if (slots.length > 0) {
      // Read before the emit, and so the state the press started from: nothing
      // the guest owns moves until the parent applies this change.
      const snapshot = snapshotSlots(slots, props.availability, props.ifNeeded);
      emit("paint", { type: dragType.value, slots });
      commitMenu(dragStart.value, dragCur.value, slots, snapshot);
      committed = true;
    }
  } else if (!props.editable && pressCell.value && event && !panMoved) {
    // A tap or click in the group view pins the slot under the pointer — unless
    // the press turned out to be a pan, which is a different gesture entirely.
    const cell = cellFromEvent(event) ?? pressCell.value;
    if (cell.row === pressCell.value.row && cell.col === pressCell.value.col) {
      const slot = slotFor(cell);
      hoverCell.value = cell;
      if (slot !== null) emit("pin", slot);
      // On a phone the pin is also the only way to read who is free, so the
      // card comes with it. Told the same slot twice it closes, exactly as the
      // pin unpins.
      if (slot !== null && props.compact) toggleSummary(slot, event.clientX, event.clientY);
    }
  }
  // A drag that landed on nothing leaves no rectangle behind, and so nothing
  // for the preview that followed it to become.
  if (!committed) closeMenu();

  dragging.value = false;
  dragStart.value = null;
  dragCur.value = null;
  pressCell.value = null;
}

/**
 * The pointer was taken away. On touch that is the platform saying it wants the
 * gesture for a scroll, which is the ordinary case rather than an error — so the
 * undecided press is simply dropped, and a selection already on screen is left
 * for `onScroll` to deal with if the chart really moves.
 */
function onPointerCancel(event?: PointerEvent) {
  window.removeEventListener("pointerup", endDrag);
  stopEdgeScroll();
  const scrolling = touchPress !== null && event?.pointerType !== "mouse";
  touchPress = null;
  if (!scrolling) closeMenu();
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
    endResize();
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
//
// It rides the drag rather than waiting for it. Appearing only on release meant
// the options arrived somewhere the hand had already left, announced by nothing;
// carried along beside the pointer from the press onwards they are simply
// already there when the finger lifts, in the place the finger lifted from. For
// as long as the drag runs the menu is a preview — a label on what is being
// drawn, taking no pointer at all, because the one pointer in play belongs to
// the drag and nothing floating under it may be allowed to intercept it. The
// release is what turns it into a control, at the position it had reached.
//
// An erase gets one too. It has no meaning to choose, but it has the same thing
// to take back, and a rectangle wiped by accident used to be unrecoverable
// except by painting it again from memory.
//
// Either strip ends with a cross. Undo and dismiss are two different answers —
// one moves the marks back, the other only closes the strip — and while the
// cross stood for the first of them there was no button for the second at all,
// only the two things a visitor has to be told: wait, or press elsewhere.

type MenuKind = "create" | "erase";

interface MenuState {
  kind: MenuKind;
  /** Corners of the rectangle, so the outline outlives the drag with the menu. */
  start: Cell;
  end: Cell;
  /** Where the menu is pinned, in the wrap's coordinates. */
  x: number;
  y: number;
  /** Whether a finger is driving it: the menu clears above one, below a cursor. */
  touch: boolean;
  /** False while the drag runs — a preview cannot be clicked, or aimed at. */
  live: boolean;
  /**
   * Whether the rectangle carries handles: true for the touch path, where the
   * tap is the start of the selection rather than the whole of it. A drag has
   * already been aimed by hand and needs none.
   */
  handles: boolean;
  slots: number[];
  /** What those slots were before the drag; null until the drag commits. */
  snapshot: SlotSnapshot | null;
}

const menuState = ref<MenuState | null>(null);
/** The strip and the handle layer, so a press can be told from an outside one. */
const menuEl = ref<HTMLElement | null>(null);
const gripsEl = ref<HTMLElement | null>(null);
let menuTimer: ReturnType<typeof setTimeout> | undefined;

function closeMenu() {
  clearTimeout(menuTimer);
  menuTimer = undefined;
  menuState.value = null;
}

/** Restarted on every use: a spell of *inattention*, not of existence. */
function holdMenu() {
  clearTimeout(menuTimer);
  const linger = menuState.value?.handles ? MENU_LINGER_TOUCH_MS : MENU_LINGER_MS;
  menuTimer = setTimeout(closeMenu, linger);
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

/**
 * A client point in the coordinates the overlays are positioned in — the wrap
 * the menu and the tooltip are absolutely placed inside. The scrollport's own
 * rect carries the scroll already, so nothing here has to know where the track
 * has got to.
 */
function anchorFromPoint(clientX: number, clientY: number): { x: number; y: number } | null {
  const element = viewport.value;
  if (!element) return null;
  const rect = element.getBoundingClientRect();
  return {
    x: clientX - rect.left + viewportLeft.value,
    y: clientY - rect.top + viewportTop.value,
  };
}

function openMenu(cell: Cell, kind: MenuKind, event: PointerEvent, handles = false) {
  const anchor = anchorFromPoint(event.clientX, event.clientY);
  if (!anchor) return;
  clearTimeout(menuTimer);
  menuTimer = undefined;
  menuState.value = {
    kind,
    start: cell,
    end: cell,
    x: anchor.x,
    y: anchor.y,
    touch: event.pointerType !== "mouse",
    live: false,
    handles,
    slots: [],
    snapshot: null,
  };
}

/** The preview keeps up with the pointer; a live menu stays where it landed. */
function followMenu(event: PointerEvent) {
  const state = menuState.value;
  if (!state || state.live) return;
  const anchor = anchorFromPoint(event.clientX, event.clientY);
  if (!anchor) return;
  state.x = anchor.x;
  state.y = anchor.y;
}

/** The release: the preview becomes the control, without moving. */
function commitMenu(start: Cell, end: Cell, slots: number[], snapshot: SlotSnapshot) {
  const state = menuState.value;
  if (!state) return;
  state.start = start;
  state.end = end;
  state.slots = slots;
  state.snapshot = snapshot;
  state.live = true;
  holdMenu();
}

function chooseType(type: AvailabilityType) {
  const state = menuState.value;
  if (!state?.live) return;
  emit("flip", { type, slots: state.slots });
  // It stays: having just changed their mind once, the visitor may change it
  // back, and the menu that let them do it should not vanish for having worked.
  holdMenu();
}

/**
 * Undo, spoken in the grid's own emits: the parent hears the same two changes it
 * hears from a drag, applies them the same way and queues the same save, so the
 * restored state reaches the server by the route every other edit takes.
 *
 * The menu goes with it. Unlike a flip, which invites being flipped back, this
 * has put things exactly as they were — there is nothing left for it to offer.
 */
function revertRect() {
  const state = menuState.value;
  if (!state?.live || !state.snapshot) return;
  for (const op of revertOperations(state.snapshot)) {
    if (op.emit === "paint") emit("paint", { type: op.type, slots: op.slots });
    else emit("flip", { type: op.type, slots: op.slots });
  }
  closeMenu();
}

/**
 * Put the options away and leave the marks alone — what a press outside the
 * selection does, and what the countdown does on its own, said as a button.
 *
 * Worth a control of its own because the other two ways of reaching it are both
 * things you have to know: that the strip goes by itself if left, and that
 * anywhere else on the chart dismisses it. A cross in the corner is neither.
 * It takes the handles with it, because the selection and its options are one
 * thing on screen and dismissing half of it would leave a rectangle nothing
 * explains.
 */
function dismissMenu() {
  if (!menuState.value?.live) return;
  closeMenu();
}

// A finger's menu is bigger in both directions, and both numbers are what its
// placement is worked out against.
function menuWidthFor(kind: MenuKind): number {
  return (coarsePointer.value ? MENU_WIDTH_TOUCH : MENU_WIDTH)[kind];
}
const menuHeight = computed(() => (coarsePointer.value ? MENU_HEIGHT_TOUCH : MENU_HEIGHT));

/**
 * Beside the pointer, never under it, and never outside the chart. Centred on
 * the pointer horizontally and clamped into the column area; vertically it takes
 * the side the pointing device leaves free, flipping to the other when the first
 * would put it off the top or the bottom of the scrollport.
 */
const menu = computed(() => {
  const state = menuState.value;
  if (!state || !props.editable) return null;

  const { left, top } = placeOverlay(
    { width: menuWidthFor(state.kind), height: menuHeight.value },
    overlayField.value,
    {
      x: state.x,
      y: state.y,
      clearance: state.touch ? MENU_TOUCH_CLEARANCE : MENU_CURSOR_CLEARANCE,
      gap: MENU_GAP,
      above: state.touch,
    },
  );

  // Which of the two it currently is, read off the answer itself rather than
  // remembered here: a flip is applied by the parent, and this follows it.
  const type: AvailabilityType = state.slots.some((slot) => props.ifNeeded.has(slot))
    ? "if_needed"
    : "available";

  return { left, top, type, kind: state.kind, live: state.live };
});

/**
 * The rectangle the menu is talking about, ringed so there is no doubt which
 * cells it means. Drawn from the drag while the drag runs and from the menu's
 * own corners afterwards, so the ring and the options appear and vanish
 * together. Inside the track, so it travels with the columns.
 */
const region = computed(() => {
  const state = menuState.value;
  if (!props.editable || !state) return null;
  const start = dragging.value ? dragStart.value : state.start;
  const end = dragging.value ? dragCur.value : state.end;
  if (!start || !end) return null;

  const minCol = Math.min(start.col, end.col);
  const maxCol = Math.max(start.col, end.col);
  const minRow = Math.min(start.row, end.row);
  const maxRow = Math.max(start.row, end.row);
  const left = offsets.value[minCol] ?? 0;
  const top = rowTop(minRow);

  return {
    left,
    top,
    width: (offsets.value[maxCol] ?? left) + colWidth.value - left,
    height: rowTop(maxRow) + rowHeight.value - top,
    kind: state.kind,
  };
});

// --- the handles ----------------------------------------------------------
//
// What a finger drags instead of the cells. Two of them, on opposite corners of
// the rectangle, and everything they do is a resize of a selection that has
// already been committed — so every step has to leave the grid, the options and
// the record of how to undo it all agreeing with each other.
//
// They live outside `.body`, in a layer over the track, for one reason: the body
// clips, and a handle centred on a corner of the first row or the first column
// would be sliced in half along with the 44 pixels a finger has to find it by.
// They still scroll with the columns, because the layer is in the track.

/** Where the two handles sit, in the track's own pixels. */
const handles = computed(() => {
  const state = menuState.value;
  if (!state || !props.editable || !state.handles || !state.live) return null;

  const { moving: first } = selectionCorners(state.start, state.end, "from");
  const { moving: last } = selectionCorners(state.start, state.end, "to");
  return {
    kind: state.kind,
    from: { x: offsets.value[first.col] ?? 0, y: rowTop(first.row) },
    to: {
      x: (offsets.value[last.col] ?? 0) + colWidth.value,
      y: rowTop(last.row) + rowHeight.value,
    },
  };
});

/**
 * Grows or shrinks the committed rectangle to reach `cell`.
 *
 * The corner being dragged is kept in `start` and the one it is pinned to in
 * `end`, which is why a handle dragged clean past its anchor keeps working: a
 * rectangle is a span, and `selectionCorners` sorts them out again next time
 * either handle is picked up.
 */
function applyResize(cell: Cell) {
  const state = menuState.value;
  if (!state?.live || !state.snapshot) return;
  if (state.start.row === cell.row && state.start.col === cell.col) return;

  // What the selection currently means, read off the answer itself — the same
  // way the options strip reads it — before any of this step's emits move it.
  const type: AvailabilityType = state.slots.some((slot) => props.ifNeeded.has(slot))
    ? "if_needed"
    : "available";

  state.start = cell;
  const step = selectionStep({
    previous: state.slots,
    next: rectangleSlots(props.model, state.start, state.end),
    snapshot: state.snapshot,
    availability: props.availability,
    ifNeeded: props.ifNeeded,
  });

  // Everything the rectangle has let go of, put back as this gesture found it.
  for (const op of step.restore) {
    if (op.emit === "paint") emit("paint", { type: op.type, slots: op.slots });
    else emit("flip", { type: op.type, slots: op.slots });
  }
  // And everything it has taken in, painted as the selection means.
  if (step.entering.length > 0) {
    if (state.kind === "erase") emit("paint", { type: "remove", slots: step.entering });
    else emit("flip", { type, slots: step.entering });
  }

  state.snapshot = step.snapshot;
  state.slots = step.slots;
}

function startResize(handle: "from" | "to", event: PointerEvent) {
  const state = menuState.value;
  if (!state?.live || !state.handles) return;
  if (event.button !== 0 && event.pointerType === "mouse") return;
  if (!event.isPrimary) return;

  const { moving, anchor } = selectionCorners(state.start, state.end, handle);
  state.start = moving;
  state.end = anchor;
  resizing.value = handle;
  lastPointer = { x: event.clientX, y: event.clientY };
  // A hand on a handle is attention, whatever kind of pointer it is.
  clearTimeout(menuTimer);
  menuTimer = undefined;

  (event.currentTarget as HTMLElement | null)?.setPointerCapture?.(event.pointerId);
  window.addEventListener("pointermove", onResizeMove);
  window.addEventListener("pointerup", endResize);
  window.addEventListener("pointercancel", endResize);
  // The press must not reach the cells underneath, or the pane, or the page.
  event.preventDefault();
  event.stopPropagation();
}

function onResizeMove(event: PointerEvent) {
  if (resizing.value === null) return;
  lastPointer = { x: event.clientX, y: event.clientY };
  const cell = cellFromPoint(event.clientX, event.clientY);
  if (cell) applyResize(cell);
  updateEdgeScroll(event);
  event.preventDefault();
}

function endResize() {
  window.removeEventListener("pointermove", onResizeMove);
  window.removeEventListener("pointerup", endResize);
  window.removeEventListener("pointercancel", endResize);
  resizing.value = null;
  stopEdgeScroll();
  // The countdown starts again from the end of the work, not from the tap.
  if (menuState.value?.live) holdMenu();
}

/**
 * A press anywhere that is not the selection puts it away, and does nothing
 * else.
 *
 * Only for the touch path, and only because that path has something a drag's
 * options do not: handles, which are a thing left on the chart to be used later
 * rather than a label on something just done. A press on the options or on a
 * handle is the selection being used, and a press inside the rectangle is the
 * ordinary tap it has always been. Everything else — the cells around it
 * included — is the dismissal, and only the dismissal.
 *
 * That last part is why this runs in the capture phase and stops the press where
 * it stands: reaching the body it would paint a cell and raise a fresh selection
 * in the same movement that was meant to put one away, and there would be no
 * gesture left that only put one away. The tap after it, with the chart clear,
 * draws as usual. `selectionPress` is the whole rule; this only carries it out.
 */
function onChartPress(event: PointerEvent) {
  const state = menuState.value;
  const target = event.target as Node;
  const onCells = Boolean(body.value?.contains(target));
  const verdict = selectionPress({
    selection: state?.live && state.handles ? { start: state.start, end: state.end } : null,
    onControls: Boolean(menuEl.value?.contains(target) || gripsEl.value?.contains(target)),
    onCells,
    cell: onCells ? cellFromEvent(event) : null,
  });
  if (verdict !== "deselect") return;
  closeMenu();
  // Spent. Nothing downstream may read it as the start of anything — not the
  // paint, not the pan, not the pin. Propagation only: a `preventDefault` here
  // would also take away the scroll this press may yet turn out to be.
  if (onCells) event.stopPropagation();
}

watch(
  () => Boolean(menuState.value?.live && menuState.value.handles),
  (armed) => {
    if (typeof window === "undefined") return;
    if (armed) window.addEventListener("pointerdown", onChartPress, true);
    else window.removeEventListener("pointerdown", onChartPress, true);
  },
);

onBeforeUnmount(() => {
  closeMenu();
  endResize();
  if (typeof window !== "undefined") {
    window.removeEventListener("pointerdown", onChartPress, true);
  }
});

// --- who is free here -----------------------------------------------------
//
// On a desktop the answer to "who is free at this cell?" is already on screen,
// in the column beside the chart. On a phone that column is behind a drawer, and
// a drawer is the wrong place for the answer to the question a tap on a cell
// *is*: by the time it is open the cell is under it. So the same reading — the
// time, the fraction, and each person's own mark in the glyph the list uses for
// it — is composed over the chart, beside the cell that was tapped.
//
// The pin is untouched underneath: a tap still pins, so the drawer, the outline
// and the desktop column all say the same thing about the same slot. This is a
// second view of the pinned slot, not a second kind of selection.

/**
 * How many people the card will name. Eight chips run two or three to a line, so
 * the card stays under about a third of the chart's height on the narrowest
 * phone. Past that it names the people who can make it and counts the rest
 * (`slotDigest`); the drawer holds the full list either way.
 */
const SUMMARY_CAP = 8;
/** Clearance from the tapped point, and from the chart's own edges. */
const SUMMARY_CLEARANCE = 22;
const SUMMARY_GAP = 8;
/** What each glyph says, for anyone who is not looking at it. */
const STANCE_LABELS: Record<SlotStance, string> = {
  available: "Available",
  if_needed: "If needed",
  unavailable: "Unavailable",
};

const summaryState = ref<{ slot: number; x: number; y: number } | null>(null);
const summaryEl = ref<HTMLElement | null>(null);
/**
 * The card's measured box. It is sized by its own content — a name may be long,
 * a time label may wrap — so the placement cannot be worked out from constants
 * the way the options strip's is. It is rendered once unplaced and invisible,
 * measured, and only then shown, which costs one frame nobody can see and
 * removes a pair of numbers that would have had to track the CSS by hand.
 */
const summarySize = ref<{ width: number; height: number } | null>(null);

function closeSummary() {
  summaryState.value = null;
  summarySize.value = null;
}

function measureSummary() {
  const element = summaryEl.value;
  if (!element) return;
  summarySize.value = { width: element.offsetWidth, height: element.offsetHeight };
}

/**
 * Opens the card on a slot, or closes it when that slot is the one it is already
 * showing — the same toggle the pin itself does, so the two cannot disagree.
 * Returns whether the slot ends up pinned.
 */
function toggleSummary(slot: number, clientX: number, clientY: number): boolean {
  if (summaryState.value?.slot === slot) {
    closeSummary();
    return false;
  }
  const anchor = anchorFromPoint(clientX, clientY);
  if (!anchor) return false;
  summarySize.value = null;
  summaryState.value = { slot, x: anchor.x, y: anchor.y };
  void nextTick(measureSummary);
  return true;
}

const summary = computed(() => {
  const state = summaryState.value;
  if (!state || props.editable) return null;

  const digest = slotDigest(state.slot, props.responseIndex, { cap: SUMMARY_CAP });
  const label = formatSlotRange(
    state.slot,
    props.model.slotMinutes,
    props.model.timezoneOffset,
    props.hour12,
    {
      withDate: props.model.showDates,
      dowDates: props.event.type === "dow" ? props.event.dates : undefined,
      startOnMonday: props.event.startOnMonday,
    },
  );

  const size = summarySize.value;
  const placement = size
    ? placeOverlay(size, overlayField.value, {
        x: state.x,
        y: state.y,
        clearance: SUMMARY_CLEARANCE,
        gap: SUMMARY_GAP,
        // Above the finger, which covers the cell it just touched.
        above: true,
      })
    : { left: state.x, top: state.y };

  // Same three readings the respondents list gives the fraction: everyone free
  // is the answer you are looking for, nobody free rules the slot out, and
  // anything between is a compromise to weigh.
  const tone =
    digest.free === 0 ? "none" : digest.free === digest.total ? "all" : "some";

  return { ...digest, label, tone, ...placement, placed: size !== null };
});

/**
 * A tap anywhere that is not the card takes it away. The chart's own presses go
 * through `onPointerDown`, which closes it before the release decides whether to
 * open it again; this is for everything else on the page — the view switch, the
 * identity bar, the foot.
 */
function onDocumentPointerDown(event: PointerEvent) {
  if (!summaryState.value) return;
  const target = event.target as Node;
  if (summaryEl.value?.contains(target)) return;
  // A press on the cells is the tap gesture itself: the release decides whether
  // the card moves, closes or stays put, and closing it here first would turn a
  // second tap on the same cell into a re-open of the thing it meant to shut.
  if (body.value?.contains(target)) return;
  dismissSummary();
}

/** Dismissal releases the pin as well: one gesture put both up, one takes both
 *  down, and a pinned slot with nothing on screen explaining it is a trap. */
function dismissSummary() {
  closeSummary();
  emit("pin", null);
}

watch(
  () => summaryState.value !== null,
  (open) => {
    if (typeof window === "undefined") return;
    if (open) window.addEventListener("pointerdown", onDocumentPointerDown, true);
    else window.removeEventListener("pointerdown", onDocumentPointerDown, true);
  },
);

// Switching to editing, or losing the slot the card is about, leaves it stale.
watch([() => props.editable, () => props.activeSlot], () => {
  if (!summaryState.value) return;
  if (props.editable || props.activeSlot !== summaryState.value.slot) closeSummary();
});

onBeforeUnmount(() => {
  closeSummary();
  if (typeof window !== "undefined") {
    window.removeEventListener("pointerdown", onDocumentPointerDown, true);
  }
});

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
      <div class="stage" :class="{ dragging: gesturing }">
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

              <!-- No `touch-action` of its own in either mode: a finger's drag
                   belongs to the platform, and selecting is done by tapping and
                   then dragging a handle. -->
              <div
                ref="body"
                class="body"
                :class="{ editing: editable, dragging }"
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

                <!-- What the floating options apply to, ringed for as long as
                     they are on screen. Inert, and inside the track so it
                     stays on its cells while the chart scrolls under it. -->
                <div
                  v-if="region"
                  class="region"
                  :class="`region--${region.kind}`"
                  aria-hidden="true"
                  :style="{
                    left: `${region.left}px`,
                    top: `${region.top}px`,
                    width: `${region.width}px`,
                    height: `${region.height}px`,
                  }"
                />
              </div>

              <!-- Over the track rather than inside the body, so a handle on the
                   first row or the first column is not sliced in half by the
                   body's own clipping — and its 44px with it. The layer is a
                   hole; only the two discs take the pointer. -->
              <div v-if="handles" ref="gripsEl" class="grips" aria-hidden="true">
                <div
                  class="grip"
                  :class="`grip--${handles.kind}`"
                  :style="{
                    left: `${handles.from.x}px`,
                    top: `${HEADER_HEIGHT + handles.from.y}px`,
                  }"
                  @pointerdown="startResize('from', $event)"
                />
                <div
                  class="grip"
                  :class="`grip--${handles.kind}`"
                  :style="{
                    left: `${handles.to.x}px`,
                    top: `${HEADER_HEIGHT + handles.to.y}px`,
                  }"
                  @pointerdown="startResize('to', $event)"
                />
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

      <!-- Who is free at the cell that was just tapped, over the chart, on the
           layout where the list that would otherwise say it is behind a drawer.
           Sized by its own content and placed once measured, so the first frame
           is laid out but not shown. -->
      <div
        v-if="summary"
        ref="summaryEl"
        class="digest"
        :class="{ 'digest--placed': summary.placed }"
        role="group"
        :aria-label="`Who is free at ${summary.label}`"
        :style="{ left: `${summary.left}px`, top: `${summary.top}px` }"
      >
        <div class="digest__head">
          <!-- One line, whatever the label says: the card floats over the chart
               and a second line of heading would push the names it exists to
               show off the bottom of it. Cut short, the whole of it is still on
               the element for anything that can ask. -->
          <span class="digest__when" :title="summary.label">{{ summary.label }}</span>
          <button
            type="button"
            class="digest__close"
            aria-label="Dismiss"
            @click="dismissSummary"
          >
            <IconClose aria-hidden="true" />
          </button>
        </div>

        <p v-if="summary.total === 0" class="digest__none">No answers yet.</p>

        <template v-else>
          <p class="digest__count" :class="`digest__count--${summary.tone}`">
            {{ summary.free }} of {{ summary.total }} free
          </p>

          <!-- One chip per person, in the same three glyphs the respondents
               list uses, so the two readings of a slot are the same reading. -->
          <ul class="digest__people">
            <li
              v-for="person in summary.people"
              :key="person.name"
              class="who"
              :class="`who--${person.stance}`"
              :title="person.name"
            >
              <!-- The glyph is the whole of what the chip says about them, so
                   it carries the word rather than sitting out of the tree the
                   way decoration does. -->
              <span class="who__mark" role="img" :aria-label="STANCE_LABELS[person.stance]">
                <IconCheck v-if="person.stance === 'available'" />
                <IconHourglass v-else-if="person.stance === 'if_needed'" />
                <IconClose v-else stroke-width="2.2" />
              </span>
              <span class="who__name">{{ person.name }}</span>
            </li>
            <!-- Everyone the card chose not to name. Only worth saying beside
                 names it did name: with nobody free to list, the fraction above
                 is already the whole answer. -->
            <li v-if="summary.hidden > 0 && summary.people.length > 0" class="who who--more">
              +{{ summary.hidden }} more
            </li>
          </ul>
        </template>
      </div>

      <!-- What the rectangle being drawn means. Carried beside the pointer for
           the length of the drag as a preview that takes no pointer at all, and
           left where the drag ended as a working control. Even then only its
           buttons take the pointer, so the cells it floats above can still be
           painted straight through. -->
      <div
        v-if="menu"
        ref="menuEl"
        class="meaning"
        :class="{ 'meaning--preview': !menu.live }"
        :style="{ left: `${menu.left}px`, top: `${menu.top}px` }"
        role="group"
        :aria-label="
          menu.kind === 'erase'
            ? 'The times you just cleared'
            : 'What the times you just marked mean'
        "
        @pointerenter="pauseMenu"
        @pointerleave="resumeMenu"
      >
        <template v-if="menu.kind === 'create'">
          <button
            type="button"
            class="meaning__option meaning__option--available"
            :class="{ 'meaning__option--on': menu.type === 'available' }"
            :aria-pressed="menu.type === 'available'"
            :tabindex="menu.live ? undefined : -1"
            @click="chooseType('available')"
          >
            <IconCheck aria-hidden="true" />
            Available
          </button>

          <button
            type="button"
            class="meaning__option meaning__option--if-needed"
            :class="{ 'meaning__option--on': menu.type === 'if_needed' }"
            :aria-pressed="menu.type === 'if_needed'"
            :tabindex="menu.live ? undefined : -1"
            @click="chooseType('if_needed')"
          >
            <IconHourglass aria-hidden="true" />
            If needed
          </button>

          <!-- No label: it stands beside two that carry one, and a third word
               would make the strip something to read rather than something to
               choose from. The back-arrow is the one glyph that says "put it
               back" without one. -->
          <button
            type="button"
            class="meaning__option meaning__option--undo meaning__option--icon"
            aria-label="Undo this selection"
            title="Undo this selection"
            :tabindex="menu.live ? undefined : -1"
            @click="revertRect"
          >
            <IconUndo aria-hidden="true" />
          </button>
        </template>

        <!-- An erase has nothing to choose between, so its undo says in a word
             what it does rather than leaving a glyph to be guessed at — the
             same glyph either way, and the word beside it. -->
        <button
          v-else
          type="button"
          class="meaning__option meaning__option--undo meaning__option--revert"
          :tabindex="menu.live ? undefined : -1"
          @click="revertRect"
        >
          <IconUndo aria-hidden="true" />
          Revert
        </button>

        <!-- Last, in the corner a dismissal always sits in, and about the strip
             rather than about the times: it closes what is open and changes
             nothing, which is what waiting or pressing elsewhere would have
             done. The undo beside it is the one that moves the marks. -->
        <button
          type="button"
          class="meaning__option meaning__option--dismiss meaning__option--icon"
          aria-label="Dismiss"
          title="Dismiss"
          :tabindex="menu.live ? undefined : -1"
          @click="dismissMenu"
        >
          <IconClose aria-hidden="true" />
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

/* Positioned, because the handle layer is placed against it: the handles have to
   travel with the columns, and this is what the columns are laid out in. */
.track {
  position: relative;
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

/* The ring round the rectangle the options apply to. It has to read over an
   empty cell, a green one, an amber one and the erase wash alike, in both
   themes, so it is not a hairline: two solid pixels, held off the surrounding
   fills by a thin sheath of the page colour on both sides of the stroke, and a
   soft halo of its own colour so the shape carries at a glance. */
.region {
  position: absolute;
  z-index: 1;
  pointer-events: none;
  border-radius: var(--radius-sm);
  outline: 2px solid var(--color-selection-create);
  outline-offset: -1px;
  box-shadow:
    inset 0 0 0 1px color-mix(in srgb, var(--color-bg) 75%, transparent),
    0 0 0 1px color-mix(in srgb, var(--color-bg) 75%, transparent),
    0 0 10px color-mix(in srgb, var(--color-selection-create) 55%, transparent);
}

.region--erase {
  outline-color: var(--color-selection-delete);
  box-shadow:
    inset 0 0 0 1px color-mix(in srgb, var(--color-bg) 75%, transparent),
    0 0 0 1px color-mix(in srgb, var(--color-bg) 75%, transparent),
    0 0 10px color-mix(in srgb, var(--color-selection-delete) 55%, transparent);
}

/* --- the handles ---------------------------------------------------------- */

/* A hole over the whole track: the cells under it stay tappable and a swipe
   across it still scrolls the pane. Only the discs are solid. */
.grips {
  position: absolute;
  inset: 0;
  z-index: 6;
  pointer-events: none;
}

/* Centred on the corner it moves. The target is the 44px floor while the disc
   drawn inside it is small, so what a finger can hit is much bigger than what a
   finger covers — the same trade the scroll knobs make. `touch-action: none` is
   here and nowhere else on the chart: this is the one place a finger's drag means
   something other than scrolling. */
.grip {
  position: absolute;
  display: grid;
  place-items: center;
  width: var(--tap-min);
  height: var(--tap-min);
  transform: translate(-50%, -50%);
  cursor: grab;
  pointer-events: auto;
  touch-action: none;
}

/* The disc itself, in the selection's own colour with a sheath of the page
   between it and whatever it is sitting on — so it reads over an empty cell, a
   green one, an amber one and the erase wash alike, in both themes. */
.grip::after {
  content: "";
  width: 0.95rem;
  height: 0.95rem;
  background: var(--color-selection-create);
  border: 2px solid var(--color-bg);
  border-radius: var(--radius-pill);
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--color-selection-create) 60%, transparent),
    var(--shadow-sm);
  transition: transform var(--transition-fast);
}

.grip--erase::after {
  background: var(--color-selection-delete);
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--color-selection-delete) 60%, transparent),
    var(--shadow-sm);
}

/* Under the finger. Grown rather than recoloured: the colour is what it means,
   and it has not stopped meaning that. */
.grip:active::after {
  transform: scale(1.25);
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

/* Pinned beside the pointer and clamped to the chart's own box, so it cannot
   hang off a narrow screen. Only the buttons take the pointer: the strip itself
   is a hole, and a drag that starts under it paints as usual. */
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

/* While the drag runs the whole strip is a label, not a control. Nothing in it
   may take the pointer that is drawing the rectangle — the one thing it must
   never do is intercept the gesture it exists to describe. */
.meaning--preview .meaning__option {
  pointer-events: none;
  cursor: default;
}

.meaning__option + .meaning__option {
  border-left: 1px solid var(--color-border);
}

/* Sized by its glyph rather than by absent text: the undo in a creation strip,
   and the dismissal in both. */
.meaning__option--icon {
  justify-content: center;
  padding: 0.3rem 0.55rem;
}

.meaning__option--icon svg {
  width: 0.95rem;
  height: 0.95rem;
}

/* Labelled, like the two it follows in the erase strip. */
.meaning__option--revert {
  padding: 0.3rem 0.7rem;
}

/* The undo moves the marks back, so it warns the way anything that takes
   something away does. The dismissal beside it changes nothing and keeps the
   neutral hover of the generic rule below. Specific enough to beat it. */
.meaning__option--undo:hover:not(.meaning__option--on) {
  color: var(--color-danger);
  background: var(--color-danger-soft);
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

.meaning__option--if-needed.meaning__option--on {
  background: color-mix(in srgb, var(--color-slot-if-needed) 45%, var(--color-surface));
}

/* --- who is free here ----------------------------------------------------- */

/* The respondents column, folded into something a thumb's width of chart can
   hold and laid over the cell it is about. Placed the way the options strip is —
   centred on the tap, clamped into the columns, above the finger — and held to a
   width that leaves the chart either side of it visible, so it reads as an
   annotation on the grid rather than as a screen of its own.

   Unplaced until measured: it is sized by its content, so the first frame is
   laid out where the tap was and not shown, and the frame after that is in the
   right place. */
.digest {
  position: absolute;
  z-index: 18;
  width: max-content;
  max-width: min(15rem, 100%);
  transform: translateX(-50%);
  padding: 0.4rem 0.5rem 0.5rem;
  background: var(--color-raised);
  border: 1px solid var(--color-border-strong);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-md);
  visibility: hidden;
}

.digest--placed {
  visibility: visible;
}

.digest__head {
  display: flex;
  align-items: flex-start;
  gap: 0.25rem;
}

/* One line. Nothing that floats over the chart is allowed to grow by wrapping:
   the card is placed against a measured box, and a heading that took a second
   line would move the names down instead of the card up. `min-width: 0` is what
   lets it shrink far enough to be cut at all, flex items refusing to go below
   their content otherwise. */
.digest__when {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  font-size: 0.75rem;
  font-weight: 600;
  line-height: 1.3;
  white-space: nowrap;
  text-overflow: ellipsis;
  color: var(--color-text);
}

/* The card's own dismissal, in the corner a dismissal always sits in. It gives
   the pin back as well: one tap raised both, one takes both down. */
.digest__close {
  display: grid;
  flex: none;
  place-items: center;
  width: 1.35rem;
  height: 1.35rem;
  margin: -0.15rem -0.2rem 0 0;
  padding: 0;
  color: var(--color-text-muted);
  background: none;
  border: none;
  border-radius: var(--radius-sm);
  cursor: pointer;
}

.digest__close svg {
  width: 0.7rem;
  height: 0.7rem;
}

.digest__close:focus-visible {
  outline: var(--focus-ring);
  outline-offset: calc(var(--focus-ring-offset) * -1);
}

.digest__count {
  margin-top: 0.1rem;
  font-size: 0.6875rem;
  font-weight: 500;
}

.digest__count--all {
  color: var(--color-success);
}

.digest__count--some {
  color: var(--color-warning);
}

.digest__count--none {
  color: var(--color-danger);
}

.digest__none {
  margin-top: 0.15rem;
  font-size: 0.6875rem;
  color: var(--color-text-muted);
}

/* Chips rather than rows: two or three to a line at a phone's width, so a card
   naming eight people is four lines tall instead of eight. */
.digest__people {
  display: flex;
  flex-wrap: wrap;
  gap: 0.15rem 0.3rem;
  margin: 0.3rem 0 0;
  padding: 0;
  list-style: none;
}

/* A chip is one line: the glyph, and as much of the name as fits. It may shrink
   to make room — `min-width: 0` again — and the name inside it is what gives
   way, so a long one is cut rather than folded onto a line of its own. */
.who {
  display: inline-flex;
  align-items: center;
  gap: 0.2rem;
  min-width: 0;
  max-width: 100%;
  font-size: 0.75rem;
  line-height: 1.35;
  white-space: nowrap;
  color: var(--color-text);
}

.who__mark {
  display: grid;
  flex: none;
  place-items: center;
  width: 0.75rem;
  height: 0.75rem;
}

.who__mark svg {
  width: 100%;
  height: 100%;
}

.who__name {
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

/* The grid's own three colours at ink weight, the same three the list uses. */
.who--available .who__mark {
  color: var(--color-accent-text);
}

.who--if_needed .who__mark {
  color: var(--color-if-needed-text);
}

.who--unavailable .who__mark {
  color: var(--color-danger);
}

/* Struck through and muted, the way the list says it, so a glance over the
   chips separates the two answers by weight as well as by glyph. */
.who--unavailable .who__name {
  color: var(--color-text-muted);
  text-decoration: line-through;
}

.who--more {
  flex: none;
  color: var(--color-text-muted);
  font-size: 0.6875rem;
}

/* The one line a time range is. `TOOLTIP_MAX_WIDTH` in the script is this
   max-width, and the clamp that keeps the bubble on screen is worked out from
   it — so the bubble may be cut short at that width but must never grow past
   it, and must never grow downwards either. */
.tooltip {
  position: absolute;
  z-index: 20;
  max-width: 180px;
  overflow: hidden;
  transform: translate(-50%, -115%);
  padding: 0.25rem 0.5rem;
  font-size: 0.75rem;
  white-space: nowrap;
  text-overflow: ellipsis;
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

  /* Carrying no label, these would otherwise be the controls in the strip
     narrower than a finger. Padded out to the 44px floor on both axes. */
  .meaning__option--icon {
    padding-inline: 0.95rem;
  }

  .knob {
    width: var(--tap-min);
    height: var(--tap-min);
  }

  /* The card's dismissal is the only control on it, and a finger has to be able
     to hit it without hitting the chart behind. */
  .digest__close {
    width: 2.1rem;
    height: 2.1rem;
    margin: -0.35rem -0.35rem 0 0;
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
  .grip::after,
  .meaning__option {
    transition: none;
  }
}
</style>
