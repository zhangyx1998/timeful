<script setup lang="ts">
/**
 * The interactive half of the event page: identity, grid state and autosave.
 *
 * Mounted client-side only, so it can read localStorage and the browser's
 * timezone without risking an SSR hydration mismatch.
 */
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import AvailabilityGrid from "./AvailabilityGrid.vue";
import ColorLegend from "./ColorLegend.vue";
import GuestIdentityDialog from "./GuestIdentityDialog.vue";
import IdentityCard from "./IdentityCard.vue";
import RespondentsPanel from "./RespondentsPanel.vue";
import TimezoneField from "./TimezoneField.vue";
import Button from "../ui/Button.vue";
import Dialog from "../ui/Dialog.vue";
import Segmented from "../ui/Segmented.vue";
import IconPeople from "../../assets/icons/people.svg";
import IconPerson from "../../assets/icons/person.svg";
import IconGear from "../../assets/icons/gear.svg";
import IconTrash from "../../assets/icons/trash.svg";
import { api, apiError } from "../../lib/api";
import {
  formatSlotRange,
  getLocalTimezone,
  getScheduleTimezoneOffset,
  getTimezoneReferenceDateForEvent,
  listTimezones,
  prefers12Hour,
} from "../../lib/dates";
import { buildGrid, buildResponseIndex, maxRespondents } from "../../lib/grid";
import { toAvailabilitySets, toIsoArray, type AvailabilityType, type EventDoc } from "../../lib/event";
import { createSyncEngine, type SyncBaseline } from "../../lib/sync";

const props = withDefaults(
  defineProps<{
    event: EventDoc;
    /**
     * Who else is on this page right now, by the name each of them adopted.
     * Comes off the realtime channel, which the page above owns, and is empty
     * whenever there is no live connection — so the list simply has no dots in
     * it, which is what it looked like before presence existed.
     */
    present?: string[];
  }>(),
  { present: () => [] },
);

const emit = defineEmits<{
  refresh: [];
  /** The name this visitor is answering as, or null once they are nobody. */
  identity: [name: string | null];
}>();

const STORAGE = {
  timezone: "timeful.timezone",
  guestName: "timeful.guestName",
  hour12: "timeful.hour12",
  bestTimes: "timeful.bestTimes",
};

function readStorage(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Private browsing: preferences simply do not persist.
  }
}

function clearStorage(key: string) {
  try {
    window.localStorage.removeItem(key);
  } catch {
    // Private browsing: there was nothing stored to remove.
  }
}

// --- preferences ----------------------------------------------------------

const storedHour12 = readStorage(STORAGE.hour12);

/**
 * The zone the browser reports, read once. Everything about the timezone
 * control is relative to it: it is the value the page falls back to, the option
 * marked "(auto)", and the thing "overridden" is measured against.
 */
const autoTimezone = getLocalTimezone();

const timezone = ref(readStorage(STORAGE.timezone) || autoTimezone);
const hour12 = ref(storedHour12 === null ? prefers12Hour() : storedHour12 === "true");
const showBestTimes = ref(readStorage(STORAGE.bestTimes) === "true");

/**
 * Only an override is worth remembering. Landing back on the browser's own zone
 * — by the reset button, or by picking it out of the list — is not a preference
 * to carry to the next visit, it is the absence of one, so the stored value is
 * dropped rather than rewritten. That is also what makes the reset honest: a
 * reload afterwards derives the zone again instead of replaying a decision.
 */
watch(timezone, (value) => {
  if (value === autoTimezone) clearStorage(STORAGE.timezone);
  else writeStorage(STORAGE.timezone, value);
});

/** Gives the zone back to the browser; the grid re-renders off the same ref. */
function resetTimezone() {
  clearStorage(STORAGE.timezone);
  timezone.value = autoTimezone;
}
watch(hour12, (value) => writeStorage(STORAGE.hour12, String(value)));
watch(showBestTimes, (value) => writeStorage(STORAGE.bestTimes, String(value)));

