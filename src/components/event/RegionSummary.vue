<script setup lang="ts">
/**
 * Who is free across the region that was just drawn, composed over the chart
 * beside the cells it is about.
 *
 * On a desktop the answer to "who is free at this cell?" is already on screen,
 * in the column beside the chart. On a phone that column is behind a drawer,
 * and a drawer is the wrong place for the answer to the question a tap on a
 * cell *is*: by the time it is open the cell is under it. So the same reading —
 * the time, the fraction, and each person's own mark in the glyph the list uses
 * for it — floats here instead.
 *
 * It answers for a region rather than for a cell, and so it is on the desktop
 * too. The column beside the chart reads one slot and cannot be asked about a
 * span of them; a region can, and the answer is a different one —
 * `regionDigest` gives each person the worst thing they said anywhere inside
 * it, so "4 of 9 free" over an afternoon means four people can make the *whole*
 * afternoon. A one-cell region is the old reading exactly, which is what keeps
 * the phone's tap doing what it always did.
 *
 * The chart owns the region — which cells, what they are called, where their
 * box sits; this owns the reading of them and the card it is printed on.
 */
import { computed, nextTick, onMounted, ref, watch } from "vue";
import {
  placeOverlay,
  regionDigest,
  toneFor,
  STANCE_LABELS,
  type OverlayField,
  type ResponseIndex,
} from "../../lib/grid";
import IconCheck from "../../assets/icons/check.svg";
import IconHourglass from "../../assets/icons/hourglass.svg";
import IconClose from "../../assets/icons/close-sm.svg";

const props = defineProps<{
  /** The region's slots — what the digest is a digest of. */
  slotIds: number[];
  responseIndex: ResponseIndex;
  /** What the region is called: the cells' own span, in the chart's words. */
  label: string;
  /**
   * The region's centre, in the wrap's coordinates, with the region's own
   * half-height as the clearance — so the card lands clear of the whole
   * rectangle on whichever side has room, not merely clear of a point.
   */
  anchor: { x: number; y: number; clearance: number };
  /** The box the card is placed inside and clamped to. */
  field: OverlayField;
}>();

const emit = defineEmits<{
  dismiss: [];
}>();

/**
 * How many people the card will name. Eight chips run two or three to a line,
 * so the card stays under about a third of the chart's height on the narrowest
 * phone. Past that it names the people who can make it and counts the rest
 * (`regionDigest`); the drawer holds the full list either way.
 */
const SUMMARY_CAP = 8;
/** Clearance from the chart's own edges. */
const SUMMARY_GAP = 8;

/** The root element, exposed: the chart tells a press on the card from a press
 *  outside it by asking this element, and a component instance cannot answer
 *  `contains()`. */
const element = ref<HTMLElement | null>(null);
/**
 * The card's measured box. It is sized by its own content — a name may be
 * long, a time label may wrap — so the placement cannot be worked out from
 * constants the way it could for a box of buttons. It is rendered once
 * unplaced and invisible, measured, and only then shown, which costs one frame
 * nobody can see and removes a pair of numbers that would have had to track
 * the CSS by hand.
 */
const size = ref<{ width: number; height: number } | null>(null);

function measure() {
  const root = element.value;
  if (root) size.value = { width: root.offsetWidth, height: root.offsetHeight };
}

onMounted(measure);

// The content changes as the rectangle grows or is replaced — a name comes or
// goes with every cell a handle crosses — and the card has to be re-placed
// against the new box. It keeps the size it has until the new one is read, so
// it does not blink out under the finger that is dragging it.
watch(
  () => props.slotIds,
  () => void nextTick(measure),
);

const digest = computed(() => regionDigest(props.slotIds, props.responseIndex, { cap: SUMMARY_CAP }));

/** More than one cell, so the fraction is about all of them at once. */
const whole = computed(() => props.slotIds.length > 1);

// Same three readings the respondents list gives the fraction (`toneFor`).
const tone = computed(() => toneFor(digest.value.free, digest.value.total));

/** Above by preference: a finger covers what it has just touched, and below a
 *  region near the foot of the chart is where the least room is. */
const placement = computed(() => {
  const box = size.value;
  if (!box) return { left: props.anchor.x, top: props.anchor.y };
  return placeOverlay(box, props.field, {
    x: props.anchor.x,
    y: props.anchor.y,
    clearance: props.anchor.clearance,
    gap: SUMMARY_GAP,
    above: true,
  });
});

const placed = computed(() => size.value !== null);

defineExpose({ element });
</script>

<template>
  <div
    ref="element"
    class="digest"
    :class="{ 'digest--placed': placed }"
    role="group"
    :aria-label="whole ? `Who is free throughout ${label}` : `Who is free at ${label}`"
    :style="{ left: `${placement.left}px`, top: `${placement.top}px` }"
  >
    <div class="digest__head">
      <!-- One line, whatever the label says: the card floats over the chart
           and a second line of heading would push the names it exists to
           show off the bottom of it. Cut short, the whole of it is still on
           the element for anything that can ask. -->
      <span class="digest__when" :title="label">{{ label }}</span>
      <button type="button" class="digest__close" aria-label="Dismiss" @click="emit('dismiss')">
        <IconClose width="14" height="14" aria-hidden="true" />
      </button>
    </div>

    <p v-if="digest.total === 0" class="digest__none">No answers yet.</p>

    <template v-else>
      <!-- The fraction says the same thing the aggregate does: over more
           than one cell, "free" means free for every one of them, so the
           word that makes that plain rides along with it. -->
      <p class="digest__count" :class="`digest__count--${tone}`">
        {{ digest.free }} of {{ digest.total }} free{{ whole ? " throughout" : "" }}
      </p>

      <!-- One chip per person, in the same three glyphs the respondents
           list uses, so the two readings of a slot are the same reading. -->
      <ul class="digest__people">
        <li
          v-for="person in digest.people"
          :key="person.key"
          class="who"
          :class="`who--${person.stance}`"
          :title="person.label"
        >
          <!-- The glyph is the whole of what the chip says about them, so
               it carries the word rather than sitting out of the tree the
               way decoration does. -->
          <span class="who__mark" role="img" :aria-label="STANCE_LABELS[person.stance]">
            <IconCheck v-if="person.stance === 'available'" />
            <IconHourglass v-else-if="person.stance === 'if_needed'" />
            <IconClose v-else stroke-width="2.2" />
          </span>
          <span class="who__name">{{ person.label }}</span>
        </li>
        <!-- Everyone the card chose not to name. Only worth saying beside
             names it did name: with nobody free to list, the fraction above
             is already the whole answer. -->
        <li v-if="digest.hidden > 0 && digest.people.length > 0" class="who who--more">
          +{{ digest.hidden }} more
        </li>
      </ul>
    </template>
  </div>
</template>

<style scoped>
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
  --focus-ring-inset: calc(var(--focus-ring-offset) * -1);

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

/* The card's dismissal is the only control on it, and a finger has to be able
   to hit it without hitting the chart behind. */
@media (pointer: coarse) {
  .digest__close {
    width: 2.1rem;
    height: 2.1rem;
    margin: -0.35rem -0.35rem 0 0;
  }
}
</style>
