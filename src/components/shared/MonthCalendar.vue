<script setup lang="ts">
/**
 * Month grid for picking multiple dates. No dependencies: the month is laid out
 * from the local-time first-of-month, and each cell toggles a "YYYY-MM-DD" key
 * in the bound array.
 *
 * Always six weeks
 * ----------------
 * The grid is a fixed 6×7 whatever the month's shape, with the neighbouring
 * months' days filling the corners rather than blanks. Two things follow. The
 * calendar is one height, so opening a month that happens to span six weeks
 * does not shove the rest of the form down — and neither does changing month,
 * which is what makes the change animatable at all. And the days either side of
 * a boundary are pickable without navigating: a Mon–Fri that straddles the end
 * of a month is one drag of the eye, not two screens.
 *
 * Clicking a neighbouring month's day selects it and **stays on this month**.
 * Navigating as a side effect of picking would move the grid out from under the
 * pointer, so picking the second of two adjacent bleed days would mean chasing
 * it. The cell keeps its dimmed styling while selected, which is how you can
 * still tell it is not in the month you are looking at.
 *
 * Three months on a track
 * ----------------------
 * The month keeps one size — the size a month wants to be — and the calendar
 * spends any extra width the dialog gives it on the months either side, dimmed
 * and clipped by the box's own edges. It is the cheapest possible statement
 * that there is more this way: not a hint at an affordance, the thing itself,
 * since a peeked month is clickable and lands you on it.
 *
 * The track is what makes that honest. All three months are laid out for real,
 * side by side, and changing month is the track sliding by exactly one of them
 * while the arriving month brightens and the leaving one dims. Below the width
 * where a neighbour would show, the months are as wide as the box and the
 * peeks simply are not there — the same track, with nothing spare to spend.
 */
import { computed, ref } from "vue";
import IconButton from "../ui/IconButton.vue";
import { dayKey } from "../../lib/event-form";
import { WEEKDAY_LABELS } from "../../lib/dates";

interface Cell {
  day: number;
  key: string;
  /** Belongs to the month before or after the one on screen. */
  outside: boolean;
}

interface Page {
  /** -1, 0 or 1: which side of the month on screen this one is. */
  offset: number;
  /** Identity across a month change, so the same node slides and re-dims. */
  key: string;
  label: string;
  cells: Cell[];
}

/** Six weeks covers every month's layout, so the box never changes height. */
const WEEKS = 6;

const props = withDefaults(defineProps<{ modelValue?: string[] }>(), {
  modelValue: () => [],
});
const emit = defineEmits<{ (e: "update:modelValue", value: string[]): void }>();

const today = new Date();
const initial = props.modelValue.length
  ? new Date(`${[...props.modelValue].sort()[0]}T00:00:00`)
  : today;

const viewYear = ref(initial.getFullYear());
const viewMonth = ref(initial.getMonth());

/**
 * Where the track starts a change from: the neighbour that was centred a moment
 * ago. The month state commits first — the heading and the pages are already
 * the new ones — and the track is offset by one month to put the old one back
 * under the eye, then released. Animating towards the truth rather than away
 * from it is what keeps the label, the grid and the slide in step.
 */
const from = ref<"prev" | "next" | null>(null);
/** Off for the frame the offset is applied, on for the frame it is released. */
const animating = ref(false);

const todayKey = dayKey(today.getFullYear(), today.getMonth(), today.getDate());

function monthLabelOf(date: Date): string {
  return date.toLocaleDateString(undefined, { month: "long", year: "numeric" });
}

const monthLabel = computed(() => monthLabelOf(new Date(viewYear.value, viewMonth.value, 1)));

function monthCells(year: number, month: number): Cell[] {
  // How many days of the previous month lead the first row.
  const lead = new Date(year, month, 1).getDay();
  const out: Cell[] = [];
  for (let i = 0; i < WEEKS * 7; i += 1) {
    // Day 0 and beyond the month's length both roll over correctly here, which
    // is what makes one loop enough for all three months.
    const date = new Date(year, month, 1 - lead + i);
    out.push({
      day: date.getDate(),
      key: dayKey(date.getFullYear(), date.getMonth(), date.getDate()),
      outside: date.getMonth() !== month,
    });
  }
  return out;
}

const pages = computed<Page[]>(() =>
  [-1, 0, 1].map((offset) => {
    const date = new Date(viewYear.value, viewMonth.value + offset, 1);
    return {
      offset,
      key: `${date.getFullYear()}-${date.getMonth()}`,
      label: monthLabelOf(date),
      cells: monthCells(date.getFullYear(), date.getMonth()),
    };
  }),
);

const selected = computed(() => new Set(props.modelValue));

