<script setup lang="ts">
/**
 * Public event page. The server renders the shell plus a static availability
 * preview; the interactive scheduler mounts client-side only (browser timezone
 * and localStorage would otherwise produce a hydration mismatch) and replaces
 * it (ARCHITECTURE.md § Routing / SSR).
 */
import { computed, inject, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import AdminDrawer from "../components/event/AdminDrawer.vue";
import EventScheduler from "../components/event/EventScheduler.vue";
import SchedulerPreview from "../components/event/SchedulerPreview.vue";
import InviteButton from "../components/event/InviteButton.vue";
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
import { eventPageTitle, type EventSubpage } from "../lib/event-routes";
import { userKeyFromParam } from "../lib/user-key";
import {
  connectRealtime,
  type PresenceEntry,
  type RealtimeHandle,
  type RealtimeSession,
  type SavePayload,
} from "../lib/realtime";
import { useViewport } from "../lib/viewport";

defineProps<{ slug?: string; userKey?: string }>();

const injected = inject<EventDoc | null>("initialEvent", null);
const event = ref<EventDoc | null>(injected);
const mounted = ref(false);

// The server's layout guess for the static preview; hydration gets the same
// value from `window.__PREVIEW__`, so the two renders cannot disagree.
const previewCompact = inject<boolean>("previewCompact", false);

// `isAdmin` lives in lib/admin.ts and fails closed; every route behind it is
// gated by the session cookie regardless (ARCHITECTURE.md § Guest UX).
const editOpen = ref(false);

// `compact` and `adminOpen` are false until mount, so SSR renders neither the
// shield button nor the sheet and there is nothing to mismatch on hydration.
const { compact } = useViewport();
const adminOpen = ref(false);

watch(compact, (on) => {
  if (!on) adminOpen.value = false;
});

function onAdminEdit(): void {
  editOpen.value = true;
}

/** Set when the event is deleted out from under an open page. */
const gone = ref(false);

let realtime: RealtimeHandle | null = null;

// Raw degraded flag; `realtimeDown` below also asks whether this event was
// supposed to have live updates at all.
const realtimeDegraded = ref(false);

const realtimeDown = computed(
  () =>
    realtimeDegraded.value && event.value !== null && realtimeAllowed(event.value),
);

/** Presence straight off the channel: empty until the socket says otherwise. */
const present = ref<PresenceEntry[]>([]);

// Kept in a ref as well as pushed at the handle because mount order is
// unreliable: the scheduler may adopt a stored name before this page connects.
const identity = ref<RealtimeSession | null>(null);

const scheduler = ref<{
  leaveEditing: () => void;
  resumeEditing: () => void;
} | null>(null);

/** The key whose session is held elsewhere, while the prompt is up. */
const occupiedBy = ref<RealtimeSession | null>(null);
/** The identity this page just lost to another window, while the notice is up. */
const replacedFor = ref<RealtimeSession | null>(null);

// A stable object rather than the handle itself: the handle is replaced on
// mount and the prop must not go stale.
const writer = {
  save(payload: SavePayload) {
    return realtime?.save(payload) ?? null;
  },
};

function onIdentity(session: RealtimeSession | null): void {
  identity.value = session;
  // The identity is part of the handshake; the write session is a property of
  // the connection.
  realtime?.setSession(session);
}

// The retry after a refusal; a session already held sees no change and does nothing.
function onClaim(): void {
  realtime?.setSession(identity.value);
}

// The write session goes back while `identity` stays.
function onRelease(): void {
  realtime?.setSession(null);
}

// A takeover is a thing done to another human, so it is never automatic.
function onOccupied(session: RealtimeSession): void {
  scheduler.value?.leaveEditing();
  occupiedBy.value = session;
}

// Set for exactly one reconnection — the one a takeover asked for — or every
// reopened session would push the page back into edit mode.
let resumeOnOpen = false;

function takeOver(): void {
  const session = occupiedBy.value;
  occupiedBy.value = null;
  if (!session) return;
  // A connector that has given up can claim nothing: setSession is a no-op.
  if (realtime?.stopped) return;
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

const route = useRoute();
const router = useRouter();

/** Which of the page's three shapes the URL is on (`lib/event-routes.ts`). */
const subpage = computed<EventSubpage>(() => {
  if (route.name === "event-view") return { kind: "view" };
  if (route.name === "event-edit")
    return { kind: "edit", key: String(route.params.userKey ?? "") };
  return { kind: "root" };
});

// Same builder as the SSR head, keeping the hydrated title byte-equal to the
// served one on first paint.
const title = computed(() => {
  if (!event.value) return null;
  const sub = subpage.value;
  const editorName =
    sub.kind === "edit" &&
    identity.value !== null &&
    identity.value.key === userKeyFromParam(sub.key)
      ? identity.value.displayName
      : undefined;
  return eventPageTitle(event.value, sub, editorName);
});

watch(title, (value) => {
  if (value) document.title = value;
});

/** SSR has no timezone, so the subtitle renders in UTC and is refined on mount. */
const subtitleOffset = ref(0);

const subtitle = computed(() =>
  event.value ? formatEventDateRange(event.value, subtitleOffset.value) : "",
);

// The one path for "the event changed", whoever brought it. The visitor's own
// half-finished answer is untouched: the scheduler only re-seeds when it asked
// for a refresh, and the override layers the current marks back over the group.
function applyEvent(next: EventDoc): void {
  // Every broadcast path bumps `updatedAt` (ARCHITECTURE.md § Realtime), so an
  // older document lost the race. `<` not `<=`, so an equal-timestamp
  // re-render still lands.
  if (event.value && next.updatedAt < event.value.updatedAt) return;
  const before = event.value?.slug;
  event.value = next;
  if (next.slug && next.slug !== before) {
    // Replaced, not pushed: the old slug is dead and must not sit in history.
    // Through the router because the path carries state a bare /slug would drop.
    void router.replace({
      name: (route.name as string) || "event",
      params: { ...route.params, slug: next.slug },
      query: route.query,
    });
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

// Nothing left to answer; stop rather than autosave into a 404.
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
  <!-- `event-page` is the marker the global sheet keys the phone scroll lock
       off — a rule about <html>/<body> that cannot live in a scoped block. -->
  <div class="page event-page">
    <AppHeader>
      <template #lead>
        <h1 v-if="event" class="name" :title="event.name">{{ event.name }}</h1>
        <!-- Client-only. The slug, not the address bar: the canonical root URL
             is the only link worth handing out. -->
        <InviteButton v-if="mounted && event" :slug="event.slug" />
      </template>

      <p v-if="event" class="when" :title="subtitle">{{ subtitle }}</p>

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
        <!-- The static group heatmap the mounted scheduler replaces. -->
        <SchedulerPreview v-else :event="event" :compact="previewCompact" />
      </template>

      <div v-else-if="gone" class="gone">
        <h2 class="gone__title">Event deleted</h2>
        <p class="gone__text">It was removed while you had it open.</p>
        <a class="gone__home" href="/">Go home</a>
      </div>

      <p v-else class="loading">No event data.</p>
    </main>

    <!-- Before the form dialog below it, so the sheet's teleport anchor lands
         first in <body> and the form it opens is drawn over it. -->
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

    <!-- Client-only: `Dialog` teleports to <body>, and a teleport rendered
         into the SSR output is a hydration mismatch. -->
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

/* Invisible padding keeps the tap target at the floor. */
.gone__home {
  display: inline-block;
  padding: 0.75rem 1rem;
  margin-top: 0.25rem;
  font-size: 0.875rem;
  color: var(--color-accent);
}


/* Phone layout: the page is exactly the viewport and does not scroll; anything
   that scrolls does so inside its own box. The pane's height derives from the
   flex column, not viewport minus header. */
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
    /* The centring margins would otherwise opt this item out of stretching. */
    width: 100%;
    padding: 0.5rem calc(var(--page-pad) + var(--safe-right)) 0
      calc(var(--page-pad) + var(--safe-left));
  }
}

@media (max-height: 480px) and (max-width: 820px) {
  .main {
    padding-top: 0.25rem;
  }
}
</style>
