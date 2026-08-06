<script setup lang="ts">
/**
 * The floating options strip: what the rectangle being drawn means.
 *
 * Carried beside the pointer for the length of a drag as a preview that takes
 * no pointer at all, and left where the drag ended as a working control. The
 * gesture, the countdown and the undo history all live in the chart that owns
 * the selection; this owns only what a strip is — the buttons, and where the
 * box those buttons sit in may go.
 *
 * It places itself. The strip is sized by its own labels, set in whatever the
 * platform calls its UI font, so the width cannot be a constant — the same
 * three words are wider under iOS than here. It is measured on mount and again
 * whenever it becomes a different strip (a creation menu and an erase menu
 * carry different controls, and a coarse pointer sizes both), and every
 * measurement lands before the browser paints, so the placement the constants
 * used to guess at is simply read.
 */
import { computed, nextTick, onMounted, ref, watch } from "vue";
import { placeOverlay, type OverlayField } from "../../lib/grid";
import IconCheck from "../../assets/icons/check.svg";
import IconCheckWide from "../../assets/icons/check-wide.svg";
import IconHourglass from "../../assets/icons/hourglass.svg";
import IconUndo from "../../assets/icons/undo.svg";
import type { AvailabilityType } from "../../lib/event";

const props = defineProps<{
  /** Which strip this is: a creation carries four controls, an erase two. */
  kind: "create" | "erase";
  /** What the rectangle currently means, read off the answer itself. */
  type: AvailabilityType;
  /** False while the drag runs — a preview cannot be clicked, or aimed at. */
  live: boolean;
  /** The point the strip keeps beside, in the wrap's coordinates, and whether
   *  a finger is driving it: the strip clears above one, below a cursor. */
  anchor: { x: number; y: number; touch: boolean };
  /** The box the strip is placed inside and clamped to. */
  field: OverlayField;
  /** Whether the pointer is a finger: the strip is sized for one if it is. */
  coarse: boolean;
}>();

const emit = defineEmits<{
  choose: [type: AvailabilityType];
  undo: [];
  dismiss: [];
}>();

/** Clearance between the strip and the edges of the chart it is clamped into. */
const MENU_GAP = 8;
/**
 * How far the strip keeps off the pointer itself. A cursor points at a spot and
 * hides almost none of it, so the strip sits just below. A finger covers what
 * it touches and everything for a few millimetres around, so the strip goes
 * above it and further out.
 */
const MENU_CURSOR_CLEARANCE = 18;
const MENU_TOUCH_CLEARANCE = 26;

/** The root element, exposed: the chart tells a press on the strip from a
 *  press outside it by asking this element, and a component instance cannot
 *  answer `contains()`. */
const element = ref<HTMLElement | null>(null);
const size = ref<{ width: number; height: number } | null>(null);

function measure() {
  const root = element.value;
  if (root) size.value = { width: root.offsetWidth, height: root.offsetHeight };
}

onMounted(measure);

// Re-measured whenever the strip becomes a different strip. The old size holds
// until the new one is read — both the change and the correction land before a
// paint, so neither is ever seen.
watch(
  () => `${props.kind}:${props.coarse}`,
  () => void nextTick(measure),
);

/**
 * Beside the pointer, never under it, and never outside the chart. Centred on
 * the pointer horizontally and clamped into the column area; vertically it
 * takes the side the pointing device leaves free, flipping to the other when
 * the first would put it off the top or the bottom of the scrollport.
 */
const placement = computed(() => {
  const box = size.value;
  if (!box) return { left: props.anchor.x, top: props.anchor.y };
  return placeOverlay(box, props.field, {
    x: props.anchor.x,
    y: props.anchor.y,
    clearance: props.anchor.touch ? MENU_TOUCH_CLEARANCE : MENU_CURSOR_CLEARANCE,
    gap: MENU_GAP,
    above: props.anchor.touch,
  });
});

defineExpose({ element });
</script>

