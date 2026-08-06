<script setup lang="ts">
// Removing a response is offered to everyone on purpose: the event URL is the trust boundary (ARCHITECTURE.md § API).
// Stance glyphs differ in shape as well as hue, so the reading survives a monochrome screen.
import { computed, ref, watch } from "vue";
import ConfirmDialog from "../ui/ConfirmDialog.vue";
import Spinner from "../ui/Spinner.vue";
import IconCheck from "../../assets/icons/check.svg";
import IconHourglass from "../../assets/icons/hourglass.svg";
import IconClose from "../../assets/icons/close.svg";
import IconPersonFilled from "../../assets/icons/person-filled.svg";
import IconPerson from "../../assets/icons/person.svg";
import IconTrash from "../../assets/icons/trash.svg";
import IconPlus from "../../assets/icons/plus.svg";
import IconEye from "../../assets/icons/eye.svg";
import IconEyeOff from "../../assets/icons/eye-off.svg";
import { STANCE_LABELS, toneFor, type SlotStance } from "../../lib/grid";
import { isOnChart } from "../../lib/isolation";
import type { PresenceEntry } from "../../lib/realtime";

const props = defineProps<{
  embedded?: boolean;
  keys: string[];
  labels: Map<string, string>;
  present: PresenceEntry[];
  /** Keys available at the active slot. Null when no slot is active. */
  availableNames: Set<string> | null;
  ifNeededNames: Set<string>;
  slotLabel: string | null;
  pinned: boolean;
  highlight: string | null;
  currentKey: string | null;
  deleting: string | null;
  deleteError: string | null;
  solo?: string | null;
}>();

const emit = defineEmits<{
  highlight: [key: string | null];
  unpin: [];
  delete: [key: string];
  add: [];
  switch: [person: { key: string; displayName: string }];
  solo: [person: { key: string; displayName: string } | null];
}>();

const confirming = ref<string | null>(null);
const switching = ref<string | null>(null);

const answered = computed(() => new Set(props.keys));
const online = computed(() => new Set(props.present.map((person) => person.key)));

// The stored spelling wins over whatever the presence entry claims.
const labelFor = computed(() => {
  const map = new Map(props.labels);
  for (const person of props.present) {
    if (!map.has(person.key)) map.set(person.key, person.displayName);
  }
  return map;
});

function label(key: string): string {
  return labelFor.value.get(key) ?? key;
}

// Ordered by shown name so a row does not move when its owner finally saves.
const listed = computed(() => {
  const extra = props.present
    .map((person) => person.key)
    .filter((key) => !answered.value.has(key));
  if (extra.length === 0) return props.keys;
  return [...new Set([...props.keys, ...extra])].sort(
    (a, b) => label(a).localeCompare(label(b)) || a.localeCompare(b),
  );
});

// A vanished row must not leave a dialog open over it.
watch(
  () => listed.value,
  (keys) => {
    if (confirming.value !== null && !keys.includes(confirming.value)) {
      confirming.value = null;
    }
    if (switching.value !== null && !keys.includes(switching.value)) {
      switching.value = null;
    }
  },
);

const availableCount = computed(() =>
  props.availableNames ? props.availableNames.size : props.keys.length,
);

const countTone = computed(() => toneFor(availableCount.value, props.keys.length));

function slotState(key: string): SlotStance | null {
  if (props.availableNames === null) return null;
  if (!props.availableNames.has(key)) return "unavailable";
  return props.ifNeededNames.has(key) ? "if_needed" : "available";
}

// slotState reads a missing name as unavailable — right for a respondent, a lie
// for somebody who has not answered — so non-respondents keep the person icon.
const rows = computed(() =>
  listed.value.map((key) => {
    const answers = answered.value.has(key);
    const state = answers ? slotState(key) : null;
    return {
      key,
      name: label(key),
      answers,
      online: online.value.has(key),
      state,
      stateLabel: state ? STANCE_LABELS[state] : null,
      unavailable: state === "unavailable",
      ifNeeded: state === "if_needed",
      isCurrent: key === props.currentKey,
      isSolo: key === props.solo,
      // The eye draws state (on the chart right now), not the gesture. See `isOnChart`.
      onChart: isOnChart(props.solo, key),
    };
  }),
);

const confirmingName = computed(() =>
  confirming.value === null ? "" : label(confirming.value),
);
const switchingName = computed(() =>
  switching.value === null ? "" : label(switching.value),
);

