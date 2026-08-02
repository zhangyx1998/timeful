<script setup lang="ts">
/**
 * Root page ('/'), client-rendered only. `GET /api/status` decides between
 * first-run setup, the sign-in form, and the management panel. A signed-out
 * visitor sees nothing but the sign-in form.
 */
import { computed, onMounted, ref } from "vue";
import AdminPanel from "../components/admin/AdminPanel.vue";
import { api, apiError } from "../lib/api";
import LoginView from "../components/admin/LoginView.vue";
import SetupView from "../components/admin/SetupView.vue";
import AppHeader from "../components/ui/AppHeader.vue";
import Button from "../components/ui/Button.vue";
import ThemeToggle from "../components/ui/ThemeToggle.vue";
import type { StatusResponse } from "../lib/api";

type View = "loading" | "setup" | "login" | "panel" | "error";

const status = ref<StatusResponse | null>(null);
const error = ref("");
const notice = ref("");

const view = computed<View>(() => {
  if (error.value) return "error";
  if (!status.value) return "loading";
  if (status.value.needsSetup) return "setup";
  return status.value.authed ? "panel" : "login";
});

const email = computed(() => status.value?.email ?? "");

async function refresh(): Promise<void> {
  error.value = "";
  try {
    status.value = await api.get<StatusResponse>("/api/status");
  } catch (err) {
    error.value = apiError(err, "Could not reach the server").message;
  }
}

const retrying = ref(false);

/**
 * The error view's own way back in. Not `refresh()`: that clears `error`
 * synchronously, which would swap the view to "Loading…" and unmount the very
 * button being pressed. Here the message stands until a new answer has
 * actually landed, so a still-down server just leaves the view as it was.
 */
async function retry(): Promise<void> {
  if (retrying.value) return;
  retrying.value = true;
  try {
    const next = await api.get<StatusResponse>("/api/status");
    error.value = "";
    status.value = next;
  } catch (err) {
    error.value = apiError(err, "Could not reach the server").message;
  } finally {
    retrying.value = false;
  }
}

function onAuthed(nextEmail: string): void {
  notice.value = "";
  status.value = { needsSetup: false, authed: true, email: nextEmail };
}

function onSignedOut(message = ""): void {
  notice.value = message;
  status.value = { needsSetup: false, authed: false };
}

onMounted(() => {
  document.title = "Admin · Timeful";
  void refresh();
});
</script>

<template>
  <SetupView v-if="view === 'setup'" @authed="onAuthed" />
  <LoginView v-else-if="view === 'login'" :notice="notice" @authed="onAuthed" />
  <AdminPanel
    v-else-if="view === 'panel'"
    :email="email"
    @signed-out="(message: string) => onSignedOut(message)"
  />
  <div v-else class="page">
    <AppHeader>
      <ThemeToggle />
    </AppHeader>
    <main class="screen">
      <div v-if="view === 'error'" class="trouble">
        <p class="message message--error">{{ error }}</p>
        <Button variant="secondary" :loading="retrying" @click="retry">Try again</Button>
      </div>
      <p v-else class="message">Loading…</p>
    </main>
  </div>
</template>

<style scoped>
.page {
  min-height: 100dvh;
  background: var(--color-bg);
}

.screen {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 4rem var(--page-pad);
}

.trouble {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 1rem;
}

.message {
  margin: 0;
  font-size: 0.875rem;
  color: var(--color-text-muted);
}

.message--error {
  color: var(--color-danger);
}
</style>
