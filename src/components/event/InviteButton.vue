<script setup lang="ts">
// The blessed producer of `?name=` invite links (`lib/entry-identity.ts`); blank means
// the plain link. Built from the event's slug — the canonical root URL, where the query
// is read (ARCHITECTURE.md § Guest UX) — never from the address bar. Client-only.
import { computed, ref, useId } from "vue";
import Button from "../ui/Button.vue";
import Dialog from "../ui/Dialog.vue";
import IconButton from "../ui/IconButton.vue";
import TextInput from "../ui/TextInput.vue";
import IconPersonPlus from "../../assets/icons/person-plus.svg";
import { useCopyFeedback } from "../../lib/copy-feedback";
import { inviteLink, MAX_GREETING_PREFIX_LENGTH } from "../../lib/entry-identity";
import { guestNameProblem, MAX_GUEST_NAME_LENGTH } from "../../lib/user-key";

// A datalist, not a Select: the list is a suggestion. An unusable prefix is silently dropped, never an error.
const PREFIX_OPTIONS = ["Mr.", "Ms.", "Mx.", "Dr.", "Prof."];

const props = defineProps<{
  slug: string;
}>();

const open = ref(false);
const name = ref("");
const prefix = ref("");
const prefixListId = useId();

const base = computed(() => `${window.location.origin}/${props.slug}`);

function show(): void {
  name.value = "";
  prefix.value = "";
  open.value = true;
}

/** Blank is not a problem here: it simply means the plain link. */
const problem = computed(() =>
  name.value.trim() === "" ? null : guestNameProblem(name.value),
);

const link = computed(() =>
  open.value && problem.value === null
    ? inviteLink(base.value, name.value, prefix.value)
    : null,
);

const { copied, failed, copy } = useCopyFeedback();

function copyLink(): void {
  if (link.value === null) return;
  void copy(link.value);
}
</script>

<template>
  <IconButton label="Invite" @click="show">
    <IconPersonPlus aria-hidden="true" />
  </IconButton>

  <Dialog :open="open" title="Invite someone" @close="open = false">
    <form class="body" @submit.prevent="copyLink">
      <p class="lead">
        Put a name on the link and the page will greet them by it. Leave it
        blank for a plain link anyone can use.
      </p>

      <div class="who">
        <TextInput
          v-model="prefix"
          class="who__prefix"
          label="Prefix"
          type="text"
          :maxlength="MAX_GREETING_PREFIX_LENGTH"
          placeholder="Optional"
          :list="prefixListId"
        />
        <datalist :id="prefixListId">
          <option v-for="option in PREFIX_OPTIONS" :key="option" :value="option" />
        </datalist>

        <TextInput
          v-model="name"
          class="who__name"
          label="Invitee’s name"
          :error="problem ? `${problem}.` : ''"
          type="text"
          autofocus
          :maxlength="MAX_GUEST_NAME_LENGTH"
          placeholder="e.g. Ada Lovelace"
        />
      </div>

      <p v-if="link !== null" class="preview">{{ link }}</p>

      <div class="actions">
        <!-- The label is the live region (lib/copy-feedback.ts). -->
        <Button
          variant="primary"
          type="submit"
          :disabled="problem !== null"
          aria-live="polite"
        >
          {{ copied ? "Copied" : failed ? "Couldn’t copy" : "Copy link" }}
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

.lead {
  font-size: 0.8125rem;
  line-height: 1.5;
  color: var(--color-text-muted);
}

.who {
  display: flex;
  flex-wrap: wrap;
  gap: 0.75rem;
  align-items: flex-start;
}

.who__prefix {
  flex: 0 1 6.5rem;
}

.who__name {
  flex: 1 1 12rem;
}

.preview {
  padding: 0.5rem 0.6rem;
  font-family: var(--font-mono);
  font-size: 0.75rem;
  line-height: 1.5;
  overflow-wrap: anywhere;
  color: var(--color-text-muted);
  background: var(--color-subtle);
  border-radius: var(--radius-md);
}

.actions {
  display: flex;
  justify-content: flex-end;
  margin-top: 0.25rem;
}
</style>
