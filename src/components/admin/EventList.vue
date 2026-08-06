<script setup lang="ts">
import { ref } from "vue";
import { api, apiError, eventSettingsPath } from "../../lib/api";
import { formatDateTime } from "../../lib/dates";
import { eventTypeLabel } from "../../lib/event-form";
import Button from "../ui/Button.vue";
import Card from "../ui/Card.vue";
import ConfirmDialog from "../ui/ConfirmDialog.vue";
import CopyLinkButton from "../ui/CopyLinkButton.vue";
import ErrorNote from "../ui/ErrorNote.vue";
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
    await api.del(eventSettingsPath(event.id));
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

    <ErrorNote class="card-error" :message="error" alert />

    <p v-if="props.loading" class="empty">Loading…</p>
    <p v-else-if="!props.events.length" class="empty">No events yet.</p>

    <ul v-else class="list">
      <li v-for="event in props.events" :key="event.id" class="item">
        <div class="item__main">
          <div class="item__name" :title="event.name">{{ event.name }}</div>
          <div class="item__link">
            <a
              class="link"
              :href="`/${event.slug}`"
              :title="`/${event.slug}`"
              target="_blank"
              rel="noopener"
            >
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

    <ConfirmDialog
      :open="confirming !== null"
      title="Delete this event?"
      confirm-label="Delete"
      :loading="deleting"
      @confirm="remove"
      @close="confirming = null"
    >
      <strong>{{ confirming?.name }}</strong> and every answer on it go, and
      its link stops working. This cannot be undone.
    </ConfirmDialog>
  </Card>
</template>

<style scoped>
/* ErrorNote declares no margin of its own, which is what makes this safe. */
.card-error {
  margin: 1rem;
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
  overflow: hidden;
  font-size: 0.9375rem;
  font-weight: 500;
  color: var(--color-text);
  white-space: nowrap;
  text-overflow: ellipsis;
}

.item__link {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  min-width: 0;
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

.stat {
  display: inline-flex;
  flex: none;
  align-items: center;
  gap: 0.25rem;
  white-space: nowrap;
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

.delete:hover,
.delete--armed {
  color: var(--color-danger);
  background: var(--color-danger-soft);
}

/* block, not flex: a flex box has no inline content for an ellipsis to land in. */
.link {
  display: block;
  min-width: 0;
  overflow: hidden;
  min-height: 1.75rem;
  font-size: 0.875rem;
  line-height: 1.75rem;
  color: var(--color-accent-text);
  text-decoration: none;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.link:hover {
  text-decoration: underline;
}

@media (pointer: coarse) {
  .link {
    min-height: var(--tap-min);
  }
}
</style>
