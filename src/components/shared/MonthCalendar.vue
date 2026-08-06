<script setup lang="ts">
// Dependency-free month grid: each cell toggles a "YYYY-MM-DD" key in the bound array.
// Fixed 6×7 with neighbour-month bleed days (one height, animatable); picking a bleed
// day stays on this month. Three months sit on a real track; a change slides it by one.
import { computed, ref } from "vue";
import IconButton from "../ui/IconButton.vue";
import { dayKey } from "../../lib/event-form";
import { WEEKDAY_LABELS } from "../../lib/dates";

interface Cell {
  day: number;
  key: string;
  outside: boolean;
}

interface Page {
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

// The month state commits first; the track is offset one month back, then released,
// so the label, the grid and the slide stay in step.
const from = ref<"prev" | "next" | null>(null);
/** Off for the frame the offset is applied, on for the frame it is released. */
const animating = ref(false);

const todayKey = dayKey(today.getFullYear(), today.getMonth(), today.getDate());

function monthLabelOf(date: Date): string {
  return date.toLocaleDateString(undefined, { month: "long", year: "numeric" });
}

const monthLabel = computed(() => monthLabelOf(new Date(viewYear.value, viewMonth.value, 1)));

function monthCells(year: number, month: number): Cell[] {
  const lead = new Date(year, month, 1).getDay();
  const out: Cell[] = [];
  for (let i = 0; i < WEEKS * 7; i += 1) {
    // Day 0 and beyond the month's length both roll over correctly.
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

  // Two frames: one is not enough for the browser to lay the offset out before the transition turns on.
  from.value = delta > 0 ? "prev" : "next";
  animating.value = false;
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      animating.value = true;
      from.value = null;
    });
  });
}

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
          <!-- inert: a peeked month's cells leave the tab order; the sheet over it is the click target. -->
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
  /* The viewport's height is six cells plus gaps; the two must agree exactly. */
  --cell: var(--tap-min);
  --cell-gap: 0.25rem;
  /* Everything that lines up over the centred month is this wide; extra width belongs to the peeks. */
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

/* One line: a wrapping month name used to change the header's height under the grid. */
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

/* Text glyphs, not svg: sized here because IconButton's glyph sizing only reaches slotted svg. */
.calendar__nav {
  font-size: 1rem;
  line-height: 1;
}

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

.calendar__viewport {
  position: relative;
  height: calc(6 * var(--cell) + 5 * var(--cell-gap));
  margin-top: var(--cell-gap);
  overflow: hidden;
  /* Fade stops meet at the centred month's edges, so with no overhang nothing is dimmed. */
  mask-image: linear-gradient(
    to right,
    rgb(0 0 0 / 0) 0,
    rgb(0 0 0 / 1) calc(50% - var(--month) / 2),
    rgb(0 0 0 / 1) calc(50% + var(--month) / 2),
    rgb(0 0 0 / 0) 100%
  );
}

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

/* Height, not aspect-ratio: seven square 44px cells plus gaps overflow a 360px screen. */
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

.calendar__day--outside {
  color: var(--color-text-muted);
  opacity: 0.6;
}

.calendar__day--outside.calendar__day--selected {
  color: var(--color-accent-contrast);
}

@media (min-width: 40rem) {
  .calendar {
    padding: 1rem;
  }
}
</style>
