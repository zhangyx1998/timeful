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
 *
 * On a phone, where the chart is a heatmap and this list is behind a drawer,
 * each answered row also offers to put its owner's answer on the chart *alone*.
 * A sum cannot say who is behind it, and that is the one question about the
 * chart the colours can never answer. Doing so collapses the list to that
 * person — the sheet would otherwise cover the very chart it just changed — and
 * the way back is where the list's action row always is.
 *
 * Whoever is on the page right now gets three quietly pulsing dots after their
 * name, the visitor included — they are online too, and a rule with no
 * exceptions is one nobody has to learn. Somebody who is here but has not
 * answered yet is a row all the same: it is the moment you most want to know
 * they arrived. Such a row has no answer to show, so it keeps the person icon
 * whatever slot is active, counts towards nothing, and offers no delete —
 * there is nothing stored to delete. Their first save turns it into an ordinary
 * row where it already sits, and closing their tab takes it away again.
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
import IconEye from "../../assets/icons/eye.svg";
import IconEyeOff from "../../assets/icons/eye-off.svg";
import IconPeople from "../../assets/icons/people.svg";
import type { PresenceEntry } from "../../lib/realtime";

const props = defineProps<{
  /**
   * Inside a drawer the card chrome and the heading are the drawer's own, so
   * both are dropped and only the answer is left.
   */
  embedded?: boolean;
  /**
   * Everyone with a stored answer, by user key. The counts are about these and
   * only these: being on the page is not an answer.
   *
   * Keys throughout, and never the names themselves — matching a respondent
   * against a presence entry and against the visitor's own identity is exactly
   * what a key is for. `labels` says how each one is spelled on screen.
   */
  keys: string[];
  labels: Map<string, string>;
  /**
   * Everyone the server says holds a write session on this event right now,
   * whether or not they have answered. Empty when there is no live connection.
   */
  present: PresenceEntry[];
  /** Keys available at the active slot. Null when no slot is active. */
  availableNames: Set<string> | null;
  ifNeededNames: Set<string>;
  slotLabel: string | null;
  pinned: boolean;
  highlight: string | null;
  /** The visitor's own key, when they have one. */
  currentKey: string | null;
  /** Key whose delete is in flight, if any. */
  deleting: string | null;
  deleteError: string | null;
  /**
   * Whether a row may ask the chart to show its owner's answer and nothing
   * else. The phone's group view only: on a desktop the heatmap and the person
   * you are pointing at are on screen together already, and while you are
   * writing your own answer the chart is not showing anybody else's to narrow.
   */
  soloable?: boolean;
  /** Whose answer the chart is showing alone, if anyone's. By key. */
  solo?: string | null;
}>();

const emit = defineEmits<{
  highlight: [key: string | null];
  unpin: [];
  delete: [key: string];
  add: [];
  /** Adopt this person's identity. The display name goes with the key: it is
   *  what the identity dialog and the save both need. */
  switch: [person: { key: string; displayName: string }];
  /** Show this one person's answer on the chart, or null for the group's. */
  solo: [key: string | null];
}>();

/** The respondent the delete dialog is asking about. At most one. */
const confirming = ref<string | null>(null);
/** The respondent the switch-identity dialog is asking about. */
const switching = ref<string | null>(null);

/** Who has a stored answer, as a set: asked once per row below. */
const answered = computed(() => new Set(props.keys));
const online = computed(() => new Set(props.present.map((person) => person.key)));

/**
 * How each key is spelled: the stored response's own display name when there is
 * one, and otherwise whatever the presence entry claims.
 *
 * The record wins on purpose. A page can connect as `ada-lovelace` spelling
 * itself "ada LOVELACE" while the stored answer says "Ada Lovelace", and the
 * list must show one row with the name the group already recognises rather than
 * the shouting of whoever happens to be online.
 */
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

/**
 * Every key the list shows: the respondents, plus anyone who is here without
 * having answered, in one run ordered by the name each is shown under so a row
 * does not move when its owner finally saves something.
 */
const listed = computed(() => {
  const extra = props.present
    .map((person) => person.key)
    .filter((key) => !answered.value.has(key));
  if (extra.length === 0) return props.keys;
  return [...new Set([...props.keys, ...extra])].sort(
    (a, b) => label(a).localeCompare(label(b)) || a.localeCompare(b),
  );
});

