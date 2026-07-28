<script setup lang="ts">
/** Inline busy indicator. Inherits `currentColor`, so it matches its context. */
withDefaults(defineProps<{ size?: number; label?: string }>(), {
  size: 14,
  label: "Loading",
});
</script>

<template>
  <span
    class="spinner"
    role="status"
    :aria-label="label"
    :style="{ width: `${size}px`, height: `${size}px` }"
  />
</template>

<style scoped>
.spinner {
  display: inline-block;
  flex: none;
  border: 2px solid currentColor;
  border-top-color: transparent;
  border-radius: 50%;
  animation: spin 0.7s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

@media (prefers-reduced-motion: reduce) {
  .spinner {
    animation-duration: 2s;
  }
}
</style>
