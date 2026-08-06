<script setup lang="ts">
/**
 * The scheduling grid: one delegated pointer handler on the body, hit-tested
 * against measured geometry. Gestures, scrolling and the selection model are
 * documented in ARCHITECTURE.md § Client model.
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import {
  columnOffsets as columnOffsetsOf,
  columnWidthFor,
  edgeGlideStep,
  edgeScrollDirection,
  GAP_HEIGHT,
  GAP_WIDTH,
  geometryFor,
  HEADER_HEIGHT,
  heatmapColor,
  hitTest,
  inRectangle,
  isBestTime,
  MIN_COL_WIDTH,
  overlayCenterX,
  PEEK,
  rectangleSlots,
  rowHeightFor,
  scrollEdges,
  scrollStepFor,
  selectionCorners,
  selectionPress,
  selectionStep,
  slotAt,
  snapshotSlots,
  type Cell,
  type EdgeDirection,
  type GridModel,
  type OverlayField,
  type ResponseIndex,
  type SlotSnapshot,
} from "../../lib/grid";
import type { HistoryCommit } from "../../lib/history";
import { useSlotBaseColor } from "../../lib/colors";
import { formatSlotRange, timeNumToTimeText } from "../../lib/dates";
import IconChevronLeft from "../../assets/icons/chevron-left.svg";
import IconChevronRight from "../../assets/icons/chevron-right.svg";
import RegionSummary from "./RegionSummary.vue";
import SelectionMenu from "./SelectionMenu.vue";
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
  /** Whose answer alone the chart is painting, by user key. */
  highlightRespondent: string | null;
  /** Hovered or pinned slot, outlined in the grid. */
  activeSlot: number | null;
  hour12: boolean;
}>();

const emit = defineEmits<{
  paint: [change: { type: "add" | "remove"; slots: number[] }];
  /** The just-painted rectangle, told what it means. */
  flip: [change: { type: AvailabilityType; slots: number[] }];
  /** Sent after the emits above, so the page pairs what the slots were with what they now are (`lib/history.ts`). */
  commit: [action: HistoryCommit];
  /** The arrow asks for the same undo the keyboard does, off the same stack. */
  undo: [];
  hover: [slot: number | null];
  pin: [slot: number | null];
}>();

defineSlots<{
  /** A row under the chart, laid out to the chart body's exact box. */
  foot?: () => unknown;
}>();

/** Matches `.tooltip { max-width }`; used to keep the bubble on screen. */
const TOOLTIP_MAX_WIDTH = 180;
/** How long it waits to be used before it takes itself away. */
const MENU_LINGER_MS = 5000;
/** Longer for a selection with handles: a tap's options start the gesture rather than end it. */
const MENU_LINGER_TOUCH_MS = 12000;
/** How far a finger may travel and still be a tap; the browser's pointercancel usually settles it first. */
const TAP_SLOP = 12;
/** How far a mouse has to travel before it is panning rather than clicking. */
const PAN_THRESHOLD = 5;
/** How deep a drag reaches before the track comes by itself: roughly the fade's width, wider for a finger. */
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

const rowHeight = computed(() => rowHeightFor(props.model.slotMinutes));

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

/** Read back rather than assumed, so the columns and the hit-testing cannot drift apart. */
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

function onScroll() {
  const wasLeft = scrollLeft.value;
  const wasTop = scrollTop.value;
  readScroll();
  if (gesturing.value) retrack();
  // A live menu is about a rectangle in the track, so it moves with it; a
  // preview follows the pointer instead. The summary card is placed against the
  // region's box, which has already moved.
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

// A shorter track may leave the resting position past its end; the container
// corrects itself, and this reads it back.
watch([colWidth, () => columns.value.length], () => void nextTick(readScroll));

// --- chevrons -------------------------------------------------------------

/** Instant under `prefers-reduced-motion`: the destination is the point, the travel is not. */
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
  // Over the cells the drag belongs to the cells, in either mode; the pan gets
  // the headings and the gutter.
  if (body.value?.contains(event.target as Node)) return;
  startPan(event);
}

