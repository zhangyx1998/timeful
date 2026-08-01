<script setup lang="ts">
/**
 * Autosave status. There is no Save button — this is the only save feedback.
 *
 * Five states, in two groups. The three loud ones are about a save: it is
 * happening, it landed, it failed. The two quiet ones are about the answer as
 * it stands before anything has been saved this visit, which is the question a
 * guest actually arrives with — "is my answer in there?" — and which an
 * indicator that says nothing until you touch the grid never answered.
 *
 * `empty` is a name with no answer behind it; `current` is an answer already
 * on the server. Both rest: no spinner, no urgency. `current` states a
 * condition rather than an event, so unlike `saved` it keeps the muted text of
 * the card around it and lets the tick alone carry the green.
 */
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
    /**
     * The admin-only elaboration under the failure — the server includes it
     * only for a request carrying the owner's session, so rendering it here
     * is admin-only by construction; a guest's failures never have one.
     */
    detail?: string | null;
  }>(),
  { detail: null },
);
const emit = defineEmits<{ retry: [] }>();
</script>

<template>
  <!-- Dashed like the empty seat in the card around it: the same "nobody has
       filled this in" vocabulary, one line down. -->
  <p v-if="status === 'empty'" class="status resting" role="status">
    <IconCircleDashed class="icon" aria-hidden="true" />
    No selection
  </p>
  <!-- An enclosed tick, where `saved` uses a bare one: a state something is
       in, not a thing that just happened. -->
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
  <!-- A column, not a row: the detail is its own line, and a column's
       intrinsic width is its widest child rather than the sum — a wrapped row
       would still ask for one-line width and crush the name beside it on the
       phone's identity bar. -->
  <div v-else-if="status === 'error'" class="status failed" role="alert">
    <p class="failed__row">
      <IconAlertTriangle class="icon" aria-hidden="true" />
      <!-- In its own element rather than loose text: this is the one string
           here a server picks the length of, and an ellipsis needs a box to
           happen in. Whatever the truncation eats is on the tooltip. -->
      <span class="message" :title="error ?? 'Could not save your availability'">
        {{ error ?? "Could not save your availability" }}
      </span>
      <button type="button" class="retry" @click="emit('retry')">Retry</button>
    </p>
    <!-- The cause, under the sentence: rendered only when the response carried
         it, which the server does only for the signed-in owner. Muted and
         monospace — a diagnostic, not a second message — and selectable,
         because its whole point is being pasted somewhere. -->
    <span v-if="detail" class="detail" :title="detail">{{ detail }}</span>
  </div>
</template>

<style scoped>
/* One line. Four of the five states are two short words and would never break
   anyway; the fifth carries an error message of unknown length, and this row
   sits at the bottom edge of a phone layout that has no spare line to give it.
   `nowrap` also keeps the short states from splitting mid-label. */
.status {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  max-width: 100%;
  font-size: 0.8125rem;
  line-height: 1.2;
  white-space: nowrap;
}

/* Deliberately not `min-width: 0` on the row above: four of the five states are
   two short words that should hold their width against a long name beside them,
   and only this one — the message a server chose the length of — is capped. */
.message {
  min-width: 0;
  max-width: 12rem;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* The two states nothing is happening in. They sit next to a name on a bar the
   guest is looking past while they paint, so they read at the weight of a
   caption; only the tick keeps its colour. */
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
  /* The one state with a possible second line: a column of the sentence row
     and the detail, so the detail never widens the row it sits under. */
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

/* The admin's diagnostic line. Its own line under the message, quiet, mono,
   and selectable — it exists to be read closely and pasted, not to alarm.
   Capped like the message above it: an errno line quotes a whole file path,
   and without the cap its intrinsic width would out-compete the name on the
   phone's identity bar. Whatever the ellipsis eats is on the tooltip. */
.detail {
  min-width: 0;
  /* The message's own cap: the diagnostic must never be the widest line, or
     it decides the bar's width instead of the sentence above it. */
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

/* The way out of the error never shrinks or wraps away from it. */
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
