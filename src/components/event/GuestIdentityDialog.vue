<script setup lang="ts">
/**
 * Up-front identity step (ARCHITECTURE.md § Guest UX). The name is the only
 * identifier a response has, so continuing under a name that already answered
 * loads and then overwrites that answer — which the dialog says plainly.
 *
 * "Just browsing" is not the same as dismissing the dialog: it says "do not
 * take me as anyone", which has to drop whatever identity the page was holding,
 * so it gets its own event. Closing (Escape, the backdrop, the X) only closes.
 */
import { computed, ref, watch } from "vue";
import Button from "../ui/Button.vue";
import Dialog from "../ui/Dialog.vue";
import TextInput from "../ui/TextInput.vue";

// `dismissible` needs an explicit default: Vue casts an absent Boolean prop to
// `false`, not `undefined`, so without this the dialog silently loses its close
// button and its "Just browsing" escape hatch.
const props = withDefaults(
  defineProps<{
    open: boolean;
    existingNames: string[];
    dismissible?: boolean;
  }>(),
  { dismissible: true },
);

const emit = defineEmits<{ confirm: [name: string]; close: []; browse: [] }>();

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

/** The stored name matching what was typed, ignoring case. */
const matchedName = computed(() => {
  const needle = trimmed.value.toLowerCase();
  if (!needle) return null;
  return props.existingNames.find((existing) => existing.toLowerCase() === needle) ?? null;
});

const suggestions = computed(() => {
  const needle = trimmed.value.toLowerCase();
  return props.existingNames
    .filter((existing) => existing.toLowerCase() !== needle)
    .filter((existing) => !needle || existing.toLowerCase().includes(needle))
    .slice(0, 6);
});

const invalid = computed(() => touched.value && trimmed.value.length === 0);

function confirm() {
  touched.value = true;
  if (!trimmed.value) return;
  // Snap to the stored spelling so a differently-cased name does not create a
  // second response for the same person.
  emit("confirm", matchedName.value ?? trimmed.value);
}

function pick(suggestion: string) {
  name.value = suggestion;
  confirm();
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
        :invalid="invalid"
        type="text"
        autocomplete="name"
        autofocus
        maxlength="100"
        placeholder="e.g. Ada Lovelace"
        @blur="touched = true"
      />

      <p v-if="invalid" class="hint hint--error">A name is required.</p>
      <!-- The one consequence worth spelling out: continuing under a name that
           answered already edits that answer rather than adding a second. -->
      <p v-else-if="matchedName" class="hint hint--warn">
        <strong>{{ matchedName }}</strong> already answered — continuing edits
        their times.
      </p>
      <p v-else class="hint hint--muted" title="Stored in this browser only">
        Saved on this device, so you can come back and edit.
      </p>

      <div v-if="suggestions.length > 0" class="suggestions">
        <span class="suggestions__label">Already answered</span>
        <ul class="chips">
          <li v-for="suggestion in suggestions" :key="suggestion">
            <button
              type="button"
              class="chip"
              :title="suggestion"
              @click="pick(suggestion)"
            >
              {{ suggestion }}
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
          :disabled="trimmed.length === 0"
          :title="matchedName ? `Continue as ${matchedName}` : undefined"
        >
          <!-- One element, so the button's flex gap does not land between the
               words on top of the space that is already there. -->
          <span v-if="matchedName" class="continue">Continue as <span
            class="continue__name"
          >{{ matchedName }}</span></span>
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
