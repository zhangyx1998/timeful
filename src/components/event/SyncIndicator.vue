<script setup lang="ts">
// Autosave status — the only save feedback. Three loud states are about a save; the two
// resting ones (`empty`, `current`) answer "is my answer in there?" before anything is saved.
import Spinner from "../ui/Spinner.vue";
import IconCircleDashed from "../../assets/icons/circle-dashed.svg";
import IconCircleCheck from "../../assets/icons/circle-check.svg";
import IconCheck from "../../assets/icons/check-sm.svg";
import IconAlertTriangle from "../../assets/icons/alert-triangle-sm.svg";
import type { SyncStatus } from "../../lib/sync";

withDefaults(
  defineProps<{
    status: SyncStatus;
    error: string | null;
    /** Admin-only by construction: the server includes it only for the owner's session. */
    detail?: string | null;
  }>(),
  { detail: null },
);
const emit = defineEmits<{ retry: [] }>();
</script>

<template>
  <p v-if="status === 'empty'" class="status resting" role="status">
    <IconCircleDashed class="icon" aria-hidden="true" />
    No selection
  </p>
  <p v-else-if="status === 'current'" class="status resting" role="status">
    <IconCircleCheck class="icon icon--ok" aria-hidden="true" />
    Up to date
  </p>
  <p v-else-if="status === 'syncing'" class="status syncing" role="status">
    <Spinner :size="13" label="Saving" />
    Saving…
  </p>
  <p v-else-if="status === 'saved'" class="status saved" role="status">
    <IconCheck class="icon" aria-hidden="true" />
    Saved
  </p>
  <!-- A column: a wrapped row would still ask for one-line width and crush the name beside it. -->
  <div v-else-if="status === 'error'" class="status failed" role="alert">
    <p class="failed__row">
      <IconAlertTriangle class="icon" aria-hidden="true" />
      <span class="message" :title="error ?? 'Could not save your availability'">
        {{ error ?? "Could not save your availability" }}
      </span>
      <button type="button" class="retry" @click="emit('retry')">Retry</button>
    </p>
    <span v-if="detail" class="detail" :title="detail">{{ detail }}</span>
  </div>
</template>

<style scoped>
/* nowrap: the row sits on a phone bar with no spare line to give. */
.status {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  max-width: 100%;
  font-size: 0.8125rem;
  line-height: 1.2;
  white-space: nowrap;
}

/* Only the server-length message is capped; the short states hold their width. */
.message {
  min-width: 0;
  max-width: 12rem;
  overflow: hidden;
  text-overflow: ellipsis;
}

.resting {
  color: var(--color-text-muted);
}

.syncing {
  color: var(--color-warning);
}

.saved {
  color: var(--color-success);
}

.failed {
  flex-direction: column;
  align-items: flex-start;
  gap: 0.15rem;
  color: var(--color-danger);
}

.failed__row {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  max-width: 100%;
}

/* Capped so the diagnostic never decides the bar's width; the rest is on the tooltip. */
.detail {
  min-width: 0;
  max-width: 12rem;
  overflow: hidden;
  font-family: var(--font-mono);
  font-size: 0.6875rem;
  line-height: 1.35;
  color: var(--color-text-muted);
  text-overflow: ellipsis;
  user-select: text;
  white-space: nowrap;
}

.icon {
  width: 14px;
  height: 14px;
  flex: none;
}

.icon--ok {
  color: var(--color-success);
}

.retry {
  flex: none;
  margin-left: 0.15rem;
  padding: 0.1rem 0.45rem;
  font: inherit;
  font-weight: 600;
  color: var(--color-danger);
  background: var(--color-danger-soft);
  border: 1px solid currentColor;
  border-radius: var(--radius-sm);
  cursor: pointer;
}

.retry:hover {
  color: var(--color-danger-contrast);
  background: var(--color-danger);
}
</style>
