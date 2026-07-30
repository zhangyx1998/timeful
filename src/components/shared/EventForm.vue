<script setup lang="ts">
/**
 * Create / edit form for an event. Builds `dates[]` as UTC instants from the
 * admin's local timezone and `duration` as end - start in hours (end <= start
 * means the window runs past midnight).
 *
 * Slugs (ARCHITECTURE.md § Security)
 * ---------------------------------
 * A default slug is a capability URL: 16 random base62 characters that the
 * server mints. It must never be derived from the event name, or the URL
 * becomes guessable. So the create form leases one up front
 * (`POST /api/slug-leases`) purely to be able to show the final link before the
 * event exists; creating the event consumes that lease. Anything that makes the
 * lease unwanted — typing a custom path, regenerating, cancelling — releases it
 * (`DELETE /api/slug-leases/:slug`). A lease also lapses on its own after ~15
 * minutes, so nothing leaks if the tab is simply closed.
 *
 * Editing leases the same way, because the edit form offers the same shuffle:
 * an admin who wants to retire a guessable path needs a fresh capability slug
 * exactly as much as a new event does. A rename onto a live lease used to be
 * refused while a create claimed it; the server now claims it in both cases
 * (server/routes/events.ts), since the only lease a rename can meet is the one
 * this form took a moment ago for that rename.
 *
 * The path is validated as it is typed, against `lib/slug-rules` — the same
 * module the server validates with, so the inline message is word for word the
 * one the API would have returned, and an illegal path disables saving instead
 * of making the round trip to find out.
 *
 * The form draws no chrome of its own: it is always presented inside
 * `EventFormDialog`, which supplies the panel and the title.
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import {
  api,
  apiError,
  createSlugLease,
  eventSettingsPath,
  releaseSlugLease,
} from "../../lib/api";
import MonthCalendar from "./MonthCalendar.vue";
import Button from "../ui/Button.vue";
import IconButton from "../ui/IconButton.vue";
import Segmented from "../ui/Segmented.vue";
import Select from "../ui/Select.vue";
import Spinner from "../ui/Spinner.vue";
import TextInput from "../ui/TextInput.vue";
import IconRotateCw from "../../assets/icons/rotate-cw.svg";
import { slugProblem } from "../../lib/slug-rules";
import { realtimeAllowed } from "../../lib/event";
import type { EventPayload } from "../../lib/api";
import type { EventDoc, EventType } from "../../lib/event";
import {
  buildDates,
  dayIndexesFromEvent,
  dayKeysFromEvent,
  durationFromTimes,
  endTimeFromDuration,
  formatDayKey,
  startTimeFromEvent,
  TIME_INCREMENTS,
  TIME_OPTIONS,
  WEEKDAY_LABELS,
} from "../../lib/event-form";

const props = withDefaults(defineProps<{ event?: EventDoc | null }>(), {
  event: null,
});
const emit = defineEmits<{
  (e: "saved", event: EventDoc): void;
  (e: "cancel"): void;
}>();

const TYPE_OPTIONS: { value: EventType; label: string }[] = [
  { value: "specific_dates", label: "Specific dates" },
  { value: "dow", label: "Days of week" },
];

const editing = computed(() => Boolean(props.event));

const name = ref(props.event?.name ?? "");
const type = ref<EventType>(props.event?.type ?? "specific_dates");
const dayKeys = ref<string[]>(dayKeysFromEvent(props.event));
const dayIndexes = ref<number[]>(dayIndexesFromEvent(props.event));
const startOnMonday = ref(Boolean(props.event?.startOnMonday));
const startTime = ref(props.event ? startTimeFromEvent(props.event) : 9);
const endTime = ref(
  props.event
    ? endTimeFromDuration(startTimeFromEvent(props.event), props.event.duration ?? 8)
    : 17,
);
const timeIncrement = ref<number>(props.event?.timeIncrement ?? 15);
const slug = ref(props.event?.slug ?? "");
// Absent on an event written before live updates existed, and that reads as on
// — `realtimeAllowed` is the one place that rule is written down.
const realtime = ref(props.event ? realtimeAllowed(props.event) : true);

const saving = ref(false);
const error = ref("");
const slugError = ref("");

// --- slug lease -----------------------------------------------------------

/** The slug currently reserved for this form, or null when nothing is held. */
const leasedSlug = ref<string | null>(null);
const leasing = ref(false);
const leaseNotice = ref("");
/** Set once the event is created: the server consumed the lease for us. */
let leaseConsumed = false;

/** True while the field still holds the untouched leased capability slug. */
const usingLease = computed(
  () => leasedSlug.value !== null && slug.value === leasedSlug.value,
);

