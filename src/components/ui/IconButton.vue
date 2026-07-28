<script setup lang="ts">
/**
 * A control whose whole content is an icon: a 44px hit area (ARCHITECTURE.md
 * § UX bar) wrapped around a small glyph, matching the theme toggle that sits
 * next to it in the header.
 *
 * Renders an `<a>` when given an `href` and a `<button>` otherwise, so a
 * navigation stays a real link — middle-click, open in a new tab, and the
 * status bar all keep working. `label` is required: there is no visible text
 * to name the control, so it supplies both the accessible name and the
 * hover tooltip.
 */
withDefaults(
  defineProps<{
    label: string;
    /** Renders a link to this target instead of a button. */
    href?: string;
    type?: "button" | "submit" | "reset";
    /**
     * `sm` is for a control that sits *inside* another, where a full 44px box
     * would set the height of the thing containing it. Under a coarse pointer
     * it grows back to the tap floor, since that is the size a finger needs
     * whatever the button is nested in.
     */
    size?: "md" | "sm";
  }>(),
  { href: "", type: "button", size: "md" },
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
    :title="label"
  >
    <slot />
  </component>
</template>

<style scoped>
.icon-button {
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

.icon-button:hover {
  color: var(--color-text);
  background: var(--color-subtle);
}

.icon-button--sm {
  width: 2.25rem;
  height: 2.25rem;
}

@media (pointer: coarse) {
  .icon-button--sm {
    width: var(--tap-min);
    height: var(--tap-min);
  }
}

.icon-button:focus-visible {
  outline: var(--focus-ring);
  outline-offset: calc(var(--focus-ring-offset) * -1);
}

/* The glyph is passed in by the parent, so it carries the parent's scope:
   `:slotted` is what reaches it from here. */
.icon-button :slotted(svg) {
  width: 1.125rem;
  height: 1.125rem;
}

@media (prefers-reduced-motion: reduce) {
  .icon-button {
    transition: none;
  }
}
</style>
