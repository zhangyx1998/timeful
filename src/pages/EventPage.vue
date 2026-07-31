<script setup lang="ts">
/**
 * Public event page.
 *
 * The server renders the shell — name, subtitle, meta — from the event it
 * serialised into `window.__EVENT__`. The scheduler mounts client-side only:
 * it depends on the browser's timezone and localStorage, which the server
 * cannot know without producing a hydration mismatch.
 */
import { computed, inject, onBeforeUnmount, onMounted, ref, watch } from "vue";
import AdminDrawer from "../components/event/AdminDrawer.vue";
import CopyLinkButton from "../components/ui/CopyLinkButton.vue";
import EventScheduler from "../components/event/EventScheduler.vue";
import EventFormDialog from "../components/shared/EventFormDialog.vue";
import AppHeader from "../components/ui/AppHeader.vue";
import IconButton from "../components/ui/IconButton.vue";
import ThemeToggle from "../components/ui/ThemeToggle.vue";
import ConfirmDialog from "../components/ui/ConfirmDialog.vue";
import IconShield from "../assets/icons/shield-half.svg";
import { isAdmin, refreshAdmin } from "../lib/admin";
import { api, eventDataPath } from "../lib/api";
import {
  formatEventDateRange,
  getLocalTimezone,
  getScheduleTimezoneOffset,
} from "../lib/dates";
import { realtimeAllowed, type EventDoc } from "../lib/event";
import {
  connectRealtime,
  type PresenceEntry,
  type RealtimeHandle,
  type RealtimeSession,
  type SavePayload,
} from "../lib/realtime";
import { useViewport } from "../lib/viewport";

defineProps<{ slug?: string }>();

const injected = inject<EventDoc | null>("initialEvent", null);
const event = ref<EventDoc | null>(injected);
const mounted = ref(false);

/**
 * Whether the visitor is the signed-in owner. The flag itself lives in
 * `lib/admin.ts`, because the scheduler's sidebar renders off it too and
 * signing in or out from there has to move it for the whole page at once. It
 * fails closed, and nothing rests on it: every route behind it is gated by the
 * session cookie regardless (ARCHITECTURE.md § Guest UX).
 */
const editOpen = ref(false);

/**
 * The phone's admin drawer, and the navbar shield that opens it.
 *
 * It lives up here rather than in the scheduler because the button does: the
 * navbar is this page's, and the tools it opens act on the event rather than on
 * either view of the chart — so the sheet answers a tap the same way whether
 * the group's answers or the visitor's own are on screen.
 *
 * `compact` is the same measurement the scheduler makes (`lib/viewport.ts`);
 * both are false until mount, so the server renders neither the button nor the
 * sheet and there is nothing here to mismatch on hydration.
 */
const { compact } = useViewport();
const adminOpen = ref(false);

/** Widening past the phone layout puts the tools back in the sidebar, so the
 *  sheet holding a second copy of them goes — the same rule the scheduler
 *  applies to its own two drawers. */
watch(compact, (on) => {
  if (!on) adminOpen.value = false;
});

/** The drawer asked for the edit form, which is this page's own dialog. */
function onAdminEdit(): void {
  editOpen.value = true;
}

/** Set when the event is deleted out from under an open page. */
const gone = ref(false);

/** The realtime subscription, while the page is mounted. */
let realtime: RealtimeHandle | null = null;

/**
 * The connector has been failing long enough to say so (`lib/realtime.ts`,
 * `onDegraded`). Raw here; what the footer actually shows is `realtimeDown`
 * below, which also asks whether this event was supposed to have live updates
 * at all — an event with them switched off gets the same refusals off the
 * server, and they are not news.
 */
const realtimeDegraded = ref(false);

const realtimeDown = computed(
  () =>
    realtimeDegraded.value && event.value !== null && realtimeAllowed(event.value),
);

/**
 * Who is on this page right now, straight off the channel — so it is empty
 * until the socket says otherwise, and empty again the moment it drops. It
 * belongs here rather than in the scheduler because the socket does: presence
 * arrives on the same connection as the snapshots, and there is one owner of
 * that connection.
 */
const present = ref<PresenceEntry[]>([]);

/**
 * Who the scheduler is answering as, which the socket claims a write session
 * for on the visitor's behalf.
 *
 * Kept in a ref as well as pushed at the handle because the two are mounted in
 * an order neither can rely on: the scheduler may adopt a stored name before
 * this page has connected, in which case the connection reads it from here.
 */
