<script setup lang="ts">
// The sign-in form shared by `/` and the event page's dialog. Reports the email it
// signed in as: the server's answer beats what was typed. The provider button
// leaves the page instead, and comes back to `returnTo` signed in.
import { ref } from "vue";
import { api, apiError, oidcStartUrl, PASSWORD_ONLY } from "../../lib/api";
import Button from "../ui/Button.vue";
import ErrorNote from "../ui/ErrorNote.vue";
import TextInput from "../ui/TextInput.vue";
import type { AuthResponse, LoginMethods } from "../../lib/api";

const props = withDefaults(
  defineProps<{
    /** Two forms may be in the DOM at once; a duplicated id would point every label at the first. */
    idPrefix?: string;
    autofocus?: boolean;
    methods?: LoginMethods;
    /** Where the provider round-trip lands; the current page by default. */
    returnTo?: string;
  }>(),
  { idPrefix: "login", autofocus: false, methods: () => PASSWORD_ONLY, returnTo: "" },
);

const emit = defineEmits<{ (e: "authed", email: string): void }>();

const email = ref("");
const password = ref("");
const persist = ref(false);
const error = ref("");
const saving = ref(false);

const leaving = ref(false);

function continueWithProvider(): void {
  leaving.value = true;
  const returnTo = props.returnTo || window.location.pathname + window.location.search;
  window.location.assign(oidcStartUrl({ persist: persist.value, returnTo }));
}

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
  <div v-if="!props.methods.password" class="form">
    <label class="checkbox">
      <input v-model="persist" type="checkbox" />
      Stay signed in
    </label>

    <Button variant="primary" block :loading="leaving" @click="continueWithProvider">
      Continue with {{ props.methods.oidc }}
    </Button>
  </div>

  <form v-else class="form" @submit.prevent="submit">
    <template v-if="props.methods.oidc">
      <Button variant="secondary" block :loading="leaving" @click="continueWithProvider">
        Continue with {{ props.methods.oidc }}
      </Button>
      <p class="divider" aria-hidden="true"><span>or</span></p>
    </template>

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

.divider {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  margin: 0;
  font-size: 0.75rem;
  color: var(--color-text-muted);
}

.divider::before,
.divider::after {
  content: "";
  flex: 1;
  border-top: 1px solid var(--color-border);
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