// A row that has gone — deleted, the event reloaded, or somebody who was only
// here and has now closed the tab — must not leave a dialog open over a person
// who is no longer in the list.
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

/**
 * How many of the respondents are free at the active slot, out of how many
 * answered. Both halves are about stored answers: somebody who is on the page
 * without having answered is on neither side of the fraction, and cannot be —
 * they have marked nothing, so there is nothing of theirs to count.
 */
const availableCount = computed(() =>
  props.availableNames ? props.availableNames.size : props.keys.length,
);

/**
 * How the count reads at a glance: everyone free is the answer you are looking
 * for, nobody free rules the slot out, and anything between is a compromise to
 * weigh. Same three colours the rest of the app uses for good/attention/bad.
 */
const countTone = computed(() => {
  if (availableCount.value === 0) return "none";
  return availableCount.value === props.keys.length ? "all" : "some";
});

type SlotState = "available" | "if-needed" | "unavailable";

const SLOT_STATE_LABELS: Record<SlotState, string> = {
  available: "Available",
  "if-needed": "If needed",
  unavailable: "Unavailable",
};

/** What this person said about the active slot, or null when none is active. */
function slotState(key: string): SlotState | null {
  if (props.availableNames === null) return null;
  if (!props.availableNames.has(key)) return "unavailable";
  return props.ifNeededNames.has(key) ? "if-needed" : "available";
}

/**
 * One pass over the names for the whole list. The icon names the slot only
 * while there is a slot to name: off a slot it is decoration next to the name
 * it belongs to and stays out of the accessibility tree; on one it carries the
 * answer, which is nowhere else in the row.
 *
 * A row with no answer behind it never reaches that state. `slotState` reads a
 * missing name as unavailable, which is right for a respondent who left the
 * slot blank and a lie about somebody who has not answered at all — so they are
 * asked nothing and keep the person icon.
 */
/**
 * Whether the chart is currently showing one person's answer alone.
 *
 * A name nobody has an answer for cannot be soloed — there would be nothing on
 * the chart to see — so a stale name simply reads as off.
 */
const soloing = computed(
  () => Boolean(props.soloable && props.solo) && answered.value.has(props.solo as string),
);

/**
 * While one person's answer is on the chart the list collapses to that person.
 *
 * Not for tidiness: the drawer is a bottom sheet and a full list of it covers
 * the chart completely on a phone, so a single-person heatmap nobody can see
 * would be a setting rather than a view. Collapsed, the sheet is two rows tall
 * and the chart it is describing is above it.
 */
const rows = computed(() =>
  (soloing.value ? [props.solo as string] : listed.value).map((key) => {
    const answers = answered.value.has(key);
    const state = answers ? slotState(key) : null;
    return {
      key,
      name: label(key),
      answers,
      online: online.value.has(key),
      state,
      stateLabel: state ? SLOT_STATE_LABELS[state] : null,
      unavailable: state === "unavailable",
      ifNeeded: state === "if-needed",
      isCurrent: key === props.currentKey,
      // Nothing stored means nothing to put on the chart alone.
      soloable: Boolean(props.soloable) && answers,
      isSolo: soloing.value && key === props.solo,
    };
  }),
);

/** The name behind a key the dialogs are asking about. */
const confirmingName = computed(() =>
  confirming.value === null ? "" : label(confirming.value),
);
const switchingName = computed(() =>
  switching.value === null ? "" : label(switching.value),
);

/**
 * The hover highlight, which is a hover and nothing else.
 *
 * Two things kept it from being one. Inside a drawer there is nothing to
 * highlight *for*: the sheet is over the chart the highlight would change, so
 * pointing at a row there can only narrow something nobody can see — and on a
 * phone the row was reached by a finger, which lands and is never reported as
 * having left, so the chart used to be stuck on one person's answer with no way
 * back. That is what the eye exists for instead.
 *
 * The pointer type matters even on a desktop, because a tap is followed by a
 * compatibility `pointerenter` that says `mouse`: after a list has been
 * re-rendered under the finger, that phantom lands on whichever row has moved
 * into the gap and highlights somebody nobody pointed at.
 *
 * Leaving always clears, whatever the pointer: a highlight nobody set is still
 * one worth dropping.
 */