const CLOCK_OPTIONS = [
  { value: "12", label: "12h" },
  { value: "24", label: "24h" },
];

/** Segmented options are strings; the model behind this one is a boolean. */
const clock = computed<string>({
  get: () => (hour12.value ? "12" : "24"),
  set: (value) => {
    hour12.value = value === "12";
  },
});

const timezones = computed(() => {
  const zones = listTimezones();
  return zones.includes(timezone.value) ? zones : [timezone.value, ...zones];
});

// --- grid state -----------------------------------------------------------

const availability = reactive(new Set<number>());
const ifNeeded = reactive(new Set<number>());
const guestName = ref<string | null>(null);
const editing = ref(false);
const identityOpen = ref(false);
/** Day columns a viewport of the chart holds; the rest is scrolled to. */
const perView = ref(7);
/** The phone layout: a viewport-locked chart with its controls in drawers. */
const compact = ref(false);
const peopleOpen = ref(false);
const settingsOpen = ref(false);
const hoveredSlot = ref<number | null>(null);
const pinnedSlot = ref<number | null>(null);
const highlight = ref<string | null>(null);
/**
 * Whose answer the chart is showing on its own, asked for from a row of the
 * phone's respondents drawer.
 *
 * It lives as long as the drawer does and no longer. The drawer is a bottom
 * sheet over the chart it changes, so "showing only Ada" is a thing you set up
 * and then look at — and the looking is the drawer's whole purpose being over.
 * Anything that closes the drawer therefore puts the group's heatmap back,
 * which also means there is no state left behind for a later visit to the page
 * to be confused by.
 */
const soloName = ref<string | null>(null);
/** Set when the guest paints; blocks a background refresh from clobbering edits. */
const dirtySinceConfirm = ref(false);
let awaitingIdentityRefresh: string | null = null;

const referenceDate = computed(() => getTimezoneReferenceDateForEvent(props.event));
const timezoneOffset = computed(() =>
  getScheduleTimezoneOffset(props.event, timezone.value),
);

const model = computed(() =>
  buildGrid(props.event, { timezoneOffset: timezoneOffset.value, hour12: hour12.value }),
);

const override = computed(() =>
  guestName.value ? { name: guestName.value, availability, ifNeeded } : null,
);

const responseIndex = computed(() => buildResponseIndex(props.event, override.value));
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

const existingNames = computed(() => Object.keys(props.event.responses ?? {}).sort());

/**
 * Announces the identity upwards so the realtime connection can carry it.
 *
 * A watcher rather than a call in each of the three places a name is taken up
 * or given up: it fires after the synchronous work of the switch — including
 * `engine.flush()`, which has to reach the server as the person being stepped
 * out of — so reconnecting cannot get ahead of the autosave it follows.
 */
watch(guestName, (name) => emit("identity", name));

// --- autosave -------------------------------------------------------------

/**
 * Whose answer the queued payload is. Not `guestName`: switching person while
 * an edit is still queued must not post that edit under the name being switched
 * *to*. It is set where the payload is built and left alone thereafter, so a
 * flush during the switch still lands under the person who made the edit.
 */
let savingAs: string | null = null;

const engine = createSyncEngine({
  save: async (payload) => {
    const name = savingAs;
    if (!name) return;
    await api.put(
      `/events/${props.event.id}/responses/${encodeURIComponent(name)}`,
      payload,
    );
  },
});

const syncStatus = engine.status;
const syncError = engine.error;

function queueSave() {
  if (!guestName.value) return;
  savingAs = guestName.value;
  engine.schedule({
    availability: toIsoArray(availability),
    ifNeeded: toIsoArray(ifNeeded),
  });
}

/** Move a set of slots into one of the two marks, or out of both. */
function mark(slots: number[], as: AvailabilityType | null) {
  for (const slot of slots) {
    if (as === "available") {
      availability.add(slot);
      ifNeeded.delete(slot);
    } else if (as === "if_needed") {
      ifNeeded.add(slot);
      availability.delete(slot);
    } else {
      availability.delete(slot);
      ifNeeded.delete(slot);
    }
  }
  dirtySinceConfirm.value = true;
  queueSave();
}

