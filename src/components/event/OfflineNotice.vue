<script setup lang="ts">
/**
 * The one sentence about a connection that should be live and is not.
 *
 * Extracted from the event footer so the phone can show it without a drawer in
 * the way: the desktop footer still renders it as its top row, and the phone
 * mounts it above the identity bar — the place a visitor already looks for the
 * state of their answer. Whoever mounts it decides *whether* it shows; this
 * component only says the sentence, and always the same one.
 */
</script>

<template>
  <!-- Honest and small: the page is not broken — saves and reloads still go
       over plain requests — but nothing new arrives on its own any more. -->
  <p class="offline" role="status">
    Live updates are unavailable. The page still works — others' changes
    appear on reload.
  </p>
</template>

<style scoped>
/* Quiet-but-visible: the danger pair at small size, because the page is
   degraded rather than broken. */
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
