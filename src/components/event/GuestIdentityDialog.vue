<script setup lang="ts">
/**
 * Up-front identity step (ARCHITECTURE.md § Guest UX). A response is filed
 * under the [key](../../lib/user-key.ts) of the name, so continuing under a
 * name that normalizes to one that already answered loads and then overwrites
 * that answer — which the dialog says plainly, whatever the spelling.
 *
 * Matching is on keys and nothing else. "ada  LOVELACE" finds "Ada Lovelace",
 * and continuing adopts the spelling the event already carries rather than
 * rewriting it, so the group keeps seeing the name it knows.
 *
 * The rules the server would enforce are enforced here, from the same module,
 * as the guest types — including the one new one, that a name may not contain a
 * dash. Finding out by being refused would be the same answer a few seconds
 * later and in a worse place for it.
 *
 * "Just browsing" is not the same as dismissing the dialog: it says "do not
 * take me as anyone", which has to drop whatever identity the page was holding,
 * so it gets its own event. Closing (Escape, the backdrop, the X) only closes.
 */
import { computed, ref, watch } from "vue";
import Button from "../ui/Button.vue";
import Dialog from "../ui/Dialog.vue";
import TextInput from "../ui/TextInput.vue";
import { guestNameProblem, MAX_GUEST_NAME_LENGTH, userKey } from "../../lib/user-key";

/** One person already on the event: the key to match, the name to show. */
export interface KnownPerson {
  key: string;
  displayName: string;
}

// `dismissible` needs an explicit default: Vue casts an absent Boolean prop to
// `false`, not `undefined`, so without this the dialog silently loses its close
// button and its "Just browsing" escape hatch.
const props = withDefaults(
  defineProps<{
    open: boolean;
    existingPeople: KnownPerson[];
    dismissible?: boolean;
  }>(),
  { dismissible: true },
);

const emit = defineEmits<{
  confirm: [person: KnownPerson];
  close: [];
  browse: [];
}>();

/**
 * Always blank on open. The dialog asks who you are, and a name typed in for
 * you is an answer you did not give — it invites a distracted return visitor to
 * confirm somebody else's row, and it makes the suggestion chips look like a
 * correction rather than the choice they are. Whatever is remembered about this
 * device is used to skip the dialog entirely, not to fill it in.
 */
const name = ref("");
const touched = ref(false);

watch(
  () => props.open,
  (open) => {
    if (open) {
      name.value = "";
      touched.value = false;
    }
  },
);

const trimmed = computed(() => name.value.trim());

/** The key what has been typed would file under. Empty for an empty field. */
const typedKey = computed(() => userKey(name.value));

/**
 * What is wrong with the name as it stands, from the server's own rules.
 *
 * Only once the field has been touched: telling somebody their empty field is
 * empty before they have typed in it is noise, not help.
 */
const problem = computed(() =>
  touched.value ? guestNameProblem(name.value) : null,
);

/** Whether the name could be confirmed at all, touched or not. */
const usable = computed(() => guestNameProblem(name.value) === null);

/** The person already on the event whose key is the one being typed. */
const matched = computed(() => {
  const needle = typedKey.value;
  if (!needle) return null;
  return props.existingPeople.find((person) => person.key === needle) ?? null;
});

/** The name confirming would adopt: the event's spelling where there is one. */
const adopted = computed(() => {
  const known = matched.value?.displayName;
  // A grandfathered legacy spelling can contain a dash and so cannot be
  // written back. What was typed replaces it, and the key is the same either
  // way, so the answer behind it is the same answer.
  if (known && guestNameProblem(known) === null) return known;
  return trimmed.value;
});

const suggestions = computed(() => {
  const needle = typedKey.value;
  return props.existingPeople
    .filter((person) => person.key !== needle)
    .filter((person) => !needle || person.key.includes(needle))
    .slice(0, 6);
});

function confirm() {
  touched.value = true;
  if (!usable.value) return;
  // Snapped to the key, so two spellings of one person are one response.
  emit("confirm", { key: typedKey.value, displayName: adopted.value });
}

function pick(person: KnownPerson) {
  name.value = person.displayName;
  touched.value = true;
  // A legacy spelling cannot be confirmed as typed; the chip fills the field
  // and says why rather than refusing a click it just invited.
  if (!usable.value) return;
  emit("confirm", { key: person.key, displayName: adopted.value });
}
</script>