/** Firefox does not deliver shift+wheel to a container overflowing on one axis; translated here, only when there is somewhere to go. */
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
/** A touch press still undecided between tap and scroll; it paints nothing until a release settles it. */
let touchPress: { cell: Cell; x: number; y: number } | null = null;

/** A gesture owns the chart: knobs inert, edge glide running, every scroll re-read against the held pointer. */
const gesturing = computed(() => dragging.value || resizing.value !== null);

function slotFor(cell: Cell | null): number | null {
  if (!cell) return null;
  return slotAt(props.model, cell.row, cell.col);
}

/** Read off the marks themselves, so the options strip and a handle's resize get the same answer. */
function currentType(slots: number[]): AvailabilityType {
  return slots.some((slot) => props.ifNeeded.has(slot)) ? "if_needed" : "available";
}

/** The body's client rect already carries the scroll offset, so this stays correct mid-glide and mid-momentum. */
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

/** Re-reads the cell under a held pointer: what keeps both gestures correct through momentum, smooth scroll and glide. */
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
  // A frame that moved nothing still re-hit-tests: a held finger sends no moves.
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
  // Measured from where the columns begin; the pinned gutter is not part of the field.
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
  // Secondary buttons and the extra contacts of a pinch must not paint.
  if (event.button !== 0 && event.pointerType === "mouse") return;
  if (!event.isPrimary) return;
  const touch = event.pointerType !== "mouse";
  // Only `startPan` clears the pan flag; reset it so a headings drag does not
  // taint later presses on the cells.
  panMoved = false;
  // On touch the press may yet be a scroll, and scrolling past a selection is
  // not a reason to lose it.
  if (!touch) closeMenu();
  const cell = cellFromEvent(event);
  if (!cell) return;
  pressCell.value = cell;
  lastPointer = { x: event.clientX, y: event.clientY };

  const slot = slotFor(cell);
  if (slot === null) return;

  if (touch) {
    // Nothing captured, nothing prevented: a swipe scrolls the pane as usual.
    touchPress = { cell, x: event.clientX, y: event.clientY };
    return;
  }

  if (!props.editable) {
    // Only a release on a different cell makes a region; press and release on
    // one cell is still the click that pins a slot.
    dragging.value = true;
    dragStart.value = cell;
    dragCur.value = cell;
    openMenu(cell, "view", event);
    body.value?.setPointerCapture?.(event.pointerId);
    window.addEventListener("pointerup", endDrag);
    event.preventDefault();
    return;
  }

  // Pressing a claimed cell gives it back; pressing an unclaimed one takes it.
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
  // No hover bubble over a live region — the card already answers.
  if (viewSelection.value) return;
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

/** A tap marks one cell as a single-cell drag would, and hands back a rectangle with handles. */
function commitTap(press: { cell: Cell }, event: PointerEvent): boolean {
  const { cell } = press;
  const slot = slotFor(cell);
  if (slot === null) return false;

  const marked = props.availability.has(slot) || props.ifNeeded.has(slot);
  dragType.value = marked ? "remove" : "add";
  const slots = [slot];
  // Read before the emit, so the record is the state the tap interrupted.
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
  if (touchPress && event) {
    committed = props.editable
      ? commitTap(touchPress, event)
      : commitViewTap(touchPress, event);
    touchPress = null;
  } else if (props.editable && dragging.value && dragStart.value && dragCur.value) {
    const slots = rectangleSlots(props.model, dragStart.value, dragCur.value);
    if (slots.length > 0) {
      // Read before the emit: the state the press started from.
      const snapshot = snapshotSlots(slots, props.availability, props.ifNeeded);
      emit("paint", { type: dragType.value, slots });
      commitMenu(dragStart.value, dragCur.value, slots, snapshot);
      committed = true;
    }
  } else if (!props.editable && dragging.value && dragStart.value && dragCur.value) {
    committed = commitViewDrag(dragStart.value, dragCur.value, event);
  }
  // A drag that landed on nothing leaves nothing for the preview to become.
  if (!committed) closeMenu();

  dragging.value = false;
  dragStart.value = null;
  dragCur.value = null;
  pressCell.value = null;
}