function prefersReducedMotion(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

function shiftMonth(delta: number): void {
  if (delta === 0) return;
  const next = new Date(viewYear.value, viewMonth.value + delta, 1);
  viewYear.value = next.getFullYear();
  viewMonth.value = next.getMonth();

  if (prefersReducedMotion()) {
    from.value = null;
    animating.value = false;
    return;
  }

  // Put the month just left of centre back under the eye, unanimated, then let
  // it go on the next frame. Two frames because one is not enough for the
  // browser to have laid the offset out before the transition is turned on.
  from.value = delta > 0 ? "prev" : "next";
  animating.value = false;
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      animating.value = true;
      from.value = null;
    });
  });
}

/** A year is twelve months; the animation is the same either way. */
function shiftYear(delta: number): void {
  shiftMonth(delta * 12);
}

function toggle(key: string): void {
  const next = new Set(props.modelValue);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  emit("update:modelValue", [...next].sort());
}
</script>

<template>
  <div class="calendar">
    <!-- Year outside month, so the pair reads as coarse-then-fine in both
         directions and tabs through in the order it is drawn. -->
    <div class="calendar__header">
      <div class="calendar__nav-group">
        <IconButton class="calendar__nav" size="xs" label="Previous year" @click="shiftYear(-1)">
          &#171;
        </IconButton>
        <IconButton class="calendar__nav" size="xs" label="Previous month" @click="shiftMonth(-1)">
          &#8249;
        </IconButton>
      </div>

      <div class="calendar__month" aria-live="polite">{{ monthLabel }}</div>

      <div class="calendar__nav-group">
        <IconButton class="calendar__nav" size="xs" label="Next month" @click="shiftMonth(1)">
          &#8250;
        </IconButton>
        <IconButton class="calendar__nav" size="xs" label="Next year" @click="shiftYear(1)">
          &#187;
        </IconButton>
      </div>
    </div>

    <div class="calendar__weekdays">
      <div v-for="label in WEEKDAY_LABELS" :key="label" :title="label">
        {{ label.slice(0, 1) }}
      </div>
    </div>

    <!-- Clipped, so the months either side are cut off by the calendar's own
         edges rather than spilling across the form. -->
    <div class="calendar__viewport">
      <div
        class="calendar__track"
        :class="{
          'calendar__track--from-prev': from === 'prev',
          'calendar__track--from-next': from === 'next',
          'calendar__track--animating': animating,
        }"
      >
        <div
          v-for="page in pages"
          :key="page.key"
          class="calendar__page"
          :class="{ 'calendar__page--peek': page.offset !== 0 }"
        >
          <!-- A peeked month is a picture of a month, not a month you can pick
               days out of: inert takes its cells out of the tab order and out
               of the way of the pointer, and the sheet over it is the one
               thing there is to click. -->
          <div class="calendar__grid" :inert="page.offset !== 0">
            <button
              v-for="cell in page.cells"
              :key="cell.key"
              class="calendar__day"
              :class="{
                'calendar__day--selected': selected.has(cell.key),
                'calendar__day--today': cell.key === todayKey && !selected.has(cell.key),
                'calendar__day--outside': cell.outside,
              }"
              type="button"
              :aria-pressed="selected.has(cell.key)"
              @click="toggle(cell.key)"
            >
              {{ cell.day }}
            </button>
          </div>

          <button
            v-if="page.offset !== 0"
            class="calendar__peek-hit"
            type="button"
            :aria-label="`Go to ${page.label}`"
            :title="page.label"
            @click="shiftMonth(page.offset)"
          />
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.calendar {
  /* One number for the cell height, because the viewport's height is six of
     them plus their gaps and the two have to agree exactly. */
  --cell: var(--tap-min);
  --cell-gap: 0.25rem;
  /* What a month is worth. Everything that has to line up over the month on
     screen — the heading, the weekday letters, the track's own step — is this
     wide, and any width beyond it belongs to the neighbours. Below it there is
     nothing spare and the peeks are pushed clean off the edges. */
  --month: min(21rem, 100%);
  --month-gap: 1rem;

  width: 100%;
  padding: 0.75rem;
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  user-select: none;
  -webkit-user-select: none;
}

/* Over the month it moves, not over the whole box: with the arrows out at the
   edges of a wide dialog they would read as chrome on the card rather than as
   the controls of the thing in the middle of it. */
.calendar__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  width: var(--month);
  margin: 0 auto;
}

.calendar__nav-group {
  display: flex;
  flex: none;
  align-items: center;
}

/* Squeezed between two fixed nav groups on a 320px screen this has about a
   hundred pixels to work with, and a locale that spells the month out — or an
   arrow tap into a longer one — used to wrap it and change the header's height
   under the grid the component otherwise keeps perfectly still. */
.calendar__month {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  font-size: 0.875rem;
  font-weight: 500;
  text-align: center;
  white-space: nowrap;
  text-overflow: ellipsis;
  color: var(--color-text);
}