<template>
  <Dialog
    :open="open"
    title="Add your availability"
    :dismissible="dismissible"
    @close="emit('close')"
  >
    <form class="body" @submit.prevent="confirm">
      <TextInput
        v-model="name"
        label="Your name"
        :invalid="problem !== null"
        type="text"
        autocomplete="name"
        autofocus
        :maxlength="MAX_GUEST_NAME_LENGTH"
        placeholder="e.g. Ada Lovelace"
        @blur="touched = true"
      />

      <p v-if="problem" class="hint hint--error">{{ problem }}.</p>
      <!-- The one consequence worth spelling out: continuing under a name that
           answered already edits that answer rather than adding a second. Said
           in the event's own spelling, which is the one that will be kept. -->
      <p v-else-if="matched" class="hint hint--warn">
        <strong>{{ matched.displayName }}</strong> already answered — continuing
        edits their times.
      </p>
      <p v-else class="hint hint--muted" title="Stored in this browser only">
        Saved on this device, so you can come back and edit.
      </p>

      <div v-if="suggestions.length > 0" class="suggestions">
        <span class="suggestions__label">Already answered</span>
        <ul class="chips">
          <li v-for="person in suggestions" :key="person.key">
            <button
              type="button"
              class="chip"
              :title="person.displayName"
              @click="pick(person)"
            >
              {{ person.displayName }}
            </button>
          </li>
        </ul>
      </div>

      <div class="actions">
        <Button v-if="dismissible" variant="ghost" @click="emit('browse')">
          Just browsing
        </Button>
        <!-- The name is the only part of this label that can be any length, so
             it is the only part that gives way. A button is `nowrap` by design,
             which without a cap here means the panel overflows sideways rather
             than the label shortening. -->
        <Button
          variant="primary"
          type="submit"
          :disabled="!usable"
          :title="matched ? `Continue as ${adopted}` : undefined"
        >
          <!-- One element, so the button's flex gap does not land between the
               words on top of the space that is already there. -->
          <span v-if="matched" class="continue">Continue as <span
            class="continue__name"
          >{{ adopted }}</span></span>
          <template v-else>Continue</template>
        </Button>
      </div>
    </form>
  </Dialog>
</template>

<style scoped>
.body {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.hint {
  font-size: 0.8125rem;
  line-height: 1.4;
}

.hint--muted {
  color: var(--color-text-muted);
}

.hint--warn {
  padding: 0.5rem 0.6rem;
  color: var(--color-warning);
  background: var(--color-warning-soft);
  border-radius: var(--radius-md);
}

.hint--error {
  color: var(--color-danger);
}

.suggestions {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}

.suggestions__label {
  font-size: 0.75rem;
  font-weight: 600;
  letter-spacing: 0.02em;
  text-transform: uppercase;
  color: var(--color-text-muted);
}

.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem;
  padding: 0;
  margin: 0;
  list-style: none;
}

/* The chip caps itself, but its list item has to be allowed to be narrower than
   the name inside it before that cap can bite. */
.chips li {
  min-width: 0;
  max-width: 100%;
}

/* A pill is a pill: one line of it. Left to wrap, a long name turns the chip
   into a two-line lozenge and the row of them into a ragged block. The cap is
   generous enough to show most of a real name and never wider than the row. */
.chip {
  max-width: min(12rem, 100%);
  min-height: 2rem;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  padding: 0.25rem 0.7rem;
  font: inherit;
  font-size: 0.8125rem;
  color: var(--color-text);
  background: var(--color-subtle);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-pill);
  cursor: pointer;
}

.chip:hover {
  background: var(--color-accent-soft);
  border-color: var(--color-accent);
}

.chip:focus-visible {
  outline: var(--focus-ring);
  outline-offset: var(--focus-ring-offset);
}

@media (pointer: coarse) {
  .chip {
    min-height: var(--tap-min);
  }
}

.continue {
  min-width: 0;
}

/* `bottom` rather than the baseline an overflow-hidden inline-block would
   otherwise offer, which sits at its margin edge and drops the name below the
   words beside it. */
.continue__name {
  display: inline-block;
  max-width: 11rem;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  vertical-align: bottom;
}

/* Two buttons still stack rather than crowd on the narrowest panel. */
.actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 0.5rem;
  margin-top: 0.25rem;
}
</style>
