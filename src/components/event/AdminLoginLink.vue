<script setup lang="ts">
// In-page admin sign-in: the same LoginForm in a dialog; the admin state is
// reactive, so no redirect and nothing on the page is disturbed. Provider-only
// sign-in has no form to show, so the link goes straight to the provider.
import { ref } from "vue";
import { oidcStartUrl } from "../../lib/api";
import Dialog from "../ui/Dialog.vue";
import LoginForm from "../admin/LoginForm.vue";
import IconShield from "../../assets/icons/shield-half.svg";
import { loginMethods, refreshAdmin } from "../../lib/admin";

const open = ref(false);

function start(): void {
  if (loginMethods.value.password) {
    open.value = true;
    return;
  }
  window.location.assign(
    oidcStartUrl({ returnTo: window.location.pathname + window.location.search }),
  );
}

// Re-probes rather than trusting the form: whether this browser holds a session is the server's answer.
async function onAuthed(): Promise<void> {
  await refreshAdmin();
  open.value = false;
}
</script>

<template>
  <button type="button" class="link" @click="start">
    <IconShield class="link__mark" aria-hidden="true" />
    <span class="link__text">Administrator Login</span>
  </button>

  <Dialog :open="open" title="Administrator sign-in" @close="open = false">
    <template #icon><IconShield /></template>
    <LoginForm
      id-prefix="event-login"
      autofocus
      :methods="loginMethods"
      @authed="onAuthed"
    />
  </Dialog>
</template>

<style scoped>
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

@media (pointer: coarse) {
  .link {
    min-height: var(--tap-min);
  }
}
</style>
