<script setup lang="ts">
/**
 * VitePress-style appearance switch: a pill with a sliding knob that carries a
 * sun in light mode and a moon in dark. Clicking flips the theme that is
 * currently on screen and persists that choice (ARCHITECTURE.md § Theming).
 *
 * The knob's position and icon come from CSS, keyed off the same signals as the
 * palette (`prefers-color-scheme` plus `html[data-theme]`), so a server-rendered
 * event page shows the right state before any JavaScript runs — and there is
 * nothing theme-dependent in the markup to mismatch on hydration. Only the ARIA
 * state needs the reactive theme, so it waits for mount.
 *
 * The visible pill is small; the button around it is a full-size tap target.
 */
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

/* Dark state. Declared twice on purpose — once for "the system says dark and
   the user has not overridden it", once for the explicit override — because a
   media query cannot be folded into a selector list.

   The `html` ancestor is written bare, NOT wrapped in `:global()`. Scoped CSS
   only stamps the scope attribute onto the last compound selector, so
   `html[data-theme="dark"] .knob` already compiles to
   `html[data-theme="dark"] .knob[data-v-x]` — exactly what is wanted. Wrapping
   the ancestor in `:global()` makes the compiler drop everything after it and
   emit `html[data-theme="dark"] { … }`, which styles the root element and
   leaves the knob untouched. */
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
