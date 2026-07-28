<script setup lang="ts">
/**
 * Who answered, and who is free at the slot under the pointer.
 *
 * With no slot active the list is a roster: every name reads as available (the
 * legacy default) behind a person icon, filled for the visitor's own row and
 * outlined for everyone else, so they are findable at a glance in a list of
 * strangers.
 *
 * Hovering or pinning a slot turns the roster into an answer for that slot:
 * each person icon becomes the mark that person made — a green check, an
 * amber hourglass for if-needed, a red cross for unavailable — in the same
 * three colours the grid and its legend use. The glyphs differ in shape as
 * well as hue, so the reading survives a monochrome screen. Releasing the slot
 * puts the person icons back.
 *
 * Removing a response is offered to everyone, not just the admin: the event's
 * URL is the trust boundary and the endpoint behind it is public
 * (ARCHITECTURE.md § API), so gating the button only hid a door that was
 * already unlocked — from the guest who most often needs it, the one who
 * answered twice under two spellings. Because it is destructive and one row
 * looks much like the next, it confirms in a dialog that names the respondent
 * rather than in the row, which would make the list jump as you aim.
 *
 * The dashed row at the bottom is the way to answer as somebody else: it opens
 * the same identity dialog with an empty field. Clicking a name that is already
 * there does the same thing for that person — after a confirm, because it means
 * editing somebody else's times and one row looks much like the next.
 */
import { computed, ref, watch } from "vue";
import Button from "../ui/Button.vue";
import Dialog from "../ui/Dialog.vue";
import Spinner from "../ui/Spinner.vue";
import IconCheck from "../../assets/icons/check.svg";
import IconHourglass from "../../assets/icons/hourglass.svg";
import IconClose from "../../assets/icons/close.svg";
import IconPersonFilled from "../../assets/icons/person-filled.svg";
import IconPerson from "../../assets/icons/person.svg";
import IconTrash from "../../assets/icons/trash.svg";
import IconPlus from "../../assets/icons/plus.svg";

const props = defineProps<{
  /**
   * Inside a drawer the card chrome and the heading are the drawer's own, so
   * both are dropped and only the answer is left.
   */
  embedded?: boolean;
  names: string[];
  /** Names available at the active slot. Null when no slot is active. */
  availableNames: Set<string> | null;
  ifNeededNames: Set<string>;
  slotLabel: string | null;
  pinned: boolean;
  highlight: string | null;
  /** The visitor's own name, when they have one. */
  currentName: string | null;
  /** Name whose delete is in flight, if any. */
  deleting: string | null;
  deleteError: string | null;
}>();

const emit = defineEmits<{
  highlight: [name: string | null];
  unpin: [];
  delete: [name: string];
  add: [];
  switch: [name: string];
}>();

/** The respondent the delete dialog is asking about. At most one. */
const confirming = ref<string | null>(null);
/** The respondent the switch-identity dialog is asking about. */
const switching = ref<string | null>(null);

// A row that has gone (deleted, or the event reloaded) must not leave a dialog
// open over a name that is no longer there.
watch(
  () => props.names,
  (names) => {
    if (confirming.value !== null && !names.includes(confirming.value)) {
      confirming.value = null;
    }
    if (switching.value !== null && !names.includes(switching.value)) {
      switching.value = null;
    }
  },
);

const availableCount = computed(() =>
  props.availableNames ? props.availableNames.size : props.names.length,
);

/**
 * How the count reads at a glance: everyone free is the answer you are looking
 * for, nobody free rules the slot out, and anything between is a compromise to
 * weigh. Same three colours the rest of the app uses for good/attention/bad.
 */
const countTone = computed(() => {
  if (availableCount.value === 0) return "none";
  return availableCount.value === props.names.length ? "all" : "some";
});

type SlotState = "available" | "if-needed" | "unavailable";

const SLOT_STATE_LABELS: Record<SlotState, string> = {
  available: "Available",
  "if-needed": "If needed",
  unavailable: "Unavailable",
};

/** What this person said about the active slot, or null when none is active. */
function slotState(name: string): SlotState | null {
  if (props.availableNames === null) return null;
  if (!props.availableNames.has(name)) return "unavailable";
  return props.ifNeededNames.has(name) ? "if-needed" : "available";
}

