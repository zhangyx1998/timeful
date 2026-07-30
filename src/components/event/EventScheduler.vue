<script setup lang="ts">
/**
 * The interactive half of the event page: the chart, and everything arranged
 * around it.
 *
 * Mounted client-side only, so it can read localStorage and the browser's
 * timezone without risking an SSR hydration mismatch.
 *
 * What is left here is the arrangement. The four things it arranges are each a
 * concern of their own and live next door:
 *
 * | `lib/response-session.ts` | who you are, what you marked, and the autosave |
 * | `lib/preferences.ts`      | zone, clock, best-times — this visitor's, kept |
 * | `lib/viewport.ts`         | phone or desktop, and how many columns fit     |
 * | `lib/isolation.ts`        | showing one person's answer instead of the sum |
 *
 * The two layouts share this one component rather than splitting into a phone
 * shell and a desktop shell, because they are not two layouts of *different*
 * things: the same chart, the same identity, the same respondents and the same
 * settings, with the phone putting three of them behind drawers. A split would
 * have duplicated every prop of every one of them to say so.
 */
import { computed, ref, watch } from "vue";
import AdminLoginLink from "./AdminLoginLink.vue";
import AdminTools from "./AdminTools.vue";
import AvailabilityGrid from "./AvailabilityGrid.vue";
import ColorLegend from "./ColorLegend.vue";
import EventSettingsDrawer from "./EventSettingsDrawer.vue";
import GuestIdentityDialog from "./GuestIdentityDialog.vue";
import IdentityCard from "./IdentityCard.vue";
import ModePills from "./ModePills.vue";
import RespondentsPanel from "./RespondentsPanel.vue";
import TimezoneField from "./TimezoneField.vue";
import Button from "../ui/Button.vue";
import Dialog from "../ui/Dialog.vue";
import Segmented from "../ui/Segmented.vue";
import IconPeople from "../../assets/icons/people.svg";
import IconPerson from "../../assets/icons/person.svg";
import IconGear from "../../assets/icons/gear.svg";
import IconTrash from "../../assets/icons/trash.svg";
import { isAdmin } from "../../lib/admin";
import {
  formatSlotRange,
  getScheduleTimezoneOffset,
  getTimezoneReferenceDateForEvent,
} from "../../lib/dates";
import { buildGrid, buildResponseIndex, maxRespondents, snapshotSlots } from "../../lib/grid";
import type { EventDoc } from "../../lib/event";
import { useUndoHistory } from "../../lib/history";
import { useHoldThenClose, useIsolation } from "../../lib/isolation";
import { CLOCK_OPTIONS, useEventPreferences } from "../../lib/preferences";
import type { PresenceEntry, RealtimeSession } from "../../lib/realtime";
import { useResponseSession, type RealtimeWriter } from "../../lib/response-session";
import { useViewport } from "../../lib/viewport";

export type { RealtimeWriter };

const props = withDefaults(
  defineProps<{
    event: EventDoc;
    /**
     * Who else holds a write session on this event right now. Comes off the
     * realtime channel, which the page above owns, and is empty whenever there
     * is no live connection — so the list simply has no dots in it, which is
     * what it looked like before presence existed.
     */
    present?: PresenceEntry[];
    /**
     * The page's write session, when there is one open. Saves go over it; with
     * no session, or one that is down, they go over the REST PUT exactly as
     * they always did.
     */
    writer?: RealtimeWriter | null;
  }>(),
  { present: () => [], writer: null },
);

const emit = defineEmits<{
  refresh: [];
  /** Who this visitor is answering as, or null once they are nobody. */
  identity: [session: RealtimeSession | null];
  /**
   * Ask for the write session again for the identity already adopted. Entering
   * "My availability" after a refused claim is the case: the page above owns
   * the socket and is the only thing that can try.
   */
  claim: [];
  /**
   * The owner asked to edit this event. The form dialog belongs to the page
   * above — it is the page's own copy of the document that a save replaces —
   * so the button that opens it says so upwards rather than owning it.
   */
  edit: [];
}>();

