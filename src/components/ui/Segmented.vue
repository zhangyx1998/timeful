<script lang="ts">
/**
 * A row of mutually exclusive options in one bordered pill — the shape used for
 * the view switch, the paint mode, the clock format and the event type, which
 * were all hand-rolled separately before.
 */
export interface SegmentedOption<T> {
  value: T;
  label: string;
}
</script>

<script setup lang="ts" generic="T extends string | number">
const model = defineModel<T>({ required: true });

withDefaults(
  defineProps<{
    options: readonly SegmentedOption<T>[];
    /** Group label for assistive tech. */
    label: string;
    /** `solid` fills the selected option with the accent; `soft` tints it. */
    variant?: "solid" | "soft";
    size?: "sm" | "md";
    /**
     * Sizes every option to the widest label instead of to its own. Use it
     * where the labels differ in length and the control is centred: without it
     * the pill is a different width per selection, so it shifts as you switch.
     */
    equal?: boolean;
  }>(),
  { variant: "soft", size: "md", equal: false },
);

defineSlots<{
  /** Renders one option's contents; defaults to its label. */
  option?: (props: { option: SegmentedOption<T> }) => unknown;
}>();
</script>

<template>
  <div
    class="segmented"
    :class="[
      `segmented--${variant}`,
      `segmented--${size}`,
      { 'segmented--equal': equal },
    ]"
    role="group"
    :aria-label="label"
  >
    <button
      v-for="option in options"
      :key="String(option.value)"
      class="segmented__option"
      :class="{ 'segmented__option--on': option.value === model }"
      type="button"
      :aria-pressed="option.value === model"
      @click="model = option.value"
    >
      <slot name="option" :option="option">{{ option.label }}</slot>
    </button>
  </div>
</template>

<style scoped>
.segmented {
  display: inline-flex;
  overflow: hidden;
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
}

/* Equal columns without measuring anything: in a shrink-to-fit grid every 1fr
   track resolves to the widest item's max-content, so both options end up as
   wide as the longer label and the control keeps one width. */
.segmented--equal {
  display: inline-grid;
  grid-auto-flow: column;
  grid-auto-columns: 1fr;
  max-width: 100%;
}

/* An option's label is a label, not a sentence: "Days of week" breaking across
   two lines inside its own segment makes the control grow a row and stops the
   two options reading as a pair. Callers that need a long label to shorten wrap
   it in their own truncating span (see the scheduler's view switch). */
.segmented__option {
  --focus-ring-inset: calc(var(--focus-ring-offset) * -1);

  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.35rem;
  min-width: 0;
  font: inherit;
  font-size: 0.875rem;
  white-space: nowrap;
  color: var(--color-text-muted);
  background: none;
  border: none;
  cursor: pointer;
  transition: background var(--transition-fast), color var(--transition-fast);
}

.segmented__option + .segmented__option {
  border-left: 1px solid var(--color-border);
}

.segmented__option:hover:not(.segmented__option--on) {
  color: var(--color-text);
  background: var(--color-subtle);
}

.segmented--md .segmented__option {
  min-height: 2.25rem;
  padding: 0.35rem 0.8rem;
}

.segmented--sm .segmented__option {
  min-height: 1.875rem;
  padding: 0.3rem 0.6rem;
  font-size: 0.8125rem;
}

@media (pointer: coarse) {
  .segmented--md .segmented__option,
  .segmented--sm .segmented__option {
    min-height: var(--tap-min);
  }
}

.segmented--soft .segmented__option--on {
  font-weight: 600;
  color: var(--color-text);
  background: var(--color-accent-soft);
}

.segmented--solid .segmented__option--on {
  font-weight: 600;
  color: var(--color-accent-contrast);
  background: var(--color-accent);
}
</style>
