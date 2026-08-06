<script setup lang="ts">
// Up-front identity step (ARCHITECTURE.md § Guest UX). Matching is on user keys:
// continuing under a name that normalizes to an existing one edits that answer, adopting
// the event's spelling. "Just browsing" drops the held identity; closing only closes.
import { computed, ref, watch } from "vue";
import Button from "../ui/Button.vue";
import Dialog from "../ui/Dialog.vue";
import TextInput from "../ui/TextInput.vue";
import {
  adoptDisplayName,
  guestNameProblem,
  MAX_GUEST_NAME_LENGTH,
  userKey,
} from "../../lib/user-key";

export interface KnownPerson {
  key: string;
  displayName: string;
}

// Explicit default: Vue casts an absent Boolean prop to false, which would silently drop the close button.
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

// Always blank on open: what is remembered about this device skips the dialog, never fills it in.
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

const typedKey = computed(() => userKey(name.value));

// "A name is required" waits for touch; anything actually typed is answered immediately.
const problem = computed(() => {
  const found = guestNameProblem(name.value);
  if (!found) return null;
  if (name.value.trim() === "") return touched.value ? found : null;
  return found;
});

const usable = computed(() => guestNameProblem(name.value) === null);

const matched = computed(() => {
  const needle = typedKey.value;
  if (!needle) return null;
  return props.existingPeople.find((person) => person.key === needle) ?? null;
});

const adopted = computed(() =>
  adoptDisplayName(name.value, matched.value?.displayName),
);

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
  // A legacy spelling cannot be confirmed as typed; the chip fills the field and says why.
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
      <p v-else-if="matched" class="hint hint--warn">
        <strong>{{ matched.displayName }}</strong> already answered — continuing
        edits their times.
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
        <Button
          variant="primary"
          type="submit"
          :disabled="!usable"
          :title="matched ? `Continue as ${adopted}` : undefined"
        >
          <!-- One element, so the button's flex gap does not land between the words. -->
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

/* The list item must be allowed narrower than the name before the chip's cap can bite. */
.chips li {
  min-width: 0;
  max-width: 100%;
}

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

@media (pointer: coarse) {
  .chip {
    min-height: var(--tap-min);
  }
}

.continue {
  min-width: 0;
}

/* bottom: an overflow-hidden inline-block's baseline sits at its margin edge, dropping the name. */
.continue__name {
  display: inline-block;
  max-width: 11rem;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  vertical-align: bottom;
}

.actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 0.5rem;
  margin-top: 0.25rem;
}
</style>
