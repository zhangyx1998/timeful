<script setup lang="ts">
// The sign-in screen at `/`: the shared LoginForm on the shared AuthScreen shell.
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