/* The arrows are text glyphs in IconButton's box, not icons: they render in
   the font the button inherits (the global reset's `font: inherit` keeps
   WebKit off the UA button font), sized here because the component's glyph
   sizing only reaches slotted `svg`. */
.calendar__nav {
  font-size: 1rem;
  line-height: 1;
}

/* Only the month on screen gets its letters named; the peeks are read as
   shapes, and seven more letters each side would be noise over a month nobody
   is picking days out of yet. */
.calendar__weekdays {
  display: grid;
  grid-template-columns: repeat(7, 1fr);
  gap: var(--cell-gap);
  width: var(--month);
  margin: 0.5rem auto 0;
  font-size: 0.6875rem;
  text-align: center;
  color: var(--color-text-muted);
}

/* Six rows of cells and the five gaps between them. Fixed, so the height never
   depends on which month is centred. */
.calendar__viewport {
  position: relative;
  height: calc(6 * var(--cell) + 5 * var(--cell-gap));
  margin-top: var(--cell-gap);
  overflow: hidden;
  /* The peeks dissolve into the card's edges instead of ending on a hard cut
     through a row of numbers, which reads as a chart that failed to fit rather
     than as a month carrying on past the edge. The fade covers exactly the
     overhang: the stops meet at the centred month's own edges, so where there
     is no overhang to fade — a box no wider than a month — they collapse onto
     the ends and nothing is dimmed. */
  mask-image: linear-gradient(
    to right,
    rgb(0 0 0 / 0) 0,
    rgb(0 0 0 / 1) calc(50% - var(--month) / 2),
    rgb(0 0 0 / 1) calc(50% + var(--month) / 2),
    rgb(0 0 0 / 0) 100%
  );
}

/* Three months in a row, centred on the middle one. The row is wider than the
   box it is in, which is the whole point: what hangs off either side is what
   the viewport clips into a peek. */
.calendar__track {
  display: flex;
  justify-content: center;
  gap: var(--month-gap);
}

.calendar__track--animating {
  transition: transform var(--transition-med);
}

/* One month plus the gap to it: the exact distance a change moves. */
.calendar__track--from-prev {
  transform: translateX(calc(var(--month) + var(--month-gap)));
}

.calendar__track--from-next {
  transform: translateX(calc((var(--month) + var(--month-gap)) * -1));
}

.calendar__page {
  position: relative;
  flex: none;
  width: var(--month);
  transition: opacity var(--transition-med);
}

/* Enough to read as a month and not enough to be mistaken for the one you are
   picking from. It brightens as it arrives: the same node keeps its place in
   the list across a change, so this is a transition and not a swap. */
.calendar__page--peek {
  opacity: 0.35;
}

.calendar__peek-hit {
  --focus-ring-inset: calc(var(--focus-ring-offset) * -1);

  position: absolute;
  inset: 0;
  padding: 0;
  background: none;
  border: none;
  border-radius: var(--radius-md);
  cursor: pointer;
}

.calendar__peek-hit:hover {
  background: var(--color-subtle);
}

.calendar__grid {
  display: grid;
  grid-template-columns: repeat(7, 1fr);
  grid-auto-rows: var(--cell);
  gap: var(--cell-gap);
}

/* Height, not aspect-ratio: a square cell with a 44px floor would also impose a
   44px *width* floor, and 7 of those plus gaps overflow a 360px screen. Cells
   stay tap-sized vertically and take whatever width the row gives them. */
.calendar__day {
  --focus-ring-inset: calc(var(--focus-ring-offset) * -1);

  padding: 0;
  font: inherit;
  font-size: 0.8125rem;
  color: var(--color-text);
  background: none;
  border: none;
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: background var(--transition-fast);
}

.calendar__day:hover {
  background: var(--color-subtle);
}

.calendar__day--selected {
  font-weight: 600;
  color: var(--color-accent-contrast);
  background: var(--color-accent);
}

.calendar__day--selected:hover {
  background: var(--color-accent-hover);
}

.calendar__day--today {
  box-shadow: inset 0 0 0 1px var(--color-accent);
}

/* The neighbouring months, present but plainly not the one being read. Dimmed
   whether picked or not: a selected day there still has to look like it came
   from somewhere else. */
.calendar__day--outside {
  color: var(--color-text-muted);
  opacity: 0.6;
}

.calendar__day--outside.calendar__day--selected {
  color: var(--color-accent-contrast);
}

/* --- desktop -------------------------------------------------------------
   Past the breakpoint where the form's own rows go side by side, the card
   takes the width it is given. The month inside it does not grow with it: it
   is already the size a month wants to be, and the extra width goes to the
   neighbours instead of into bigger cells. */
@media (min-width: 40rem) {
  .calendar {
    padding: 1rem;
  }
}
</style>