// Mouse only: a tap's compatibility `pointerenter` reports `mouse` and would
// highlight whichever row re-rendered under the finger.
function onRowEnter(key: string, event: PointerEvent) {
  if (props.embedded || event.pointerType !== "mouse") return;
  emit("highlight", key);
}

function onRowFocus(key: string) {
  if (props.embedded) return;
  emit("highlight", key);
}

/** Moving between controls inside one row is not leaving it. */
function onRowBlur(event: FocusEvent) {
  if (props.embedded) return;
  const next = event.relatedTarget;
  const row = event.currentTarget;
  if (next instanceof Node && row instanceof Node && row.contains(next)) return;
  emit("highlight", null);
}

function confirmDelete() {
  const key = confirming.value;
  confirming.value = null;
  if (key) emit("delete", key);
}

function confirmSwitch() {
  const key = switching.value;
  switching.value = null;
  if (key) emit("switch", { key, displayName: label(key) });
}
</script>

<template>
  <aside class="panel" :class="{ 'panel--embedded': embedded }">
    <header v-if="!embedded || slotLabel" class="head" :class="{ 'head--slim': embedded }">
      <h2 v-if="!embedded" class="heading">
        Respondents
        <span class="count" :class="`count--${countTone}`">
          {{ availableCount }}/{{ keys.length }} available
        </span>
      </h2>
      <p v-if="slotLabel" class="slot">
        <span class="slot__label" :title="slotLabel">{{ slotLabel }}</span>
        <button
          v-if="pinned"
          type="button"
          class="unpin"
          aria-label="Unpin this slot"
          title="Unpin this slot"
          @click="emit('unpin')"
        >
          <IconClose aria-hidden="true" />
        </button>
      </p>
    </header>

    <p v-if="keys.length === 0" class="empty">No answers yet.</p>

    <ul class="names">
      <li
        v-for="row in rows"
        :key="row.key"
        class="name"
        :class="{
          unavailable: row.unavailable,
          if_needed: row.ifNeeded,
          dimmed: highlight !== null && highlight !== row.key,
          'is-current': row.isCurrent,
        }"
        @pointerenter="onRowEnter(row.key, $event)"
        @pointerleave="emit('highlight', null)"
        @focusin="onRowFocus(row.key)"
        @focusout="onRowBlur"
      >
        <span
          class="avatar"
          :class="row.state ? `avatar--${row.state}` : null"
          :role="row.stateLabel ? 'img' : undefined"
          :aria-label="row.stateLabel ?? undefined"
          :aria-hidden="row.stateLabel ? undefined : 'true'"
        >
          <IconCheck v-if="row.state === 'available'" />
          <IconHourglass v-else-if="row.state === 'if_needed'" />
          <IconClose v-else-if="row.state === 'unavailable'" stroke-width="2.2" />
          <IconPersonFilled v-else-if="row.isCurrent" />
          <IconPerson v-else />
        </span>

        <!-- Online state is said in words for screen readers; the dots are decoration. -->
        <span v-if="row.isCurrent" class="text" :title="row.name">
          {{ row.name }}<span v-if="row.online" class="hidden"> (online)</span>
        </span>
        <button
          v-else
          type="button"
          class="text text--switch"
          :title="`Answer as ${row.name}`"
          @click="switching = row.key"
        >
          {{ row.name }}<span v-if="row.online" class="hidden"> (online)</span>
        </button>

        <span v-if="row.online" class="dots" aria-hidden="true">
          <span class="dot" />
          <span class="dot" />
          <span class="dot" />
        </span>

        <button
          v-if="embedded"
          type="button"
          class="reveal"
          :class="{ 'reveal--on': row.isSolo, 'reveal--hidden': !row.onChart }"
          :aria-pressed="row.isSolo"
          :aria-label="row.isSolo ? 'Show everyone again' : `Show only ${row.name}`"
          :title="row.isSolo ? 'Show everyone again' : `Show only ${row.name}`"
          @click="emit('solo', row.isSolo ? null : { key: row.key, displayName: row.name })"
        >
          <IconEye v-if="row.onChart" aria-hidden="true" />
          <IconEyeOff v-else aria-hidden="true" />
        </button>

        <template v-if="row.answers">
          <span v-if="deleting === row.key" class="busy">
            <Spinner :size="15" :label="`Removing ${row.name}`" />
          </span>
          <button
            v-else
            type="button"
            class="remove"
            :disabled="deleting !== null"
            :aria-label="`Remove ${row.name}`"
            :title="`Remove ${row.name}`"
            @click="confirming = row.key"
          >
            <IconTrash stroke-width="1.7" aria-hidden="true" />
          </button>
        </template>
      </li>

      <li class="add">
        <button type="button" class="add__button" @click="emit('add')">
          <span class="avatar" aria-hidden="true">
            <IconPlus stroke-width="2" />
          </span>
          <span class="text">Add someone</span>
        </button>
      </li>
    </ul>

    <p v-if="deleteError" class="error" role="alert">{{ deleteError }}</p>

    <ConfirmDialog
      :open="confirming !== null"
      title="Remove this response?"
      confirm-label="Remove"
      @confirm="confirmDelete"
      @close="confirming = null"
    >
      This deletes everything <strong>{{ confirmingName }}</strong> marked and
      takes them off the respondents list. They can answer again from the same
      link.
    </ConfirmDialog>

    <ConfirmDialog
      :open="switching !== null"
      :title="`Switch to ${switchingName}?`"
      confirm-label="Switch"
      tone="primary"
      @confirm="confirmSwitch"
      @close="switching = null"
    >
      The grid loads what <strong>{{ switchingName }}</strong> marked, and
      anything you change is saved as them.
    </ConfirmDialog>
  </aside>
