<script setup lang="ts">
/**
 * The bar at the top of every page — admin, sign-in, setup and event pages —
 * so the two halves of the app read as one product (ARCHITECTURE.md § UX bar).
 * Actions (theme toggle, sign out) go in the default slot, right aligned.
 *
 * The leading element is the product brand by default, and the `lead` slot
 * replaces it where something more useful belongs: the event page puts the
 * event's name there, because a guest who arrived from a link needs to know
 * which event they are looking at, not what the software is called. On '/'
 * there is no such context, so the brand stays.
 */
withDefaults(defineProps<{ tag?: string }>(), { tag: "" });

defineSlots<{
  /** Leading content; falls back to the brand when it renders nothing. */
  lead?: () => unknown;
  /** Right-aligned actions. */
  default?: () => unknown;
}>();
</script>

<template>
  <header class="app-header">
    <div class="app-header__inner">
      <div class="app-header__lead">
        <slot name="lead">
          <p class="brand">
            <span class="brand__mark" aria-hidden="true" />
            <span class="brand__name">Timeful</span>
            <span v-if="tag" class="brand__tag">{{ tag }}</span>
          </p>
        </slot>
      </div>
      <div class="app-header__actions">
        <slot />
      </div>
    </div>
  </header>
</template>

<style scoped>
/* The bar's fill runs under the status bar or the notch; its contents start
   below them. */
.app-header {
  position: sticky;
  top: 0;
  z-index: 30;
  padding-top: var(--safe-top);
  background: var(--color-surface);
  border-bottom: 1px solid var(--color-border);
}

.app-header__inner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  min-height: var(--header-height);
  max-width: var(--page-max);
  margin: 0 auto;
  /* Landscape puts the camera cutout beside the bar, not above it. */
  padding: 0.35rem calc(var(--page-pad) + var(--safe-right)) 0.35rem
    calc(var(--page-pad) + var(--safe-left));
}

/* Shrinks and clips before the actions do: a long event name gives up room,
   the theme toggle never does. */
.app-header__lead {
  display: flex;
  flex: 0 1 auto;
  align-items: center;
  gap: 0.25rem;
  min-width: 0;
}

.brand {
  display: flex;
  align-items: center;
  gap: 0.45rem;
  min-width: 0;
  margin: 0;
}

.brand__mark {
  flex: none;
  width: 0.65rem;
  height: 0.65rem;
  background: var(--color-accent);
  border-radius: 3px;
}

.brand__name {
  font-size: 1rem;
  font-weight: 600;
  letter-spacing: -0.01em;
  color: var(--color-text);
}

.brand__tag {
  font-size: 0.8125rem;
  color: var(--color-text-muted);
}

.app-header__actions {
  display: flex;
  flex: none;
  align-items: center;
  gap: 0.5rem;
  min-width: 0;
}
</style>
