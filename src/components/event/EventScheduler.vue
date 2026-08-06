<script setup lang="ts">
// Client-only mount: reads localStorage and the browser timezone, so SSR must not render it.
import { computed, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import AdminTools from "./AdminTools.vue";
import AvailabilityGrid from "./AvailabilityGrid.vue";
import ColorLegend from "./ColorLegend.vue";
import EventFooter from "./EventFooter.vue";
import EventSettingsDrawer from "./EventSettingsDrawer.vue";
import GuestIdentityDialog from "./GuestIdentityDialog.vue";
import GuestWelcomeDialog from "./GuestWelcomeDialog.vue";
import IdentityCard from "./IdentityCard.vue";
import ModePills from "./ModePills.vue";
import OfflineNotice from "./OfflineNotice.vue";
import RespondentsPanel from "./RespondentsPanel.vue";
import TimezoneField from "./TimezoneField.vue";
import Button from "../ui/Button.vue";
import ConfirmDialog from "../ui/ConfirmDialog.vue";
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
import { readEntryQuery, type EntryRoute } from "../../lib/entry-identity";
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
    present?: PresenceEntry[];
    writer?: RealtimeWriter | null;
    realtimeDown?: boolean;
  }>(),
  { present: () => [], writer: null, realtimeDown: false },
);

const emit = defineEmits<{
  refresh: [];
  identity: [session: RealtimeSession | null];
  claim: [];
  release: [];
  edit: [];
}>();

const {
  autoTimezone,
  timezone,
  hour12,
  showBestTimes,
  timezones,
  clock,
  resetTimezone,
} = useEventPreferences();

const { compact, perView } = useViewport();

const peopleOpen = ref(false);
const settingsOpen = ref(false);

watch(compact, (on) => {
  if (on) return;
  holdThenClose.cancel();
  peopleOpen.value = false;
  settingsOpen.value = false;
  // Isolation is phone-only; the desktop offers no exit pill, so clear it on widening.
  showEveryone();
});

const hoveredSlot = ref<number | null>(null);
const pinnedSlot = ref<number | null>(null);
const highlight = ref<string | null>(null);

function resetFocus() {
  pinnedSlot.value = null;
  highlight.value = null;
}