/** Every drag paints an available time; the menu that follows may refine it. */
function onPaint(change: { type: "add" | "remove"; slots: number[] }) {
  mark(change.slots, change.type === "add" ? "available" : null);
}

function onFlip(change: { type: AvailabilityType; slots: number[] }) {
  mark(change.slots, change.type);
}

onBeforeUnmount(() => {
  engine.flush();
  engine.dispose();
});

// --- identity -------------------------------------------------------------

/**
 * Adopts a name's stored answer, and tells the autosave engine which of its two
 * resting states that leaves it in.
 *
 * The distinction is the whole point of the two quiet indicator states: a name
 * that came back with marks is already saved on the server ("Up to date"),
 * while a name nobody has answered under yet has nothing behind it at all ("No
 * selection"). The zero-record invariant (ARCHITECTURE.md § API) makes the two
 * the same question — a stored response always has at least one mark, so an
 * empty grid after loading means there is no response.
 */
function loadResponseFor(name: string) {
  const sets = toAvailabilitySets(props.event.responses?.[name]);
  availability.clear();
  for (const slot of sets.availability) availability.add(slot);
  ifNeeded.clear();
  for (const slot of sets.ifNeeded) ifNeeded.add(slot);
  const baseline: SyncBaseline =
    availability.size > 0 || ifNeeded.size > 0 ? "current" : "empty";
  engine.reset(baseline);
}

function confirmIdentity(name: string) {
  // Whatever the person being stepped out of had queued goes to the server
  // before the grid is re-seeded under someone else; `loadResponseFor` drops
  // the queue, and an unsaved edit is not this new person's to carry.
  engine.flush();
  guestName.value = name;
  writeStorage(STORAGE.guestName, name);
  identityOpen.value = false;
  dirtySinceConfirm.value = false;
  loadResponseFor(name);
  editing.value = true;
  pinnedSlot.value = null;
  highlight.value = null;
  // Pull the freshest copy: someone may have answered since this page loaded.
  awaitingIdentityRefresh = name;
  emit("refresh");
}

/**
 * "Just browsing": the visitor declined to be anyone, so the page must stop
 * treating them as someone. Dropping the name is what actually stops the
 * autosave — `queueSave` is a no-op without one — and the marks go with it,
 * since they belong to the name that was just given up. Anything already typed
 * under that name is flushed first rather than lost.
 *
 * The stored name goes too. It exists for one job — skipping the dialog for a
 * visitor who already said who they are — and someone who just declined to be
 * anyone has withdrawn exactly that. Leaving it behind meant the next refresh
 * silently put them back under the name they had stepped out of. The response
 * on the server is untouched; they can pick the name again and edit it.
 */
function browseOnly() {
  engine.flush();
  clearStorage(STORAGE.guestName);
  identityOpen.value = false;
  awaitingIdentityRefresh = null;
  guestName.value = null;
  availability.clear();
  ifNeeded.clear();
  engine.reset("empty");
  editing.value = false;
  dirtySinceConfirm.value = false;
  pinnedSlot.value = null;
}

// A refresh triggered by confirming identity re-seeds the grid, unless the
// guest has already started editing.
watch(
  () => props.event,
  () => {
    const name = awaitingIdentityRefresh;
    awaitingIdentityRefresh = null;
    if (!name || dirtySinceConfirm.value || engine.pending.value) return;
    loadResponseFor(name);
  },
);

// --- clearing your own answer --------------------------------------------

const clearOpen = ref(false);

/** Nothing to clear means no button: the confirm would have no work to do. */
const hasMarks = computed(() => availability.size > 0 || ifNeeded.size > 0);

/**
 * Wipes the guest's own answer. The empty state goes out through the normal
 * autosave path — the server turns an empty PUT into a delete (zero-record
 * invariant, ARCHITECTURE.md § API), so the guest leaves the respondents list
 * instead of staying on it with nothing marked. Flushed rather than debounced
 * so the indicator confirms the wipe straight away.
 */
