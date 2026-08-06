<script setup lang="ts">
// The only button in the app (ARCHITECTURE.md § UX bar). Under a coarse pointer
// every size grows to the 44px tap-target floor.
import Spinner from "./Spinner.vue";

withDefaults(
  defineProps<{
    variant?: "primary" | "secondary" | "ghost" | "danger";
    size?: "sm" | "md";
    type?: "button" | "submit" | "reset";
    loading?: boolean;
    disabled?: boolean;
    block?: boolean;
  }>(),
  {
    variant: "secondary",
    size: "md",
    type: "button",
    loading: false,
    disabled: false,
    block: false,
  },
);
</script>

<template>
  <button
    class="btn"
    :class="[`btn--${variant}`, `btn--${size}`, { 'btn--block': block }]"
    :type="type"
    :disabled="disabled || loading"
    :aria-busy="loading || undefined"
  >
    <Spinner v-if="loading" :size="size === 'sm' ? 12 : 14" label="" />
    <slot />
  </button>
</template>

<style scoped>
.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.4rem;
  font: inherit;
  font-weight: 500;
  white-space: nowrap;
  border: 1px solid transparent;
  border-radius: var(--radius-md);
  cursor: pointer;
  transition: background var(--transition-fast), border-color var(--transition-fast),
    color var(--transition-fast);
}

.btn:disabled {
  opacity: var(--disabled-opacity);
  cursor: not-allowed;
}

.btn--block {
  width: 100%;
}

/* --- sizes --------------------------------------------------------------- */

.btn--md {
  min-height: 2.25rem;
  padding: 0.375rem 0.85rem;
  font-size: 0.875rem;
}

.btn--sm {
  min-height: 1.875rem;
  padding: 0.2rem 0.6rem;
  font-size: 0.8125rem;
}

@media (pointer: coarse) {
  .btn--md,
  .btn--sm {
    min-height: var(--tap-min);
    padding-inline: 0.9rem;
  }
}

/* --- variants ------------------------------------------------------------ */

.btn--primary {
  color: var(--color-accent-contrast);
  background: var(--color-accent);
  border-color: var(--color-accent);
}

.btn--primary:hover:not(:disabled) {
  background: var(--color-accent-hover);
  border-color: var(--color-accent-hover);
}

.btn--secondary {
  color: var(--color-text);
  background: var(--color-surface);
  border-color: var(--color-border);
}

.btn--secondary:hover:not(:disabled) {
  background: var(--color-subtle);
  border-color: var(--color-border-strong);
}

.btn--ghost {
  color: var(--color-text-muted);
  background: none;
}

.btn--ghost:hover:not(:disabled) {
  color: var(--color-text);
  background: var(--color-subtle);
}

.btn--danger {
  color: var(--color-danger);
  background: var(--color-surface);
  border-color: var(--color-border);
}

.btn--danger:hover:not(:disabled) {
  color: var(--color-danger-contrast);
  background: var(--color-danger);
  border-color: var(--color-danger);
}
</style>
