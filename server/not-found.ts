/**
 * The miss page, and the one way to send it.
 *
 * Standalone by design: it is served for paths that resolve to nothing, so it
 * must not depend on the client bundle, the SSR bundle, or the index.html
 * template being present. Colors are inlined copies of the light/dark pairs in
 * src/styles/tokens.css (bg, text, text-muted, accent); `color-scheme: light
 * dark` + `light-dark()` follows the system, and the `data-theme` rules let the
 * same stored override the app uses win over it. The `theme-color` pair is the
 * same two values again, so the browser's own chrome matches the page rather
 * than sampling it and landing a shade off.
 *
 * It lives in its own module rather than in `app.ts` because the event-scoped
 * router needs it too — a mistyped `/<slug>/typo` is a person with a bad link,
 * not an API client, and answering it with JSON would be answering the wrong
 * question. `app.ts` imports the router, so the router cannot import `app.ts`.
 */
import type { Response } from "express";

export const NOT_FOUND_HTML = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex" />
    <!-- Same idea as index.html: the browser tints its chrome with this, and
         without it Safari samples the page and lands a shade off. These two
         are this page's own background, which is the --color-bg pair inlined
         below. -->
    <meta name="theme-color" content="#fafafa" media="(prefers-color-scheme: light)" />
    <meta name="theme-color" content="#1b1b1f" media="(prefers-color-scheme: dark)" />
    <link rel="icon" href="/favicon.ico" />
    <title>Not found · Timeful</title>
    <style>
      :root { color-scheme: light dark; }
      :root[data-theme="light"] { color-scheme: light; }
      :root[data-theme="dark"] { color-scheme: dark; }
      body { margin: 0; min-height: 100dvh; display: flex; align-items: center;
        justify-content: center; font: 16px/1.5 system-ui, -apple-system, sans-serif;
        color: light-dark(#18181b, #e8e8ea); background: light-dark(#fafafa, #1b1b1f); }
      main { text-align: center; padding: 2rem; }
      h1 { font-size: 1.5rem; margin: 0 0 .5rem; }
      p { margin: 0 0 1.5rem; color: light-dark(#71717a, #9a9aa5); }
      a { color: light-dark(#00994c, #35d07f); }
    </style>
    <script>
      // Same before-first-paint override as index.html, kept in sync by hand
      // because this page intentionally loads nothing. Storage can throw.
      (function () {
        try {
          var stored = window.localStorage.getItem("timeful.theme");
          if (stored === "light" || stored === "dark") {
            document.documentElement.setAttribute("data-theme", stored);
            var metas = document.querySelectorAll("meta[name=theme-color][media]");
            for (var i = 0; i < metas.length; i++) {
              if (metas[i].media.indexOf(stored) === -1) metas[i].remove();
              else metas[i].removeAttribute("media");
            }
          }
        } catch (error) {
          /* keep the system default */
        }
      })();
    </script>
  </head>
  <body>
    <main>
      <h1>Event not found</h1>
      <p>This link doesn't point to an event.</p>
      <a href="/">Go home</a>
    </main>
  </body>
</html>
`;

/** Sends the miss page. Never call it for a request that wanted JSON. */
export function sendNotFoundPage(res: Response, status = 404): void {
  res.status(status).set("Content-Type", "text/html; charset=utf-8").end(NOT_FOUND_HTML);
}
