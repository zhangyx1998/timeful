/**
 * The Express application: API mount, SSR/static middleware, 404 page.
 *
 * Everything the server needs is passed in, so the same app is built by the
 * repo entry (`server/index.ts`), by the packaged CLI, and by tests. Only the
 * `Renderer` differs: static files + the built SSR bundle in production, Vite
 * middleware in development (`server/dev.ts`, which is never bundled).
 */
import fs from "node:fs/promises";
import path from "node:path";
import type { Server } from "node:http";
import { pathToFileURL } from "node:url";
import express from "express";
import type { Express, NextFunction, Request, Response } from "express";
import { cookieParser } from "./auth.ts";
import { realtimeEnabled } from "./config.ts";
import { statusOf } from "./http.ts";
import type { AssetPaths } from "./paths.ts";
import { describeTrustedProxies, type TrustProxySetting } from "./proxy.ts";
import { attachRealtime } from "./realtime.ts";
import { authRouter } from "./routes/auth.ts";
import { eventsRouter, resolveEvent } from "./routes/events.ts";
import { leasesRouter } from "./routes/leases.ts";
import { sessionsRouter } from "./routes/sessions.ts";
import { readEvent, readLinks } from "./storage.ts";
import { tarpitMiss } from "./tarpit.ts";
import type { StoredEvent } from "./types.ts";

/** The SSR bundle's shape, borrowed from the source entry it is built from. */
type SsrModule = typeof import("../src/entry-server.ts");
export type RenderFn = SsrModule["render"];

/** How the page handler gets its template and its renderer. */
export interface Renderer {
  /** Mounted ahead of the page handler: static assets, or Vite in dev. */
  attach?(app: Express): void;
  loadTemplate(url: string): Promise<string>;
  loadRender(): Promise<RenderFn>;
  /** Rewrites a stack trace through the dev server's source maps. */
  fixStacktrace?(err: Error): void;
}

// ---------------------------------------------------------------------------
// html helpers
// ---------------------------------------------------------------------------

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

function escapeHtml(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, (c) => HTML_ESCAPES[c] ?? c);
}

/** JSON safe to embed inside a <script> element. */
function serializeState(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

/** String replacement that never interprets `$` patterns in the replacement. */
function replaceOnce(html: string, marker: string, value: string): string {
  return html.replace(marker, () => value);
}

/**
 * The miss page. Standalone by design: it is served for paths that resolve to
 * nothing, so it must not depend on the client bundle, the SSR bundle, or the
 * index.html template being present. Colors are inlined copies of the
 * light/dark pairs in src/styles/tokens.css (bg, text, text-muted, accent);
 * `color-scheme: light dark` + `light-dark()` follows the system, and the
 * `data-theme` rules let the same stored override the app uses win over it.
 */
export const NOT_FOUND_HTML = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex" />
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

// ---------------------------------------------------------------------------
// renderers
// ---------------------------------------------------------------------------

/**
 * Production renderer: static files from the client build, `render` from the
 * SSR bundle. Both are read from `assets`, which is resolved relative to the
 * running module (see paths.ts) — never from the working directory.
 */
export function createStaticRenderer(assets: AssetPaths): Renderer {
  let templateCache: string | undefined;
  let renderCache: RenderFn | undefined;

  return {
    attach(app) {
      app.use(
        "/assets",
        express.static(path.join(assets.clientDir, "assets"), {
          immutable: true,
          maxAge: "1y",
          index: false,
        }),
      );
      app.use(express.static(assets.clientDir, { index: false }));
    },
    async loadTemplate() {
      templateCache ??= await fs.readFile(assets.templateFile, "utf8");
      return templateCache;
    },
    async loadRender() {
      // `import()` wants a URL: a bare absolute path is ambiguous on Windows
      // and a relative one would resolve against this module, not the assets.
      renderCache ??= (
        (await import(pathToFileURL(assets.serverEntry).href)) as SsrModule
      ).render;
      return renderCache;
    },
  };
}

// ---------------------------------------------------------------------------
// app
// ---------------------------------------------------------------------------

export interface AppOptions {
  trustProxy: TrustProxySetting;
  renderer: Renderer;
}

export function createApp({ trustProxy, renderer }: AppOptions): Express {
  const app = express();
  app.disable("x-powered-by");
  // Only these peers may speak X-Forwarded-For/-Proto for someone else; `req.ip`
  // then resolves to the rightmost entry that is not itself trusted.
  app.set("trust proxy", trustProxy);
  app.use(express.json({ limit: "2mb" }));
  app.use(cookieParser);

  app.use("/api", authRouter);
  app.use("/api", sessionsRouter);
  app.use("/api", leasesRouter);
  app.use("/api", eventsRouter);
  app.use("/api", (_req: Request, res: Response) => {
    res.status(404).json({ error: "Not found" });
  });

  renderer.attach?.(app);

  // -------------------------------------------------------------------------
  // page rendering
  // -------------------------------------------------------------------------

  function renderShell(template: string): string {
    return replaceOnce(replaceOnce(template, "<!--app-html-->", ""), "<!--app-head-->", "");
  }

  async function renderEventPage(
    template: string,
    event: StoredEvent,
    req: Request,
  ): Promise<string> {
    const render = await renderer.loadRender();
    const { html } = await render(req.path, { event });
    const absoluteUrl = `${req.protocol}://${req.get("host") ?? "localhost"}${req.path}`;
    const { title, tags } = eventHead(event, absoluteUrl);

    // Tells entry-client.ts there is real markup to hydrate. Stamped before the
    // markup goes in, so a rendered `<div id="app">` can never be hit instead.
    let out = replaceOnce(template, `<div id="app">`, `<div id="app" data-ssr>`);
    out = replaceOnce(out, "<!--app-html-->", html);
    out = out.replace(/<title>[\s\S]*?<\/title>/, () => `<title>${escapeHtml(title)}</title>`);
    out = replaceOnce(out, "<!--app-head-->", tags);
    out = replaceOnce(
      out,
      "</body>",
      `<script>window.__EVENT__ = ${serializeState(event)}</script>\n  </body>`,
    );
    return out;
  }

  app.use(async (req: Request, res: Response, next: NextFunction) => {
    const isRead = req.method === "GET" || req.method === "HEAD";
    const sendHtml = (status: number, html: string) =>
      res.status(status).set("Content-Type", "text/html; charset=utf-8").end(html);

    try {
      // '/' is CSR only — the admin app boots from the bare shell. It resolves
      // by definition, so it is never queued.
      if (req.path === "/") {
        if (!isRead) {
          sendHtml(404, NOT_FOUND_HTML);
          return;
        }
        sendHtml(200, renderShell(await renderer.loadTemplate(req.originalUrl)));
        return;
      }

      // Resolve first: only an actual miss enters the tarpit, whatever the
      // method. A hit with an unusable method is a plain, undelayed 404.
      const event = await resolveSlugPath(req.path);
      if (!event) {
        await tarpitMiss(req, res, () => sendHtml(404, NOT_FOUND_HTML));
        return;
      }
      if (!isRead) {
        sendHtml(404, NOT_FOUND_HTML);
        return;
      }

      sendHtml(
        200,
        await renderEventPage(await renderer.loadTemplate(req.originalUrl), event, req),
      );
    } catch (err) {
      if (err instanceof Error) renderer.fixStacktrace?.(err);
      next(err);
    }
  });

  app.use((_req: Request, res: Response) => {
    res.status(404).set("Content-Type", "text/html; charset=utf-8").end(NOT_FOUND_HTML);
  });

  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    const isParseFailure =
      typeof err === "object" && err !== null && "type" in err
        ? err.type === "entity.parse.failed"
        : false;
    const status = statusOf(err) ?? (isParseFailure ? 400 : 500);
    if (status >= 500) console.error(err);
    const detail = err instanceof Error ? err.message : "";
    const message = status >= 500 ? "Internal server error" : detail || "Bad request";
    if (req.path.startsWith("/api")) {
      res.status(status).json({ error: message });
      return;
    }
    res.status(status).set("Content-Type", "text/plain; charset=utf-8").end(message);
  });

  return app;
}