const session = useResponseSession({
  event: computed(() => props.event),
  writer: computed(() => props.writer),
  onRefresh: () => emit("refresh"),
  onClaim: () => emit("claim"),
  onRelease: () => emit("release"),
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
  welcome,
  clearOpen,
  deletingKey,
  deleteError,
  hasMarks,
  syncStatus,
  syncError,
  syncErrorDetail,
  existingPeople,
  confirmIdentity,
  browseOnly,
  confirmWelcome,
  declineWelcome,
  closeWelcome,
  closeIdentity,
  viewOnly,
  clearMine,
  removeRespondent,
  startEditing,
  stopEditing,
  changeName,
} = session;

defineExpose({ leaveEditing: session.leaveEditing, resumeEditing: session.startEditing });

// --- the URL as state (ARCHITECTURE.md § Routing / SSR) --------------------

const route = useRoute();
const router = useRouter();

const entryRoute = computed<EntryRoute>(() => {
  if (route.name === "event-view") return { kind: "view" };
  if (route.name === "event-edit")
    return { kind: "edit", key: String(route.params.userKey ?? "") };
  // Raw query string: an invite link's bare token would be garbled by vue-router's parsed `query`.
  const path = route.fullPath.split("#")[0] ?? "";
  const mark = path.indexOf("?");
  const greeting = readEntryQuery(mark >= 0 ? path.slice(mark + 1) : "");
  return { kind: "root", queryName: greeting.name, queryPrefix: greeting.prefix };
});

onMounted(() => session.applyEntry(entryRoute.value));
watch(entryRoute, (entry) => session.applyEntry(entry));

// Null while an identity prompt is up: the URL holds still until it is answered.
const desiredRoute = computed(() => {
  if (welcome.value !== null || identityOpen.value) return null;
  const slug = String(route.params.slug ?? "");
  if (!slug) return null;
  if (editing.value && guestKey.value)
    return {
      name: "event-edit" as const,
      params: { slug, userKey: guestKey.value },
    };
  return { name: "event-view" as const, params: { slug } };
});

function routeMatches(target: NonNullable<typeof desiredRoute.value>): boolean {
  if (route.name !== target.name) return false;
  if (route.params.slug !== target.params.slug) return false;
  return !("userKey" in target.params) || route.params.userKey === target.params.userKey;
}

watch(desiredRoute, (target) => {
  if (!target || routeMatches(target)) return;
  // Replace when leaving the root landing so the back button does not re-ask the question.
  if (route.name === "event") void router.replace(target);
  else void router.push(target);
});

// Keyed by event uuid, not slug: subscriptions survive renames.
const pushBinding = computed(() =>
  guestKey.value ? { eventId: props.event.id, userKey: guestKey.value } : null,
);

const chart = ref<InstanceType<typeof AvailabilityGrid> | null>(null);

// Undo replays through the same handlers the chart's emits land in — same marks, same save.
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

// Snapshot before the wipe: clearMine empties both sets synchronously. Own id, never folded into a chart gesture.
function clearEverything() {
  const slots = [...availability, ...ifNeeded];
  const before = snapshotSlots(slots, availability, ifNeeded);
  const wiped = clearMine();
  if (slots.length > 0) history.record({ id: history.nextId(), before });
  return wiped;
}

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

// Null drops pin and hover together: on touch no pointer remains to justify an outline.
function onPin(slot: number | null) {
  if (slot === null) {
    pinnedSlot.value = null;
    hoveredSlot.value = null;
    return;
  }
  pinnedSlot.value = pinnedSlot.value === slot ? null : slot;
  hoveredSlot.value = slot;
}

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

function closePeople() {
  holdThenClose.cancel();
  peopleOpen.value = false;
  highlight.value = null;
}

const holdThenClose = useHoldThenClose(closePeople);

// Close the drawer first: both teleport to <body>, and the drawer's anchor stacks over the dialog's.
function addRespondent() {
  closePeople();
  changeName();
}

const {
  key: isolated,
  show: showOnly,
  clear: showEveryone,
} = useIsolation({ editing, leaveEditing: stopEditing });

const shownAlone = computed(() =>
  editing.value ? null : isolated.value ?? highlight.value,
);

// Fallback spelling so the pill never prints a bare user key.
const askedFor = ref("");

const shownLabel = computed(() => {
  const key = shownAlone.value;
  if (key === null) return "";
  return (
    responseIndex.value.labels.get(key) ||
    props.present.find((person) => person.key === key)?.displayName ||
    (key === isolated.value ? askedFor.value : "") ||
    key
  );
});

const shownEmpty = computed(
  () => shownAlone.value !== null && !responseIndex.value.labels.has(shownAlone.value),
);

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
        :highlight-respondent="shownAlone"
        :active-slot="activeSlot"
        :hour12="hour12"
        @paint="session.onPaint"
        @flip="session.onFlip"
        @commit="history.record"
        @undo="history.undo"
        @hover="onHover"
        @pin="onPin"
      >
        <template v-if="!compact" #foot>
          <div class="chart-foot">
            <Segmented
              v-model="clock"
              class="chart-foot__clock"
              label="Clock format"
              :options="CLOCK_OPTIONS"
              size="sm"
            />

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

      <div class="side">
        <AdminTools
          v-if="isAdmin && !compact"
          :event-id="event.id"
          @edit="emit('edit')"
        />

        <TimezoneField
          v-if="!compact"
          v-model="timezone"
          :timezones="timezones"
          :reference-date="referenceDate"
          :auto-timezone="autoTimezone"
          @reset="resetTimezone"
        />

        <OfflineNotice v-if="compact && realtimeDown" />

        <IdentityCard
          :name="guestName"
          :status="syncStatus"
          :error="syncError"
          :error-detail="syncErrorDetail"
          :can-clear="compact && editing && hasMarks"
          :clearing="clearOpen"
          :push="pushBinding"
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
          :highlight="editing ? null : highlight"
          :current-key="guestKey"
          :deleting="deletingKey"
          :delete-error="deleteError"
          @highlight="highlight = $event"
          @unpin="pinnedSlot = null"
          @delete="removeRespondent"
          @add="addRespondent"
          @switch="confirmIdentity"
        />

        <EventFooter v-if="!compact" :realtime-down="realtimeDown" />
      </div>
    </div>

    <ModePills
      :isolated="isolated ? shownLabel : null"
      :best-times="showBestTimes && !editing"
      @exit-isolation="showEveryone"
      @exit-best-times="showBestTimes = false"
    />

    <!-- An empty isolated chart with no explanation reads as one that failed to load. -->
    <div v-if="shownEmpty" class="nothing" role="status">
      <p class="nothing__card">
        <strong class="nothing__name" :title="shownLabel">{{ shownLabel }}</strong>
        has not marked any times yet.
      </p>
    </div>

    <!-- `locked` refuses every dismissal during the eye's hold-then-close delay (`lib/isolation.ts`). -->
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
      :push="pushBinding"
      @close="settingsOpen = false"
      @reset-timezone="resetTimezone"
      @undo="history.undo"
      @redo="history.redo"
    />

    <GuestWelcomeDialog
      :person="welcome"
      :event-name="event.name"
      @confirm="confirmWelcome"
      @decline="declineWelcome"
      @view="viewOnly"
      @close="closeWelcome"
    />

    <GuestIdentityDialog
      :open="identityOpen"
      :existing-people="existingPeople"
      @confirm="confirmIdentity"
      @browse="browseOnly"
      @close="closeIdentity"
    />

    <ConfirmDialog
      :open="clearOpen"
      title="Remove all your marked times?"
      confirm-label="Clear my times"
      @confirm="clearEverything"
      @close="clearOpen = false"
    >
      This wipes everything <strong>{{ guestName }}</strong> marked and takes
      you off the respondents list. You can fill it in again.
    </ConfirmDialog>
  </section>
</template>

<style scoped>
.scheduler {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

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

.layout {
  display: flex;
  align-items: flex-start;
  gap: 1rem;
}

.chart {
  flex: 1 1 auto;
  min-width: 0;
}

/* Inert; z-index below the pill and the drawers (50) so the way out is never covered. */
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

/* Width pinned outright: a flex basis yields to a child's min-content line. */
.side {
  display: flex;
  flex: 0 0 14rem;
  flex-direction: column;
  gap: 0.6rem;
  min-width: 0;
  max-width: 14rem;
}

/* Phone: viewport-locked pane — the page must not scroll under a selection drag (EventPage). */
@media (max-width: 820px) {
  /* No clipping here: the identity bar bleeds past this box to both screen edges. */
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

  .handle {
    /* Focus ring drawn inside: an outside ring would be clipped against the bar's edge. */
    --focus-ring-inset: calc(var(--focus-ring-offset) * -1);

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

  .handle svg {
    width: 1.2rem;
    height: 1.2rem;
  }

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

  .compact .chart {
    flex: 1 1 auto;
    width: 100%;
    min-height: 0;
  }

  .compact .side {
    flex: none;
    width: 100%;
    max-width: none;
  }

}

/* Landscape phone: rows are at their tap floor already, so only the gaps give. */
@media (max-height: 480px) and (max-width: 820px) {
  .scheduler.compact,
  .compact .layout {
    gap: 0.25rem;
  }
}
</style>
