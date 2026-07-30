/**
 * How this visitor reads a chart: which zone, which clock, and whether the
 * heatmap is filtered to its best times.
 *
 * All three are the visitor's rather than the event's — they are not saved with
 * an answer and nobody else sees them — so they live in `localStorage`,
 * site-wide, and they are the same three whichever event is open. Gathered here
 * because they are one concern with one persistence rule, and because the
 * scheduler that used to hold them has plenty else to do.
 */
import { computed, ref, watch, type Ref, type WritableComputedRef } from "vue";
import { getLocalTimezone, listTimezones, prefers12Hour } from "./dates";
import { clearStorage, readStorage, STORAGE_KEYS, writeStorage } from "./storage";

export const CLOCK_OPTIONS = [
  { value: "12", label: "12h" },
  { value: "24", label: "24h" },
];

export interface EventPreferences {
  /** The zone the browser reports, read once. */
  autoTimezone: string;
  timezone: Ref<string>;
  hour12: Ref<boolean>;
  showBestTimes: Ref<boolean>;
  /** The zone list, with an unlisted override kept at the front of it. */
  timezones: Ref<string[]>;
  /** `Segmented` options are strings; the model behind this one is a boolean. */
  clock: WritableComputedRef<string>;
  /** Gives the zone back to the browser. */
  resetTimezone(): void;
}

export function useEventPreferences(): EventPreferences {
  const storedHour12 = readStorage(STORAGE_KEYS.hour12);

  /**
   * Everything about the timezone control is relative to this: it is the value
   * the page falls back to, the option marked "(auto)", and the thing
   * "overridden" is measured against.
   */
  const autoTimezone = getLocalTimezone();

  const timezone = ref(readStorage(STORAGE_KEYS.timezone) || autoTimezone);
  const hour12 = ref(storedHour12 === null ? prefers12Hour() : storedHour12 === "true");
  const showBestTimes = ref(readStorage(STORAGE_KEYS.bestTimes) === "true");

  /**
   * Only an override is worth remembering. Landing back on the browser's own
   * zone — by the reset button, or by picking it out of the list — is not a
   * preference to carry to the next visit, it is the absence of one, so the
   * stored value is dropped rather than rewritten. That is also what makes the
   * reset honest: a reload afterwards derives the zone again instead of
   * replaying a decision.
   */
  watch(timezone, (value) => {
    if (value === autoTimezone) clearStorage(STORAGE_KEYS.timezone);
    else writeStorage(STORAGE_KEYS.timezone, value);
  });

  watch(hour12, (value) => writeStorage(STORAGE_KEYS.hour12, String(value)));
  watch(showBestTimes, (value) => writeStorage(STORAGE_KEYS.bestTimes, String(value)));

  const timezones = computed(() => {
    const zones = listTimezones();
    return zones.includes(timezone.value) ? zones : [timezone.value, ...zones];
  });

  const clock = computed<string>({
    get: () => (hour12.value ? "12" : "24"),
    set: (value) => {
      hour12.value = value === "12";
    },
  });

  function resetTimezone(): void {
    clearStorage(STORAGE_KEYS.timezone);
    timezone.value = autoTimezone;
  }

  return { autoTimezone, timezone, hour12, showBestTimes, timezones, clock, resetTimezone };
}
