<script setup lang="ts">
// The one way an event is created or edited. The form mounts only while the dialog is
// open, so each opening is fresh and closing runs the teardown that returns an unused slug lease.
import Dialog from "../ui/Dialog.vue";
import EventForm from "./EventForm.vue";
import type { EventDoc } from "../../lib/event";

const props = withDefaults(
  defineProps<{
    open: boolean;
    event?: EventDoc | null;
  }>(),
  { event: null },
);

const emit = defineEmits<{ saved: [event: EventDoc]; close: [] }>();
</script>

<template>
  <Dialog
    :open="open"
    :title="props.event ? 'Edit event' : 'New event'"
    size="lg"
    @close="emit('close')"
  >
    <EventForm
      :key="props.event?.id ?? 'new'"
      :event="props.event"
      @saved="(saved: EventDoc) => emit('saved', saved)"
      @cancel="emit('close')"
    />
  </Dialog>
</template>
