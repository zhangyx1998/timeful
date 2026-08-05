<script setup lang="ts">
/**
 * The titlebar's invite affordance: where the bare copy-link button used to
 * sit, because handing the link to someone is still the thing a host does most
 * here — this just lets the link say who it is for.
 *
 * The dialog is the blessed producer of `?name=` links (`lib/entry-identity.ts`):
 * a name typed here lands, URL-encoded, on the canonical event URL, and the
 * welcome prompt at the other end greets exactly that person. Blank is valid
 * and means the plain link with no query at all. The name is validated live
 * from the same guest-name rules the identity dialog enforces, since a name
 * the dialog would refuse is a name the welcome prompt would ignore.
 *
 * Client-only, like the rest of the identity layer: the page mounts it beside
 * the title only after hydration, and the canonical URL is read off the
 * address bar when the dialog opens — after any `?name=` this page itself
 * arrived by has been consumed, and corrected for renames either way.
 */
import { computed, ref } from "vue";
import Button from "../ui/Button.vue";
import Dialog from "../ui/Dialog.vue";
import IconButton from "../ui/IconButton.vue";
import TextInput from "../ui/TextInput.vue";
import IconPersonPlus from "../../assets/icons/person-plus.svg";
import { useCopyFeedback } from "../../lib/copy-feedback";
import { inviteLink } from "../../lib/entry-identity";
import { guestNameProblem, MAX_GUEST_NAME_LENGTH } from "../../lib/user-key";

const open = ref(false);
const name = ref("");

/**
 * The canonical event URL, taken when the dialog opens: origin and path only,
 * so whatever query or fragment the address bar happens to hold can never
 * leak into a link handed to somebody else.
 */
const base = ref("");

function show(): void {
  const here = new URL(window.location.href);
  base.value = here.origin + here.pathname;
  name.value = "";
  open.value = true;
}

/** Blank is not a problem here: it simply means the plain link. */
const problem = computed(() =>
  name.value.trim() === "" ? null : guestNameProblem(name.value),
);

/** The URL being offered, exactly as the copy button will put it on the clipboard. */
const link = computed(() =>
  problem.value === null ? inviteLink(base.value, name.value) : null,
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

      <TextInput
        v-model="name"
        label="Invitee’s name"
        :error="problem ? `${problem}.` : ''"
        type="text"
        autofocus
        :maxlength="MAX_GUEST_NAME_LENGTH"
        placeholder="e.g. Ada Lovelace"
      />

      <!-- The URL exactly as Copy will hand it over — a preview, not a field.
           Present only while there is one: an unusable name has the error line
           above instead, and no link worth showing. -->
      <p v-if="link !== null" class="preview">{{ link }}</p>

      <div class="actions">
        <!-- The label is the live region: the same Copied / Couldn't copy
             verdicts the titlebar's old button gave, from the same machinery
             (lib/copy-feedback.ts). -->
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

/* One long token with no spaces: it wraps anywhere rather than widening the
   panel, and reads as machine text against the page's prose. */
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