// --- how this visitor reads a chart ---------------------------------------

const {
  autoTimezone,
  timezone,
  hour12,
  showBestTimes,
  timezones,
  clock,
  resetTimezone,
} = useEventPreferences();

// --- phone or desktop -----------------------------------------------------

const { compact, perView } = useViewport();

const peopleOpen = ref(false);
const settingsOpen = ref(false);

// Widening past the phone layout takes the drawers with it: what they hold is
// on the page again, and a sheet left open over it would be a second copy.
watch(compact, (on) => {
  if (on) return;
  // Including a dismissal that was mid-flight: the drawer it was going to close
  // is already gone, and the list is back on the page beside the chart.
  holdThenClose.cancel();
  peopleOpen.value = false;
  settingsOpen.value = false;
});

// --- what the chart is pointing at ----------------------------------------

const hoveredSlot = ref<number | null>(null);
const pinnedSlot = ref<number | null>(null);
const highlight = ref<string | null>(null);

/**
 * Drops whatever the chart was pointing at.
 *
 * Every change of who you are does this: a pinned slot is a question about the
 * group's answer at one time, and the answer it was asked about has just been
 * replaced. The session below calls it rather than reaching into the chart's
 * own state, which is not its to know about.
 */
function resetFocus() {
  pinnedSlot.value = null;
  highlight.value = null;
}

// --- who you are, and what you marked -------------------------------------

const session = useResponseSession({
  event: computed(() => props.event),
  writer: computed(() => props.writer),
  onRefresh: () => emit("refresh"),
  onClaim: () => emit("claim"),
  onIdentity: (identity) => emit("identity", identity),
  resetFocus,
});

const {
  availability,
  ifNeeded,
  guestKey,
  guestName,
  editing,
  identityOpen,
  clearOpen,
  deletingKey,
  deleteError,
  hasMarks,
  syncStatus,
  syncError,
  existingPeople,
  confirmIdentity,
  browseOnly,
  clearMine,
  removeRespondent,
  startEditing,
  stopEditing,
  changeName,
} = session;

// The two things only the page above can tell this component to do: it owns the
// socket, so it is the only thing that knows a session was taken away.
defineExpose({ leaveEditing: session.leaveEditing, resumeEditing: session.startEditing });

// --- taking it back -------------------------------------------------------

const chart = ref<InstanceType<typeof AvailabilityGrid> | null>(null);

/**
 * Undo and redo for the answer being written, and nothing else on the page.
 *
 * It is handed the same two functions the chart's own emits land in, so a
 * keystroke and a drag are indistinguishable by the time anything is moved —
 * same marks, same debounce, same save. What it is *not* handed is any way to
 * write directly: `lib/history.ts` only ever hands back operations, and this is
 * the one place that decides what running them means.
 *
 * The session it is tied to is "who is editing", so it empties itself on every
 * way out of the edit view there is: the switch, browsing, a different name, and
 * the page closing with it.
 */
const history = useUndoHistory({
  session: computed(() => (editing.value ? guestKey.value : null)),
  apply: (operations) => {
    for (const operation of operations) {
      if (operation.emit === "paint") {
        session.onPaint({ type: operation.type, slots: operation.slots });
      } else {
        session.onFlip({ type: operation.type, slots: operation.slots });
      }
    }
  },
  read: (slots) => snapshotSlots(slots, availability, ifNeeded),
  beforeApply: () => chart.value?.clearSelection(),
});

/**
 * Wiping the whole answer, recorded as the one action it is.
 *
 * The record has to be taken before the wipe and filed after it, and `clearMine`
 * empties both sets synchronously — everything it awaits afterwards is about the
 * save, not the marks — so the pair either side of the call is the pair the
 * stack wants. It gets an id of its own because it is not a chart gesture and
 * must never be folded into whatever selection was last on screen.
 */
