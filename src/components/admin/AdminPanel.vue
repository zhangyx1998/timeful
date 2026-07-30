<script setup lang="ts">
/**
 * Signed-in management view, in two tabs.
 *
 * Events is what the owner comes here for; sessions and credentials are
 * housekeeping they touch once in a while, so they move behind Settings rather
 * than sitting under the list as two more panels to scroll past. The switch is
 * the same segmented control the event page uses for its two views.
 */
import { onMounted, ref } from "vue";
import AccountSection from "./AccountSection.vue";
import { api, apiError, eventDataPath } from "../../lib/api";
import EventFormDialog from "../shared/EventFormDialog.vue";
import EventList from "./EventList.vue";
import SessionsSection from "./SessionsSection.vue";
import UpdateSection from "./UpdateSection.vue";
import AppHeader from "../ui/AppHeader.vue";
import Button from "../ui/Button.vue";
import Segmented from "../ui/Segmented.vue";
import ThemeToggle from "../ui/ThemeToggle.vue";
import IconCalendar from "../../assets/icons/calendar.svg";
import IconSliders from "../../assets/icons/sliders.svg";
import type { EventSummary } from "../../lib/api";
import type { EventDoc } from "../../lib/event";

const props = withDefaults(defineProps<{ email?: string }>(), { email: "" });
const emit = defineEmits<{ (e: "signed-out", message: string): void }>();

const events = ref<EventSummary[]>([]);
const loading = ref(true);
const error = ref("");

const TABS = [
  { value: "events", label: "Events" },
  { value: "settings", label: "Settings" },
] as const;

const tab = ref<string>("events");

/** null = dialog closed; { event: null } = create; { event } = edit. */
const form = ref<{ event: EventDoc | null } | null>(null);

async function loadEvents(): Promise<void> {
  error.value = "";
  loading.value = true;
  try {
    events.value = await api.get<EventSummary[]>("/api/events");
  } catch (err) {
    const { message, status } = apiError(err, "Could not load events");
    if (status === 401) {
      emit("signed-out", "");
      return;
    }
    error.value = message;
  } finally {
    loading.value = false;
  }
}

function openCreate(): void {
  form.value = { event: null };
}

async function openEdit(summary: EventSummary): Promise<void> {
  error.value = "";
  try {
    const full = await api.get<EventDoc>(eventDataPath(summary.id));
    form.value = { event: full };
  } catch (err) {
    error.value = apiError(err, "Could not open the event").message;
  }
}

async function onSaved(): Promise<void> {
  form.value = null;
  await loadEvents();
}

async function logout(): Promise<void> {
  try {
    await api.post("/api/auth/logout");
  } catch {
    /* signing out locally regardless */
  }
  emit("signed-out", "");
}

onMounted(loadEvents);
</script>

<template>
  <div class="page">
    <AppHeader tag="admin">
      <span v-if="props.email" class="header__email" :title="props.email">
        {{ props.email }}
      </span>
      <ThemeToggle />
      <Button variant="secondary" size="sm" @click="logout">Sign out</Button>
    </AppHeader>

    <main class="main">
      <div class="tabs">
        <Segmented v-model="tab" label="Panel section" variant="solid" equal :options="TABS">
          <template #option="{ option }">
            <IconCalendar
              v-if="option.value === 'events'"
              class="tab-icon"
              aria-hidden="true"
            />
            <IconSliders v-else class="tab-icon" aria-hidden="true" />
            {{ option.label }}
          </template>
        </Segmented>
      </div>

      <p v-if="error" class="error">{{ error }}</p>

      <EventFormDialog
        :open="form !== null"
        :event="form?.event ?? null"
        @saved="onSaved"
        @close="form = null"
      />

      <template v-if="tab === 'events'">
        <EventList
          :events="events"
          :loading="loading"
          @create="openCreate"
          @edit="openEdit"
          @changed="loadEvents"
        />
      </template>

      <template v-else>
        <SessionsSection @signed-out="emit('signed-out', 'You were signed out.')" />

        <AccountSection
          :email="props.email"
          @signed-out="(message: string) => emit('signed-out', message)"
        />

        <UpdateSection @signed-out="emit('signed-out', 'You were signed out.')" />
      </template>
    </main>
  </div>
</template>

<style scoped>
.page {
  min-height: 100dvh;
  background: var(--color-bg);
}

.header__email {
  overflow: hidden;
  font-size: 0.875rem;
  color: var(--color-text-muted);
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* The email is the first thing to go when the header runs out of room. */
@media (max-width: 30rem) {
  .header__email {
    display: none;
  }
}

.main {
  display: flex;
  flex-direction: column;
  gap: 1.5rem;
  max-width: var(--page-max);
  margin: 0 auto;
  padding: 1.5rem var(--page-pad) 3rem;
}

/* Centred and set apart from the panels below, the way the event page's view
   switch sits over its content. */
.tabs {
  display: flex;
  justify-content: center;
  margin: 0.25rem 0 0.75rem;
}

.tab-icon {
  width: 1rem;
  height: 1rem;
  flex: none;
}

.error {
  margin: 0;
  padding: 0.5rem 0.75rem;
  font-size: 0.875rem;
  color: var(--color-danger);
  background: var(--color-danger-soft);
  border-radius: var(--radius-md);
}
</style>
