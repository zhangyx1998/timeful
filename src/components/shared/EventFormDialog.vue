<script setup lang="ts">
/**
 * The one way an event is created or edited, wherever the request comes from:
 * the admin panel's list and the edit control on the event page both open this.
 *
 * It is always a centred modal. The form used to render inline above the list,
 * which pushed the page around as it opened and gave the same task two
 * different shapes depending on where you started it.
 *
 * The form is only mounted while the dialog is open — `Dialog` renders its slot
 * behind `v-if` — so each opening gets a fresh instance, and closing runs the
 * form's teardown (which is what hands an unused slug lease back).
 */
import Dialog from "../ui/Dialog.vue";
import EventForm from "./EventForm.vue";
import type { EventDoc } from "../../lib/event";

const props = withDefaults(
  defineProps<{
    open: boolean;
    /** The event being edited, or null to create a new one. */
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
