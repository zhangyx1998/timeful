import { renderToString } from "vue/server-renderer";
import { createApp } from "./app";
import type { EventDoc } from "./lib/event";

/** What the Express server hands the renderer for an event page. */
export type SsrContext = {
  event?: EventDoc | null;
};

/**
 * Render an event page to HTML.
 * `url` is the request path, e.g. '/my-party'.
 */
export async function render(
  url: string,
  ssrContext: SsrContext = {},
): Promise<{ html: string }> {
  const { app, router } = createApp(ssrContext.event ?? null);
  await router.push(url);
  await router.isReady();
  const html = await renderToString(app, ssrContext);
  return { html };
}