function onRowEnter(key: string, event: PointerEvent) {
  if (props.embedded || event.pointerType !== "mouse") return;
  emit("highlight", key);
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
  <aside class="panel" :class="{ 'panel--embedded': embedded, 'panel--solo': soloing }">
    <!-- Collapsed to one person, the head goes: the fraction and the slot it is
         about are a reading of the group's answer, which is exactly what has
         been set aside. The drawer's own title names whose chart it is. -->
    <header v-if="!soloing" class="head">
      <h2 class="heading">
        <template v-if="!embedded">Respondents</template>
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

    <p v-if="keys.length === 0 && !soloing" class="empty">No answers yet.</p>

    <ul class="names">
      <li
        v-for="row in rows"
        :key="row.key"
        class="name"
        :class="{
          unavailable: row.unavailable,
          'if-needed': row.ifNeeded,
          dimmed: highlight !== null && highlight !== row.key,
          'is-current': row.isCurrent,
        }"
        @pointerenter="onRowEnter(row.key, $event)"
        @pointerleave="emit('highlight', null)"
      >
        <span
          class="avatar"
          :class="row.state ? `avatar--${row.state}` : null"
          :role="row.stateLabel ? 'img' : undefined"
          :aria-label="row.stateLabel ?? undefined"
          :aria-hidden="row.stateLabel ? undefined : 'true'"
        >
          <!-- On a slot: what this person marked there. -->
          <IconCheck v-if="row.state === 'available'" />
          <IconHourglass v-else-if="row.state === 'if-needed'" />
          <IconClose v-else-if="row.state === 'unavailable'" stroke-width="2.2" />
          <!-- Off a slot: filled for you, outlined for everyone else. -->
          <IconPersonFilled v-else-if="row.isCurrent" />
          <IconPerson v-else />
        </span>

        <!-- Your own row is not a button: there is nothing to switch to. The
             online state is said in words for a screen reader, where three
             animated dots would be either silence or noise. -->
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

        <!-- Here right now. Decoration for the words beside it, so it is not in
             the accessibility tree at all. -->
        <span v-if="row.online" class="dots" aria-hidden="true">
          <span class="dot" />
          <span class="dot" />
          <span class="dot" />
        </span>

        <!-- Puts this person's answer on the chart on its own. A heatmap is a
             sum, and a sum cannot say who is behind it; this is the one
             question the list is asked that the colours cannot answer. Only
             where the chart is showing the group's answer to narrow, and only
             for a row with something stored to show. -->
        <button
          v-if="row.soloable"
          type="button"
          class="reveal"
          :class="{ 'reveal--on': row.isSolo }"
          :aria-pressed="row.isSolo"
          :aria-label="row.isSolo ? 'Show everyone again' : `Show only ${row.name}`"
          :title="row.isSolo ? 'Show everyone again' : `Show only ${row.name}`"
          @click="emit('solo', row.isSolo ? null : row.key)"
        >
          <IconEyeOff v-if="row.isSolo" aria-hidden="true" />
          <IconEye v-else aria-hidden="true" />
        </button>

        <!-- Nothing is stored for somebody who is only here, so there is
             nothing for a delete to do. And with the list collapsed to a single
             row, a bin beside it is only something to hit by mistake. -->
        <template v-if="row.answers && !soloing">
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

      <!-- The way back to the group's answer, in the place the list's own
           action row always sits. -->
      <li v-if="soloing" class="add">
        <button type="button" class="add__button" @click="emit('solo', null)">
          <span class="avatar" aria-hidden="true">
            <IconPeople />
          </span>
          <span class="text">Show everyone</span>
        </button>
      </li>

      <li v-else class="add">
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
          This deletes everything <strong>{{ confirmingName }}</strong> marked on this
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
      :title="`Switch to ${switchingName}?`"
      @close="switching = null"
    >
      <div class="confirm">
        <p class="confirm__text">
          You’ll be editing their availability: the grid loads what
          <strong>{{ switchingName }}</strong> marked, and anything you change is
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