/**
 * One pass over the names for the whole list. The icon names the slot only
 * while there is a slot to name: off a slot it is decoration next to the name
 * it belongs to and stays out of the accessibility tree; on one it carries the
 * answer, which is nowhere else in the row.
 */
const rows = computed(() =>
  props.names.map((name) => {
    const state = slotState(name);
    return {
      name,
      state,
      label: state ? SLOT_STATE_LABELS[state] : null,
      unavailable: state === "unavailable",
      ifNeeded: state === "if-needed",
      isCurrent: name === props.currentName,
    };
  }),
);

function confirmDelete() {
  const name = confirming.value;
  confirming.value = null;
  if (name) emit("delete", name);
}

function confirmSwitch() {
  const name = switching.value;
  switching.value = null;
  if (name) emit("switch", name);
}
</script>

<template>
  <aside class="panel" :class="{ 'panel--embedded': embedded }">
    <header class="head">
      <h2 class="heading">
        <template v-if="!embedded">Respondents</template>
        <span class="count" :class="`count--${countTone}`">
          {{ availableCount }}/{{ names.length }} available
        </span>
      </h2>
      <p v-if="slotLabel" class="slot">
        {{ slotLabel }}
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

    <p v-if="names.length === 0" class="empty">No answers yet.</p>

    <ul class="names">
      <li
        v-for="row in rows"
        :key="row.name"
        class="name"
        :class="{
          unavailable: row.unavailable,
          'if-needed': row.ifNeeded,
          dimmed: highlight !== null && highlight !== row.name,
          'is-current': row.isCurrent,
        }"
        @pointerenter="emit('highlight', row.name)"
        @pointerleave="emit('highlight', null)"
      >
        <span
          class="avatar"
          :class="row.state ? `avatar--${row.state}` : null"
          :role="row.label ? 'img' : undefined"
          :aria-label="row.label ?? undefined"
          :aria-hidden="row.label ? undefined : 'true'"
        >
          <!-- On a slot: what this person marked there. -->
          <IconCheck v-if="row.state === 'available'" />
          <IconHourglass v-else-if="row.state === 'if-needed'" />
          <IconClose v-else-if="row.state === 'unavailable'" stroke-width="2.2" />
          <!-- Off a slot: filled for you, outlined for everyone else. -->
          <IconPersonFilled v-else-if="row.isCurrent" />
          <IconPerson v-else />
        </span>

        <!-- Your own row is not a button: there is nothing to switch to. -->
        <span v-if="row.isCurrent" class="text">{{ row.name }}</span>
        <button
          v-else
          type="button"
          class="text text--switch"
          :title="`Answer as ${row.name}`"
          @click="switching = row.name"
        >
          {{ row.name }}
        </button>

        <span v-if="deleting === row.name" class="busy">
          <Spinner :size="15" :label="`Removing ${row.name}`" />
        </span>
        <button
          v-else
          type="button"
          class="remove"
          :disabled="deleting !== null"
          :aria-label="`Remove ${row.name}`"
          :title="`Remove ${row.name}`"
          @click="confirming = row.name"
        >
          <IconTrash stroke-width="1.7" aria-hidden="true" />
        </button>
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

    <Dialog
      :open="confirming !== null"
      title="Remove this response?"
      @close="confirming = null"
    >
      <div class="confirm">
        <p class="confirm__text">
          This deletes everything <strong>{{ confirming }}</strong> marked on this
          event and takes them off the respondents list. They can answer again
          from the same link.
        </p>
        <div class="confirm__actions">
          <Button variant="ghost" @click="confirming = null">Cancel</Button>
          <Button variant="danger" @click="confirmDelete">Remove</Button>
        </div>
      </div>
    </Dialog>

    <Dialog
      :open="switching !== null"
      :title="`Switch to ${switching}?`"
      @close="switching = null"
    >
      <div class="confirm">
        <p class="confirm__text">
          You’ll be editing their availability: the grid loads what
          <strong>{{ switching }}</strong> marked, and anything you change is
          saved as them.
        </p>
        <div class="confirm__actions">
          <Button variant="ghost" @click="switching = null">Cancel</Button>
          <Button variant="primary" @click="confirmSwitch">Switch</Button>
        </div>
      </div>
    </Dialog>
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
  padding: 0;
  background: none;
  border: none;
  border-radius: 0;
  box-shadow: none;
}

