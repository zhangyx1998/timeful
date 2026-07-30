import { createApp } from "./app";
import { installKeyboardInset } from "./lib/keyboard";
import { initTheme } from "./lib/theme";
import { installThemeColor } from "./lib/theme-color";

// Sync the reactive theme state with whatever the inline head script applied,
// before anything renders.
initTheme();

// A theme toggled after load cannot be seen by the media-keyed `theme-color`
// pair in the head, so the browser's chrome would keep the colour it started
// with. This tracks the token instead.
installThemeColor();

// The keyboard no longer resizes the page (index.html), so something has to say
// how much of it is covered. One installation for the document, before anything
// can raise a keyboard.
installKeyboardInset();

const container = document.getElementById("app");

// The server stamps `data-ssr` on the container only when it filled it with
// rendered markup (event pages). '/' gets a bare shell, and hydrating that
// would log a mismatch warning and discard the render — mount plainly instead.
const hydrate = container?.hasAttribute("data-ssr") ?? false;

const initialEvent = window.__EVENT__ ?? null;
const { app, router } = createApp(initialEvent, { hydrate });

void router.isReady().then(() => {
  app.mount(container ?? "#app");
});
