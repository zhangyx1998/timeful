<script setup lang="ts">
/**
 * The full-page shell shared by the sign-in and first-run setup screens: the
 * app bar with a theme toggle, and one centred panel holding a title, an
 * optional subtitle, and whatever form the caller slots in.
 *
 * Extracted because the two screens had drifted apart only by accident-prone
 * copies of the same five rules. The two deliberate differences survive as
 * custom properties a caller sets on the component root:
 *
 * - `--auth-screen-top`: the top-padding clamp (default: the sign-in value).
 * - `--auth-subtitle-gap`: space between the title and the subtitle.
 */
import AppHeader from "../ui/AppHeader.vue";
import ThemeToggle from "../ui/ThemeToggle.vue";

withDefaults(
  defineProps<{
    /** The panel heading. */
    title: string;
    /** Rendered under the title when non-empty. */
    subtitle?: string;
    /** Passed through to `AppHeader`'s brand tag ("setup" on first run). */
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
