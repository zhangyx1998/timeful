<script setup lang="ts">
// The one shape every "are you sure" dialog takes. No autofocus: focus starts on the
// panel so Enter's meaning stays uniform. A closed confirm renders nothing (Dialog's
// v-if), which the SSR tests rely on. `cancelLabel=""` makes it an acknowledgement.
import Button from "./Button.vue";
import Dialog from "./Dialog.vue";

withDefaults(
  defineProps<{
    open: boolean;
    title: string;
    confirmLabel: string;
    cancelLabel?: string;
    tone?: "danger" | "primary";
    loading?: boolean;
    // Passed through to Dialog untouched; undefined takes Dialog's own defaults.
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
