<script setup lang="ts">
/**
 * The phone's version of the column the desktop keeps beside the chart.
 *
 * This is the one place the two layouts genuinely diverge rather than reflow.
 * A desktop has a column for everything that says *how the chart is read* — the
 * zone, the clock, what the colours mean — and a phone has a fixed pane where
 * every row of chrome comes off the grid. So on a phone they go behind a gear,
 * and the foot keeps only the control that changes what the chart *says*.
 *
 * The owner's tools lead it, as they lead the desktop column, and the way in
 * for an owner who is not signed in closes it, as it closes the desktop column.
 * Same order, same reasons, different container.
 */
import AdminLoginLink from "./AdminLoginLink.vue";
import AdminTools from "./AdminTools.vue";
import ColorLegend from "./ColorLegend.vue";
import TimezoneField from "./TimezoneField.vue";
import Dialog from "../ui/Dialog.vue";
import Segmented from "../ui/Segmented.vue";
import { isAdmin } from "../../lib/admin";
import { CLOCK_OPTIONS } from "../../lib/preferences";
import type { GridMode } from "../../lib/event";

defineProps<{
  open: boolean;
  /** The event the owner's tools act on. The uuid, so a rename cannot strand them. */
  eventId: string;
  timezones: string[];
  referenceDate: Date;
  autoTimezone: string;
  /** Which set of swatches the legend shows. */
  mode: GridMode;
  max: number;
  total: number;
}>();

const timezone = defineModel<string>("timezone", { required: true });
const clock = defineModel<string>("clock", { required: true });

const emit = defineEmits<{ close: []; "reset-timezone": []; edit: [] }>();
</script>

<template>
  <Dialog variant="sheet" :open="open" title="View settings" @close="emit('close')">
    <div class="stack">
      <AdminTools v-if="isAdmin" :event-id="eventId" @edit="emit('edit')" />

      <TimezoneField
        v-model="timezone"
        :timezones="timezones"
        :reference-date="referenceDate"
        :auto-timezone="autoTimezone"
        @reset="emit('reset-timezone')"
      />

      <div class="setting">
        <span class="setting__label">Clock</span>
        <Segmented
          v-model="clock"
          class="setting__control"
          label="Clock format"
          :options="CLOCK_OPTIONS"
          size="sm"
        />
      </div>

      <!-- Room to say what the colours mean, which is exactly what the foot
           did not have. -->
      <div class="setting setting--stacked">
        <span class="setting__label">Colours</span>
        <ColorLegend :mode="mode" :max="max" :total="total" />
      </div>

      <AdminLoginLink v-if="!isAdmin" />
    </div>
  </Dialog>
</template>

<style scoped>
.stack {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  padding-top: 0.35rem;
}

/* One setting per row: the name of it at the left, the control at the right,
   the way the timezone field above them already reads. */
.setting {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
}

/* Except where the control is a paragraph of swatches rather than a widget. */
.setting--stacked {
  flex-direction: column;
  align-items: flex-start;
  gap: 0.4rem;
}

.setting__label {
  font-size: 0.8125rem;
  font-weight: 600;
  color: var(--color-text);
}

.setting__control {
  flex: none;
}
</style>
