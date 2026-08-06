<script setup lang="ts">
// The one sentence about a connection that should be live and is not; the mount decides whether it shows.
</script>

<template>
  <p class="offline" role="status">
    Live updates are unavailable. The page still works — others' changes
    appear on reload.
  </p>
</template>

<style scoped>
.offline {
  align-self: stretch;
  padding: 0.45rem 0.6rem;
  font-size: 0.75rem;
  line-height: 1.45;
  text-align: center;
  color: var(--color-danger);
  background: var(--color-danger-soft);
  border-radius: var(--radius-md);
}
</style>
