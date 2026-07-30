<script setup lang="ts">
/**
 * A confirm prompt: one sentence of prose, then the way out and the act at the
 * trailing edge. Every "are you sure" dialog in the app is this shape, and the
 * wrapper owns the shape once so the sites cannot drift apart.
 *
 * Deliberately nothing more than `Dialog` plus the two buttons:
 *
 * - No autofocus. `Dialog` moves focus to the panel itself, and a confirm that
 *   opened with focus on a button would change what Enter does on every
 *   confirm in the app at once.
 * - The prose is the default slot and the labels are props, all of it rendered
 *   inside `Dialog`'s own `v-if` — a closed confirm renders nothing at all,
 *   which the SSR tests rely on: dialog copy must never leak into the HTML of
 *   a page whose dialogs are shut.
 * - An acknowledgement — one button, nothing to cancel — is `cancelLabel=""`.
 *   Confirming it is the same as closing it; the caller wires both to the
 *   same reset.
 */
import Button from "./Button.vue";
import Dialog from "./Dialog.vue";

withDefaults(
  defineProps<{
    open: boolean;
    title: string;
    /** What the confirming button says: the verb, not "OK". */
    confirmLabel: string;
    /** Empty means no cancel button at all — an acknowledgement. */
    cancelLabel?: string;
    /** What kind of act confirming is; it colours the confirm button. */
    tone?: "danger" | "primary";
    /** Spinner on the confirm button while the action is in flight. */
    loading?: boolean;
    // Passed through to Dialog untouched. Left unset (undefined) they take
    // Dialog's own defaults, so those are declared in exactly one place.
    size?: "sm" | "lg";
    dismissible?: boolean;
    locked?: boolean;
    dim?: boolean;
  }>(),
  {
    cancelLabel: "Cancel",
    tone: "danger",
    loading: false,
    size: undefined,
    dismissible: undefined,
    locked: undefined,
    dim: undefined,
  },
);

const emit = defineEmits<{ confirm: []; close: [] }>();
</script>

<template>
  <Dialog
    :open="open"
    :title="title"
    :size="size"
    :dismissible="dismissible"
    :locked="locked"
    :dim="dim"
    @close="emit('close')"
  >
    <div class="confirm">
      <p class="confirm__text"><slot /></p>
      <div class="confirm__actions">
        <Button v-if="cancelLabel" variant="ghost" @click="emit('close')">
          {{ cancelLabel }}
        </Button>
        <Button :variant="tone" :loading="loading" @click="emit('confirm')">
          {{ confirmLabel }}
        </Button>
      </div>
    </div>
  </Dialog>
</template>

<style scoped>
.confirm {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.confirm__text {
  font-size: 0.875rem;
  line-height: 1.5;
  color: var(--color-text-muted);
}

.confirm__actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 0.5rem;
}
</style>