function clearEverything() {
  const slots = [...availability, ...ifNeeded];
  const before = snapshotSlots(slots, availability, ifNeeded);
  const wiped = clearMine();
  if (slots.length > 0) history.record({ id: history.nextId(), before });
  return wiped;
}

// --- the chart's model ----------------------------------------------------

const referenceDate = computed(() => getTimezoneReferenceDateForEvent(props.event));
const timezoneOffset = computed(() =>
  getScheduleTimezoneOffset(props.event, timezone.value),
);

const model = computed(() =>
  buildGrid(props.event, { timezoneOffset: timezoneOffset.value, hour12: hour12.value }),
);

const responseIndex = computed(() =>
  buildResponseIndex(props.event, session.override.value),
);
const maxCount = computed(() => maxRespondents(model.value, responseIndex.value));

const activeSlot = computed(() => pinnedSlot.value ?? hoveredSlot.value);

const availableNames = computed(() => {
  if (activeSlot.value === null) return null;
  return responseIndex.value.available.get(activeSlot.value) ?? new Set<string>();
});

const ifNeededNames = computed(() => {
  if (activeSlot.value === null) return new Set<string>();
  return responseIndex.value.ifNeeded.get(activeSlot.value) ?? new Set<string>();
});

const slotLabel = computed(() => {
  if (activeSlot.value === null) return null;
  return formatSlotRange(
    activeSlot.value,
    model.value.slotMinutes,
    timezoneOffset.value,
    hour12.value,
    {
      withDate: model.value.showDates,
      dowDates: props.event.type === "dow" ? props.event.dates : undefined,
      startOnMonday: props.event.startOnMonday,
    },
  );
});

function onHover(slot: number | null) {
  if (pinnedSlot.value !== null) return;
  hoveredSlot.value = slot;
}

/**
 * A tap or click on a cell pins the slot it landed on, and pins it off again
 * when it is the one already pinned.
 *
 * Null is the grid asking for the pin to be dropped outright, which is what
 * dismissing the phone's slot card does: the card and the pin go up together on
 * a tap, so they come down together too. The hover goes with it — on touch there
 * is no pointer left over the chart to justify an outline.
 */
function onPin(slot: number | null) {
  if (slot === null) {
    pinnedSlot.value = null;
    hoveredSlot.value = null;
    return;
  }
  pinnedSlot.value = pinnedSlot.value === slot ? null : slot;
  hoveredSlot.value = slot;
}

// --- the two views --------------------------------------------------------

/**
 * The view switch is a segmented control over the same two entry points. On a
 * phone the two labels have to share a row with the drawer handles, so they
 * shorten to the word that distinguishes them rather than being ellipsised or
 * pushing anything off the screen.
 */
const viewOptions = computed(() => {
  const mine = guestName.value
    ? compact.value
      ? "Mine"
      : "My availability"
    : compact.value
      ? "Add yours"
      : "Add your availability";
  return [
    { value: "group", label: compact.value ? "Group" : "Group availability" },
    { value: "mine", label: mine },
  ];
});

const viewMode = computed<string>({
  get: () => (editing.value ? "mine" : "group"),
  set: (value) => {
    if (value === "mine") startEditing();
    else stopEditing();
  },
});

// --- the drawers ----------------------------------------------------------

/**
 * Closes the respondents drawer.
 *
 * It used to take the isolated view down with it, back when the two were one
 * thing. They are not: closing the drawer is now how you *look* at what an eye
 * asked for (`lib/isolation.ts`) — and on a phone the drawer does that itself,
 * a beat after the eye is pressed, rather than waiting to be asked.
 */
function closePeople() {
  // Whatever brought us here — a tap on the backdrop, the sheet's own timer, or
  // widening past the phone layout — there is no drawer left to close.
  holdThenClose.cancel();
  peopleOpen.value = false;
  // The rows the pointer was over have just gone; nothing is left to hover.
  highlight.value = null;
}

