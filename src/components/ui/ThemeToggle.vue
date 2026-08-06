<script setup lang="ts">
// Appearance switch (ARCHITECTURE.md § Theming). Knob state comes from CSS keyed off the
// same signals as the palette, so SSR is right pre-JS and nothing mismatches on hydration;
// only the ARIA state needs the reactive theme, so it waits for mount.
import { computed, onMounted, ref } from "vue";
import IconSun from "../../assets/icons/sun.svg";
import IconMoon from "../../assets/icons/moon.svg";
import { useTheme } from "../../lib/theme";

const { theme, toggleTheme } = useTheme();

const mounted = ref(false);
onMounted(() => {
  mounted.value = true;
});

const isDark = computed(() => mounted.value && theme.value === "dark");
const label = computed(() =>
  isDark.value ? "Switch to light theme" : "Switch to dark theme",
);
</script>

<template>
  <button
    class="toggle"
    type="button"
    role="switch"
    :aria-checked="isDark"
    :aria-label="label"
    :title="label"
    @click="toggleTheme()"
  >
    <span class="track">
      <span class="knob">
        <IconSun class="icon icon--sun" aria-hidden="true" />
        <IconMoon class="icon icon--moon" aria-hidden="true" />
      </span>
    </span>
  </button>
</template>

<style scoped>
.toggle {
  --focus-ring-inset: calc(var(--focus-ring-offset) * -1);

  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: var(--tap-min);
  height: var(--tap-min);
  padding: 0;
  background: none;
  border: none;
  border-radius: var(--radius-md);
  cursor: pointer;
}

.track {
  position: relative;
  display: block;
  width: 40px;
  height: 22px;
  background: var(--color-subtle);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-pill);
  transition: background var(--transition-med), border-color var(--transition-med);
}

.toggle:hover .track {
  border-color: var(--color-border-strong);
}

.knob {
  position: absolute;
  top: 1px;
  left: 1px;
  display: grid;
  place-items: center;
  width: 18px;
  height: 18px;
  color: var(--color-text-muted);
  background: var(--color-surface);
  border-radius: 50%;
  box-shadow: var(--shadow-sm);
  transition: transform var(--transition-med), color var(--transition-med),
    background var(--transition-med);
}

.icon {
  grid-area: 1 / 1;
  width: 12px;
  height: 12px;
  fill: currentColor;
  transition: opacity var(--transition-med), transform var(--transition-med);
}

.icon--moon {
  opacity: 0;
  transform: rotate(-90deg) scale(0.6);
}

/* Declared twice: a media query cannot be folded into a selector list. The `html` ancestor
   is bare, NOT `:global()` — scoped CSS stamps only the last compound, and `:global()` would
   make the compiler drop everything after it. */
@media (prefers-color-scheme: dark) {
  html:not([data-theme="light"]) .knob {
    color: var(--color-accent);
    transform: translateX(18px);
  }

  html:not([data-theme="light"]) .icon--sun {
    opacity: 0;
    transform: rotate(90deg) scale(0.6);
  }

  html:not([data-theme="light"]) .icon--moon {
    opacity: 1;
    transform: none;
  }
}

html[data-theme="dark"] .knob {
  color: var(--color-accent);
  transform: translateX(18px);
}

html[data-theme="dark"] .icon--sun {
  opacity: 0;
  transform: rotate(90deg) scale(0.6);
}

html[data-theme="dark"] .icon--moon {
  opacity: 1;
  transform: none;
}
</style>
