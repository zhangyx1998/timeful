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
 * The owner's tools used to lead it, as they lead the desktop column. They do
 * not any more: they are not settings — they act on the event, or leave it —
 * and behind a gear they were a surprise waiting for whichever visitor happened
 * to be signed in. They have a sheet of their own now, opened from the shield
 * in the navbar (`AdminDrawer`). What stays is the way *in* for an owner who is
 * not signed in yet, at the foot, as it closes the desktop column: it is the
 * one admin thing on the page a guest is allowed to find, and there is nowhere
 * else on a phone to put it.
 *
 * It carries one thing the desktop has no need of. Undo and redo are a pair of
 * keystrokes on a keyboard, and a phone has none — so the two of them are
 * buttons here, in the only drawer a hand can reach without leaving the chart.
 * They are disabled rather than hidden when there is nothing to take back: a
 * control that comes and goes is one you have to hunt for, and the pair is also
 * how you find out that undo exists at all.
 */
import AdminLoginLink from "./AdminLoginLink.vue";
import ColorLegend from "./ColorLegend.vue";
import TimezoneField from "./TimezoneField.vue";
import Dialog from "../ui/Dialog.vue";
import Segmented from "../ui/Segmented.vue";
import IconRedo from "../../assets/icons/redo.svg";
import IconUndo from "../../assets/icons/undo.svg";
import { isAdmin } from "../../lib/admin";
import { CLOCK_OPTIONS } from "../../lib/preferences";
import type { GridMode } from "../../lib/event";

defineProps<{
  open: boolean;
  timezones: string[];
  referenceDate: Date;
  autoTimezone: string;
  /** Which set of swatches the legend shows. */
  mode: GridMode;
  max: number;
  total: number;
  /** Whether the edit session has anything left to take back, or to put back. */
  canUndo: boolean;
  canRedo: boolean;
}>();

const timezone = defineModel<string>("timezone", { required: true });
const clock = defineModel<string>("clock", { required: true });

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

      <!-- Only while you are writing an answer: there is nothing to take back
           from reading one, and an always-dead pair of buttons would say the
           feature is broken rather than that it does not apply. -->
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

/* The pair reads as one control, so they sit in one bordered group the way the
   segmented switches beside them do. */
.steps {
  display: flex;
  flex: none;
  overflow: hidden;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
}

/* At the tap floor in both directions: this is a phone's only undo, and it is
   pressed repeatedly, so it is the last thing that should ask for precision. */
.step {
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

.step:focus-visible {
  outline: var(--focus-ring);
  outline-offset: calc(var(--focus-ring-offset) * -1);
}

/* Dimmed rather than gone: the pair stays where it was so the one that still
   works is in the same place it was a moment ago. */
.step:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
</style>
