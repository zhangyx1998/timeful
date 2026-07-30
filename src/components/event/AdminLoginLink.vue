<script setup lang="ts">
/**
 * The way in, for the one person the event page has nothing to offer.
 *
 * Signing in used to be somewhere else entirely: `/`, which meant leaving the
 * event, finding it again in the list, and coming back. The form is the same
 * form (`LoginForm`), in a dialog over the page you are already on, and what
 * follows it is not a redirect — the admin state is reactive, so the tools
 * group appears where it stands and everything else about the page, including
 * a half-finished answer on the grid, is left exactly as it was.
 *
 * Quiet on purpose, and at the bottom of the column. A guest has no business
 * here and should not be invited: this is a door for whoever already knows it
 * is a door, not a call to action.
 */
import { ref } from "vue";
import Dialog from "../ui/Dialog.vue";
import LoginForm from "../admin/LoginForm.vue";
import IconShield from "../../assets/icons/shield-half.svg";
import { refreshAdmin } from "../../lib/admin";

const open = ref(false);

/**
 * Re-probes rather than trusting the form's word for it. The form knows its
 * request came back 200; whether this browser now holds a session is a
 * question for the server, and the answer is what the page renders off.
 */
async function onAuthed(): Promise<void> {
  await refreshAdmin();
  open.value = false;
}
</script>

<template>
  <!-- The same half-solid shield the owner's own tools wear, so the door and
       what is behind it are marked with one glyph rather than two. -->
  <button type="button" class="link" @click="open = true">
    <IconShield class="link__mark" aria-hidden="true" />
    <span class="link__text">Administrator Login</span>
  </button>

  <Dialog :open="open" title="Administrator sign-in" @close="open = false">
    <template #icon><IconShield /></template>
    <LoginForm id-prefix="event-login" autofocus @authed="onAuthed" />
  </Dialog>
</template>

<style scoped>
/* Grey and set as text: it is a way out of this page for somebody who already
   knows they want it, not an offer being made to everyone who lands here. */
.link {
  display: inline-flex;
  align-self: center;
  align-items: center;
  gap: 0.35rem;
  padding: 0.35rem 0.5rem;
  font: inherit;
  font-size: 0.75rem;
  color: var(--color-text-muted);
  background: none;
  border: none;
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: color var(--transition-fast);
}

/* The mark sits outside the rule: an underline running under a shield reads as
   a glyph struck through rather than as a link with a badge on it. */
.link__mark {
  flex: none;
  width: 0.85rem;
  height: 0.85rem;
}

.link__text {
  text-decoration: underline;
  text-decoration-color: var(--color-border-strong);
  text-underline-offset: 0.2em;
}

.link:hover {
  color: var(--color-text);
}

/* A finger needs somewhere to land even for something this quiet. */
@media (pointer: coarse) {
  .link {
    min-height: var(--tap-min);
  }
}
</style>
