<script setup lang="ts">
/**
 * The red banner a surface prints its request failures in. One box for all of
 * them, so "something went wrong" reads the same on every screen.
 *
 * It renders nothing at all when the message is empty — callers bind the ref
 * and forget about it — and it deliberately declares **no margin**: the global
 * reset zeroes it, and the callers that need one (the flush cards, whose boxes
 * would otherwise touch the card edge) set it from outside via a class. That
 * only stays safe while nothing in here competes with the caller's
 * declaration; a caller's scoped rule and this component's are the same
 * specificity, and which would win is style-injection order.
 *
 * `role="alert"` is opt-in per site, not the default: most of these banners
 * sit beside the button that caused them, and announcing all of them would be
 * noise where today there is silence.
 */
withDefaults(defineProps<{ message: string; alert?: boolean }>(), { alert: false });
</script>

<template>
  <p v-if="message" class="error" :role="alert ? 'alert' : undefined">{{ message }}</p>
</template>

<style scoped>
.error {
  padding: 0.5rem 0.75rem;
  font-size: 0.875rem;
  color: var(--color-danger);
  background: var(--color-danger-soft);
  border-radius: var(--radius-md);
}
</style>
