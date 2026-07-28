<script lang="ts">
/**
 * Native <select> wearing the same shell as TextInput: same height, border,
 * focus halo. The arrow is drawn in `currentColor` so it themes with the text
 * instead of relying on the platform's own (untintable) chevron.
 */
export interface SelectOption<T> {
  value: T;
  label: string;
}
</script>

<script setup lang="ts" generic="T extends string | number">
import { computed, useId } from "vue";
import IconChevronDown from "../../assets/icons/chevron-down.svg";

const model = defineModel<T>({ required: true });

const props = withDefaults(
  defineProps<{
    options: readonly SelectOption<T>[];
    label?: string;
    id?: string;
    hint?: string;
    /** Keeps the label for screen readers only — for dense toolbars. */
    hideLabel?: boolean;
    /** Caps the control's width; useful for long timezone names. */
    maxWidth?: string;
  }>(),
  { label: "", id: "", hint: "", hideLabel: false, maxWidth: "" },
);

const generatedId = useId();
const selectId = computed(() => props.id || generatedId);
</script>

<template>
  <div class="select-field" :style="maxWidth ? { maxWidth } : undefined">
    <label
      v-if="label"
      class="select-field__label"
      :class="{ 'select-field__label--hidden': hideLabel }"
      :for="selectId"
    >
      {{ label }}
    </label>
    <div class="select-field__control">
      <select :id="selectId" v-model="model" class="select-field__select">
        <option v-for="option in options" :key="String(option.value)" :value="option.value">
          {{ option.label }}
        </option>
      </select>
      <IconChevronDown class="select-field__arrow" aria-hidden="true" />
    </div>
    <p v-if="hint" class="select-field__message">{{ hint }}</p>
  </div>
</template>

<style scoped>
.select-field {
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
  min-width: 0;
}

.select-field__label {
  font-size: 0.875rem;
  font-weight: 500;
  color: var(--color-text);
}

.select-field__label--hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}

.select-field__control {
  position: relative;
  display: flex;
  min-width: 0;
}

.select-field__select {
  width: 100%;
  min-height: 2.5rem;
  padding: 0.5rem 2rem 0.5rem 0.75rem;
  font: inherit;
  font-size: 0.875rem;
  color: var(--color-text);
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  outline: none;
  appearance: none;
  text-overflow: ellipsis;
  cursor: pointer;
  transition: border-color var(--transition-fast), box-shadow var(--transition-fast);
}

@media (pointer: coarse) {
  .select-field__select {
    min-height: var(--tap-min);
  }
}

.select-field__select:focus {
  border-color: var(--color-accent);
  box-shadow: var(--focus-shadow);
}

.select-field__arrow {
  position: absolute;
  top: 50%;
  right: 0.6rem;
  width: 12px;
  height: 12px;
  color: var(--color-text-muted);
  transform: translateY(-50%);
  pointer-events: none;
}

.select-field__message {
  margin: 0;
  font-size: 0.75rem;
  color: var(--color-text-muted);
}

@media (prefers-reduced-motion: reduce) {
  .select-field__select {
    transition: none;
  }
}
</style>