/**
 * The half-second between an eye being pressed inside the drawer and the drawer
 * getting out of the way of what it changed. See `lib/isolation.ts`.
 */
const holdThenClose = useHoldThenClose(closePeople);

/** The respondents list's add row: the same dialog, from a third entry point.
 *  The people drawer closes first — both teleport to <body>, and the dialog's
 *  anchor was appended before the drawer's, so left open the drawer would sit
 *  on top of the prompt it just asked for. */
function addRespondent() {
  closePeople();
  identityOpen.value = true;
}

// --- showing one person ---------------------------------------------------

const {
  key: isolated,
  show: showOnly,
  clear: showEveryone,
} = useIsolation({ editing, leaveEditing: stopEditing });

/**
 * The spelling the row used when it asked, kept as a fallback.
 *
 * The live label is preferred — a rename between then and now should show —
 * but somebody who is only present has no stored label at all, and a response
 * deleted while it is being looked at loses the one it had. Neither is a
 * reason for the pill to start printing a bare user key.
 */
const askedFor = ref("");

/** The name to print on the pill, and in the overlay for a name with no answer. */
const isolatedLabel = computed(() =>
  isolated.value === null
    ? ""
    : responseIndex.value.labels.get(isolated.value) ||
      props.present.find((person) => person.key === isolated.value)?.displayName ||
      askedFor.value ||
      isolated.value,
);

/**
 * Isolating somebody who has not answered leaves an empty chart, which on its
 * own looks like a chart that failed to load. It is a real question with a real
 * answer — they are here, they have marked nothing yet — so the chart says so.
 */
const isolatedEmpty = computed(
  () => isolated.value !== null && !responseIndex.value.labels.has(isolated.value),
);

/**
 * A row's eye. Null is the "show everyone" an eye already on sends.
 *
 * On a desktop the list is beside the chart, so the change is visible where it
 * was asked for and nothing else has to happen. Inside the phone's drawer the
 * list is *over* the chart it just filtered, so the sheet gives the eye half a
 * second to be seen moving and then takes itself down — refusing every
 * dismissal in between, so a stray backdrop tap cannot race it.
 */
function onSolo(person: { key: string; displayName: string } | null) {
  if (person === null) {
    showEveryone();
  } else {
    askedFor.value = person.displayName;
    showOnly(person.key);
  }
  if (compact.value && peopleOpen.value) holdThenClose.begin();
}
</script>

