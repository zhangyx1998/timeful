/**
 * Theme state (ARCHITECTURE.md § Theming). Three-valued preference:
 * "light" | "dark" writes `<html data-theme>` and localStorage; null follows
 * the OS. The inline script in index.html applies the attribute before first
 * paint; `initTheme()` only re-syncs with what it decided. Module-level state
 * on purpose: one global, shared by every `useTheme()` caller.
 */
import { computed, ref } from "vue";
import type { ComputedRef, Ref } from "vue";
import { clearStorage, readStorage, STORAGE_KEYS, writeStorage } from "./storage";

export type ThemePreference = "light" | "dark" | null;
export type Theme = "light" | "dark";

/** The user's explicit choice, or null when following the system. */
const preference = ref<ThemePreference>(null);
/** What the OS asks for. Irrelevant while `preference` is set. */
const systemTheme = ref<Theme>("light");

/** The theme actually on screen. */
const theme = computed<Theme>(() => preference.value ?? systemTheme.value);

let initialized = false;
let media: MediaQueryList | null = null;

function readStoredPreference(): ThemePreference {
  // A blocked localStorage reads as null, i.e. "follow the system".
  const stored = readStorage(STORAGE_KEYS.theme);
  return stored === "light" || stored === "dark" ? stored : null;
}

function writeStoredPreference(value: ThemePreference): void {
  if (value === null) clearStorage(STORAGE_KEYS.theme);
  else writeStorage(STORAGE_KEYS.theme, value);
}

/** Mirrors the preference onto <html>; absent attribute means "follow system". */
function applyToDocument(value: ThemePreference): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  if (value === null) root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", value);
}

/** Idempotent, no-op on the server. Call before mounting. */
export function initTheme(): void {
  if (initialized || typeof window === "undefined") return;
  initialized = true;

  if (typeof window.matchMedia === "function") {
    media = window.matchMedia("(prefers-color-scheme: dark)");
    systemTheme.value = media.matches ? "dark" : "light";
    const onChange = (event: MediaQueryListEvent) => {
      systemTheme.value = event.matches ? "dark" : "light";
    };
    // Safari < 14 only has the deprecated listener API.
    if (typeof media.addEventListener === "function") {
      media.addEventListener("change", onChange);
    } else {
      (media as MediaQueryList).addListener(onChange);
    }
  }

  preference.value = readStoredPreference();
  // The inline script should have done this; re-applying covers it failing.
  applyToDocument(preference.value);
}

/** Sets (or clears, with null) the explicit preference. */
export function setTheme(value: ThemePreference): void {
  preference.value = value;
  // Attribute first: anything reacting to `theme` — the heatmap re-reading its
  // CSS custom properties — must observe the new document state.
  applyToDocument(value);
  writeStoredPreference(value);
}

/** Flips the theme currently on screen and remembers the result. */
export function toggleTheme(): void {
  setTheme(theme.value === "dark" ? "light" : "dark");
}

export function useTheme(): {
  theme: ComputedRef<Theme>;
  preference: Ref<ThemePreference>;
  setTheme: (value: ThemePreference) => void;
  toggleTheme: () => void;
} {
  return { theme, preference, setTheme, toggleTheme };
}
