<script setup lang="ts">
// The bar on every page (ARCHITECTURE.md § UX bar). The `lead` slot replaces the
// brand where something more useful belongs; actions go in the default slot.
withDefaults(defineProps<{ tag?: string }>(), { tag: "" });

defineSlots<{
  /** Falls back to the brand when it renders nothing. */
  lead?: () => unknown;
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
/* The fill runs under the status bar or notch; contents start below them. */
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

/* min-width: 0 so slotted text can be clipped; the controls hold their own floor. */
.app-header__actions {
  display: flex;
  flex: 0 1 auto;
  align-items: center;
  gap: 0.5rem;
  min-width: 0;
}

/* Landscape phone: keep the 44px floor, lose the air around it. */
@media (max-height: 480px) and (max-width: 820px) {
  .app-header__inner {
    min-height: 0;
    padding-top: 0.15rem;
    padding-bottom: 0.15rem;
  }
}
</style>
