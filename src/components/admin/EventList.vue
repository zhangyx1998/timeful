<script setup lang="ts">
/**
 * The owner's events.
 *
 * Each row's actions are icons — copy, edit, delete — because the row already
 * says what it is about and three verbs per row said it three more times. Each
 * carries its accessible name in `label`, which IconButton also renders as the
 * hover tooltip. Deleting takes everyone's answers with it, so it asks in a
 * dialog that names the event rather than swapping buttons into the row, which
 * made the list jump under the pointer.
 */
import { ref } from "vue";
import { api, apiError } from "../../lib/api";
import { formatDateTime } from "../../lib/dates";
import { eventTypeLabel } from "../../lib/event-form";
import Button from "../ui/Button.vue";
import Card from "../ui/Card.vue";
import CopyLinkButton from "../ui/CopyLinkButton.vue";
import Dialog from "../ui/Dialog.vue";
import IconButton from "../ui/IconButton.vue";
import IconPlus from "../../assets/icons/plus.svg";
import IconPersonFilled from "../../assets/icons/person-filled.svg";
import IconClock from "../../assets/icons/clock.svg";
import IconPencil from "../../assets/icons/pencil.svg";
import IconTrash from "../../assets/icons/trash.svg";
import type { EventSummary } from "../../lib/api";

const props = withDefaults(
  defineProps<{ events?: EventSummary[]; loading?: boolean }>(),
  { events: () => [], loading: false },
);
const emit = defineEmits<{
  (e: "create"): void;
  (e: "edit", event: EventSummary): void;
  (e: "changed"): void;
}>();

/** The event the delete dialog is asking about. At most one. */
const confirming = ref<EventSummary | null>(null);
const deleting = ref(false);
const error = ref("");

function publicUrl(event: EventSummary): string {
  const origin = typeof window === "undefined" ? "" : window.location.origin;
  return `${origin}/${event.slug}`;
}

async function remove(): Promise<void> {
  const event = confirming.value;
  if (!event) return;
  error.value = "";
  deleting.value = true;
  try {
    await api.del(`/events/${event.id}`);
    confirming.value = null;
    emit("changed");
  } catch (err) {
    error.value = apiError(err, "Could not delete the event").message;
  } finally {
    deleting.value = false;
  }
}
</script>

<template>
  <Card title="Events" flush>
    <template #actions>
      <Button variant="primary" size="sm" @click="emit('create')">
        <IconPlus class="plus" aria-hidden="true" />
        New event
      </Button>
    </template>

    <p v-if="error" class="error" role="alert">{{ error }}</p>

    <p v-if="props.loading" class="empty">Loading…</p>
    <p v-else-if="!props.events.length" class="empty">No events yet.</p>

    <ul v-else class="list">
      <li v-for="event in props.events" :key="event.id" class="item">
        <div class="item__main">
          <div class="item__name">{{ event.name }}</div>
          <div class="item__link">
            <a class="link" :href="`/${event.slug}`" target="_blank" rel="noopener">
              /{{ event.slug }}
            </a>
            <CopyLinkButton :url="publicUrl(event)" label="Copy link" />
          </div>
          <div class="item__meta">
            <span>{{ eventTypeLabel(event.type) }}</span>
            <span
              class="stat"
              :title="`${event.responseCount} response${event.responseCount === 1 ? '' : 's'}`"
            >
              <IconPersonFilled aria-hidden="true" />
              {{ event.responseCount }}
            </span>
            <span class="stat" title="Last changed">
              <IconClock aria-hidden="true" />
              {{ formatDateTime(event.updatedAt) }}
            </span>
          </div>
        </div>

        <div class="item__actions">
          <IconButton :label="`Edit ${event.name}`" @click="emit('edit', event)">
            <IconPencil aria-hidden="true" />
          </IconButton>

          <IconButton
            class="delete"
            :class="{ 'delete--armed': confirming?.id === event.id }"
            :label="`Delete ${event.name}`"
            @click="confirming = event"
          >
            <IconTrash aria-hidden="true" />
          </IconButton>
        </div>
      </li>
    </ul>

    <Dialog
      :open="confirming !== null"
      title="Delete this event?"
      @close="confirming = null"
    >
      <div class="confirm">
        <p class="confirm__text">
          <strong>{{ confirming?.name }}</strong> and every answer on it go, and
          its link stops working. This cannot be undone.
        </p>
        <div class="confirm__actions">
          <Button variant="ghost" @click="confirming = null">Cancel</Button>
          <Button variant="danger" :loading="deleting" @click="remove">Delete</Button>
        </div>
      </div>
    </Dialog>
  </Card>
</template>

<style scoped>
.error {
  margin: 1rem;
  padding: 0.5rem 0.75rem;
  font-size: 0.875rem;
  color: var(--color-danger);
  background: var(--color-danger-soft);
  border-radius: var(--radius-md);
}

.empty {
  margin: 0;
  padding: 1.5rem 1.25rem;
  font-size: 0.875rem;
  color: var(--color-text-muted);
}

.plus {
  width: 0.85rem;
  height: 0.85rem;
}

.list {
  margin: 0;
  padding: 0;
  list-style: none;
}

/* Rows drop their actions onto their own line once the name and the buttons
   stop fitting side by side. */
.item {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  justify-content: space-between;
  gap: 0.75rem;
  padding: 0.85rem 1.25rem;
  border-top: 1px solid var(--color-border);
}

.item:first-child {
  border-top: none;
}

.item__main {
  flex: 1 1 14rem;
  min-width: 0;
}

.item__name {
  font-size: 0.9375rem;
  font-weight: 500;
  color: var(--color-text);
  overflow-wrap: anywhere;
}

.item__link {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.4rem;
  margin-top: 0.125rem;
}

.item__meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.75rem;
  margin-top: 0.25rem;
  font-size: 0.75rem;
  color: var(--color-text-muted);
}

/* Glyph then number: the icon carries the noun the text used to spell out. */
.stat {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
}

.stat svg {
  width: 0.8rem;
  height: 0.8rem;
}

.item__actions {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  gap: 0.15rem;
}

/* Destructive, so it reads as such under the pointer and stays red while its
   confirm is open. */
.delete:hover,
.delete--armed {
  color: var(--color-danger);
  background: var(--color-danger-soft);
}

.link {
  display: inline-flex;
  align-items: center;
  min-height: 1.75rem;
  font-size: 0.875rem;
  color: var(--color-accent-text);
  text-decoration: none;
  overflow-wrap: anywhere;
}

.link:hover {
  text-decoration: underline;
}

.link:focus-visible {
  outline: var(--focus-ring);
  outline-offset: var(--focus-ring-offset);
}

/* The slug is how you open the event — give it a real tap target on touch. */
@media (pointer: coarse) {
  .link {
    min-height: var(--tap-min);
  }
}

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
