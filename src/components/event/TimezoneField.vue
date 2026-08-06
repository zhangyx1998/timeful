<script setup lang="ts">
// Which zone the chart's hours are printed in. The browser's zone is "(auto)";
// anything else is an override, and the reset button appears only while one is set.
import { computed } from "vue";
import IconButton from "../ui/IconButton.vue";
import Select from "../ui/Select.vue";
import IconRotateCcw from "../../assets/icons/rotate-ccw.svg";
import { timezoneGmtString } from "../../lib/dates";

const timezone = defineModel<string>({ required: true });

const props = defineProps<{
  timezones: string[];
  referenceDate: Date;
  autoTimezone: string;
}>();

const emit = defineEmits<{ reset: [] }>();

// Zone first, offset second: a narrow closed select shows only the label's start.
const options = computed(() =>
  props.timezones.map((zone) => {
    const name = `${zone.replace(/_/g, " ")} ${timezoneGmtString(zone, props.referenceDate)}`;
    return { value: zone, label: zone === props.autoTimezone ? `${name} (auto)` : name };
  }),
);

const overridden = computed(() => timezone.value !== props.autoTimezone);

// In words, because "(auto)" is the first thing a narrow select truncates.
const note = computed(() =>
  overridden.value
    ? `Your browser is on ${props.autoTimezone.replace(/_/g, " ")}.`
    : "Following your browser.",
);
</script>

<template>
  <div class="tz">
    <Select v-model="timezone" class="tz__select" label="Timezone" :options="options" />

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
