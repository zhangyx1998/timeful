<script setup lang="ts">
/**
 * Which zone the chart's hours are printed in.
 *
 * It lives at the head of the column beside the chart because it is the first
 * thing that has to be true before anything below it means what it says: the
 * hours in the gutter, the times in the respondents list, the answer you are
 * about to paint. Picking one is a decision that outlives the page — it is
 * remembered — so the field also has to be able to say when it is *not* being
 * made, and to give it back.
 *
 * The zone the browser reports is marked "(auto)" in the list, and choosing
 * anything else is an override. While one is set the reset button appears
 * beside the select; there is nothing for it to do otherwise, so it is not
 * drawn otherwise.
 */
import { computed } from "vue";
import IconButton from "../ui/IconButton.vue";
import Select from "../ui/Select.vue";
import IconRotateCcw from "../../assets/icons/rotate-ccw.svg";
import { timezoneGmtString } from "../../lib/dates";

const timezone = defineModel<string>({ required: true });

const props = defineProps<{
  timezones: string[];
  referenceDate: Date;
  /** The zone the browser reports; the one an override is an override of. */
  autoTimezone: string;
}>();

const emit = defineEmits<{ reset: [] }>();

/**
 * Zone first, offset second. The list is sorted by zone name, so leading with
 * the offset made an alphabetical list look shuffled; and in a column this
 * narrow the closed select has room for the beginning of its label and not
 * much else, which had better be the part that names the place.
 */
const options = computed(() =>
  props.timezones.map((zone) => {
    const name = `${zone.replace(/_/g, " ")} ${timezoneGmtString(zone, props.referenceDate)}`;
    return { value: zone, label: zone === props.autoTimezone ? `${name} (auto)` : name };
  }),
);

const overridden = computed(() => timezone.value !== props.autoTimezone);

/**
 * The state in words, because the "(auto)" marker in the list is the first
 * thing a narrow select truncates. It also says what the reset button would
 * give back, which is the only way to know that without pressing it.
 */
const note = computed(() =>
  overridden.value
    ? `Your browser is on ${props.autoTimezone.replace(/_/g, " ")}.`
    : "Following your browser.",
);
</script>

<template>
  <div class="tz">
    <Select v-model="timezone" class="tz__select" label="Timezone" :options="options" />

    <!-- Bottom-aligned rather than centred: it belongs to the select's control
         row, not to the label above it. -->
    <IconButton
      v-if="overridden"
      class="tz__reset"
      label="Reset to system timezone"
      size="sm"
      @click="emit('reset')"
    >
      <IconRotateCcw aria-hidden="true" />
    </IconButton>

    <p class="tz__note">{{ note }}</p>
  </div>
</template>

<style scoped>
/* Two columns for the control row, one row under it for the state: the button
   lines up with the select's own box rather than with the label above it or
   the sentence below it. */
.tz {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: end;
  gap: 0.2rem 0.35rem;
}

.tz__select {
  min-width: 0;
}

.tz__note {
  grid-column: 1 / -1;
  font-size: 0.75rem;
  line-height: 1.35;
  color: var(--color-text-muted);
}
</style>