async function clearMine() {
  clearOpen.value = false;
  if (!guestName.value) return;
  availability.clear();
  ifNeeded.clear();
  pinnedSlot.value = null;
  dirtySinceConfirm.value = true;
  queueSave();
  engine.flush();
  await engine.settled();
  // Drop the stale copy of the response the page is still holding, so coming
  // back through the switch-person button cannot reload what was just deleted.
  // Only once the save actually landed — after a failure the retry still needs
  // the old view, and the error has to stay on screen to be retried from.
  if (syncStatus.value !== "saved") return;
  emit("refresh");
  // "Saved" would be the wrong thing to leave behind: what the server holds is
  // now nothing at all, which is exactly the state a name with no answer is in.
  // The grid is empty, the name is off the respondents list, and the indicator
  // says so rather than claiming an answer is stored.
  engine.reset("empty");
}

// --- removing a response --------------------------------------------------

/**
 * Anyone holding the link may remove a response — the endpoint is public and
 * the URL is the trust boundary (ARCHITECTURE.md § API/§ Security). The panel
 * confirms first; this only runs the delete and reports what came back.
 */
const deletingName = ref<string | null>(null);
const deleteError = ref<string | null>(null);

async function removeRespondent(name: string) {
  if (deletingName.value) return;
  deletingName.value = name;
  deleteError.value = null;
  try {
    await api.del(
      `/events/${props.event.id}/responses/${encodeURIComponent(name)}`,
    );
    // Their own answer is held locally as well; drop it so the override cannot
    // put the row straight back.
    if (guestName.value === name) {
      availability.clear();
      ifNeeded.clear();
      engine.reset("empty");
    }
    emit("refresh");
  } catch (err) {
    deleteError.value = apiError(err, "Could not remove that response").message;
  } finally {
    deletingName.value = null;
  }
}

function startEditing() {
  if (guestName.value) {
    editing.value = true;
    pinnedSlot.value = null;
    return;
  }
  identityOpen.value = true;
}

function stopEditing() {
  engine.flush();
  editing.value = false;
}

function changeName() {
  identityOpen.value = true;
}

/** The respondents list's add row: the same dialog, from a third entry point.
 *  The people drawer closes first — both teleport to <body>, and the dialog's
 *  anchor was appended before the drawer's, so left open the drawer would sit
 *  on top of the prompt it just asked for. */
function addRespondent() {
  closePeople();
  identityOpen.value = true;
}

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

// --- responsive -----------------------------------------------------------
//
// One breakpoint decides two things: how many columns a viewport of the chart
// holds, and — at 820px, the same width the layout has always stacked at —
// whether the page is the desktop one or the phone one.

function updateLayout() {
  const width = window.innerWidth;
  perView.value = width < 520 ? 3 : width < 900 ? 5 : 7;
  compact.value = width <= 820;
  if (!compact.value) {
    peopleOpen.value = false;
    settingsOpen.value = false;
  }
}

onMounted(() => {
  updateLayout();
  window.addEventListener("resize", updateLayout);

  const stored = readStorage(STORAGE.guestName)?.trim();
  if (stored) {
    // A returning guest is not interrupted: their answer is loaded and the grid
    // opens ready to edit.
    guestName.value = stored;
    loadResponseFor(stored);
    editing.value = true;
  } else {
    identityOpen.value = true;
  }
});

onBeforeUnmount(() => window.removeEventListener("resize", updateLayout));

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
/**
 * Closes the respondents drawer, and with it any single-person view it was
 * holding. Every way out of the drawer goes through here — the close button, the
 * backdrop, Escape — so there is one place the rule lives rather than three.
 */
function closePeople() {
  peopleOpen.value = false;
  soloName.value = null;
  // The rows the pointer was over have just gone; nothing is left to hover.
  highlight.value = null;
}

/** The chart shows one person, or the group. Never both, and never nobody. */
function onSolo(name: string | null) {
  soloName.value = name;
}