/** On touch, cancel is the platform taking the gesture for a scroll — the ordinary case, not an error. */
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

/** `view` is a region drawn over the group's answers to read them: no options strip, no countdown, no record. */
type MenuKind = "create" | "erase" | "view";

interface MenuState {
  kind: MenuKind;
  /** One gesture, one history entry: every commit this selection makes carries the same id. */
  action: number;
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
  /** True for the touch path, where the tap starts the selection rather than ends it. */
  handles: boolean;
  slots: number[];
  /** What those slots were before the drag; null until the drag commits. */
  snapshot: SlotSnapshot | null;
}

const menuState = ref<MenuState | null>(null);
/** Counts gestures, so each selection's commits are told apart from the last's. */
let actions = 0;
/** The strip's exposed root element, for `contains()` press tests. */
const menuComp = ref<InstanceType<typeof SelectionMenu> | null>(null);
const gripsEl = ref<HTMLElement | null>(null);
let menuTimer: ReturnType<typeof setTimeout> | undefined;

/** Takes away whatever is on the chart: the strip, the ring, and the card with them. */
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

// Hover pauses the countdown; touch has no enter/leave pairing worth trusting.
function pauseMenu(event: PointerEvent) {
  if (event.pointerType === "touch") return;
  clearTimeout(menuTimer);
  menuTimer = undefined;
}

function resumeMenu(event: PointerEvent) {
  if (event.pointerType === "touch") return;
  holdMenu();
}

/** A client point in the wrap's coordinates; the scrollport's rect already carries the scroll. */
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
  actions += 1;
  menuState.value = {
    kind,
    action: actions,
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

/** The release: the preview becomes the control. The record goes up after the emits that moved the marks. */
function commitMenu(start: Cell, end: Cell, slots: number[], snapshot: SlotSnapshot) {
  const state = menuState.value;
  if (!state) return;
  state.start = start;
  state.end = end;
  state.slots = slots;
  state.snapshot = snapshot;
  state.live = true;
  holdMenu();
  emit("commit", { id: state.action, before: snapshot });
}

function chooseType(type: AvailabilityType) {
  const state = menuState.value;
  if (!state?.live) return;
  emit("flip", { type, slots: state.slots });
  // Still the same action: saying what the rectangle means is the last beat of drawing it.
  if (state.snapshot) emit("commit", { id: state.action, before: state.snapshot });
  // It stays: the visitor may change their mind back.
  holdMenu();
}

/** Routed through the page's stack, so the arrow and cmd+Z are one history; the menu goes with it. */
function undoSelection() {
  if (!menuState.value?.live) return;
  closeMenu();
  emit("undo");
}

/** Puts the options away and leaves the marks alone; takes the handles with it. */
function dismissMenu() {
  if (!menuState.value?.live) return;
  closeMenu();
}

/** The chart owns the gesture, the countdown and the anchor; the strip measures its own box. */
const menu = computed(() => {
  const state = menuState.value;
  if (!state || !props.editable) return null;
  // A region over the group's answers changed nothing, so it gets no options.
  if (state.kind === "view") return null;

  return {
    kind: state.kind,
    type: currentType(state.slots),
    live: state.live,
    anchor: { x: state.x, y: state.y, touch: state.touch },
  };
});

/** A rectangle's box in the track's own pixels. */
function regionBox(start: Cell, end: Cell) {
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
  };
}

/** The ringed rectangle: drawn from the drag while it runs, from the selection's corners afterwards. */
const region = computed(() => {
  const state = menuState.value;
  if (!state) return null;
  const start = dragging.value ? dragStart.value : state.start;
  const end = dragging.value ? dragCur.value : state.end;
  if (!start || !end) return null;
  return { ...regionBox(start, end), kind: state.kind };
});

