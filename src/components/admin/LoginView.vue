<script setup lang="ts">
import { ref } from "vue";
import { api, apiError } from "../../lib/api";
import AppHeader from "../ui/AppHeader.vue";
import Button from "../ui/Button.vue";
import TextInput from "../ui/TextInput.vue";
import ThemeToggle from "../ui/ThemeToggle.vue";
import type { AuthResponse } from "../../lib/api";

const props = withDefaults(defineProps<{ notice?: string }>(), { notice: "" });
const emit = defineEmits<{ (e: "authed", email: string): void }>();

const email = ref("");
const password = ref("");
const persist = ref(false);
const error = ref("");
const saving = ref(false);

async function submit(): Promise<void> {
  error.value = "";
  saving.value = true;
  try {
    const result = await api.post<AuthResponse>("/auth/login", {
      email: email.value.trim(),
      password: password.value,
      persist: persist.value,
    });
    password.value = "";
    emit("authed", result?.email ?? email.value.trim().toLowerCase());
  } catch (err) {
    error.value = apiError(err, "Sign in failed").message;
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <div class="page">
    <AppHeader>
      <ThemeToggle />
    </AppHeader>

    <main class="screen">
      <div class="panel">
        <h1 class="title">Sign in</h1>
        <p v-if="props.notice" class="subtitle">{{ props.notice }}</p>

        <form class="form" @submit.prevent="submit">
          <TextInput
            id="login-email"
            v-model="email"
            label="Email"
            type="email"
            autocomplete="username"
            required
          />

          <TextInput
            id="login-password"
            v-model="password"
            label="Password"
            type="password"
            autocomplete="current-password"
            required
          />

          <label class="checkbox">
            <input v-model="persist" type="checkbox" />
            Stay signed in
          </label>

          <p v-if="error" class="error">{{ error }}</p>

          <Button variant="primary" type="submit" block :loading="saving">
            {{ saving ? "Signing in…" : "Sign in" }}
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
  padding: clamp(2rem, 12vh, 6rem) var(--page-pad) 3rem;
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
  margin: 0.75rem 0 0;
  font-size: 0.875rem;
  color: var(--color-text-muted);
}

.form {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  margin-top: 1.5rem;
}

.checkbox {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  min-height: 1.75rem;
  font-size: 0.875rem;
  color: var(--color-text);
  cursor: pointer;
}

.checkbox input {
  width: 1rem;
  height: 1rem;
  accent-color: var(--color-accent);
}

@media (pointer: coarse) {
  .checkbox {
    min-height: var(--tap-min);
  }
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
