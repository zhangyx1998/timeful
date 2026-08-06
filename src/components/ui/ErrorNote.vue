<script setup lang="ts">
// One box for all request failures; renders nothing on empty. Declares no margin:
// callers set it from outside, and a competing rule here would tie on specificity,
// leaving style-injection order to decide.
withDefaults(
  defineProps<{
    message: string;
    alert?: boolean;
    /** Admin-only by construction: the server includes it only for the signed-in owner. */
    detail?: string;
  }>(),
  { alert: false, detail: "" },
);
</script>

<template>
  <p v-if="message" class="error" :role="alert ? 'alert' : undefined">
    {{ message }}
    <span v-if="detail" class="detail">{{ detail }}</span>
  </p>
</template>

<style scoped>
.error {
  padding: 0.5rem 0.75rem;
  font-size: 0.875rem;
  color: var(--color-danger);
  background: var(--color-danger-soft);
  border-radius: var(--radius-md);
}

.detail {
  display: block;
  margin-top: 0.25rem;
  overflow-wrap: anywhere;
  font-family: var(--font-mono);
  font-size: 0.75rem;
  line-height: 1.4;
  color: var(--color-text-muted);
  user-select: text;
}
</style>
