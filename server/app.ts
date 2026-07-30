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
import type { IncomingMessage, Server } from "node:http";
import { pathToFileURL } from "node:url";
import express from "express";
import type { Express, NextFunction, Request, Response } from "express";
import { cookieParser } from "./auth.ts";
import { realtimeEnabled } from "./config.ts";
// Runtime, like the slug rules: what a link-holder may see is one definition,
// and the SSR page applies exactly the one the JSON route applies.
import { publicEvent } from "../src/lib/event.ts";
import { statusOf } from "./http.ts";
import type { AssetPaths } from "./paths.ts";
import { describeTrustedProxies, type TrustProxySetting } from "./proxy.ts";
import { NOT_FOUND_HTML, sendNotFoundPage } from "./not-found.ts";
import { attachRealtime } from "./realtime.ts";
import { authRouter } from "./routes/auth.ts";
import {
  eventScopedRouter,
  eventsRouter,
  resolveEvent,
  writeResponse,
} from "./routes/events.ts";
import { leasesRouter } from "./routes/leases.ts";
import { sessionsRouter } from "./routes/sessions.ts";
import { readEvent, readLinks } from "./storage.ts";
import { tarpitMiss } from "./tarpit.ts";
import type { StoredEvent } from "./types.ts";

// Re-exported from where it used to live, so importers keep working; the page
// itself moved to its own module because the event-scoped router needs it too.
export { NOT_FOUND_HTML };

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

  // Event-scoped endpoints live on the event's own path, not under `/api`
  // (ARCHITECTURE.md § API). Mounted *after* the static middleware so a real
  // file under `/assets/…` is still a file rather than a slug named "assets",
  // and before the page handler, which owns single-segment paths.
  app.use(eventScopedRouter);

  // -------------------------------------------------------------------------
  // page rendering
  // -------------------------------------------------------------------------

  function renderShell(template: string): string {
    return replaceOnce(replaceOnce(template, "<!--app-html-->", ""), "<!--app-head-->", "");
  }

  async function renderEventPage(
    template: string,
    stored: StoredEvent,
    req: Request,
  ): Promise<string> {
    // The whole document is inlined into the page, so the page is a public
    // route like any other and takes the same strip. Done once, here: the
    // markup is rendered from this copy and the `window.__EVENT__` script
    // serialises the same one, so the two cannot disagree.
    const event = publicEvent(stored);
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
    sendNotFoundPage(res);
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
    // `/api/*` by its prefix, and the event-scoped endpoints by the mark
    // `jsonRoute` leaves — their paths look exactly like page URLs.
    if (req.path.startsWith("/api") || res.locals.jsonRoute === true) {
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

/**
 * The client address of a WebSocket upgrade, evaluated by the app's own
 * `trust proxy` setting.
 *
 * An upgrade never reaches Express, so there is no `req.ip` to read — but the
 * rule for deriving one is a property of the app rather than of the request,
 * and Express keeps it on the request *prototype*. Borrowing that prototype
 * asks the same question the `PUT` asks, with the same answer, instead of
 * reimplementing a forwarded-chain walk that would drift from it. Nothing
 * depends on it succeeding: the peer address is the fallback, which is what
 * this would have been without it.
 *
 * The [tarpit](./tarpit.ts) deliberately does *not* use this. Counting misses
 * wants the address a client cannot lie about; recording where an answer was
 * edited from wants the one nginx is forwarding.
 */
function upgradeClientIp(app: Express, req: IncomingMessage): string {
  try {
    const proto = Object.create(app.request) as {
      app: Express;
      headers: IncomingMessage["headers"];
      socket: IncomingMessage["socket"];
      connection: IncomingMessage["socket"];
      ip?: string;
    };
    proto.app = app;
    proto.headers = req.headers;
    proto.socket = req.socket;
    proto.connection = req.socket;
    if (typeof proto.ip === "string" && proto.ip) return proto.ip;
  } catch {
    // Fall through: an Express that no longer exposes this is not a reason to
    // refuse the upgrade.
  }
  return req.socket.remoteAddress || "";
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
        const hub = attachRealtime(server, {
          resolveEvent,
          writeResponse,
          clientIp: (req) => upgradeClientIp(app, req),
        });
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