// --- the handles ----------------------------------------------------------

/** The two ends a handle can hold, for the template's pair of discs. */
const GRIP_ENDS = ["from", "to"] as const;

/** Where the two handles sit, in the track's own pixels. */
const handles = computed(() => {
  const state = menuState.value;
  if (!state || !state.handles || !state.live) return null;

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

/** Resizes to reach `cell`. The dragged corner lives in `start`, its anchor in `end`; `selectionCorners` re-sorts on the next pickup. */
function applyResize(cell: Cell) {
  const state = menuState.value;
  if (!state?.live) return;
  if (state.start.row === cell.row && state.start.col === cell.col) return;

  // A view region only changes which cells the card is reading.
  if (state.kind === "view") {
    state.start = cell;
    state.slots = rectangleSlots(props.model, state.start, state.end);
    // Past one cell the pin no longer names what is selected.
    if (state.slots.length > 1) emit("pin", null);
    return;
  }
  if (!state.snapshot) return;

  // Read before any of this step's emits move it.
  const type = currentType(state.slots);

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
  // The record grew, so the entry grows with it: still one action.
  emit("commit", { id: state.action, before: step.snapshot });
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

/** The release of a mouse drag over the group's answers: one cell is the pinning click, more is a region. */
function commitViewDrag(start: Cell, end: Cell, event?: PointerEvent): boolean {
  if (!event || panMoved) return false;
  if (start.row === end.row && start.col === end.col) {
    const slot = slotFor(start);
    hoverCell.value = start;
    if (slot !== null) emit("pin", slot);
    return false;
  }

  const slots = rectangleSlots(props.model, start, end);
  if (slots.length === 0) return false;
  // A pin names one cell, and the question is no longer about one cell.
  emit("pin", null);
  hoverCell.value = null;
  commitRegion(start, end, slots);
  return true;
}

/** Where a phone's region begins: one cell with handles. Tapping the one-cell region it already is takes it away. */
function commitViewTap(press: { cell: Cell }, event: PointerEvent): boolean {
  const { cell } = press;
  const slot = slotFor(cell);
  if (slot === null) return false;

  const state = menuState.value;
  const sameCell =
    state?.live && state.kind === "view" && state.slots.length === 1 && state.slots[0] === slot;
  if (sameCell) {
    dismissRegion();
    return false;
  }

  emit("pin", slot);
  openMenu(cell, "view", event, true);
  commitRegion(cell, cell, [slot]);
  return true;
}

/** Deliberately not `commitMenu`: nothing was painted, so no history entry and no countdown. */
function commitRegion(start: Cell, end: Cell, slots: number[]) {
  const state = menuState.value;
  if (!state) return;
  state.start = start;
  state.end = end;
  state.slots = slots;
  state.live = true;
  clearTimeout(menuTimer);
  menuTimer = undefined;
}

function endResize() {
  window.removeEventListener("pointermove", onResizeMove);
  window.removeEventListener("pointerup", endResize);
  window.removeEventListener("pointercancel", endResize);
  resizing.value = null;
  stopEdgeScroll();
  // The countdown restarts from the end of the work; a view region has none to start.
  const state = menuState.value;
  if (state?.live && state.kind !== "view") holdMenu();
}

/** Capture-phase: a dismissal press must not reach the body and paint. `selectionPress` is the whole rule; this only carries it out. */
function onChartPress(event: PointerEvent) {
  const state = menuState.value;
  const target = event.target as Node;
  const onCells = Boolean(body.value?.contains(target));
  const verdict = selectionPress({
    selection: armed.value && state ? { start: state.start, end: state.end } : null,
    onControls: Boolean(
      menuComp.value?.element?.contains(target) ||
        gripsEl.value?.contains(target) ||
        summaryComp.value?.element?.contains(target),
    ),
    onCells,
    cell: onCells ? cellFromEvent(event) : null,
  });
  if (verdict !== "deselect") return;
  if (state?.kind === "view") dismissRegion();
  else closeMenu();
  // Propagation only: `preventDefault` would take away the scroll this press may yet be.
  if (onCells) event.stopPropagation();
}

/** A selection a press elsewhere should put away rather than paint through: handles while editing, any region in the group view. */
const armed = computed(() => {
  const state = menuState.value;
  if (!state?.live) return false;
  return state.kind === "view" || state.handles;
});

watch(armed, (on) => {
  if (typeof window === "undefined") return;
  if (on) window.addEventListener("pointerdown", onChartPress, true);
  else window.removeEventListener("pointerdown", onChartPress, true);
});

onBeforeUnmount(() => {
  closeMenu();
  endResize();
  if (typeof window !== "undefined") {
    window.removeEventListener("pointerdown", onChartPress, true);
  }
});

// --- who is free here -----------------------------------------------------

/** Clearance between the card and the region it is about. */
const SUMMARY_CLEARANCE = 12;

/** The card's exposed root element, for `contains()` press tests. */
const summaryComp = ref<InstanceType<typeof RegionSummary> | null>(null);

/** The live region the card is about, or null when the chart carries none. */
const viewSelection = computed(() => {
  const state = menuState.value;
  if (props.editable || !state?.live || state.kind !== "view") return null;
  return state;
});

/** Built once, so the tooltip and the region's label describe a slot in the same words. */
const rangeOptions = computed(() => ({
  withDate: props.model.showDates,
  dowDates: props.event.type === "dow" ? props.event.dates : undefined,
  startOnMonday: props.event.startOnMonday,
}));

/** The region's span; a single cell keeps the tooltip's wording for the same slot. */
function regionLabel(start: Cell, end: Cell): string {
  const minRow = Math.min(start.row, end.row);
  const maxRow = Math.max(start.row, end.row);
  const minCol = Math.min(start.col, end.col);
  const maxCol = Math.max(start.col, end.col);

  const single = minRow === maxRow && minCol === maxCol;
  const slot = single ? slotAt(props.model, minRow, minCol) : null;
  if (slot !== null) {
    return formatSlotRange(
      slot,
      props.model.slotMinutes,
      props.model.timezoneOffset,
      props.hour12,
      rangeOptions.value,
    );
  }

  // The columns' own headings: dates where the chart shows dates, weekdays otherwise.
  const nameOf = (index: number) => {
    const column = props.model.columns[index];
    if (!column) return "";
    return props.model.showDates ? column.dateLabel : column.weekday;
  };
  const days = minCol === maxCol ? nameOf(minCol) : `${nameOf(minCol)} – ${nameOf(maxCol)}`;

  const from = props.model.rows[minRow]?.localTimeNum ?? 0;
  const until = (props.model.rows[maxRow]?.localTimeNum ?? 0) + props.model.stepHours;
  const times = `${timeNumToTimeText(from, props.hour12)} – ${timeNumToTimeText(
    until % 24,
    props.hour12,
  )}`;
  return `${days} · ${times}`;
}

const summary = computed(() => {
  const selection = viewSelection.value;
  if (!selection) return null;

  // Anchored on the region's centre with its half-height as clearance: clear of
  // the rectangle and its handles, and it follows the columns under a scroll.
  const box = regionBox(selection.start, selection.end);
  return {
    slotIds: selection.slots,
    label: regionLabel(selection.start, selection.end),
    anchor: {
      x: chartLeft.value + box.left + box.width / 2 - scrollLeft.value,
      y: viewportTop.value + HEADER_HEIGHT + box.top + box.height / 2 - scrollTop.value,
      clearance: box.height / 2 + SUMMARY_CLEARANCE,
    },
  };
});

/** Takes the region and the pin together: a rectangle nothing explains is a trap. */
function dismissRegion() {
  closeMenu();
  emit("pin", null);
}

// --- painting -------------------------------------------------------------

interface PaintedCell {
  row: number;
  slot: number | null;
  color: string | null;
  kind: "disabled" | "empty" | "available" | "if_needed" | "erasing";
}

/** Heatmap base for the current theme; flipping the theme repaints the grid. */
const slotBase = useSlotBaseColor();

/** The whole event, so scrolling never rebuilds it; the active slot is a class on one cell, not a repaint. */
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
          // A drag paints an available time; its meaning is asked once it lands.
          return { row: rowIndex, slot, color: null, kind: "available" };
        }
        if (availability.has(slot)) {
          return { row: rowIndex, slot, color: null, kind: "available" };
        }
        if (ifNeeded.has(slot)) {
          return { row: rowIndex, slot, color: null, kind: "if_needed" };
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
          ? "if_needed"
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
        return { row: rowIndex, slot, color: null, kind: "if_needed" };
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
  // Both axes subtract the scroll: the cell it points at moves with the track.
  const centre =
    chartLeft.value + offsets.value[cell.col] + colWidth.value / 2 - scrollLeft.value;
  return {
    text: formatSlotRange(
      slot,
      props.model.slotMinutes,
      props.model.timezoneOffset,
      props.hour12,
      rangeOptions.value,
    ),
    left: overlayCenterX(TOOLTIP_MAX_WIDTH, overlayField.value, centre),
    top: HEADER_HEIGHT + rowTop(cell.row) - scrollTop.value,
  };
});

/** For the page: an undo moves the marks a live ring is drawn around, and a stale ring lies about them. */
function clearSelection() {
  closeMenu();
  endResize();
}

defineExpose({ measure, clearSelection });
</script>

<template>
  <div class="grid" :class="{ scrollable }">
    <div class="wrap">
      <div class="stage" :class="{ dragging: gesturing }">
        <!-- One scrollport; the gutter and headings are pinned inside it. -->
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
              <!-- On the gutter, so the rubber-band moves them as one (ARCHITECTURE.md § Client model). -->
              <div v-if="moreBefore" class="gutter-fade" aria-hidden="true" />
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

              <!-- No `touch-action` of its own: a finger's drag belongs to the platform (ARCHITECTURE.md § Client model). -->
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

                <!-- The ring. Inert, inside the track so it stays on its cells. -->
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

              <!-- Over the track, not in the body: the body's clipping would
                   slice a corner handle and its 44px. Only the discs take the pointer. -->
              <div v-if="handles" ref="gripsEl" class="grips" aria-hidden="true">
                <div
                  v-for="end in GRIP_ENDS"
                  :key="end"
                  class="grip"
                  :class="`grip--${handles.kind}`"
                  :style="{
                    left: `${handles[end].x}px`,
                    top: `${HEADER_HEIGHT + handles[end].y}px`,
                  }"
                  @pointerdown="startResize(end, $event)"
                />
              </div>
            </div>
          </div>
        </div>

        <!-- Outside the scrollport so they stay put; the start fade rides the gutter instead. -->
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

      <!-- A direct child of the wrap, not teleported: its clamp and coordinates are the wrap's own. -->
      <RegionSummary
        v-if="summary"
        ref="summaryComp"
        :slot-ids="summary.slotIds"
        :response-index="responseIndex"
        :label="summary.label"
        :anchor="summary.anchor"
        :field="overlayField"
        @dismiss="dismissRegion"
      />

      <!-- A preview beside the pointer during the drag, a control where it
           ended; only its buttons take the pointer. Not teleported: its
           coordinates are the wrap's own. -->
      <SelectionMenu
        v-if="menu"
        ref="menuComp"
        :kind="menu.kind"
        :type="menu.type"
        :live="menu.live"
        :anchor="menu.anchor"
        :field="overlayField"
        :coarse="coarsePointer"
        @choose="chooseType"
        @undo="undoSelection"
        @dismiss="dismissMenu"
        @pointerenter="pauseMenu"
        @pointerleave="resumeMenu"
      />
    </div>
  </div>