function eventHead(event: StoredEvent, url: string): { title: string; tags: string } {
  const name = escapeHtml(event.name);
  const description = escapeHtml(`Fill in your availability for ${event.name}.`);
  const tags = [
    // Event URLs are capability links (ARCHITECTURE.md § Security): knowing one
    // is permission to answer it, so none of them belong in a search index. The
    // OG/Twitter tags stay — unfurling a link in a chat app is the point.
    `<meta name="robots" content="noindex" />`,
    `<meta name="description" content="${description}" />`,
    `<meta property="og:type" content="website" />`,
    `<meta property="og:site_name" content="Timeful" />`,
    `<meta property="og:title" content="${name}" />`,
    `<meta property="og:description" content="${description}" />`,
    `<meta property="og:url" content="${escapeHtml(url)}" />`,
    `<meta name="twitter:card" content="summary" />`,
    `<meta name="twitter:title" content="${name}" />`,
    `<meta name="twitter:description" content="${description}" />`,
  ].join("\n    ");
  return { title: `${event.name} · Timeful`, tags };
}

/**
 * Resolves a request path to an event. Everything but `/` is a potential slug;
 * a path separator or a file extension can never be one.
 */
async function resolveSlugPath(pathname: string): Promise<StoredEvent | null> {
  let slug: string;
  try {
    slug = decodeURIComponent(pathname.slice(1));
  } catch {
    return null; // malformed percent-encoding
  }
  if (!slug || slug.includes("/") || slug.includes(".")) return null;
  const links = await readLinks();
  const id = links[slug];
  return id ? readEvent(id) : null;
}

// ---------------------------------------------------------------------------
// listening
// ---------------------------------------------------------------------------

export interface ServeOptions extends AppOptions {
  host: string;
  port: number;
  /** Named in the startup line, e.g. "dev" or "production". */
  mode?: string;
  /**
   * Serve the realtime WebSocket channel. Defaults to the `TIMEFUL_REALTIME`
   * reading; the CLI passes the value it resolved from the config file instead.
   * When false, no upgrade listener is registered at all.
   */
  realtime?: boolean;
}

/** Builds the app and listens. Resolves once the socket is open. */
export function serve(options: ServeOptions): Promise<Server> {
  const app = createApp(options);
  const realtime = options.realtime ?? realtimeEnabled();
  return new Promise((resolve, reject) => {
    const server = app.listen(options.port, options.host, () => {
      // Attached to the listening server, never to the app: an upgrade is a
      // property of the HTTP connection and never reaches Express at all.
      if (realtime) {
        const hub = attachRealtime(server, { resolveEvent });
        server.on("close", () => void hub.close());
      }
      console.log(
        `Timeful ${options.mode ?? "production"} server on http://${options.host}:${options.port}`,
      );
      console.log(`Trusted proxies: ${describeTrustedProxies(options.trustProxy)}`);
      console.log(`Realtime updates: ${realtime ? "on" : "off"}`);
      resolve(server);
    });
    server.on("error", reject);
  });
}
