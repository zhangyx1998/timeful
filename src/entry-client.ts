import { createApp } from "./app";
import { installKeyboardInset } from "./lib/keyboard";
import { initTheme } from "./lib/theme";
import { installThemeColor } from "./lib/theme-color";

// Before anything renders: re-sync with the inline head script's decision.
initTheme();

installThemeColor();

// Before anything can raise a keyboard.
installKeyboardInset();

const container = document.getElementById("app");

// `data-ssr` marks a server-filled container (event pages); hydrating the
// bare '/' shell would log a mismatch and discard the render.
const hydrate = container?.hasAttribute("data-ssr") ?? false;

const initialEvent = window.__EVENT__ ?? null;
const { app, router } = createApp(initialEvent, { hydrate });

void router.isReady().then(() => {
  app.mount(container ?? "#app");
});