const identity = ref<RealtimeSession | null>(null);

/** The scheduler, for the two things only this page can tell it to do. */
const scheduler = ref<{
  leaveEditing: () => void;
  resumeEditing: () => void;
} | null>(null);

/** The key whose session is held elsewhere, while the prompt is up. */
const occupiedBy = ref<RealtimeSession | null>(null);
/** The identity this page just lost to another window, while the notice is up. */
const replacedFor = ref<RealtimeSession | null>(null);

/**
 * The scheduler's way onto the socket: one method, and no more of the handle
 * than that.
 *
 * A stable object rather than the handle itself, because the handle is replaced
 * on mount and the prop must not go stale — and because "can this page send a
 * save right now" is the only question the scheduler ever asks of it.
 */
const writer = {
  save(payload: SavePayload) {
    return realtime?.save(payload) ?? null;
  },
};

function onIdentity(session: RealtimeSession | null): void {
  identity.value = session;
  // Reconnecting is how the room learns about it: the identity is part of the
  // handshake, and the write session is a property of the connection.
  realtime?.setSession(session);
}

/**
 * "My availability" was entered again under an identity already adopted. If the
 * session was refused or taken away, this is the retry; if it is already held,
 * `setSession` sees no change and does nothing.
 */
function onClaim(): void {
  realtime?.setSession(identity.value);
}

/**
 * The scheduler left the edit tab and has flushed what was pending: the write
 * session goes back, while `identity` stays. Presence stops listing this
 * editor, and the key is free for another device to claim without a takeover
 * prompt. Entering "My availability" again claims it back through `onClaim` —
 * including the occupied path, if somebody took the name in the meantime.
 */
function onRelease(): void {
  realtime?.setSession(null);
}

/**
 * Somebody else is editing as this person. Step back to the group view and ask
 * — a takeover is a thing done to another human, so it is never automatic.
 */
function onOccupied(session: RealtimeSession): void {
  scheduler.value?.leaveEditing();
  occupiedBy.value = session;
}

/**
 * Set for exactly one reconnection: the one a takeover asked for.
 *
 * Without it every reopened session would push the page back into edit mode —
 * a network blip while somebody is reading the group's chart would take the
 * chart away from them.
 */
let resumeOnOpen = false;

function takeOver(): void {
  const session = occupiedBy.value;
  occupiedBy.value = null;
  if (!session) return;
  resumeOnOpen = true;
  realtime?.setSession(session, { takeover: true });
}

/** The other side of a takeover: this window is the one that lost the session. */
function onReplaced(session: RealtimeSession): void {
  scheduler.value?.leaveEditing();
  replacedFor.value = session;
}

/** A session opened. Only a takeover puts the page back into edit mode. */
function onSessionOpen(): void {
  if (!resumeOnOpen) return;
  resumeOnOpen = false;
  scheduler.value?.resumeEditing();
}

/** SSR has no timezone, so the subtitle renders in UTC and is refined on mount. */
const subtitleOffset = ref(0);

const subtitle = computed(() =>
  event.value ? formatEventDateRange(event.value, subtitleOffset.value) : "",
);

/**
 * Adopts a new copy of the event, whoever brought it: the owner's edit dialog,
 * a refresh, or a snapshot pushed over the realtime channel. Everything the
 * page draws comes off `event`, so replacing it *is* the update — the title,
 * the date range, the heatmap and the respondents list all follow, and there is
 * exactly one path for "the event changed" rather than one per source.
 *
 * A renamed slug moves the event's URL, and the old one is dead the moment the
 * rename lands — so the address bar is corrected in place rather than pushed,
 * leaving no back-button entry pointing at a 404.
 *
 * What this deliberately does *not* touch is the visitor's own half-finished
 * answer. The grid's marks live in `EventScheduler`, which only re-seeds them
 * from a new document when it asked for one (`awaitingIdentityRefresh`), and
 * the current name is layered back over the group's answers by the response-
 * index override. So a snapshot arriving mid-drag updates everyone else and
 * leaves the drag alone.
 */
function applyEvent(next: EventDoc): void {
  const before = event.value?.slug;
  event.value = next;
  document.title = `${next.name} · Timeful`;
  if (next.slug && next.slug !== before) {
    window.history.replaceState(window.history.state, "", `/${next.slug}`);
  }
}