<template>
  <section class="scheduler" :class="{ compact }">
    <div class="bar">
      <!-- Each side carries the glyph for who it is about: the group of people
           whose answers you are reading, and the single person whose answer you
           are writing. The same two figures the respondents list and the
           identity card already use, so the switch names its halves in the
           page's own vocabulary rather than in a new one. The words stay: the
           icon is a second reading of the label, not a replacement for it. -->
      <Segmented
        class="switch"
        v-model="viewMode"
        label="View"
        variant="solid"
        equal
        :options="viewOptions"
      >
        <template #option="{ option }">
          <IconPeople
            v-if="option.value === 'group'"
            class="switch__icon"
            aria-hidden="true"
          />
          <IconPerson
            v-else
            class="switch__icon"
            stroke-width="2"
            stroke-linejoin="round"
            aria-hidden="true"
          />
          <span class="switch__label">{{ option.label }}</span>
        </template>
      </Segmented>

      <!-- The phone's whole secondary chrome: two handles, two drawers. What
           they open is what the desktop shows beside and under the chart. -->
      <div v-if="compact" class="handles">
        <button
          type="button"
          class="handle"
          aria-label="View settings"
          title="View settings"
          @click="settingsOpen = true"
        >
          <IconGear aria-hidden="true" />
        </button>

        <button
          type="button"
          class="handle"
          :aria-label="`Respondents, ${responseIndex.keys.length} answered`"
          title="Respondents"
          @click="peopleOpen = true"
        >
          <IconPeople stroke-width="1.8" aria-hidden="true" />
          <span class="handle__count">{{ responseIndex.keys.length }}</span>
        </button>
      </div>
    </div>

    <div class="layout">
      <!-- A row's eye and a row's hover ask the chart for the same thing — one
           person's answer instead of the sum of everybody's — so they arrive by
           the same prop. The eye is the deliberate one, and wins. -->
      <AvailabilityGrid
        ref="chart"
        class="chart"
        :event="event"
        :model="model"
        :per-view="perView"
        :editable="editing"
        :availability="availability"
        :if-needed="ifNeeded"
        :response-index="responseIndex"
        :max-count="maxCount"
        :total-respondents="responseIndex.keys.length"
        :show-best-times="showBestTimes"
        :highlight-respondent="editing ? null : isolated ?? highlight"
        :active-slot="activeSlot"
        :hour12="hour12"
        @paint="session.onPaint"
        @flip="session.onFlip"
        @commit="history.record"
        @undo="history.undo"
        @hover="onHover"
        @pin="onPin"
      >
        <!-- The foot of the chart, in the chart's own box, and everything in
             it is about how the chart is read. It starts where the columns do
             with the clock the hours are printed on, then the best-times
             filter, then what the colours mean — and at the far end, the last
             column's edge, the one control that acts on the chart rather than
             describing it: the thing that wipes your own answer.

             On a phone none of it survives. The foot is a row of a fixed pane
             rather than something the page scrolls past, so every pixel it
             spends comes off the grid — the three ways of reading the chart go
             into the settings drawer behind the gear, and clearing your answer
             goes the other way, onto the identity bar beside the name it wipes.
             That leaves nothing, so there is no foot at all rather than an
             empty row holding a line of space open. -->
        <template v-if="!compact" #foot>
          <div class="chart-foot">
            <!-- Which clock the gutter is printed on, at the gutter's own
                 edge: the control sits where what it changes begins. -->
            <Segmented
              v-model="clock"
              class="chart-foot__clock"
              label="Clock format"
              :options="CLOCK_OPTIONS"
              size="sm"
            />

            <!-- Beside the clock rather than at the far end, where it used to
                 sit in the slot that belongs to the mode's own action. It is
                 not an action: it is a way of reading the chart, like the clock
                 it now stands next to and the legend that follows them. -->
            <label v-if="!editing" class="best">
              <input v-model="showBestTimes" type="checkbox" />
              Show best times
            </label>

            <ColorLegend
              class="chart-foot__legend"
              :mode="editing ? 'edit' : 'group'"
              :max="maxCount"
              :total="responseIndex.keys.length"
            />

            <!-- The one control on the page that destroys something, so it
                 says what it destroys rather than leaving a bin glyph to be
                 guessed at. On a phone it is not here at all — it rides the
                 identity bar, next to the name whose answer it wipes. -->
            <Button
              v-if="editing && guestName && hasMarks"
              class="clear chart-foot__end"
              :class="{ 'clear--armed': clearOpen }"
              variant="ghost"
              size="sm"
              @click="clearOpen = true"
            >
              <IconTrash aria-hidden="true" />
              Clear my response
            </Button>
          </div>
        </template>
      </AvailabilityGrid>

      <!-- Beside the chart on a desktop; the bottom edge of the screen on a
           phone, where the respondents have moved into a drawer and only the
           identity is left. -->
      <div class="side">
        <!-- Above everything the event is about, because it is not about the
             event: it is about who is looking at it. A guest renders none of
             it (`isAdmin` fails closed) and gets the quiet way in at the
             bottom of the column instead. -->
        <AdminTools
          v-if="isAdmin && !compact"
          :event-id="event.id"
          @edit="emit('edit')"
        />

        <!-- Ahead of the name, because it is ahead of it in what it decides:
             every hour in the chart, every time in the list below, and the
             answer being written under that name are all read against this
             zone. It sits level with the chart's own headings for the same
             reason — it is a heading for the times, not a footnote to them. -->
        <TimezoneField
          v-if="!compact"
          v-model="timezone"
          :timezones="timezones"
          :reference-date="referenceDate"
          :auto-timezone="autoTimezone"
          @reset="resetTimezone"
        />

        <IdentityCard
          :name="guestName"
          :status="syncStatus"
          :error="syncError"
          :can-clear="compact && editing && hasMarks"
          :clearing="clearOpen"
          @change="changeName"
          @pick="startEditing"
          @retry="session.retry()"
          @clear="clearOpen = true"
        />

        <RespondentsPanel
          v-if="!compact"
          class="panel-area"
          :keys="responseIndex.keys"
          :labels="responseIndex.labels"
          :present="present"
          :available-names="availableNames"
          :if-needed-names="ifNeededNames"
          :slot-label="slotLabel"
          :pinned="pinnedSlot !== null"
          :highlight="editing || isolated ? null : highlight"
          :solo="isolated"
          :current-key="guestKey"
          :deleting="deletingKey"
          :delete-error="deleteError"
          @highlight="highlight = $event"
          @unpin="pinnedSlot = null"
          @delete="removeRespondent"
          @add="addRespondent"
          @switch="confirmIdentity"
          @solo="onSolo"
        />

        <!-- Last, and quiet. The column is about the event; this is the one
             thing on it that is about leaving the event, and only the person
             who already knows it is here needs to find it. -->
        <AdminLoginLink v-if="!isAdmin && !compact" />
      </div>
    </div>

    <!-- What the group view is currently doing to itself — showing one
         person, showing only the fullest slots, or both — and the way out of
         each. See `ModePills` for why they stack rather than merge. -->
    <ModePills
      :isolated="isolated ? isolatedLabel : null"
      :best-times="showBestTimes && !editing"
      @exit-isolation="showEveryone"
      @exit-best-times="showBestTimes = false"
    />

    <!-- An empty chart with no explanation reads as one that failed to load.
         Fixed too, and inert: it is a caption for the whole view, so it does
         not travel with the columns under a scroll and does not take the taps
         that scroll them. -->
    <div v-if="isolatedEmpty" class="nothing" role="status">
      <p class="nothing__card">
        <strong class="nothing__name" :title="isolatedLabel">{{ isolatedLabel }}</strong>
        has not marked any times yet.
      </p>
    </div>

    <!-- An eye in here changes what is *behind* the sheet, so the sheet holds
         still long enough for the toggle to be seen moving and then gets out of
         the way of its own accord. `locked` is that half second: every way out
         is refused while a dismissal is already on its way. -->
    <Dialog
      v-if="compact"
      variant="sheet"
      :open="peopleOpen"
      :locked="holdThenClose.holding.value"
      title="Respondents"
      @close="closePeople"
    >
      <RespondentsPanel
        embedded
        :keys="responseIndex.keys"
        :labels="responseIndex.labels"
        :present="present"
        :available-names="availableNames"
        :if-needed-names="ifNeededNames"
        :slot-label="slotLabel"
        :pinned="pinnedSlot !== null"
        :highlight="editing || isolated ? null : highlight"
        :solo="isolated"
        :current-key="guestKey"
        :deleting="deletingKey"
        :delete-error="deleteError"
        @highlight="highlight = $event"
        @unpin="pinnedSlot = null"
        @delete="removeRespondent"
        @add="addRespondent"
        @switch="confirmIdentity"
        @solo="onSolo"
      />
    </Dialog>

    <!-- The one thing the phone does not merely reflow: what the desktop keeps
         in a column goes behind a gear here, because a fixed pane spends grid
         on every row of chrome. The owner's tools are not among them — they
         act on the event rather than describing it, and have a sheet of their
         own off the navbar (`AdminDrawer`, owned by the page above). -->
    <EventSettingsDrawer
      v-if="compact"
      v-model:timezone="timezone"
      v-model:clock="clock"
      v-model:best-times="showBestTimes"
      :open="settingsOpen"
      :timezones="timezones"
      :reference-date="referenceDate"
      :auto-timezone="autoTimezone"
      :mode="editing ? 'edit' : 'group'"
      :max="maxCount"
      :total="responseIndex.keys.length"
      :can-undo="history.canUndo.value"
      :can-redo="history.canRedo.value"
      @close="settingsOpen = false"
      @reset-timezone="resetTimezone"
      @undo="history.undo"
      @redo="history.redo"
    />

    <GuestIdentityDialog
      :open="identityOpen"
      :existing-people="existingPeople"
      @confirm="confirmIdentity"
      @browse="browseOnly"
      @close="identityOpen = false"
    />

    <Dialog
      :open="clearOpen"
      title="Remove all your marked times?"
      @close="clearOpen = false"
    >
      <div class="confirm">
        <p class="confirm__text">
          This wipes everything <strong>{{ guestName }}</strong> marked on this
          event and takes you off the respondents list. You can always fill it in
          again.
        </p>
        <div class="confirm__actions">
          <Button variant="ghost" @click="clearOpen = false">Cancel</Button>
          <Button variant="danger" @click="clearEverything">Clear my times</Button>
        </div>
      </div>
    </Dialog>
  </section>
