<script setup lang="ts">
// The owner's controls. Guests never render this (`isAdmin` fails closed), but nothing
// rests on that: every route behind these buttons is gated by the session cookie.
import { ref } from "vue";
import PushToggle from "./PushToggle.vue";
import LogViewer from "../shared/LogViewer.vue";
import Button from "../ui/Button.vue";
import Dialog from "../ui/Dialog.vue";
import Segmented from "../ui/Segmented.vue";
import Spinner from "../ui/Spinner.vue";
import IconPencil from "../../assets/icons/pencil.svg";
import IconHome from "../../assets/icons/home.svg";
import IconClock from "../../assets/icons/clock.svg";
import IconSignOut from "../../assets/icons/sign-out.svg";
import IconShield from "../../assets/icons/shield-half.svg";
import { adminLogout } from "../../lib/admin";
import { api, apiError, eventDetailsPath, eventLogsPath } from "../../lib/api";
import { formatDateTime } from "../../lib/dates";
import type { EventDetails, EventDetailsUser } from "../../lib/api";

const props = defineProps<{
  /** The uuid, so a rename cannot strand these. */
  eventId: string;
  embedded?: boolean;
}>();

const emit = defineEmits<{ edit: [] }>();

const detailsOpen = ref(false);
const loading = ref(false);
const error = ref("");
const errorDetail = ref("");
const users = ref<EventDetailsUser[]>([]);
const signingOut = ref(false);

// The log tab mounts its viewer only while showing, so its socket opens and closes with the tab.
const DETAIL_TABS = [
  { value: "details", label: "Details" },
  { value: "logs", label: "Server logs" },
] as const;

const detailTab = ref<string>("details");

// Fetched on open rather than held: a page left open would show a stale answer with no sign of it.
async function openDetails(): Promise<void> {
  detailsOpen.value = true;
  detailTab.value = "details";
  loading.value = true;
  error.value = "";
  errorDetail.value = "";
  try {
    users.value = (await api.get<EventDetails>(eventDetailsPath(props.eventId))).users;
  } catch (err) {
    users.value = [];
    const failure = apiError(err, "Could not load the details");
    error.value = failure.message;
    errorDetail.value = failure.detail;
  } finally {
    loading.value = false;
  }
}

async function signOut(): Promise<void> {
  signingOut.value = true;
  try {
    await adminLogout();
  } finally {
    signingOut.value = false;
  }
}
</script>

<template>
  <section
    class="tools"
    :class="{ 'tools--embedded': embedded }"
    :aria-labelledby="embedded ? undefined : 'admin-tools-title'"
    :aria-label="embedded ? 'Admin' : undefined"
  >
    <h2 v-if="!embedded" id="admin-tools-title" class="tools__title">
      <IconShield class="tools__mark" aria-hidden="true" />
      Admin
    </h2>

    <div class="tools__actions">
      <Button class="tool" variant="ghost" size="sm" @click="emit('edit')">
        <IconPencil aria-hidden="true" />
        Edit event
      </Button>

      <!-- An anchor, not a button: middle-click and long-press should offer what they always offer. -->
      <a class="tool tool--link" href="/">
        <IconHome aria-hidden="true" />
        Back to home
      </a>

      <Button class="tool" variant="ghost" size="sm" @click="openDetails">
        <IconClock aria-hidden="true" />
        Details
      </Button>

      <PushToggle
        :event-id="eventId"
        role="owner"
        label="Notify me about responses"
      />

      <Button
        class="tool"
        variant="ghost"
        size="sm"
        :loading="signingOut"
        @click="signOut"
      >
        <IconSignOut v-if="!signingOut" aria-hidden="true" />
        Logout
      </Button>
    </div>
  </section>

  <Dialog
    :open="detailsOpen"
    size="lg"
    title="Event details"
    @close="detailsOpen = false"
  >
    <div class="details">
      <div class="details__tabs">
        <Segmented
          v-model="detailTab"
          label="Details section"
          size="sm"
          equal
          :options="DETAIL_TABS"
        />
      </div>

      <template v-if="detailTab === 'logs'">
        <p class="details__note">Live, and visible only to you.</p>
        <LogViewer
          :path="eventLogsPath(props.eventId)"
          empty-text="Nothing logged for this event yet"
        />
      </template>

      <template v-else>
      <p class="details__note">
        Recorded when a response was last saved, and visible only to you.
      </p>

      <p v-if="loading" class="details__state">
        <Spinner :size="15" label="Loading details" />
      </p>
      <p v-else-if="error" class="details__state details__state--error" role="alert">
        {{ error }}
        <span v-if="errorDetail" class="details__cause">{{ errorDetail }}</span>
      </p>
      <p v-else-if="users.length === 0" class="details__state">Nobody has answered yet.</p>

      <ul v-else class="rows">
        <li v-for="user in users" :key="user.key" class="row">
          <p class="row__name" :title="user.displayName">{{ user.displayName }}</p>

          <template v-if="user.lastEdit">
            <dl class="facts">
              <div class="fact">
                <dt class="fact__key">IP</dt>
                <dd class="fact__value fact__value--mono">{{ user.lastEdit.ip || "—" }}</dd>
              </div>
              <div class="fact">
                <dt class="fact__key">When</dt>
                <dd class="fact__value">{{ formatDateTime(user.lastEdit.at) }}</dd>
              </div>
            </dl>
            <p class="row__agent" :title="user.lastEdit.userAgent">
              {{ user.lastEdit.userAgent || "No user agent" }}
            </p>
          </template>

          <p v-else class="row__none">
            Saved before this was recorded, so there is nothing to show.
          </p>
        </li>
      </ul>
      </template>
    </div>
  </Dialog>
