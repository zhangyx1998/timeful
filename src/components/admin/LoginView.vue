<script setup lang="ts">
/**
 * The sign-in screen at `/`: the shared form on the shared shell.
 *
 * The form itself is `LoginForm`, because an event page can now offer the same
 * one in a dialog and the two must not drift; the shell is `AuthScreen`, which
 * the setup screen shares for the same reason.
 */
import AuthScreen from "./AuthScreen.vue";
import LoginForm from "./LoginForm.vue";

const props = withDefaults(defineProps<{ notice?: string }>(), { notice: "" });
const emit = defineEmits<{ (e: "authed", email: string): void }>();
</script>

<template>
  <AuthScreen title="Sign in" :subtitle="props.notice">
    <LoginForm
      class="form"
      id-prefix="login"
      @authed="(email: string) => emit('authed', email)"
    />
  </AuthScreen>
</template>

<style scoped>
.form {
  margin-top: 1.5rem;
}
</style>