/* The slot line comes and goes with the slot. Its height is held open so the
   list below does not jump as the pointer crosses the grid — the old copy that
   filled the space said only what hovering a cell says by itself. */
.head {
  min-height: 2.9rem;
  padding-bottom: 0.6rem;
  margin-bottom: 0.6rem;
  border-bottom: 1px solid var(--color-border);
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

.slot {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.4rem;
  margin-top: 0.2rem;
  font-size: 0.75rem;
  color: var(--color-text-muted);
}

/* Releases the pinned slot. A cross on the label it undoes, the way a chip
   drops its own value. */
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

.unpin:focus-visible {
  outline: var(--focus-ring);
  outline-offset: var(--focus-ring-offset);
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

/* One row height for the whole list: the name rows, the add row and the square
   delete button at the end of each row all read it, so they cannot drift apart.
   Under a coarse pointer it grows to the 44px tap floor and takes the button
   with it. */
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

.name:hover {
  background: var(--color-subtle);
}

.name.unavailable .text {
  text-decoration: line-through;
  color: var(--color-text-muted);
}

/* A wash rather than the legend's own fill: the hourglass sits on top of it and
   has to stay readable, and the row is a caption for the slot, not a swatch. */
.name.if-needed {
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

/* The three answers, in the grid's own three colours at ink weight. These win
   over the current-visitor accent above: on a slot the icon reports the slot,
   not whose row it is — the bold name still says that. */
.avatar--available,
.name.is-current .avatar--available {
  color: var(--color-accent-text);
}

.avatar--if-needed,
.name.is-current .avatar--if-needed {
  color: var(--color-if-needed-text);
}

.avatar--unavailable,
.name.is-current .avatar--unavailable {
  color: var(--color-danger);
}

.name.is-current .text {
  font-weight: 600;
}

.text {
  min-width: 0;
  overflow-wrap: anywhere;
  text-align: left;
}

/* A name you can answer as. Kept looking like text — it is one item in a list
   of names, not a row of buttons — and says so on hover and focus. */
.text--switch {
  padding: 0;
  font: inherit;
  color: inherit;
  background: none;
  border: none;
  cursor: pointer;
}

.text--switch:hover {
  text-decoration: underline;
}

.text--switch:focus-visible {
  outline: var(--focus-ring);
  outline-offset: var(--focus-ring-offset);
  border-radius: var(--radius-sm);
}

.tag {
  flex: none;
  font-size: 0.6875rem;
  color: var(--color-if-needed-text);
}

/* --- removing a respondent ------------------------------------------------ */

/* Whatever trails the name is pushed to the right edge of the row; when both a
   tag and a control are present the first `auto` eats the slack and the rest
   sit beside it. */
.tag,
.busy,
.remove {
  margin-left: auto;
}

/* Full-height square hard against the row's right edge — no padding of its
   own, so the glyph is as big as the row allows and there is nothing to miss.
   The spinner takes the same box so the row does not resize mid-delete. */
.busy,
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
  cursor: pointer;
  /* Hidden until the row is hovered or the button is tabbed to, so the list
     stays a list. Kept in the layout so nothing shifts on hover. */
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

.remove:hover:not(:disabled) {
  color: var(--color-danger);
  background: var(--color-danger-soft);
}

.remove:focus-visible {
  outline: var(--focus-ring);
  outline-offset: calc(var(--focus-ring-offset) * -1);
}

.remove:disabled {
  cursor: not-allowed;
}

/* --- add someone ---------------------------------------------------------- */

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

.add__button:hover {
  color: var(--color-text);
  background: var(--color-subtle);
  border-color: var(--color-accent);
}

.add__button:focus-visible {
  outline: var(--focus-ring);
  outline-offset: var(--focus-ring-offset);
}

/* Touch has no hover to reveal on, and no cursor to aim with. */
@media (pointer: coarse) {
  .names {
    --row-height: var(--tap-min);
  }

  .remove {
    opacity: 1;
  }
}

.confirm {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.confirm__text {
  font-size: 0.875rem;
  line-height: 1.5;
  color: var(--color-text-muted);
}

.confirm__actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 0.5rem;
}

.error {
  margin-top: 0.5rem;
  font-size: 0.75rem;
  color: var(--color-danger);
}

@media (prefers-reduced-motion: reduce) {
  .remove,
  .add__button {
    transition: none;
  }
}
</style>