/* "3/5 available" is one fact and breaks as one: the word must not come away
   from the fraction it qualifies. */
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

/* Held to one line: the head's `min-height` above is what stops the list
   jumping as the pointer crosses the grid, and a slot label that wraps to two
   lines walks straight through it. */
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

/* Only where a pointer can actually hover. A tap is followed by a compatibility
   mouse event, which would otherwise leave whichever row the finger last touched
   lit as though the pointer were still resting on it. */
@media (hover: hover) {
  .name:hover {
    background: var(--color-subtle);
  }
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

/* One line, and the first thing on the row to give way. Every row in this list
   is one --row-height tall, and a name allowed to wrap breaks that for the whole
   list: the delete button, the eye and the spinner are all sized off it. The
   dots and the controls are siblings rather than part of this box, so they stay
   put at their own end of the row when the name is cut — the dots land just
   after the ellipsis, still reading as "this person, here right now". */
.text {
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
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

@media (hover: hover) {
  .text--switch:hover {
    text-decoration: underline;
  }
}

.text--switch:focus-visible {
  outline: var(--focus-ring);
  outline-offset: var(--focus-ring-offset);
  border-radius: var(--radius-sm);
}

/* What the dots say, for anyone who is not looking at them. */
.hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}

/* --- here right now ------------------------------------------------------- */

/* Three dots after the name, in the accent the page already uses for "you and
   yours". They sit tight against the name rather than at the row's end, because
   they are part of it: the row's right edge belongs to the delete button. */
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
  /* The wave runs at a third of the way apart, so the three read as one
     travelling pulse rather than as a flicker. */
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

/* Whoever asked for less movement gets the fact without the animation: three
   dots, evenly lit, saying exactly what the moving ones say. */
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

/* --- removing a respondent ------------------------------------------------ */

/* Whatever trails the name is pushed to the right edge of the row; when both a
   tag and a control are present the first `auto` eats the slack and the rest
   sit beside it. */
.tag,
.busy,
.reveal,
.remove {
  margin-left: auto;
}

/* Only the first of them takes the slack. Two controls each claiming it would
   leave the first stranded in the middle of the row instead of beside the
   second, at the edge where the row's controls live. */
.reveal ~ .busy,
.reveal ~ .remove {
  margin-left: 0;
}

/* Full-height square hard against the row's right edge — no padding of its
   own, so the glyph is as big as the row allows and there is nothing to miss.
   The spinner takes the same box so the row does not resize mid-delete. */
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

@media (hover: hover) {
  .remove:hover:not(:disabled) {
    color: var(--color-danger);
    background: var(--color-danger-soft);
  }
}

.remove:focus-visible {
  outline: var(--focus-ring);
  outline-offset: calc(var(--focus-ring-offset) * -1);
}

.remove:disabled {
  cursor: not-allowed;
}

/* --- one person's answer, alone -------------------------------------------- */

/* Sits where the delete does when both are there, and takes the row's edge when
   it is alone — collapsed to a single row the delete is gone, and this is the
   only thing at that end. Always visible: there is no hover to reveal it on
   where it is offered at all. */
.reveal {
  cursor: pointer;
  transition: color var(--transition-fast), background var(--transition-fast);
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

/* On, and the only thing on the row that says so besides the chart itself. The
   accent rather than a neutral fill: it is the same "you asked for this" the
   page uses everywhere, and it has to read at a glance from a row that is now
   the whole list. */
.reveal--on,
.reveal--on:hover {
  color: var(--color-accent-contrast);
  background: var(--color-accent);
}

.reveal:focus-visible {
  outline: var(--focus-ring);
  outline-offset: calc(var(--focus-ring-offset) * -1);
}

/* Collapsed, the panel is two rows and no more: the chart above it is what the
   drawer is now for, so it spends nothing on anything else. */
.panel--solo .names {
  gap: 0.25rem;
}

.panel--solo .name {
  background: var(--color-subtle);
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

@media (hover: hover) {
  .add__button:hover {
    color: var(--color-text);
    background: var(--color-subtle);
    border-color: var(--color-accent);
  }
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
  .reveal,
  .add__button {
    transition: none;
  }
}
</style>
