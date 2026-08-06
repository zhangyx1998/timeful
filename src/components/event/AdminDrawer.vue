<script setup lang="ts">
// The owner's tools on a phone, in their own sheet off the navbar shield.
// Button and sheet both hang off `isAdmin` (`lib/admin.ts`): fails closed, reactive.
import AdminTools from "./AdminTools.vue";
import Dialog from "../ui/Dialog.vue";
import IconShield from "../../assets/icons/shield-half.svg";

defineProps<{
  open: boolean;
  eventId: string;
}>();

const emit = defineEmits<{ close: []; edit: [] }>();

// Close first: both teleport to <body>, and this sheet's anchor stacks over the form's.
function onEdit(): void {
  emit("close");
  emit("edit");
}
</script>

<template>
  <Dialog variant="sheet" :open="open" title="Admin" @close="emit('close')">
    <template #icon><IconShield /></template>
    <div class="stack">
      <AdminTools embedded :event-id="eventId" @edit="onEdit" />
    </div>
  </Dialog>
</template>

<style scoped>
.stack {
  padding-top: 0.35rem;
}
</style>
