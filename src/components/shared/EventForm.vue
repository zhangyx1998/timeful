<script setup lang="ts">
// Builds `dates[]` as UTC instants; `duration` is end - start in hours (end <= start runs past midnight).
// Slugs are capability URLs, never derived from the event name (ARCHITECTURE.md § Security):
// the form leases one up front to preview the link and releases it when unwanted; leases lapse on their own.
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
import ErrorNote from "../ui/ErrorNote.vue";
import IconButton from "../ui/IconButton.vue";
import Segmented from "../ui/Segmented.vue";
import Select from "../ui/Select.vue";
import Spinner from "../ui/Spinner.vue";
import TextInput from "../ui/TextInput.vue";
import IconRotateCw from "../../assets/icons/rotate-cw.svg";
import { slugProblem } from "../../lib/slug-rules";
import { realtimeAllowed } from "../../lib/event";
import { WEEKDAY_LABELS } from "../../lib/dates";
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
// Absent on pre-realtime events reads as on (`realtimeAllowed`).
const realtime = ref(props.event ? realtimeAllowed(props.event) : true);

const saving = ref(false);
const error = ref("");
const slugError = ref("");

const leasedSlug = ref<string | null>(null);
const leasing = ref(false);
const leaseNotice = ref("");
/** Set once the event is created: the server consumed the lease for us. */
let leaseConsumed = false;

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

async function regenerate(): Promise<void> {
  leaseNotice.value = "";
  await releaseLease();
  await takeLease();
}

onMounted(() => {
  if (!editing.value) void takeLease();
});

onBeforeUnmount(() => {
  void releaseLease();
});

// Typing a custom path releases the reservation and stales the old server verdict.
function onSlugInput(): void {
  slugError.value = "";
  if (leasedSlug.value !== null && slug.value !== leasedSlug.value) {
    leaseNotice.value = "";
    void releaseLease();
  }
}

const duration = computed(() => durationFromTimes(startTime.value, endTime.value));
const crossesMidnight = computed(() => endTime.value <= startTime.value);

const origin = typeof window === "undefined" ? "" : window.location.origin;
const originPrefix = `${origin}/`;
const urlPreview = computed(() => `${origin}/${slug.value}`);

const trimmedSlug = computed(() => slug.value.trim());

// An empty field sends no slug: the server mints one (create) or keeps the path (edit).
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

// Trim only. Slugs are case-sensitive: lowercasing would mangle a leased capability slug into a weaker path.
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
  // A keyboard submit must not get past the disabled button.
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
    // The write consumed the reservation server-side, so do not hand it back.
    if (!props.event || saved.slug === leasedSlug.value) leaseConsumed = true;
    emit("saved", saved);
  } catch (err) {
    const { message, status } = apiError(err, "Could not save the event");
    const aboutSlug = status === 409 || /slug/i.test(message);
    if (aboutSlug && usingLease.value) {
      // Stale reservation: take a new one so save can just be pressed again.
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
          {{ label }}
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

      <p class="hint hint--url">
        {{ slug ? urlPreview : `${origin}/… — a random link is created on save` }}
      </p>

      <p v-if="leaseNotice" class="hint hint--warn">{{ leaseNotice }}</p>
      <p
        v-else-if="!editing && !usingLease"
        class="hint hint--warn"
        title="A path someone could guess can be found without being shared"
      >
        Custom paths are easy to share, and easy to guess.
      </p>
    </div>

    <div class="field">
      <label
        class="checkbox"
        title="Open pages show new answers as they arrive, without being reloaded"
      >
        <input v-model="realtime" type="checkbox" />
        Live updates
      </label>
    </div>

    <ErrorNote :message="error" />

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

.slug__input {
  width: 100%;
}

/* The origin gives way before the path: the row hands the input its 12ch first. */
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

.actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: flex-end;
  gap: 0.5rem;
}
</style>
