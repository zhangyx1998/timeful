<script setup lang="ts">
import { computed, ref } from "vue";
import { api, apiError } from "../../lib/api";
import AppHeader from "../ui/AppHeader.vue";
import Button from "../ui/Button.vue";
import TextInput from "../ui/TextInput.vue";
import ThemeToggle from "../ui/ThemeToggle.vue";
import type { AuthResponse } from "../../lib/api";

const emit = defineEmits<{ (e: "authed", email: string): void }>();

const email = ref("");
const password = ref("");
const confirm = ref("");
const error = ref("");
const saving = ref(false);

const mismatch = computed(
  () => confirm.value.length > 0 && password.value !== confirm.value,
);

async function submit(): Promise<void> {
  error.value = "";
  if (password.value !== confirm.value) {
    error.value = "Passwords do not match";
    return;
  }
  if (password.value.length < 8) {
    error.value = "Password must be at least 8 characters";
    return;
  }
  saving.value = true;
  try {
    const result = await api.post<AuthResponse>("/api/auth/setup", {
      email: email.value.trim(),
      password: password.value,
      persist: true,
    });
    emit("authed", result?.email ?? email.value.trim().toLowerCase());
  } catch (err) {
    error.value = apiError(err, "Could not create the account").message;
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <div class="page">
    <AppHeader tag="setup">
      <ThemeToggle />
    </AppHeader>

    <main class="screen">
      <div class="panel">
        <h1 class="title">Create admin account</h1>
        <p class="subtitle">
          This is the only account. Keep the credentials somewhere safe.
        </p>

        <form class="form" @submit.prevent="submit">
          <TextInput
            id="setup-email"
            v-model="email"
            label="Email"
            type="email"
            autocomplete="username"
            required
          />

          <TextInput
            id="setup-password"
            v-model="password"
            label="Password"
            hint="At least 8 characters."
            type="password"
            autocomplete="new-password"
            minlength="8"
            required
          />

          <TextInput
            id="setup-confirm"
            v-model="confirm"
            label="Confirm password"
            :error="mismatch ? 'Passwords do not match.' : ''"
            type="password"
            autocomplete="new-password"
            required
          />

          <p v-if="error" class="error">{{ error }}</p>

          <Button variant="primary" type="submit" block :loading="saving">
            {{ saving ? "Creating…" : "Create account" }}
          </Button>
        </form>
      </div>
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
  align-items: flex-start;
  justify-content: center;
  padding: clamp(2rem, 10dvh, 5rem) var(--page-pad) 3rem;
}

.panel {
  width: 100%;
  max-width: 22rem;
}

.title {
  margin: 0;
  font-size: 1.25rem;
  font-weight: 600;
  color: var(--color-text);
}

.subtitle {
  margin: 0.25rem 0 0;
  font-size: 0.875rem;
  color: var(--color-text-muted);
}

.form {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  margin-top: 1.5rem;
}

.error {
  margin: 0;
  padding: 0.5rem 0.75rem;
  font-size: 0.875rem;
  color: var(--color-danger);
  background: var(--color-danger-soft);
  border-radius: var(--radius-md);
}
</style>
