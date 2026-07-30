/**
 * Keeping the browser's own chrome the same colour as the app's edges.
 *
 * With `viewport-fit=cover` the document runs under iOS Safari's bottom
 * toolbar, and Safari tints that toolbar from `theme-color` — or, with none,
 * from whatever it finds behind it, which is the page's canvas rather than the
 * bar the visitor can actually see. Either way the answer has to be the colour
 * of the bars that sit against the chrome, top and bottom: `--color-surface`.
 *
 * index.html carries a static `theme-color` pair keyed off
 * `prefers-color-scheme`, which is what applies before any of this runs, and
 * the before-first-paint script there keeps whichever of the two matches an
 * explicit override. Neither can follow a theme *toggled* after load, because
 * a media query cannot see `data-theme`. So this prepends a third with no
 * media at all: a browser takes the first `theme-color` whose media matches,
 * and one with none always matches, so being first is what makes it win.
 *
 * The value is read back out of the token rather than written down again
 * (`resolveTokenColor`), so there is exactly one definition of that colour and
 * a change to `tokens.css` cannot leave the chrome behind.
 */
import { watch } from "vue";
import { resolveTokenColor, rgbToHex } from "./colors";
import { useTheme } from "./theme";

/** The token whose colour the browser's chrome should match. */
const CHROME_TOKEN = "--color-surface";

let meta: HTMLMetaElement | null = null;

function apply(): void {
  const color = resolveTokenColor(CHROME_TOKEN);
  // Nothing rather than a guess: the static pair is still in the head, and
  // being one theme behind beats being the wrong colour outright.
  if (!color) return;
  if (!meta) {
    meta = document.createElement("meta");
    meta.name = "theme-color";
    document.head.prepend(meta);
  }
  meta.content = rgbToHex(color);
}

/**
 * Starts tracking. Called once from the client entry, after `initTheme()`; a
 * no-op on the server, where there is no chrome and no document to prepend to.
 *
 * `setTheme` writes `data-theme` before it moves the reactive theme, so by the
 * time the watcher runs the probe is already measuring the new palette.
 */
export function installThemeColor(): void {
  if (typeof document === "undefined") return;
  const { theme } = useTheme();
  watch(theme, apply, { immediate: true, flush: "post" });
}