</template>

<style scoped>
.grid {
  /* How wide the dissolved edge is; the knob sits inside it. */
  --fade: 2rem;
  /* Mirrors HEADER_HEIGHT in the script. */
  --head: 42px;
  /* The time gutter's width; the fades, prev knob and foot start where the columns do. */
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

/* Containment is per axis: horizontal `contain` stops the back gesture but keeps
   the rubber-band (ARCHITECTURE.md § Client model); on the vertical axis it would
   swallow a wheel over the chart — `overflow-y: hidden` still makes a scroll
   container, and a contained one refuses to chain the scroll to the page. */
.viewport {
  --focus-ring-inset: calc(var(--focus-ring-offset) * -1);

  position: relative;
  flex: 1 1 auto;
  min-width: 0;
  overflow-x: auto;
  overflow-y: hidden;
  overscroll-behavior-x: contain;
  scrollbar-width: none;
}

/* The chart carries its own continuation cues; a bar would only cost a strip of grid. */
.viewport::-webkit-scrollbar {
  display: none;
}

.viewport.scrollable {
  cursor: grab;
}

.viewport.panning,
.viewport.panning .header {
  cursor: grabbing;
}

/* The gutter is stretched: even a pixel short of the track lets the body's
   bottom border show under it as the track scrolls by. */
.sheet {
  display: flex;
  align-items: stretch;
  width: max-content;
  min-width: 100%;
}

/* Pinned across the horizontal scroll; opaque, so the columns pass behind. */
.gutter {
  position: sticky;
  left: 0;
  z-index: 3;
  flex: none;
  width: var(--gutter);
  text-align: right;
  background: var(--color-bg);
}

/* Bled past the left edge: layer rounding at fractional device pixels must
   never expose the columns beneath (ARCHITECTURE.md § Client model). */
.gutter::before {
  content: "";
  position: absolute;
  top: 0;
  bottom: 0;
  left: -2px;
  width: 4px;
  background: var(--color-bg);
}

/* The corner: pinned on the other axis too, so labels cannot slide into the headings' band. */
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

/* The first label hangs below its line; straddling it would be sliced by the pinned headings. */
.gutter-label.hour.first span {
  transform: none;
}

/* Positioned: the handle layer is placed against it. */
.track {
  position: relative;
  flex: none;
}

/* --- scroll controls ----------------------------------------------------- */

/* Laid over the chart's edges, past the header so it centres on the body. */
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

/* `--dir` lets the two mirrored knobs share one transform rule per state. */
.knob--prev {
  --dir: -1;

  left: calc(var(--gutter) + 0.15rem);
}

.knob--next {
  --dir: 1;

  right: 0.15rem;
}

/* Translucent over its backdrop, so the cells it covers still read as grid. */
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

/* A tap must not leave the knob stuck in its hover state on a phone. */
@media (hover: hover) {
  .knob:hover:not(:disabled) .knob__glyph {
    color: var(--color-accent-contrast);
    background: var(--color-accent);
    border-color: var(--color-accent);
    transform: translateX(calc(var(--dir) * 1px));
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

/* Inert during a paint drag, so a sweep across one paints through instead of scrolling. */
.stage.dragging .knob {
  pointer-events: none;
  opacity: 0.3;
}

/* The knob the drag leans on stays lit — reporting, not offering. */
.stage.dragging .knob.armed {
  opacity: 1;
}

.stage.dragging .knob.armed .knob__glyph {
  color: var(--color-accent-contrast);
  background: var(--color-accent);
  border-color: var(--color-accent);
  transform: translateX(calc(var(--dir) * 2px));
}

/* The ring itself is the global rule's; the pill shape is this button's own. */
.knob:focus-visible {
  border-radius: var(--radius-pill);
}

/* The clipped end edge, dissolved rather than cut. Inert — the cells beneath take the pointer. */
.edge {
  position: absolute;
  top: 0;
  bottom: 0;
  z-index: 4;
  width: var(--fade);
  pointer-events: none;
}

.edge--end {
  right: 0;
  background: linear-gradient(to left, var(--color-bg), transparent);
}

/* On the gutter it borders, so the rubber-band cannot shear them apart (ARCHITECTURE.md § Client model). */
.gutter-fade {
  position: absolute;
  top: 0;
  bottom: 0;
  left: 100%;
  width: var(--fade);
  pointer-events: none;
  background: linear-gradient(to right, var(--color-bg), transparent);
}

/* --- chart --------------------------------------------------------------- */

/* Pinned across the vertical scroll; opaque for the same reason the gutter is. */
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

/* The height is fixed, so a wrapped label pushes the weekday out of sight;
   `nowrap` keeps a stray long label a truncation instead. */
.head-cell {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.05rem;
  overflow: hidden;
  white-space: nowrap;
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

.cell.is-if_needed {
  background-color: var(--color-slot-if-needed);
}

.cell.is-erasing {
  background-color: var(--color-danger-soft);
}

/* Two solid pixels with a page-colour sheath, so the ring reads over every fill in both themes. */
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

/* The same blue as an editing selection: the same idea, and nothing paints in the group view. */
.region--view {
  /* No halo: nothing was done to anything. */
  box-shadow:
    inset 0 0 0 1px color-mix(in srgb, var(--color-bg) 75%, transparent),
    0 0 0 1px color-mix(in srgb, var(--color-bg) 75%, transparent);
}

.region--erase {
  outline-color: var(--color-selection-delete);
  box-shadow:
    inset 0 0 0 1px color-mix(in srgb, var(--color-bg) 75%, transparent),
    0 0 0 1px color-mix(in srgb, var(--color-bg) 75%, transparent),
    0 0 10px color-mix(in srgb, var(--color-selection-delete) 55%, transparent);
}

/* --- the handles ---------------------------------------------------------- */

/* A hole over the whole track; only the discs are solid. */
.grips {
  position: absolute;
  inset: 0;
  z-index: 6;
  pointer-events: none;
}

/* A 44px target round a small disc. `touch-action: none` is here and nowhere
   else on the chart (ARCHITECTURE.md § Client model). */
.grip {
  /* The selection's own colour; the erase variant only swaps this. */
  --sel: var(--color-selection-create);

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

/* A page-colour sheath, so the disc reads over any fill in both themes. */
.grip::after {
  content: "";
  width: 0.95rem;
  height: 0.95rem;
  background: var(--sel);
  border: 2px solid var(--color-bg);
  border-radius: var(--radius-pill);
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--sel) 60%, transparent), var(--shadow-sm);
  transition: transform var(--transition-fast);
}

.grip--erase {
  --sel: var(--color-selection-delete);
}

/* Grown rather than recoloured: the colour is what it means. */
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

/* Same box as the chart body, so the foot lines up with the columns above. */
.foot {
  max-width: 100%;
  margin-top: 0.45rem;
  margin-left: var(--gutter);
}

/* `TOOLTIP_MAX_WIDTH` in the script is this max-width; the bubble may be cut short but never grow past it. */
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

/* Touch: 44px targets round the same small discs. */
@media (pointer: coarse) {
  .grid {
    --fade: 2.75rem;
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

/* The app-like layout: a fixed box between the bars, scrolling on both axes (ARCHITECTURE.md § Client model). */
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

  /* The pane owns the vertical scroll here, so that axis is contained too. */
  .viewport {
    overflow-y: auto;
    overscroll-behavior-y: contain;
    /* Room under the last row for the fades' full height and a thumb. */
    padding-bottom: 0.5rem;
  }

  .gutter-label {
    font-size: 0.625rem;
  }

  /* Load-bearing size: `perViewFor` divides the width by a shade over this heading's width. */
  .weekday,
  .date {
    font-size: 0.6875rem;
  }
}
</style>
