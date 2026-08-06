/**
 * Keeps iOS Safari's toolbar tint (`theme-color`) matching `--color-surface`.
 * The static pair in index.html cannot follow a theme toggled after load — a
 * media query cannot see `data-theme` — so this prepends a media-less meta:
 * the browser takes the first `theme-color` whose media matches, and one with
 * none always matches. The value is read out of the token, never restated.
 */
import { watch } from "vue";
import { resolveTokenColor, rgbToHex } from "./colors";
import { useTheme } from "./theme";

/** The token whose colour the browser's chrome should match. */
const CHROME_TOKEN = "--color-surface";

let meta: HTMLMetaElement | null = null;

function apply(): void {
  const color = resolveTokenColor(CHROME_TOKEN);
  // Nothing rather than a guess: the static pair in the head still applies.
  if (!color) return;
  if (!meta) {
    meta = document.createElement("meta");
    meta.name = "theme-color";
    document.head.prepend(meta);
  }
  meta.content = rgbToHex(color);
}

/**
 * Called once from the client entry, after `initTheme()`; no-op on the server.
 * `setTheme` writes `data-theme` before moving the ref, so the watcher's probe
 * measures the new palette.
 */
export function installThemeColor(): void {
  if (typeof document === "undefined") return;
  const { theme } = useTheme();
  watch(theme, apply, { immediate: true, flush: "post" });
}
