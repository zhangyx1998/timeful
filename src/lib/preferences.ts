/**
 * How this visitor reads a chart: zone, clock, best-times filter. The
 * visitor's, not the event's, so they live in localStorage site-wide.
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

  /** The fallback value, the "(auto)" option, and what "overridden" is measured against. */
  const autoTimezone = getLocalTimezone();

  const timezone = ref(readStorage(STORAGE_KEYS.timezone) || autoTimezone);
  const hour12 = ref(storedHour12 === null ? prefers12Hour() : storedHour12 === "true");
  const showBestTimes = ref(readStorage(STORAGE_KEYS.bestTimes) === "true");

  // Only an override is worth remembering; landing back on the browser's own
  // zone drops the stored value rather than rewriting it.
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
