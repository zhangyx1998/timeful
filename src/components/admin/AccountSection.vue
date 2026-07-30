<script setup lang="ts">
import { computed, ref } from "vue";
import { api, apiError } from "../../lib/api";
import Button from "../ui/Button.vue";
import Card from "../ui/Card.vue";
import ErrorNote from "../ui/ErrorNote.vue";
import TextInput from "../ui/TextInput.vue";
import IconAlertTriangle from "../../assets/icons/alert-triangle.svg";
import type { CredentialsPayload } from "../../lib/api";

const props = withDefaults(defineProps<{ email?: string }>(), { email: "" });
const emit = defineEmits<{ (e: "signed-out", message: string): void }>();

const email = ref(props.email);
const password = ref("");
const confirm = ref("");
const currentPassword = ref("");
const error = ref("");
const saving = ref(false);

const emailChanged = computed(
  () => email.value.trim().toLowerCase() !== props.email.trim().toLowerCase(),
);
const changed = computed(() => emailChanged.value || password.value.length > 0);

async function submit(): Promise<void> {
  error.value = "";
  if (!changed.value) {
    error.value = "Nothing to change";
    return;
  }
  if (password.value && password.value !== confirm.value) {
    error.value = "New passwords do not match";
    return;
  }

  const payload: CredentialsPayload = { currentPassword: currentPassword.value };
  if (emailChanged.value) payload.email = email.value.trim();
  if (password.value) payload.password = password.value;

  saving.value = true;
  try {
    await api.put("/api/auth/credentials", payload);
    emit("signed-out", "Credentials updated. Sign in again.");
  } catch (err) {
    error.value = apiError(err, "Could not update the credentials").message;
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <Card title="Account">
    <form class="form" @submit.prevent="submit">
      <TextInput
        id="account-email"
        v-model="email"
        label="Email"
        type="email"
        autocomplete="username"
      />

      <TextInput
        id="account-password"
        v-model="password"
        label="New password"
        type="password"
        autocomplete="new-password"
        placeholder="Leave blank to keep current"
      />

      <TextInput
        v-if="password"
        id="account-confirm"
        v-model="confirm"
        label="Confirm new password"
        type="password"
        autocomplete="new-password"
      />

      <TextInput
        id="account-current"
        v-model="currentPassword"
        label="Current password"
        type="password"
        autocomplete="current-password"
        required
      />

      <p class="notice" title="Every session is revoked, including this browser's">
        <IconAlertTriangle class="notice__icon" aria-hidden="true" />
        Saving signs you out everywhere.
      </p>

      <ErrorNote :message="error" />

      <div class="actions">
        <Button variant="primary" type="submit" :loading="saving" :disabled="!changed">
          {{ saving ? "Saving…" : "Save changes" }}
        </Button>
      </div>
    </form>
  </Card>
</template>

<style scoped>
.form {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  max-width: 22rem;
}

.notice {
  display: flex;
  align-items: center;
  gap: 0.45rem;
  margin: 0;
  padding: 0.5rem 0.75rem;
  font-size: 0.875rem;
  color: var(--color-warning);
  background: var(--color-warning-soft);
  border-radius: var(--radius-md);
}

.notice__icon {
  flex: none;
  width: 1rem;
  height: 1rem;
}

.actions {
  display: flex;
  gap: 0.5rem;
}
</style>