</template>

<style scoped>
.panel {
  min-width: 12rem;
  padding: 0.85rem;
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-sm);
}

.panel--embedded {
  min-width: 0;
  padding: 0.35rem 0 0;
  background: none;
  border: none;
  border-radius: 0;
  box-shadow: none;
}

/* Height held open so the list does not jump as the pointer crosses the grid. */
.head {
  min-height: 2.9rem;
  padding-bottom: 0.6rem;
  margin-bottom: 0.6rem;
  border-bottom: 1px solid var(--color-border);
}

.head--slim {
  min-height: 0;
}

.head--slim .slot {
  margin-top: 0;
}

.heading {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 0.4rem;
  font-size: 0.875rem;
  font-weight: 600;
}

.count {
  font-size: 0.8125rem;
  font-weight: 500;
  white-space: nowrap;
}

.count--all {
  color: var(--color-success);
}

.count--some {
  color: var(--color-warning);
}

.count--none {
  color: var(--color-danger);
}

/* One line only: a wrapped slot label walks through the head's min-height. */
.slot {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  min-width: 0;
  margin-top: 0.2rem;
  font-size: 0.75rem;
  color: var(--color-text-muted);
}

.slot__label {
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.unpin {
  display: inline-grid;
  flex: none;
  place-items: center;
  width: 1.15rem;
  height: 1.15rem;
  padding: 0;
  color: var(--color-accent);
  background: var(--color-accent-soft);
  border: none;
  border-radius: var(--radius-sm);
  cursor: pointer;
}

.unpin svg {
  width: 0.7rem;
  height: 0.7rem;
}

@media (pointer: coarse) {
  .unpin {
    width: 1.6rem;
    height: 1.6rem;
  }
}

.empty {
  margin-bottom: 0.5rem;
  font-size: 0.8125rem;
  color: var(--color-text-muted);
}

/* One shared row height; under a coarse pointer it grows to the 44px tap floor. */
.names {
  --row-height: 2rem;

  display: flex;
  flex-direction: column;
  gap: 0.1rem;
  padding: 0;
  margin: 0;
  list-style: none;
}

.name {
  display: flex;
  align-items: center;
  gap: 0.45rem;
  min-height: var(--row-height);
  padding-left: 0.35rem;
  font-size: 0.875rem;
  border-radius: var(--radius-sm);
  cursor: default;
}

/* (hover: hover) only: a tap's compatibility mouse event would leave the last row lit. */
@media (hover: hover) {
  .name:hover {
    background: var(--color-subtle);
  }
}

.name.unavailable .text {
  text-decoration: line-through;
  color: var(--color-text-muted);
}

.name.if_needed {
  background: var(--color-warning-soft);
}

.name.dimmed {
  opacity: 0.45;
}

.avatar {
  display: grid;
  flex: none;
  place-items: center;
  width: 1.05rem;
  height: 1.05rem;
  color: var(--color-text-muted);
}

.avatar svg {
  width: 100%;
  height: 100%;
}

.name.is-current .avatar {
  color: var(--color-accent);
}

/* Stance colours win over the current-visitor accent: on a slot the icon reports the slot. */
.avatar--available,
.name.is-current .avatar--available {
  color: var(--color-accent-text);
}

.avatar--if_needed,
.name.is-current .avatar--if_needed {
  color: var(--color-if-needed-text);
}

.avatar--unavailable,
.name.is-current .avatar--unavailable {
  color: var(--color-danger);
}

.name.is-current .text {
  font-weight: 600;
}

/* One line: a wrapped name breaks the shared --row-height for the whole list. */
.text {
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  text-align: left;
}

.text--switch {
  padding: 0;
  font: inherit;
  color: inherit;
  background: none;
  border: none;
  cursor: pointer;
}

@media (hover: hover) {
  .text--switch:hover {
    text-decoration: underline;
  }
}

.text--switch:focus-visible {
  border-radius: var(--radius-sm);
}

/* Visually hidden, spoken by screen readers. */
.hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}

