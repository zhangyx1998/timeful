<script setup lang="ts">
// Icon-only control with a 44px hit area (ARCHITECTURE.md § UX bar). Renders an <a> when
// given an href so navigation stays a real link. Glyph size and hover colours are custom
// properties, not props: a caller's scoped custom property cannot lose a specificity tie.
withDefaults(
  defineProps<{
    label: string;
    href?: string;
    type?: "button" | "submit" | "reset";
    /** Sub-md sizes are for nesting; every size grows back to the tap floor under a coarse pointer. */
    size?: "md" | "sm" | "xs" | "xxs";
    /** Opt out where the control reads as its own name; the aria-label stays. */
    tooltip?: boolean;
  }>(),
  { href: "", type: "button", size: "md", tooltip: true },
);
</script>

<template>
  <component
    :is="href ? 'a' : 'button'"
    class="icon-button"
    :class="`icon-button--${size}`"
    :href="href || undefined"
    :type="href ? undefined : type"
    :aria-label="label"
    :title="tooltip ? label : undefined"
  >
    <slot />
  </component>
</template>

<style scoped>
.icon-button {
  --focus-ring-inset: calc(var(--focus-ring-offset) * -1);

  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: var(--tap-min);
  height: var(--tap-min);
  padding: 0;
  color: var(--color-text-muted);
  background: none;
  border: none;
  border-radius: var(--radius-md);
  cursor: pointer;
  transition: color var(--transition-fast), background var(--transition-fast);
}

.icon-button:hover:not(:disabled) {
  color: var(--icon-button-hover-color, var(--color-text));
  background: var(--icon-button-hover-bg, var(--color-subtle));
}

/* Keeps its place and glyph while disabled: the dialog's close must not reflow the header. */
.icon-button:disabled {
  opacity: var(--disabled-opacity);
  cursor: not-allowed;
}

.icon-button--sm {
  width: 2.25rem;
  height: 2.25rem;
}

.icon-button--xs {
  width: 2rem;
  height: 2rem;
  border-radius: var(--radius-sm);
}

.icon-button--xxs {
  width: 1.75rem;
  height: 1.75rem;
}

@media (pointer: coarse) {
  .icon-button--sm,
  .icon-button--xs,
  .icon-button--xxs {
    width: var(--tap-min);
    height: var(--tap-min);
  }
}

/* Sized via the custom property so a caller never has to out-order this rule with an svg selector. */
.icon-button :slotted(svg) {
  width: var(--icon-button-glyph, 1.125rem);
  height: var(--icon-button-glyph, 1.125rem);
}
</style>
