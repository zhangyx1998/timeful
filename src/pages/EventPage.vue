<script setup lang="ts">
/**
 * Public event page.
 *
 * The server renders the shell — name, subtitle, meta — from the event it
 * serialised into `window.__EVENT__`. The scheduler mounts client-side only:
 * it depends on the browser's timezone and localStorage, which the server
 * cannot know without producing a hydration mismatch.
 */
import { computed, inject, onMounted, ref } from "vue";
import CopyLinkButton from "../components/ui/CopyLinkButton.vue";
import EventScheduler from "../components/event/EventScheduler.vue";
import EventFormDialog from "../components/shared/EventFormDialog.vue";
import AppHeader from "../components/ui/AppHeader.vue";
import IconButton from "../components/ui/IconButton.vue";
import ThemeToggle from "../components/ui/ThemeToggle.vue";
import IconPencil from "../assets/icons/pencil.svg";
import IconHome from "../assets/icons/home.svg";
import { api, fetchIsAdmin } from "../lib/api";
import {
  formatEventDateRange,
  getLocalTimezone,
  getScheduleTimezoneOffset,
} from "../lib/dates";
import type { EventDoc } from "../lib/event";

defineProps<{ slug?: string }>();

const injected = inject<EventDoc | null>("initialEvent", null);
const event = ref<EventDoc | null>(injected);
const mounted = ref(false);
/**
 * Whether the visitor is the signed-in owner, which decides whether the header
 * offers a way back to the panel and a way to edit this event. `fetchIsAdmin`
 * fails closed, so a guest — or anyone whose status call did not come back
 * cleanly — sees nothing extra (ARCHITECTURE.md § Guest UX). Nothing rests on
 * the flag being right: `PATCH /api/events/:id` is admin-gated regardless.
 */
const isAdmin = ref(false);

const editOpen = ref(false);

/** SSR has no timezone, so the subtitle renders in UTC and is refined on mount. */
const subtitleOffset = ref(0);

const subtitle = computed(() =>
  event.value ? formatEventDateRange(event.value, subtitleOffset.value) : "",
);

async function refresh() {
  const target = event.value?.slug ?? event.value?.id;
  if (!target) return;
  try {
    event.value = (await api.get(`/events/${encodeURIComponent(target)}`)) as EventDoc;
  } catch {
    // Keep showing what we already have; the grid stays usable either way.
  }
}

/**
 * The edit landed. Everything the page draws comes off `event`, so replacing it
 * is the refresh: the title, the date range and the grid all follow.
 *
 * A renamed slug moves the event's URL, and the old one is dead the moment the
 * PATCH returns — so the address bar is corrected in place rather than pushed,
 * leaving no back-button entry pointing at a 404.
 */
function onEdited(saved: EventDoc): void {
  const before = event.value?.slug;
  event.value = saved;
  editOpen.value = false;
  document.title = `${saved.name} · Timeful`;
  if (saved.slug && saved.slug !== before) {
    window.history.replaceState(window.history.state, "", `/${saved.slug}`);
  }
}

onMounted(() => {
  if (!event.value) event.value = window.__EVENT__ ?? null;
  if (event.value) {
    subtitleOffset.value = getScheduleTimezoneOffset(event.value, getLocalTimezone());
  }
  mounted.value = true;
  void fetchIsAdmin().then((admin) => {
    isAdmin.value = admin;
  });
});
</script>

<template>
  <!-- `event-page` carries no scoped styles: it is the marker the global sheet
       keys the phone layout's document-level scroll lock off, which is a rule
       about <html> and <body> and so cannot live in a scoped block. -->
  <div class="page event-page">
    <AppHeader>
      <template #lead>
        <h1 v-if="event" class="name" :title="event.name">{{ event.name }}</h1>
        <!-- Client-only: before hydration the button could not copy anything. -->
        <CopyLinkButton v-if="mounted && event" />

        <!-- The owner's controls sit with the name they act on. -->
        <IconButton v-if="isAdmin && event" label="Edit event" @click="editOpen = true">
          <IconPencil aria-hidden="true" />
        </IconButton>
      </template>

      <!-- The dates belong with the name they qualify, so they lead the
           right-hand group rather than sitting in the body. -->
      <p v-if="event" class="when">{{ subtitle }}</p>

      <!--
        Only the owner gets a way back to the panel; a guest has no panel to go
        to, and the flag fails closed, so an unresolved status call shows them
        nothing (ARCHITECTURE.md § Guest UX).
      -->
      <IconButton v-if="isAdmin" href="/" label="Back to your events">
        <IconHome aria-hidden="true" />
      </IconButton>
      <ThemeToggle />
    </AppHeader>

    <main class="main">
      <template v-if="event">
        <EventScheduler v-if="mounted" :event="event" @refresh="refresh" />
        <p v-else class="loading">Loading availability…</p>
      </template>

      <p v-else class="loading">No event data.</p>
    </main>

    <EventFormDialog
      v-if="isAdmin"
      :open="editOpen"
      :event="event"
      @saved="onEdited"
      @close="editOpen = false"
    />
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
  padding: 1.25rem var(--page-pad) 3rem;
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
    padding: 0.5rem var(--page-pad) 0;
  }
}
</style>