</template>

<style scoped>
.scheduler {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

/* The view switch is the page's main control, so it sits centred rather than
   pinned to one edge, and nothing shares its row that could push it off the
   page's centre line. The generous space under it is what makes it read as the
   thing that governs everything below rather than as the first item of it. */
.bar {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.5rem;
  margin: 0.75rem 0 1.75rem;
}

@media (max-width: 640px) {
  .bar {
    margin: 0.35rem 0 1.25rem;
  }
}

/* The glyph keeps its size while the label may give ground: on the narrowest
   screen the words shorten (`viewOptions`) rather than the icon shrinking, so
   the two halves stay recognisable at a glance at any width. */
.switch__icon {
  flex: none;
  width: 1rem;
  height: 1rem;
}

.switch__label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* Wiping your own answer is destructive, so it turns red under the pointer and
   stays red while its confirm dialog is open. */
.clear:hover:not(:disabled),
.clear--armed {
  color: var(--color-danger);
  background: var(--color-danger-soft);
}

.clear svg {
  width: 0.95rem;
  height: 0.95rem;
  flex: none;
}

/* Everything about *reading* the chart leads at the columns' own left edge —
   the clock, the best-times filter, then the legend — and the one thing that
   acts on the chart keeps the far end, the last column's edge, however narrow
   the screen gets. Too narrow for all of it and the row wraps rather than
   dropping the words off the button. */
.chart-foot {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.35rem 0.5rem;
}

.chart-foot__clock {
  flex: none;
}

.chart-foot__legend {
  min-width: 0;
}

.chart-foot__end {
  flex: none;
  margin-left: auto;
}

/* The filter that reads the group's answer. A checkbox rather than a button
   because it is a state of the chart, not an action on it — which is also why
   it stands beside the clock rather than at the end of the row where the
   actions are. */
.best {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  min-height: 2.25rem;
  font-size: 0.8125rem;
  color: var(--color-text-muted);
  white-space: nowrap;
  cursor: pointer;
}

.best input {
  width: 1rem;
  height: 1rem;
  accent-color: var(--color-accent);
}

@media (pointer: coarse) {
  .best {
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

.layout {
  display: flex;
  align-items: flex-start;
  gap: 1rem;
}

.chart {
  flex: 1 1 auto;
  min-width: 0;
}

/* --- one person's answer, alone ------------------------------------------- */

/* Centred on the viewport and inert. Under the pill, so the way out of the
   view this is explaining is never behind the explanation; under the drawers
   too, which are at 50. */
.nothing {
  position: fixed;
  inset: 0;
  z-index: 15;
  display: grid;
  place-items: center;
  padding: 1rem;
  pointer-events: none;
}

.nothing__card {
  max-width: 18rem;
  padding: 0.7rem 0.9rem;
  font-size: 0.875rem;
  line-height: 1.45;
  text-align: center;
  color: var(--color-text-muted);
  background: var(--color-raised);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-md);
}

.nothing__name {
  display: block;
  overflow: hidden;
  font-weight: 600;
  white-space: nowrap;
  text-overflow: ellipsis;
  color: var(--color-text);
}

/* Who you are, then who else answered — the column beside the grid, in the
   order you ask the questions. */
.side {
  display: flex;
  flex: 0 0 14rem;
  flex-direction: column;
  gap: 0.6rem;
}

/* --- the phone layout ---------------------------------------------------- */
/*
   The chart stops being a very tall thing the page scrolls past and becomes a
   viewport-locked pane: the page itself no longer scrolls (EventPage), this
   fills what is left under the header bar, and the chart scrolls inside it on
   both axes. That is what a finger swiping to *select* needs — with the page
   scrolling underneath, every drag was a negotiation.

   What the desktop shows beside and below the chart has nowhere to go in a
   layout with no spare room, so it goes into drawers: the respondents, and the
   settings-plus-legend. The view switch and the identity bar are what stay,
   because they are what you have to be able to see without asking.
*/
@media (max-width: 820px) {
  /* No clipping of its own: the identity bar bleeds past this box to both
     screen edges, and the page is already what stops anything scrolling. */
  .scheduler.compact {
    flex: 1 1 auto;
    gap: 0.5rem;
    min-height: 0;
  }

  .compact .bar {
    flex-direction: row;
    align-items: center;
    gap: 0.35rem;
    margin: 0;
  }

  .compact .switch {
    flex: 1 1 auto;
    min-width: 0;
  }

  .handles {
    display: flex;
    flex: none;
    align-items: center;
  }

  /* Icon-sized targets at the tap floor, the way the header's own controls
     are — these are the same kind of thing, one row down. */
  .handle {
    position: relative;
    display: inline-grid;
    place-items: center;
    width: var(--tap-min);
    height: var(--tap-min);
    padding: 0;
    color: var(--color-text-muted);
    background: none;
    border: none;
    border-radius: var(--radius-md);
    cursor: pointer;
  }

  .handle:hover {
    color: var(--color-text);
    background: var(--color-subtle);
  }

  .handle:focus-visible {
    outline: var(--focus-ring);
    outline-offset: calc(var(--focus-ring-offset) * -1);
  }

  .handle svg {
    width: 1.2rem;
    height: 1.2rem;
  }

  /* How many people are behind the handle, so the drawer does not have to be
     opened to find out whether anyone has answered. */
  .handle__count {
    position: absolute;
    top: 0.35rem;
    right: 0.3rem;
    min-width: 1rem;
    padding: 0 0.2rem;
    font-size: 0.6875rem;
    font-weight: 600;
    line-height: 1rem;
    text-align: center;
    color: var(--color-accent-contrast);
    background: var(--color-accent);
    border-radius: var(--radius-pill);
  }

  .compact .layout {
    flex: 1 1 auto;
    flex-direction: column;
    gap: 0.5rem;
    min-height: 0;
  }

  /* The chart takes everything that is left and scrolls inside it. */
  .compact .chart {
    flex: 1 1 auto;
    width: 100%;
    min-height: 0;
  }

  .compact .side {
    flex: none;
    width: 100%;
  }

}

/* Held sideways there are about 360 pixels of height and the switch, the foot
   and the identity row are all at their tap floor already — so what is left to
   give is the space between them. */
@media (max-height: 480px) and (max-width: 820px) {
  .scheduler.compact,
  .compact .layout {
    gap: 0.25rem;
  }
}
</style>
