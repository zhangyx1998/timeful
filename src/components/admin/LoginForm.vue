<script setup lang="ts">
/**
 * The sign-in form itself: two fields, the persist checkbox, and one error.
 *
 * Separated from the page around it because there are now two places to sign
 * in from. `/` is one — the admin app's whole first screen. The other is a
 * dialog on an event page, where an owner who is already looking at the thing
 * they want to edit should not have to leave it, sign in somewhere else, and
 * come back. Both need the same fields, the same messages and the same
 * request; only the frame around them differs, so only the frame is duplicated.
 *
 * It reports the email it signed in as rather than a boolean: the panel prints
 * it, and the server's own answer is more authoritative than what was typed.
 */
import { ref } from "vue";
import { api, apiError } from "../../lib/api";
import Button from "../ui/Button.vue";
import ErrorNote from "../ui/ErrorNote.vue";
import TextInput from "../ui/TextInput.vue";
import type { AuthResponse } from "../../lib/api";

const props = withDefaults(
  defineProps<{
    /**
     * Distinguishes the two forms' field ids. Two of these may be in the DOM
     * at once in principle, and a duplicated id would point every label at the
     * first one.
     */
    idPrefix?: string;
    /** Focus the email field on mount — a dialog opens straight into it. */
    autofocus?: boolean;
  }>(),
  { idPrefix: "login", autofocus: false },
);

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
    const result = await api.post<AuthResponse>("/api/auth/login", {
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
  <form class="form" @submit.prevent="submit">
    <TextInput
      :id="`${props.idPrefix}-email`"
      v-model="email"
      label="Email"
      type="email"
      autocomplete="username"
      :autofocus="props.autofocus"
      required
    />

    <TextInput
      :id="`${props.idPrefix}-password`"
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

    <ErrorNote :message="error" />

    <Button variant="primary" type="submit" block :loading="saving">
      {{ saving ? "Signing in…" : "Sign in" }}
    </Button>
  </form>
</template>

<style scoped>
.form {
  display: flex;
  flex-direction: column;
  gap: 1rem;
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
</style>
