import { createApp as createVueApp, createSSRApp } from "vue";
import type { App as VueApp } from "vue";
import type { Router } from "vue-router";
import AppRoot from "./App.vue";
import { createRouter } from "./router";
import type { EventDoc } from "./lib/event";
import "./index.css";

export type CreateAppOptions = {
  /**
   * Whether the app takes over server-rendered markup already in the container.
   * True for event pages and for SSR itself; false for '/', which the server
   * answers with a bare shell (ARCHITECTURE.md § Routing / SSR). Hydrating an
   * empty container "works", but warns about a mismatch and throws the
   * rendered tree away, so the CSR route builds a plain app instead.
   */
  hydrate?: boolean;
  /** The layout the SSR preview was rendered for (ARCHITECTURE.md § Routing / SSR). */
  previewCompact?: boolean;
};

/**
 * App factory shared by the client and SSR entries.
 * `initialEvent` is the event document for SSR-rendered event pages; on the
 * client it comes from `window.__EVENT__`.
 */
export function createApp(
  initialEvent: EventDoc | null = null,
  options: CreateAppOptions = {},
): {
  app: VueApp<Element>;
  router: Router;
} {
  const { hydrate = true, previewCompact = false } = options;
  const app = hydrate ? createSSRApp(AppRoot) : createVueApp(AppRoot);
  const router = createRouter();
  app.use(router);
  app.provide("initialEvent", initialEvent);
  app.provide("previewCompact", previewCompact);
  return { app, router };
}