</template>

<style scoped>
.tools {
  padding: 0.5rem 0.6rem 0.6rem;
  border: 1px solid var(--color-border-strong);
  border-radius: var(--radius-md);
}

.tools--embedded {
  padding: 0;
  border: none;
  border-radius: 0;
}

.tools__title {
  display: flex;
  align-items: center;
  gap: 0.3rem;
  margin-bottom: 0.25rem;
  font-size: 0.6875rem;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--color-text-muted);
}

.tools__mark {
  flex: none;
  width: 0.8rem;
  height: 0.8rem;
}

.tools__actions {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 0.1rem;
}

.tool {
  justify-content: flex-start;
  gap: 0.5rem;
  padding-inline: 0.4rem;
}

.tool :deep(svg),
.tool > svg {
  flex: none;
  width: 0.95rem;
  height: 0.95rem;
}

.tool--link {
  display: inline-flex;
  align-items: center;
  min-height: 1.875rem;
  font-size: 0.8125rem;
  font-weight: 500;
  color: var(--color-text-muted);
  text-decoration: none;
  border-radius: var(--radius-md);
  transition: color var(--transition-fast), background var(--transition-fast);
}

.tool--link:hover {
  color: var(--color-text);
  background: var(--color-subtle);
}

@media (pointer: coarse) {
  .tool--link {
    min-height: var(--tap-min);
  }
}

.details {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.details__tabs {
  display: flex;
  justify-content: center;
}

.details__cause {
  display: block;
  overflow-wrap: anywhere;
  font-family: var(--font-mono);
  font-size: 0.75rem;
  color: var(--color-text-muted);
  user-select: text;
}

.details__note {
  font-size: 0.8125rem;
  line-height: 1.4;
  color: var(--color-text-muted);
}

.details__state {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.875rem;
  color: var(--color-text-muted);
}

.details__state--error {
  color: var(--color-danger);
}

.rows {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  padding: 0;
  margin: 0;
  list-style: none;
}

.row {
  padding: 0.6rem 0.7rem;
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
}

.row__name {
  overflow: hidden;
  font-size: 0.9375rem;
  font-weight: 600;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.facts {
  display: flex;
  flex-wrap: wrap;
  gap: 0.15rem 1.25rem;
  margin-top: 0.3rem;
}

.fact {
  display: flex;
  align-items: baseline;
  gap: 0.4rem;
  min-width: 0;
}

.fact__key {
  font-size: 0.6875rem;
  font-weight: 600;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  color: var(--color-text-muted);
}

.fact__value {
  font-size: 0.8125rem;
  color: var(--color-text);
}

.fact__value--mono {
  font-family: var(--font-mono);
}

.row__agent {
  margin-top: 0.3rem;
  overflow: hidden;
  font-family: var(--font-mono);
  font-size: 0.75rem;
  white-space: nowrap;
  text-overflow: ellipsis;
  color: var(--color-text-muted);
}

.row__none {
  margin-top: 0.25rem;
  font-size: 0.8125rem;
  color: var(--color-text-muted);
}
</style>
