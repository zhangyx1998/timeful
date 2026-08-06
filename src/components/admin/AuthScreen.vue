<script setup lang="ts">
// Full-page shell shared by sign-in and first-run setup. The two deliberate
// differences are custom properties: `--auth-screen-top`, `--auth-subtitle-gap`.
import AppHeader from "../ui/AppHeader.vue";
import ThemeToggle from "../ui/ThemeToggle.vue";

withDefaults(
  defineProps<{
    title: string;
    subtitle?: string;
    tag?: string;
  }>(),
  { subtitle: "", tag: "" },
);
</script>

<template>
  <div class="page">
    <AppHeader :tag="tag">
      <ThemeToggle />
    </AppHeader>

    <main class="screen">
      <div class="panel">
        <h1 class="title">{{ title }}</h1>
        <p v-if="subtitle" class="subtitle">{{ subtitle }}</p>
        <slot />
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
  padding: var(--auth-screen-top, clamp(2rem, 12dvh, 6rem)) var(--page-pad)
    3rem;
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
  margin: var(--auth-subtitle-gap, 0.75rem) 0 0;
  font-size: 0.875rem;
  color: var(--color-text-muted);
}
</style>
