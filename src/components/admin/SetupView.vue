<script setup lang="ts">
import { computed, ref } from "vue";
import { api, apiError } from "../../lib/api";
import AuthScreen from "./AuthScreen.vue";
import Button from "../ui/Button.vue";
import ErrorNote from "../ui/ErrorNote.vue";
import TextInput from "../ui/TextInput.vue";
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
  <AuthScreen
    class="auth"
    tag="setup"
    title="Create admin account"
    subtitle="This is the only account. Keep the credentials somewhere safe."
  >
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

      <ErrorNote :message="error" />

      <Button variant="primary" type="submit" block :loading="saving">
        {{ saving ? "Creating…" : "Create account" }}
      </Button>
    </form>
  </AuthScreen>
</template>

<style scoped>
/* Setup sits a touch higher than sign-in, and its subtitle hugs the title. */
.auth {
  --auth-screen-top: clamp(2rem, 10dvh, 5rem);
  --auth-subtitle-gap: 0.25rem;
}

.form {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  margin-top: 1.5rem;
}
</style>
