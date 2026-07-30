<script setup lang="ts">
/**
 * A control whose whole content is an icon: a 44px hit area (ARCHITECTURE.md
 * § UX bar) wrapped around a small glyph, matching the theme toggle that sits
 * next to it in the header.
 *
 * Renders an `<a>` when given an `href` and a `<button>` otherwise, so a
 * navigation stays a real link — middle-click, open in a new tab, and the
 * status bar all keep working. `label` is required: there is no visible text
 * to name the control, so it supplies the accessible name and, unless a site
 * opts out with `tooltip: false`, the hover tooltip.
 *
 * Two knobs are custom properties rather than props, because they are read by
 * this component's own rules and a caller's scoped declaration of a custom
 * property cannot lose a specificity tie the way a competing `svg` rule can:
 * `--icon-button-glyph` sizes the slotted glyph (default 1.125rem), and
 * `--icon-button-hover-color` / `--icon-button-hover-bg` recolour the hover
 * state — the identity card's bin turns danger-red this way.
 */
withDefaults(
  defineProps<{
    label: string;
    /** Renders a link to this target instead of a button. */
    href?: string;
    type?: "button" | "submit" | "reset";
    /**
     * `md` is the full 44px box. The rest are for a control that sits *inside*
     * another, where a full box would set the height of the thing containing
     * it: `sm` (2.25rem) beside a form field, `xs` (2rem, tighter corners) in a
     * dialog or calendar header, `xxs` (1.75rem) trailing a card's own row.
     * Under a coarse pointer every size grows back to the tap floor, since
     * that is the size a finger needs whatever the button is nested in.
     */
    size?: "md" | "sm" | "xs" | "xxs";
    /**
     * Whether `label` is also the native tooltip. Opt out where the control
     * already reads as its own name — a dialog's close cross needs no bubble
     * saying "Close" — while keeping the `aria-label`.
     */
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

/* Held, not taken away: a disabled instance keeps its place and its glyph —
   the dialog's close stays put while `locked` so the header does not reflow —
   and only the cursor says it is not answering right now. */
.icon-button:disabled {
  cursor: default;
}

.icon-button--sm {
  width: 2.25rem;
  height: 2.25rem;
}

/* The header step: small enough not to stretch the row of a dialog or
   calendar heading, cornered to match the chrome it sits in. */
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

/* The glyph is passed in by the parent, so it carries the parent's scope:
   `:slotted` is what reaches it from here. Sized through the custom property
   so a caller never has to out-order this rule with an `svg` selector. */
.icon-button :slotted(svg) {
  width: var(--icon-button-glyph, 1.125rem);
  height: var(--icon-button-glyph, 1.125rem);
}
</style>