.dots {
  display: inline-flex;
  flex: none;
  gap: 0.15rem;
  align-items: center;
  color: var(--color-accent);
}

.dot {
  width: 0.25rem;
  height: 0.25rem;
  background: currentColor;
  border-radius: var(--radius-pill);
  animation: presence-pulse 1.5s ease-in-out infinite;
}

.dot:nth-child(2) {
  animation-delay: 0.2s;
}

.dot:nth-child(3) {
  animation-delay: 0.4s;
}

@keyframes presence-pulse {
  0%,
  70%,
  100% {
    opacity: 0.35;
  }

  30% {
    opacity: 1;
  }
}

@media (prefers-reduced-motion: reduce) {
  .dot {
    animation: none;
    opacity: 0.8;
  }
}

.tag {
  flex: none;
  font-size: 0.6875rem;
  color: var(--color-if-needed-text);
}

.tag,
.busy,
.reveal,
.remove {
  margin-left: auto;
}

/* Only the first trailing control takes the slack; the rest sit beside it. */
.reveal ~ .busy,
.reveal ~ .remove {
  margin-left: 0;
}

/* The spinner takes the same box so the row does not resize mid-delete. */
.busy,
.reveal,
.remove {
  display: grid;
  flex: none;
  place-items: center;
  align-self: stretch;
  width: var(--row-height);
  padding: 0;
  color: var(--color-text-muted);
  background: none;
  border: none;
  border-radius: 0 var(--radius-sm) var(--radius-sm) 0;
}

.remove {
  /* Focus ring drawn inside: an outside ring would be clipped at the row's edge. */
  --focus-ring-inset: calc(var(--focus-ring-offset) * -1);

  cursor: pointer;
  /* Hidden until hover/focus, but kept in the layout so nothing shifts. */
  opacity: 0;
  transition: opacity var(--transition-fast), color var(--transition-fast),
    background var(--transition-fast);
}

.remove svg {
  width: 62%;
  max-width: 1.35rem;
  height: auto;
}

.name:hover .remove,
.remove:focus-visible {
  opacity: 1;
}

@media (hover: hover) {
  .remove:hover:not(:disabled) {
    color: var(--color-danger);
    background: var(--color-danger-soft);
  }
}

.remove:disabled {
  cursor: not-allowed;
}

.reveal {
  /* Focus ring inside, same as .remove: the button reaches the row's edge. */
  --focus-ring-inset: calc(var(--focus-ring-offset) * -1);

  cursor: pointer;
  transition: color var(--transition-fast), background var(--transition-fast),
    opacity var(--transition-fast);
}

.reveal svg {
  width: 58%;
  max-width: 1.3rem;
  height: auto;
}

@media (hover: hover) {
  .reveal:hover {
    color: var(--color-text);
    background: var(--color-subtle);
  }
}

.reveal--on,
.reveal--on:hover {
  color: var(--color-accent-contrast);
  background: var(--color-accent);
}

.reveal--hidden {
  opacity: 0.55;
}

@media (hover: hover) {
  .reveal--hidden:hover {
    opacity: 1;
  }
}

.add {
  margin-top: 0.25rem;
}

.add__button {
  display: flex;
  align-items: center;
  gap: 0.45rem;
  width: 100%;
  min-height: var(--row-height);
  padding: 0 0.35rem;
  font: inherit;
  font-size: 0.875rem;
  color: var(--color-text-muted);
  background: none;
  border: 1px dashed var(--color-border-strong);
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: color var(--transition-fast), border-color var(--transition-fast),
    background var(--transition-fast);
}

@media (hover: hover) {
  .add__button:hover {
    color: var(--color-text);
    background: var(--color-subtle);
    border-color: var(--color-accent);
  }
}

/* Touch has no hover to reveal on. */
@media (pointer: coarse) {
  .names {
    --row-height: var(--tap-min);
  }

  .remove {
    opacity: 1;
  }
}

.error {
  margin-top: 0.5rem;
  font-size: 0.75rem;
  color: var(--color-danger);
}
</style>