async function releaseLease(): Promise<void> {
  const held = leasedSlug.value;
  leasedSlug.value = null;
  if (!held || leaseConsumed) return;
  try {
    await releaseSlugLease(held);
  } catch {
    // Nothing to do: an unreleased lease lapses on its own.
  }
}

/** Reserves a slug and puts it in the field. */
async function takeLease(): Promise<void> {
  if (leasing.value) return;
  leasing.value = true;
  try {
    const lease = await createSlugLease();
    leasedSlug.value = lease.slug;
    slug.value = lease.slug;
    slugError.value = "";
  } catch (err) {
    const { message, status } = apiError(err, "Could not reserve a link");
    // Not fatal: submitting with an empty slug still gets a server-minted one.
    if (status !== 401) leaseNotice.value = message;
  } finally {
    leasing.value = false;
  }
}

/** Swaps the reserved slug for a fresh one. */
async function regenerate(): Promise<void> {
  leaseNotice.value = "";
  await releaseLease();
  await takeLease();
}

// Only a new event opens with a reservation already made: an existing one
// already has a path, and is only given a new one if the shuffle is pressed.
onMounted(() => {
  if (!editing.value) void takeLease();
});

// Cancelling, or navigating away from the form, gives the reservation back.
onBeforeUnmount(() => {
  void releaseLease();
});

// Typing a custom path means the reservation is no longer wanted, and makes
// whatever the server last said about the old value stale.
function onSlugInput(): void {
  slugError.value = "";
  if (leasedSlug.value !== null && slug.value !== leasedSlug.value) {
    leaseNotice.value = "";
    void releaseLease();
  }
}

// --- derived --------------------------------------------------------------

const duration = computed(() => durationFromTimes(startTime.value, endTime.value));
const crossesMidnight = computed(() => endTime.value <= startTime.value);

const origin = typeof window === "undefined" ? "" : window.location.origin;
/** What the field's value is appended to, shown inside the field itself. */
const originPrefix = `${origin}/`;
const urlPreview = computed(() => `${origin}/${slug.value}`);

// --- the path's own rules -------------------------------------------------

const trimmedSlug = computed(() => slug.value.trim());

/**
 * The shared rules, applied as the admin types. An empty field is not a
 * problem: creating sends no slug at all and the server mints a capability one,
 * and editing sends none either, which leaves the existing path alone.
 */
const slugRuleProblem = computed(() =>
  trimmedSlug.value ? slugProblem(trimmedSlug.value) : null,
);

/** The live rule wins over anything the server said about an older value. */
const slugMessage = computed(() => slugRuleProblem.value ?? slugError.value);

const selectedDaysSummary = computed(() => [...dayKeys.value].sort().map(formatDayKey));

function toggleWeekday(index: number): void {
  const next = new Set(dayIndexes.value);
  if (next.has(index)) next.delete(index);
  else next.add(index);
  dayIndexes.value = [...next].sort((a, b) => a - b);
}

// Only whitespace is stripped as the field is typed. Slugs are case-sensitive
// — lowercasing here would mangle a leased capability slug (mixed-case base62)
// into a different, weaker path than the one that was reserved.
watch(slug, (value) => {
  const trimmed = value.trim();
  if (trimmed !== value) slug.value = trimmed;
});

const canSubmit = computed(() => {
  if (!name.value.trim()) return false;
  if (slugRuleProblem.value) return false;
  return type.value === "dow" ? dayIndexes.value.length > 0 : dayKeys.value.length > 0;
});

function buildPayload(): EventPayload {
  const custom = slug.value.trim();
  return {
    name: name.value.trim(),
    type: type.value,
    dates: buildDates({
      type: type.value,
      dayKeys: dayKeys.value,
      dayIndexes: dayIndexes.value,
      startTime: startTime.value,
      startOnMonday: startOnMonday.value,
    }),
    duration: duration.value,
    timeIncrement: Number(timeIncrement.value),
    startOnMonday: type.value === "dow" ? startOnMonday.value : false,
    realtime: realtime.value,
    // An empty field is sent as no slug at all, and the server mints a
    // capability slug. It is never filled in from the name.
    ...(custom ? { slug: custom } : {}),
  };
}

