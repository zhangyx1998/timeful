<script setup lang="ts">
/**
 * The owner's controls on an event page, in one labelled box.
 *
 * They used to be two unlabelled glyphs in the navbar — a pencil and a house —
 * beside controls every visitor gets. Nothing said they were the owner's, and
 * there was nowhere to put a third. Gathered into a bordered group at the head
 * of the sidebar (or of the settings drawer on a phone) they read as what they
 * are: a section of the page that belongs to whoever is signed in, and one a
 * fourth control can join without crowding the title.
 *
 * A guest never renders this at all — the whole group hangs off `isAdmin`,
 * which fails closed. Nothing rests on that: every route behind these buttons
 * is gated by the session cookie regardless.
 */
import { ref } from "vue";
import PushToggle from "./PushToggle.vue";
import Button from "../ui/Button.vue";
import Dialog from "../ui/Dialog.vue";
import Spinner from "../ui/Spinner.vue";
import IconPencil from "../../assets/icons/pencil.svg";
import IconHome from "../../assets/icons/home.svg";
import IconClock from "../../assets/icons/clock.svg";
import IconSignOut from "../../assets/icons/sign-out.svg";
import IconShield from "../../assets/icons/shield-half.svg";
import { adminLogout } from "../../lib/admin";
import { api, apiError, eventDetailsPath } from "../../lib/api";
import { formatDateTime } from "../../lib/dates";
import type { EventDetails, EventDetailsUser } from "../../lib/api";

const props = defineProps<{
  /** The event these act on. The uuid, so a rename cannot strand them. */
  eventId: string;
  /**
   * Inside the phone's admin drawer the border and the heading are the sheet's
   * own — it is titled "Admin" and wears the shield already — so both are
   * dropped here and only the tools are left. Same reasoning, and the same
   * prop name, as the respondents panel inside its own drawer.
   */
  embedded?: boolean;
}>();

const emit = defineEmits<{ edit: [] }>();

const detailsOpen = ref(false);
const loading = ref(false);
const error = ref("");
const users = ref<EventDetailsUser[]>([]);
const signingOut = ref(false);

/**
 * Fetched on open rather than held: it is a log, so what matters is what it
 * says now, and a page left open for an hour would otherwise show an hour-old
 * answer with no sign of it.
 */
async function openDetails(): Promise<void> {
  detailsOpen.value = true;
  loading.value = true;
  error.value = "";
  try {
    users.value = (await api.get<EventDetails>(eventDetailsPath(props.eventId))).users;
  } catch (err) {
    users.value = [];
    error.value = apiError(err, "Could not load the details").message;
  } finally {
    loading.value = false;
  }
}

async function signOut(): Promise<void> {
  signingOut.value = true;
  try {
    // Re-probes rather than assuming; the group disappears where it stands,
    // with no reload and nothing else about the page disturbed.
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
    <!-- The half-solid shield is the app's one admin mark: the same glyph is on
         the navbar button that opens the phone's admin drawer, on that drawer's
         own header, and on the way back in at the foot of the column. Wherever
         it appears, it means "this belongs to whoever is signed in". -->
    <h2 v-if="!embedded" id="admin-tools-title" class="tools__title">
      <IconShield class="tools__mark" aria-hidden="true" />
      Admin
    </h2>

    <div class="tools__actions">
      <Button class="tool" variant="ghost" size="sm" @click="emit('edit')">
        <IconPencil aria-hidden="true" />
        Edit event
      </Button>

      <!-- An anchor rather than a button: it goes somewhere, so a middle-click
           and a long-press should offer what they always offer. -->
      <a class="tool tool--link" href="/">
        <IconHome aria-hidden="true" />
        Back to home
      </a>

      <Button class="tool" variant="ghost" size="sm" @click="openDetails">
        <IconClock aria-hidden="true" />
        Details
      </Button>

      <!-- The owner's bell: this browser asking to hear when answers change.
           Hidden entirely where push cannot work; the prompt fires only from
           the press. In the drawer and the sidebar alike, because both render
           this same component. -->
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

  <!-- What the respondents list cannot say: two answers under one name look
       identical there, and this is where they stop looking identical. -->
  <Dialog
    :open="detailsOpen"
    size="lg"
    title="Where each answer came from"
    @close="detailsOpen = false"
  >
    <div class="details">
      <p class="details__note">
        Recorded when a response was last saved, and visible only to you.
      </p>

      <p v-if="loading" class="details__state">
        <Spinner :size="15" label="Loading details" />
      </p>
      <p v-else-if="error" class="details__state details__state--error" role="alert">
        {{ error }}
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
            <!-- The raw header, on one line with the whole of it in the
                 tooltip: a parsed "Chrome on macOS" is a guess about a string
                 that is a guess already, and the string itself is what an
                 owner comparing two rows actually wants to compare. -->
            <p class="row__agent" :title="user.lastEdit.userAgent">
              {{ user.lastEdit.userAgent || "No user agent" }}
            </p>
          </template>

          <p v-else class="row__none">
            Saved before this was recorded, so there is nothing to show.
          </p>
        </li>
      </ul>
    </div>
  </Dialog>
</template>

<style scoped>
/* Bordered and titled, because what it contains is a different *kind* of thing
   from the cards below it: those are about the event, these are about your
   being signed in to it. */
.tools {
  padding: 0.5rem 0.6rem 0.6rem;
  border: 1px solid var(--color-border-strong);
  border-radius: var(--radius-md);
}

/* In the drawer the sheet is the box and its header is the title, so the group
   is nothing but its rows. */
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

/* A shade over the cap height of the word beside it: a badge on a label, not a
   second heading. */
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

/* A column of labelled rows rather than a row of buttons: they are unrelated
   actions that happen to belong to the same person, so each gets its own line
   and none of them is the one you are being pushed towards. */
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

/* The one that is a link, dressed as the buttons beside it. */
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

/* --- the details dialog ---------------------------------------------------- */

.details {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
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

/* One line, whole string in the tooltip. A user agent is a paragraph of
   punctuation and letting it wrap turns every row into a wall. */
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