async function refresh() {
  const target = event.value?.slug ?? event.value?.id;
  if (!target) return;
  try {
    applyEvent((await api.get(eventDataPath(target))) as EventDoc);
  } catch {
    // Keep showing what we already have; the grid stays usable either way.
  }
}

function onEdited(saved: EventDoc): void {
  applyEvent(saved);
  editOpen.value = false;
}

/**
 * The event was deleted while this page had it open. There is nothing left to
 * answer, so the scheduler goes rather than sitting there autosaving into a
 * 404 — the page says what happened and stops, which is the same thing the
 * standalone 404 page says to someone arriving at a dead link.
 */
function onGone(): void {
  gone.value = true;
  event.value = null;
  editOpen.value = false;
  document.title = "Event not found · Timeful";
}

onMounted(() => {
  if (!event.value) event.value = window.__EVENT__ ?? null;
  if (event.value) {
    subtitleOffset.value = getScheduleTimezoneOffset(event.value, getLocalTimezone());
  }
  mounted.value = true;
  void refreshAdmin();

  // A silent enhancement: no indicator, nothing to configure, and a page whose
  // socket never opens behaves exactly like one from before this existed.
  // Subscribed by uuid rather than slug so a rename cannot strand it.
  const id = event.value?.id;
  if (id) {
    realtime = connectRealtime(id, {
      session: identity.value,
      onEvent: applyEvent,
      onPresence: (people) => {
        present.value = people;
      },
      onGone,
      onOccupied,
      onReplaced,
      onSessionOpen,
      onDegraded: (down) => {
        realtimeDegraded.value = down;
      },
    });
  }
});

onBeforeUnmount(() => {
  realtime?.close();
  realtime = null;
});
</script>

<template>
  <!-- `event-page` carries no scoped styles: it is the marker the global sheet
       keys the phone layout's document-level scroll lock off, which is a rule
       about <html> and <body> and so cannot live in a scoped block. -->
  <div class="page event-page">
    <AppHeader>
      <!-- What every visitor gets, and nothing else. The owner's controls used
           to sit here as two unlabelled glyphs among them; they are a labelled
           group in the sidebar now, where they read as belonging to somebody
           rather than to the page. -->
      <template #lead>
        <h1 v-if="event" class="name" :title="event.name">{{ event.name }}</h1>
        <!-- Client-only: before hydration the button could not copy anything. -->
        <CopyLinkButton v-if="mounted && event" />
      </template>

      <!-- The dates belong with the name they qualify, so they lead the
           right-hand group rather than sitting in the body. -->
      <p v-if="event" class="when" :title="subtitle">{{ subtitle }}</p>

      <!-- The phone's way to the owner's tools, beside the theme switch because
           it is the same kind of control: it acts on the whole page rather than
           on either view of the chart. A guest never renders it — `isAdmin`
           fails closed — and neither does the desktop, which keeps the tools
           where they already are, at the head of the sidebar. -->
      <IconButton
        v-if="isAdmin && compact && event"
        label="Admin tools"
        @click="adminOpen = true"
      >
        <IconShield />
      </IconButton>

      <ThemeToggle />
    </AppHeader>

    <main class="main">
      <template v-if="event">
        <EventScheduler
          v-if="mounted"
          ref="scheduler"
          :event="event"
          :present="present"
          :writer="writer"
          :realtime-down="realtimeDown"
          @refresh="refresh"
          @identity="onIdentity"
          @claim="onClaim"
          @release="onRelease"
          @edit="editOpen = true"
        />
        <p v-else class="loading">Loading availability…</p>
      </template>

      <div v-else-if="gone" class="gone">
        <h2 class="gone__title">Event deleted</h2>
        <p class="gone__text">
          This event was removed while you had it open. Nothing further can be
          filled in here.
        </p>
      </div>

      <p v-else class="loading">No event data.</p>
    </main>

    <!-- Before the form dialog below it, so the sheet's teleport anchor lands
         first in <body> and the form it opens is drawn over it rather than
         under it. -->
    <AdminDrawer
      v-if="isAdmin && compact && event"
      :open="adminOpen"
      :event-id="event.id"
      @close="adminOpen = false"
      @edit="onAdminEdit"
    />

    <EventFormDialog
      v-if="isAdmin"
      :open="editOpen"
      :event="event"
      @saved="onEdited"
      @close="editOpen = false"
    />

    <!-- One session per person per event, so adopting a name somebody is
         already editing under is a question rather than a fight. Cancelling
         leaves the page in the group view with the name still remembered: "My
         availability" asks again. -->
    <!-- Client-only, like the scheduler: `Dialog` teleports to <body>, and a
         teleport rendered into the SSR output is a hydration mismatch that
         costs the whole page. There is no socket during SSR either, so neither
         of these can have anything to say before mount. -->
    <ConfirmDialog
      v-if="mounted"
      :open="occupiedBy !== null"
      title="Already being edited"
      confirm-label="Take over"
      tone="primary"
      @confirm="takeOver"
      @close="occupiedBy = null"
    >
      <strong>{{ occupiedBy?.displayName }}</strong> is being edited in
      another session. Take over?
    </ConfirmDialog>

    <!-- The other end of the same handshake. Said plainly, because from here it
         looks like the page simply stopped saving — and it is not reclaimed
         automatically, or the two windows would take turns forever. One button
         and nothing to cancel: an acknowledgement, not a choice. -->
    <ConfirmDialog
      v-if="mounted"
      :open="replacedFor !== null"
      title="Editing session taken over"
      confirm-label="OK"
      tone="primary"
      cancel-label=""
      @confirm="replacedFor = null"
      @close="replacedFor = null"
    >
      Your editing session for
      <strong>{{ replacedFor?.displayName }}</strong> was taken over by
      another window or device. Your times are still saved; this page is now
      showing the group's availability.
    </ConfirmDialog>
  </div>
