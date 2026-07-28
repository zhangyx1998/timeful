<script setup lang="ts">
/**
 * The panel every admin section sits in: bordered surface, optional titled
 * header with a slot for its actions.
 *
 * `flush` drops the body padding for content that draws its own rows (lists,
 * tables) so they can run edge to edge.
 */
withDefaults(defineProps<{ title?: string; flush?: boolean }>(), {
  title: "",
  flush: false,
});

defineSlots<{
  default: () => unknown;
  actions?: () => unknown;
  subtitle?: () => unknown;
}>();
</script>

<template>
  <section class="card">
    <header v-if="title || $slots.actions" class="card__head">
      <div class="card__heading">
        <h2 v-if="title" class="card__title">{{ title }}</h2>
        <p v-if="$slots.subtitle" class="card__subtitle"><slot name="subtitle" /></p>
      </div>
      <div v-if="$slots.actions" class="card__actions">
        <slot name="actions" />
      </div>
    </header>
    <div class="card__body" :class="{ 'card__body--flush': flush }">
      <slot />
    </div>
  </section>
</template>

<style scoped>
.card {
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
}

.card__head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem 0.75rem;
  padding: 0.85rem 1.25rem;
  border-bottom: 1px solid var(--color-border);
}

.card__heading {
  min-width: 0;
}

.card__title {
  margin: 0;
  font-size: 1rem;
  font-weight: 600;
  color: var(--color-text);
}

.card__subtitle {
  margin: 0.15rem 0 0;
  font-size: 0.875rem;
  color: var(--color-text-muted);
}

.card__actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem;
}

.card__body {
  padding: 1.25rem;
}

.card__body--flush {
  padding: 0;
}
</style>