// Writing your own answer is not a view of anybody else's, so stepping into it
// puts the group's chart back. Widening past the phone layout does the same:
// the drawer this lives in does not exist there.
watch([editing, compact], () => {
  if (editing.value || !compact.value) soloName.value = null;
});

function onPin(slot: number | null) {
  if (slot === null) {
    pinnedSlot.value = null;
    hoveredSlot.value = null;
    return;
  }
  pinnedSlot.value = pinnedSlot.value === slot ? null : slot;
  hoveredSlot.value = slot;
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
          :aria-label="`Respondents, ${responseIndex.names.length} answered`"
          title="Respondents"
          @click="peopleOpen = true"
        >
          <IconPeople stroke-width="1.8" aria-hidden="true" />
          <span class="handle__count">{{ responseIndex.names.length }}</span>
        </button>
      </div>
    </div>

    <div class="layout">
      <!-- A row's eye and a row's hover ask the chart for the same thing — one
           person's answer instead of the sum of everybody's — so they arrive by
           the same prop. The eye is the deliberate one, and wins. -->
      <AvailabilityGrid
        class="grid-area"
        :event="event"
        :model="model"
        :per-view="perView"
        :editable="editing"
        :availability="availability"
        :if-needed="ifNeeded"
        :response-index="responseIndex"
        :max-count="maxCount"
        :total-respondents="responseIndex.names.length"
        :show-best-times="showBestTimes"
        :highlight-respondent="editing ? null : soloName ?? highlight"
        :active-slot="activeSlot"
        :hour12="hour12"
        :compact="compact"
        @paint="onPaint"
        @flip="onFlip"
        @hover="onHover"
        @pin="onPin"
      >
        <!-- The foot of the chart, in the chart's own box, and everything in
             it is about how the chart is read. It starts where the columns do
             with the clock the hours are printed on, then what the colours
             mean, and at the far end — the last column's edge — the control
             that acts on the whole chart. There is one such control per mode
             and never two at once, so they share the end: reading the group's
             answer it is the best-times filter, and writing your own it is the
             thing that wipes it.

             On a phone the foot is a row of the fixed pane rather than
             something the page scrolls past, so every pixel it spends comes
             off the chart. The two controls stay, on one row that never wraps;
             the legend goes. It was the one thing in the row that only
             described the chart rather than changing it, and at a phone's cell
             size the chart says it well enough on its own. -->
        <template #foot>
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

            <ColorLegend
              v-if="!compact"
              class="chart-foot__legend"
              :mode="editing ? 'edit' : 'group'"
              :max="maxCount"
              :total="responseIndex.names.length"
            />

            <!-- The verb is what a phone's foot row gives up first: beside a
                 heatmap, "Best times" on a checkbox says the same thing in the
                 width the row can actually spare. -->
            <label v-if="!editing" class="best chart-foot__end">
              <input v-model="showBestTimes" type="checkbox" />
              {{ compact ? "Best times" : "Show best times" }}
            </label>

            <!-- The one control on the page that destroys something, so it
                 says what it destroys rather than leaving a bin glyph to be
                 guessed at — except on a phone, where the foot row cannot
                 spare the words and the confirm dialog still says them. -->
            <Button
              v-else-if="guestName && hasMarks"
              class="clear chart-foot__end"
              :class="{ 'clear--armed': clearOpen }"
              variant="ghost"
              size="sm"
              :aria-label="compact ? 'Clear my response' : undefined"
              :title="compact ? 'Clear my response' : undefined"
              @click="clearOpen = true"
            >
              <IconTrash aria-hidden="true" />
              <template v-if="!compact">Clear my response</template>
            </Button>
          </div>
        </template>
      </AvailabilityGrid>

      <!-- Beside the chart on a desktop; the bottom edge of the screen on a
           phone, where the respondents have moved into a drawer and only the
           identity is left. -->
      <div class="side">
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
          @change="changeName"
          @pick="startEditing"
          @retry="engine.retry()"
        />

        <RespondentsPanel
          v-if="!compact"
          class="panel-area"
          :names="responseIndex.names"
          :present="present"
          :available-names="availableNames"
          :if-needed-names="ifNeededNames"
          :slot-label="slotLabel"
          :pinned="pinnedSlot !== null"
          :highlight="editing ? null : highlight"
          :current-name="guestName"
          :deleting="deletingName"
          :delete-error="deleteError"
          @highlight="highlight = $event"
          @unpin="pinnedSlot = null"
          @delete="removeRespondent"
          @add="addRespondent"
          @switch="confirmIdentity"
        />
      </div>
    </div>

    <!-- Showing one person's answer alone, the drawer stops dimming the chart
         and shrinks to the two rows it needs: what it is doing is happening up
         there, and a veil over the thing you just asked to look at is the one
         thing the sheet must not be. -->
    <Dialog
      v-if="compact"
      variant="sheet"
      :open="peopleOpen"
      :dim="soloName === null"
      :title="soloName ? `Only ${soloName}’s times` : 'Respondents'"
      @close="closePeople"
    >
      <RespondentsPanel
        embedded
        :soloable="!editing"
        :names="responseIndex.names"
        :present="present"
        :available-names="availableNames"
        :if-needed-names="ifNeededNames"
        :slot-label="slotLabel"
        :pinned="pinnedSlot !== null"
        :highlight="editing ? null : highlight"
        :solo="soloName"
        :current-name="guestName"
        :deleting="deletingName"
        :delete-error="deleteError"
        @highlight="highlight = $event"
        @unpin="pinnedSlot = null"
        @delete="removeRespondent"
        @add="addRespondent"
        @switch="confirmIdentity"
        @solo="onSolo"
      />
    </Dialog>

    <Dialog
      v-if="compact"
      variant="sheet"
      :open="settingsOpen"
      title="View settings"
      @close="settingsOpen = false"
    >
      <!-- The phone has no column to put it at the head of, so it stays where
           the settings handle has always been: the gear is now exactly one
           setting, and it is the one that decides what every hour on the
           screen says. The respondents drawer is left to the people in it. -->
      <div class="sheet-stack">
        <TimezoneField
          v-model="timezone"
          :timezones="timezones"
          :reference-date="referenceDate"
          :auto-timezone="autoTimezone"
          @reset="resetTimezone"
        />
      </div>
    </Dialog>

    <GuestIdentityDialog
      :open="identityOpen"
      :existing-names="existingNames"
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
          <Button variant="danger" @click="clearMine">Clear my times</Button>
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

/* The clock leads at the columns' own left edge, the legend follows it, and the
   mode's own control keeps the far end — the last column's edge — however
   narrow the screen gets. Too narrow for all three and the row wraps rather
   than dropping the words off the button. */
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

/* The filter that reads the group's answer, in the slot the clear button holds
   while you are writing your own. A checkbox rather than a button because it is
   a state of the chart, not an action on it. */
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

.grid-area {
  flex: 1 1 auto;
  min-width: 0;
}

/* Who you are, then who else answered — the column beside the grid, in the
   order you ask the questions. */
.side {
  display: flex;
  flex: 0 0 14rem;
  flex-direction: column;
  gap: 0.6rem;
}

/* --- the drawers --------------------------------------------------------- */

.sheet-stack {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  padding-top: 0.35rem;
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
  .compact .grid-area {
    flex: 1 1 auto;
    width: 100%;
    min-height: 0;
  }

  .compact .side {
    flex: none;
    width: 100%;
  }

  /* The foot is now a row of the pane rather than something the page scrolls
     past, so it spends as little height as it can: two controls, one row, and
     nothing that could wrap it into two. What a finger has to hit keeps its
     floor — the shrinking is in the words, not in the targets. */
  .compact .chart-foot {
    flex-wrap: nowrap;
    gap: 0.4rem;
  }

  .compact .best {
    gap: 0.3rem;
    font-size: 0.75rem;
  }

  .compact .best input {
    width: 0.9rem;
    height: 0.9rem;
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
