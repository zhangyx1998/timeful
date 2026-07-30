<script setup lang="ts">
/**
 * The owner's tools on a phone, in a drawer of their own.
 *
 * They used to ride along at the head of the view-settings sheet, which put
 * "Back to home" and "Edit event" one gear-tap away from the clock format and
 * the colour legend. Those are settings — how this visitor reads the chart —
 * and the owner's tools are not settings at all: they act on the event, or
 * leave it. Sharing a sheet meant a guest and an owner opened the same handle
 * expecting different things, and the owner's half was always the surprise.
 *
 * So the tools get their own sheet, opened from a shield in the navbar beside
 * the theme switch — where the page's other whole-page controls already are,
 * and where it is reachable from either view of the chart rather than only
 * from whichever one the settings gear was last opened over.
 *
 * The button and this sheet both hang off `isAdmin` (`lib/admin.ts`), which
 * fails closed and is reactive: signing in from the settings drawer's own link
 * makes the shield appear where it stands, with no reload and nothing about a
 * half-finished answer disturbed.
 */
import AdminTools from "./AdminTools.vue";
import Dialog from "../ui/Dialog.vue";
import IconShield from "../../assets/icons/shield-half.svg";

defineProps<{
  open: boolean;
  /** The event the tools act on. The uuid, so a rename cannot strand them. */
  eventId: string;
}>();

const emit = defineEmits<{ close: []; edit: [] }>();

/**
 * The edit form is a dialog of the page's own, and both teleport to <body>.
 * This sheet's anchor was appended after the form's, so left open it would sit
 * on top of the thing it just asked for.
 */
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
/* The same top breathing room the settings sheet gives its first row, so the
   two drawers open onto the same margin. */
.stack {
  padding-top: 0.35rem;
}
</style>
