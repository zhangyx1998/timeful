<script setup lang="ts">
/**
 * The sign-in screen at `/`: the shared form, and a page to put it on.
 *
 * The form itself is `LoginForm`, because an event page can now offer the same
 * one in a dialog and the two must not drift.
 */
import AppHeader from "../ui/AppHeader.vue";
import LoginForm from "./LoginForm.vue";
import ThemeToggle from "../ui/ThemeToggle.vue";

const props = withDefaults(defineProps<{ notice?: string }>(), { notice: "" });
const emit = defineEmits<{ (e: "authed", email: string): void }>();
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

        <LoginForm
          class="form"
          id-prefix="login"
          @authed="(email: string) => emit('authed', email)"
        />
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
  padding: clamp(2rem, 12dvh, 6rem) var(--page-pad) 3rem;
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
  margin-top: 1.5rem;
}
</style>