async function submit(): Promise<void> {
  error.value = "";
  slugError.value = "";
  leaseNotice.value = "";
  if (!name.value.trim()) {
    error.value = "Event name is required";
    return;
  }
  // The button is already disabled for this; the guard is here so a submit
  // from the keyboard cannot get past it either.
  if (slugRuleProblem.value) return;
  if (type.value === "dow" ? !dayIndexes.value.length : !dayKeys.value.length) {
    error.value = "Pick at least one day";
    return;
  }

  saving.value = true;
  try {
    const saved = props.event
      ? await api.patch<EventDoc>(eventSettingsPath(props.event.id), buildPayload())
      : await api.post<EventDoc>("/api/events", buildPayload());
    // The write consumed the reservation server-side — a create always does,
    // and a rename onto the leased path does too — so do not hand it back.
    if (!props.event || saved.slug === leasedSlug.value) leaseConsumed = true;
    emit("saved", saved);
  } catch (err) {
    const { message, status } = apiError(err, "Could not save the event");
    const aboutSlug = status === 409 || /slug/i.test(message);
    if (aboutSlug && usingLease.value) {
      // The reservation went stale (expired, or claimed elsewhere). Take a new
      // one so the admin can just press save again.
      leasedSlug.value = null;
      await takeLease();
      leaseNotice.value = "That link was no longer free — here is a fresh one.";
    } else if (aboutSlug) {
      slugError.value = message;
    } else {
      error.value = message;
    }
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <form class="form" @submit.prevent="submit">
    <TextInput
      id="event-name"
      v-model="name"
      label="Name"
      type="text"
      maxlength="200"
      required
    />

    <div class="field">
      <span class="label">Dates</span>
      <Segmented v-model="type" label="Date mode" variant="solid" :options="TYPE_OPTIONS" />
    </div>

    <div v-if="type === 'specific_dates'" class="field">
      <MonthCalendar v-model="dayKeys" />
      <!-- The calendar shows which days are picked; the count is the part it
           cannot show at a glance once the choice spans months. The days
           themselves are one hover away rather than another line of the form. -->
      <p
        v-if="selectedDaysSummary.length"
        class="hint"
        :title="selectedDaysSummary.join(', ')"
      >
        {{ selectedDaysSummary.length }}
        day{{ selectedDaysSummary.length === 1 ? "" : "s" }} selected
      </p>
    </div>

    <div v-else class="field">
      <div class="weekdays">
        <button
          v-for="(label, index) in WEEKDAY_LABELS"
          :key="label"
          class="weekday"
          :class="{ 'weekday--active': dayIndexes.includes(index) }"
          type="button"
          :aria-pressed="dayIndexes.includes(index)"
          @click="toggleWeekday(index)"
        >
          {{ label.slice(0, 3) }}
        </button>
      </div>
      <label class="checkbox">
        <input v-model="startOnMonday" type="checkbox" />
        Week starts on Monday
      </label>
    </div>

    <div class="row">
      <Select
        id="event-start"
        v-model="startTime"
        label="Start time"
        :options="TIME_OPTIONS"
      />
      <Select id="event-end" v-model="endTime" label="End time" :options="TIME_OPTIONS" />
      <Select
        id="event-increment"
        v-model="timeIncrement"
        label="Time increment"
        :options="TIME_INCREMENTS"
      />
    </div>
    <p class="hint" title="Times are in your local timezone">
      {{ duration }} hour{{ duration === 1 ? "" : "s" }} per day<span
        v-if="crossesMidnight"
      >, ending the next day</span
      >
    </p>

    <div class="field slug">
      <!-- The origin sits inside the field, ahead of the caret, because the
           value is the tail of a URL rather than a word: what you type
           continues what is already written there. The shuffle sits inside it
           too, at the other end, so it stays on the value's own row however
           many lines the validation message underneath runs to. -->
      <TextInput
        id="event-slug"
        v-model="slug"
        class="slug__input"
        label="Link"
        type="text"
        maxlength="80"
        placeholder="my-custom-path"
        :error="slugMessage"
        @input="onSlugInput"
      >
        <template #prefix>
          <span class="slug__origin" dir="rtl"><bdi>{{ originPrefix }}</bdi></span>
        </template>

        <!-- Reserving another random link is one glyph; what it does is in the
             tooltip, where it costs nothing to read and nothing to skip. It is
             offered when editing too: retiring a path that turned out to be
             guessable is exactly when you want a new one. -->
        <template #suffix>
          <span class="slug__regenerate">
            <Spinner v-if="leasing" :size="18" label="Reserving a link" />
            <IconButton
              v-else
              size="sm"
              label="Reserve a different random link"
              @click="regenerate"
            >
              <IconRotateCw aria-hidden="true" />
            </IconButton>
          </span>
        </template>
      </TextInput>

      <!-- The field truncates the origin when it has to; this is where the
           whole address is always legible, and what you would read out. -->
      <p class="hint hint--url">
        {{ slug ? urlPreview : `${origin}/… — a random link is created on save` }}
      </p>

      <p v-if="leaseNotice" class="hint hint--warn">{{ leaseNotice }}</p>
      <!-- The one thing that is not obvious from looking at the field: whether
           this path is guessable. One line either way; the reasoning behind it
           is a hover, not a paragraph. -->
      <p
        v-else-if="usingLease"
        class="hint"
        title="Random and unguessable — the link is the only thing protecting this event, and anyone who has it can respond"
      >
        Unguessable link. Type your own for something memorable.
      </p>
      <p
        v-else-if="!editing"
        class="hint hint--warn"
        title="A path someone could guess can be found without being shared"
      >
        Custom paths are easy to share, and easy to guess.
      </p>
    </div>

    <!-- Whether a page left open on this event keeps up on its own. Nothing
         depends on it: with it off the event behaves exactly as it always did,
         and a respondent sees other people's answers the next time the page
         loads. It sits last because it is the only setting here that changes
         nothing about what the event *is*. -->
    <div class="field">
      <label class="checkbox">
        <input v-model="realtime" type="checkbox" />
        Live updates
      </label>
      <p class="hint" title="Turning this off changes nothing else — answers still save the moment they are made">
        Open pages show new answers as they arrive, without being reloaded.
      </p>
    </div>

    <p v-if="error" class="error">{{ error }}</p>

    <!-- Same order as every other dialog in the app: the way out on the left,
         the thing you came to do at the right edge. -->
    <div class="actions">
      <Button variant="ghost" @click="emit('cancel')">Cancel</Button>
      <Button variant="primary" type="submit" :loading="saving" :disabled="!canSubmit">
        {{ saving ? "Saving…" : editing ? "Save changes" : "Create event" }}
      </Button>
    </div>
  </form>
</template>

<style scoped>
.form {
  display: flex;
  flex-direction: column;
  gap: 1.25rem;
}

.field {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 0.375rem;
}

.label {
  font-size: 0.875rem;
  font-weight: 500;
  color: var(--color-text);
}

/* One column on phones, three once there is room for them side by side. */
.row {
  display: grid;
  gap: 1rem;
  grid-template-columns: 1fr;
}

@media (min-width: 40rem) {
  .row {
    grid-template-columns: repeat(3, 1fr);
  }
}

.weekdays {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
}

.weekday {
  min-width: 3rem;
  min-height: var(--tap-min);
  padding: 0.375rem 0.75rem;
  font: inherit;
  font-size: 0.875rem;
  color: var(--color-text);
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  cursor: pointer;
}

.weekday:hover {
  background: var(--color-subtle);
}

.weekday:focus-visible {
  outline: var(--focus-ring);
  outline-offset: var(--focus-ring-offset);
}

.weekday--active {
  font-weight: 500;
  color: var(--color-accent-contrast);
  background: var(--color-accent);
  border-color: var(--color-accent);
}

.weekday--active:hover {
  background: var(--color-accent-hover);
}

.checkbox {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  min-height: 1.75rem;
  font-size: 0.875rem;
  color: var(--color-text);
  cursor: pointer;
}

.checkbox input {
  width: 1rem;
  height: 1rem;
  accent-color: var(--color-accent);
}

@media (pointer: coarse) {
  .checkbox {
    min-height: var(--tap-min);
  }
}

.hint {
  margin: 0;
  font-size: 0.75rem;
  color: var(--color-text-muted);
}

.slug {
  width: 100%;
}

/* The button sits on the input line, not the label line, and drops below the
   field when there is no room beside it. */
/* The fields in this form are laid out flex-start, so a field that should take
   the whole row has to say so. This one should: it holds a URL. */
.slug__input {
  width: 100%;
}

/* The origin gives way before the path does — it is fixed text, and the field's
   own value is the part being edited — but only once there is actually
   something to give way over. No cap of its own: the row decides, by handing
   the input its 12ch first and the origin whatever is left. */
.slug__origin {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* Fixed box so swapping the spinner in mid-request does not shuffle the row. */
.slug__regenerate {
  display: inline-grid;
  flex: none;
  place-items: center;
  width: 2.25rem;
}

@media (pointer: coarse) {
  .slug__regenerate {
    width: var(--tap-min);
  }
}

.hint--warn {
  color: var(--color-warning);
}

.hint--url {
  overflow-wrap: anywhere;
}

.error {
  margin: 0;
  padding: 0.5rem 0.75rem;
  font-size: 0.875rem;
  color: var(--color-danger);
  background: var(--color-danger-soft);
  border-radius: var(--radius-md);
}

.actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: flex-end;
  gap: 0.5rem;
}
</style>
