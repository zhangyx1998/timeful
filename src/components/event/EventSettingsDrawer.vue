<script setup lang="ts">
// The phone's version of the desktop's side column, behind the gear. Undo/redo live
// here because a phone has no keyboard; disabled rather than hidden so the pair stays findable.
import ColorLegend from "./ColorLegend.vue";
import EventFooter from "./EventFooter.vue";
import PushToggle from "./PushToggle.vue";
import TimezoneField from "./TimezoneField.vue";
import Dialog from "../ui/Dialog.vue";
import Segmented from "../ui/Segmented.vue";
import IconRedo from "../../assets/icons/redo.svg";
import IconUndo from "../../assets/icons/undo.svg";
import { CLOCK_OPTIONS } from "../../lib/preferences";
import type { GridMode } from "../../lib/event";

defineProps<{
  open: boolean;
  timezones: string[];
  referenceDate: Date;
  autoTimezone: string;
  mode: GridMode;
  max: number;
  total: number;
  canUndo: boolean;
  canRedo: boolean;
  /** Null hides the row; the desktop keeps the same toggle on the identity card. */
  push?: { eventId: string; userKey: string } | null;
}>();

const timezone = defineModel<string>("timezone", { required: true });
const clock = defineModel<string>("clock", { required: true });
const bestTimes = defineModel<boolean>("bestTimes", { required: true });

const emit = defineEmits<{
  close: [];
  "reset-timezone": [];
  undo: [];
  redo: [];
}>();
</script>

<template>
  <Dialog variant="sheet" :open="open" title="View settings" @close="emit('close')">
    <div class="stack">
      <TimezoneField
        v-model="timezone"
        :timezones="timezones"
        :reference-date="referenceDate"
        :auto-timezone="autoTimezone"
        @reset="emit('reset-timezone')"
      />

      <!-- Edit mode only: an always-dead pair would say the feature is broken. -->
      <div v-if="mode === 'edit'" class="setting">
        <span class="setting__label">Your edits</span>
        <div class="steps">
          <button
            type="button"
            class="step"
            :disabled="!canUndo"
            aria-label="Undo"
            title="Undo"
            @click="emit('undo')"
          >
            <IconUndo aria-hidden="true" />
          </button>
          <button
            type="button"
            class="step"
            :disabled="!canRedo"
            aria-label="Redo"
            title="Redo"
            @click="emit('redo')"
          >
            <IconRedo aria-hidden="true" />
          </button>
        </div>
      </div>

      <!-- Group mode only: the chart ignores the flag while editing. -->
      <label v-if="mode === 'group'" class="setting setting--tappable">
        <span class="setting__label">Best times only</span>
        <input v-model="bestTimes" class="check" type="checkbox" />
      </label>

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

      <div class="setting setting--stacked">
        <span class="setting__label">Colours</span>
        <ColorLegend :mode="mode" :max="max" :total="total" />
      </div>

      <PushToggle
        v-if="push"
        variant="setting"
        :event-id="push.eventId"
        role="respondent"
        :user-key="push.userKey"
        label="Notify me if the event changes"
      />

      <EventFooter />
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

.setting {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
}

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

.setting--tappable {
  min-height: var(--tap-min);
  cursor: pointer;
}

.check {
  flex: none;
  width: 1.15rem;
  height: 1.15rem;
  margin: 0;
  accent-color: var(--color-accent);
}

.steps {
  display: flex;
  flex: none;
  overflow: hidden;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
}

.step {
  --focus-ring-inset: calc(var(--focus-ring-offset) * -1);

  display: grid;
  place-items: center;
  width: var(--tap-min);
  height: var(--tap-min);
  padding: 0;
  color: var(--color-text);
  background: var(--color-surface);
  border: none;
  cursor: pointer;
  transition: color var(--transition-fast), background var(--transition-fast);
}

.step + .step {
  border-left: 1px solid var(--color-border);
}

.step svg {
  width: 1.1rem;
  height: 1.1rem;
}

.step:hover:not(:disabled) {
  background: var(--color-subtle);
}

.step:disabled {
  opacity: var(--disabled-opacity);
  cursor: not-allowed;
}
</style>