</template>

<style scoped>
.page {
  min-height: 100dvh;
  background: var(--color-bg);
}

.main {
  max-width: var(--page-max);
  margin: 0 auto;
  padding: 1.25rem calc(var(--page-pad) + var(--safe-right)) 3rem
    calc(var(--page-pad) + var(--safe-left));
  font-family: var(--font-sans);
  color: var(--color-text);
}

/* The page's one h1, in the header rather than the body: the event's name is
   what identifies this page, so it belongs in the bar that stays on screen.
   One line, ellipsis past that, full name in the tooltip. */
.name {
  min-width: 0;
  overflow: hidden;
  font-size: 1.0625rem;
  font-weight: 600;
  line-height: 1.25;
  letter-spacing: -0.01em;
  white-space: nowrap;
  text-overflow: ellipsis;
}

/* Leads the header's right-hand group. It gives up room before the icons do
   and, on a narrow phone where it would leave the name a stub, gets out of the
   way entirely — the grid's own column headings carry the dates there. */
.when {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  font-size: 0.8125rem;
  white-space: nowrap;
  text-overflow: ellipsis;
  color: var(--color-text-muted);
}

@media (max-width: 32rem) {
  .when {
    display: none;
  }
}

.loading {
  font-size: 0.875rem;
  color: var(--color-text-muted);
}

/* The event went away under an open page. Centred and quiet: it is the whole
   of what is left to say, and it says the same thing the standalone 404 page
   says to someone who arrives at a dead link. */
.gone {
  padding: 3rem 0;
  text-align: center;
}

.gone__title {
  font-size: 1.25rem;
  font-weight: 600;
  letter-spacing: -0.01em;
  color: var(--color-text);
}

.gone__text {
  max-width: 26rem;
  margin: 0.5rem auto 0;
  font-size: 0.875rem;
  line-height: 1.5;
  color: var(--color-text-muted);
}

/* The phone layout is an app, not a document: the page is exactly the viewport
   and does not scroll, so the scheduler can hand the chart a fixed pane and a
   finger drag on it can only ever mean selection. Everything that needs to
   scroll — the grid itself, a drawer's contents — scrolls inside its own box.
   Deriving the pane's height from the flex column rather than subtracting the
   header's height from the viewport keeps one number out of two files. */
@media (max-width: 820px) {
  .page {
    display: flex;
    flex-direction: column;
    height: 100dvh;
    min-height: 0;
    overflow: hidden;
  }

  .main {
    display: flex;
    flex: 1 1 auto;
    flex-direction: column;
    min-height: 0;
    /* The centring margins are what would otherwise opt this item out of
       stretching to the column's width, leaving it max-content wide. */
    width: 100%;
    padding: 0.5rem calc(var(--page-pad) + var(--safe-right)) 0
      calc(var(--page-pad) + var(--safe-left));
  }
}

/* Sideways, the chart is what is left after the chrome and there is barely any
   of it, so the shell spends nothing on air it can do without. */
@media (max-height: 480px) and (max-width: 820px) {
  .main {
    padding-top: 0.25rem;
  }
}
</style>
