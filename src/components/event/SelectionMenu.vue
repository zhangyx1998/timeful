<script setup lang="ts">
// The floating options strip: what the rectangle being drawn means. Self-placing:
// sized by its own labels in the platform UI font, so it is measured, not guessed.
import { computed, nextTick, onMounted, ref, watch } from "vue";
import { placeOverlay, type OverlayField } from "../../lib/grid";
import IconCheck from "../../assets/icons/check.svg";
import IconCheckWide from "../../assets/icons/check-wide.svg";
import IconHourglass from "../../assets/icons/hourglass.svg";
import IconUndo from "../../assets/icons/undo.svg";
import type { AvailabilityType } from "../../lib/event";

const props = defineProps<{
  kind: "create" | "erase";
  type: AvailabilityType;
  /** False while the drag runs — a preview cannot be clicked. */
  live: boolean;
  /** The strip clears above a finger, below a cursor. */
  anchor: { x: number; y: number; touch: boolean };
  field: OverlayField;
  coarse: boolean;
}>();

const emit = defineEmits<{
  choose: [type: AvailabilityType];
  undo: [];
  dismiss: [];
}>();

const MENU_GAP = 8;
// A cursor hides almost nothing, so the strip sits just below; a finger covers
// the spot, so it goes above and further out.
const MENU_CURSOR_CLEARANCE = 18;
const MENU_TOUCH_CLEARANCE = 26;

/** Exposed: the chart asks this element `contains()` to tell a press on the strip from one outside it. */
const element = ref<HTMLElement | null>(null);
const size = ref<{ width: number; height: number } | null>(null);

function measure() {
  const root = element.value;
  if (root) size.value = { width: root.offsetWidth, height: root.offsetHeight };
}

onMounted(measure);

// Re-measure when it becomes a different strip; change and correction both land before a paint.
watch(
  () => `${props.kind}:${props.coarse}`,
  () => void nextTick(measure),
);

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

    <!-- Dismissal keeps the marks: a check, not a cross (ARCHITECTURE.md § Client model). -->
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
/* The strip itself is a hole (pointer-events: none): a drag starting under it paints as usual. */
.meaning {
  position: absolute;
  z-index: 15;
  display: flex;
  align-items: stretch;
  /* max-content, not shrink-to-fit: engines disagree on a positioned flex row's minimum width (WebKit clipped controls). */
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

/* A preview must never intercept the gesture it describes. */
.meaning--preview .meaning__option {
  pointer-events: none;
  cursor: default;
}

.meaning__option + .meaning__option {
  border-left: 1px solid var(--color-border);
}

/* Inset by the border so the chosen fill follows the strip's own curve. */
.meaning__option:first-child {
  border-radius: calc(var(--radius-md) - 1px) 0 0 calc(var(--radius-md) - 1px);
}

.meaning__option:last-child {
  border-radius: 0 calc(var(--radius-md) - 1px) calc(var(--radius-md) - 1px) 0;
}

.meaning__option--icon {
  justify-content: center;
  padding: 0.3rem 0.55rem;
}

.meaning__option--icon svg {
  width: 0.95rem;
  height: 0.95rem;
}

.meaning__option--revert {
  padding: 0.3rem 0.7rem;
}

/* Specific enough to beat the generic hover below. */
.meaning__option--undo:hover:not(.meaning__option--on) {
  color: var(--color-danger);
  background: var(--color-danger-soft);
}

/* Beats the width/height attributes at usage sites — those are a floor, since a viewBox-only inline SVG has no intrinsic size. */
.meaning__option svg {
  width: 0.85rem;
  height: 0.85rem;
  flex: none;
}

.meaning__option:hover:not(.meaning__option--on) {
  color: var(--color-text);
  background: var(--color-subtle);
}

/* Affirmative hover for Done; after the generic hover it ties and must beat. */
.meaning__option--dismiss:hover:not(.meaning__option--on) {
  color: var(--color-success);
  background: var(--color-accent-soft);
}

/* Cut with the surface: neat slot colours drop the label to 1.6:1 contrast in the dark theme. */
.meaning__option--on {
  font-weight: 600;
  color: var(--color-text);
  background: color-mix(in srgb, var(--color-slot-available) 45%, var(--color-surface));
}

.meaning__option--if-needed.meaning__option--on {
  background: color-mix(in srgb, var(--color-slot-if-needed) 45%, var(--color-surface));
}

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

  /* Icon-only controls padded out to the 44px tap floor. */
  .meaning__option--icon {
    padding-inline: 0.95rem;
  }
}
</style>