<template>
  <div
    ref="element"
    class="meaning"
    :class="{ 'meaning--preview': !live }"
    :style="{ left: `${placement.left}px`, top: `${placement.top}px` }"
    role="group"
    :aria-label="
      kind === 'erase' ? 'The times you just cleared' : 'What the times you just marked mean'
    "
  >
    <template v-if="kind === 'create'">
      <button
        type="button"
        class="meaning__option meaning__option--available"
        :class="{ 'meaning__option--on': type === 'available' }"
        :aria-pressed="type === 'available'"
        :tabindex="live ? undefined : -1"
        @click="emit('choose', 'available')"
      >
        <IconCheck width="14" height="14" aria-hidden="true" />
        Available
      </button>

      <button
        type="button"
        class="meaning__option meaning__option--if-needed"
        :class="{ 'meaning__option--on': type === 'if_needed' }"
        :aria-pressed="type === 'if_needed'"
        :tabindex="live ? undefined : -1"
        @click="emit('choose', 'if_needed')"
      >
        <IconHourglass width="14" height="14" aria-hidden="true" />
        If needed
      </button>

      <!-- No label: it stands beside two that carry one, and a third word
           would make the strip something to read rather than something to
           choose from. The back-arrow is the one glyph that says "put it
           back" without one — and it is the same word underneath as the
           erase strip's, because it is now the same action off the same
           history. -->
      <button
        type="button"
        class="meaning__option meaning__option--undo meaning__option--icon"
        aria-label="Undo"
        title="Undo"
        :tabindex="live ? undefined : -1"
        @click="emit('undo')"
      >
        <IconUndo width="14" height="14" aria-hidden="true" />
      </button>
    </template>

    <!-- An erase has nothing to choose between, so it has room to say in a
         word what the creation strip leaves to the glyph. One word for both,
         since pressing either asks the page for the same thing. -->
    <button
      v-else
      type="button"
      class="meaning__option meaning__option--undo meaning__option--revert"
      aria-label="Undo"
      :tabindex="live ? undefined : -1"
      @click="emit('undo')"
    >
      <IconUndo width="14" height="14" aria-hidden="true" />
      Undo
    </button>

    <!-- Last: the way out that KEEPS the marks. It used to be a cross, and a
         cross beside an undo read as "throw my change away" — the opposite of
         what it does. A checkmark says what dismissal means here: done, keep
         it, close the strip — the same closing that waiting or pressing
         elsewhere does. The undo beside it stays the one that moves marks.
         (A cross remains right where closing accepts nothing: the digest
         card, the mode pills.) -->
    <button
      type="button"
      class="meaning__option meaning__option--dismiss meaning__option--icon"
      aria-label="Done"
      title="Done"
      :tabindex="live ? undefined : -1"
      @click="emit('dismiss')"
    >
      <IconCheckWide width="14" height="14" aria-hidden="true" />
    </button>
  </div>
</template>

<style scoped>
/* Pinned beside the pointer and clamped to the chart's own box, so it cannot
   hang off a narrow screen. Only the buttons take the pointer: the strip itself
   is a hole, and a drag that starts under it paints as usual. */
.meaning {
  position: absolute;
  z-index: 15;
  display: flex;
  align-items: stretch;
  /* Exactly as wide as what is in it, and never a pixel less.
     Absolutely positioned, it would otherwise be shrink-to-fit — sized against
     whatever is left of the containing block to the right of `left` — and how
     an engine resolves the minimum width of a flex row is exactly the thing
     engines disagree about. WebKit came out narrower here, and with the
     `overflow: hidden` this used to carry, the disagreement was invisible: the
     first label was cut off mid-word and the last two controls were not drawn
     at all. Content that does not fit now overflows, which is a thing you can
     see and fix rather than a thing that looks like a rendering bug. */
  width: -webkit-max-content;
  width: max-content;
  transform: translateX(-50%);
  background: var(--color-surface);
  border: 1px solid var(--color-border-strong);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-md);
  pointer-events: none;
}

.meaning__option {
  --focus-ring-inset: calc(var(--focus-ring-offset) * -1);

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

/* The corners the container used to clip for them. Inset by the border, so the
   tinted "chosen" fill follows the strip's own curve instead of squaring it
   off. */
.meaning__option:first-child {
  border-radius: calc(var(--radius-md) - 1px) 0 0 calc(var(--radius-md) - 1px);
}

.meaning__option:last-child {
  border-radius: 0 calc(var(--radius-md) - 1px) calc(var(--radius-md) - 1px) 0;
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

/* The size that applies. The same five glyphs also carry `width`/`height`
   attributes at their usage sites, which this beats everywhere it lands — they
   are there as a floor, because an inline SVG with only a `viewBox` has no
   intrinsic size to fall back on, and an engine that missed this rule would
   give each one a default box wide enough to shove the rest of the strip out
   of the chart. */
.meaning__option svg {
  width: 0.85rem;
  height: 0.85rem;
  flex: none;
}

.meaning__option:hover:not(.meaning__option--on) {
  color: var(--color-text);
  background: var(--color-subtle);
}

/* Done keeps the marks, and its hover says so in the affirmative — the
   counterpart of the undo's warning red. After the generic hover, which it
   ties on specificity and must beat. */
.meaning__option--dismiss:hover:not(.meaning__option--on) {
  color: var(--color-success);
  background: var(--color-accent-soft);
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

/* Sized for a finger. */
@media (pointer: coarse) {
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
}
</style>
