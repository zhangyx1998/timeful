<script setup lang="ts">
// The sign-in screen at `/`: the shared LoginForm on the shared AuthScreen shell.
import AuthScreen from "./AuthScreen.vue";
import LoginForm from "./LoginForm.vue";
import { PASSWORD_ONLY, type LoginMethods } from "../../lib/api";

const props = withDefaults(defineProps<{ notice?: string; methods?: LoginMethods }>(), {
  notice: "",
  methods: () => PASSWORD_ONLY,
});
const emit = defineEmits<{ (e: "authed", email: string): void }>();
</script>

<template>
  <AuthScreen title="Sign in" :subtitle="props.notice">
    <LoginForm
      class="form"
      id-prefix="login"
      :methods="props.methods"
      return-to="/"
      @authed="(email: string) => emit('authed', email)"
    />
  </AuthScreen>
</template>

<style scoped>
.form {
  margin-top: 1.5rem;
}
</style>
