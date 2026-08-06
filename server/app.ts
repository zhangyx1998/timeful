import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { IncomingMessage, Server } from "node:http";
import { pathToFileURL } from "node:url";
import express from "express";
import type { Express, NextFunction, Request, Response } from "express";
import { cookieParser, loadSession, sessionTokenFromHeader, touchSession } from "./auth.ts";
import { realtimeEnabled } from "./config.ts";
import { logError, redactPath, stackHead } from "./log.ts";
import { publicEvent } from "../src/lib/event.ts";
// Runtime imports: hydrated title must be byte-equal to the served one (ARCHITECTURE.md § Routing / SSR).
import {
  eventPageTitle,
  parseEventPath,
  type EventPagePath,
  type EventSubpage,
} from "../src/lib/event-routes.ts";
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
import { pushRouter, pushScopedRouter } from "./routes/push.ts";
import { sessionsRouter } from "./routes/sessions.ts";
import { updateRouter } from "./routes/update.ts";
import { readEvent, readLinks } from "./storage.ts";
import { tarpitMiss } from "./tarpit.ts";
import type { ErrorDetail, StoredEvent } from "./types.ts";

export { NOT_FOUND_HTML };

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

/** Production renderer; `assets` resolves from the running module (paths.ts), never the CWD. */
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
      // `import()` wants a URL: a bare absolute path is ambiguous on Windows.
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
  app.set("trust proxy", trustProxy);
  app.use(express.json({ limit: "2mb" }));
  app.use(cookieParser);

  app.use("/api", authRouter);
  app.use("/api", sessionsRouter);
  app.use("/api", leasesRouter);
  app.use("/api", eventsRouter);
  app.use("/api", updateRouter);
  app.use("/api", pushRouter);
  app.use("/api", (_req: Request, res: Response) => {
    res.status(404).json({ error: "Not found" });
  });

  renderer.attach?.(app);

  // After static middleware, before the page handler; push router first or the
  // event router's catch-all swallows `/:slug/push` (ARCHITECTURE.md § API).
  app.use(pushScopedRouter);
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
    sub: EventSubpage,
  ): Promise<string> {
    // One publicEvent copy feeds both the markup and `window.__EVENT__`.
    const event = publicEvent(stored);
    const render = await renderer.loadRender();
    const { html } = await render(req.path, { event });
    const absoluteUrl = `${req.protocol}://${req.get("host") ?? "localhost"}${req.path}`;
    const { title, tags } = eventHead(event, absoluteUrl, sub);

    // Stamped before the markup goes in, so a rendered `<div id="app">` is never hit.
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
      res
        .status(status)
        .set("Content-Type", "text/html; charset=utf-8")
        .set("Cache-Control", "no-cache")
        .end(html);

    try {
      // '/' is CSR only — the admin app boots from the bare shell.
      if (req.path === "/") {
        if (!isRead) {
          sendHtml(404, NOT_FOUND_HTML);
          return;
        }
        sendHtml(200, renderShell(await renderer.loadTemplate(req.originalUrl)));
        return;
      }

      // Only an actual miss enters the tarpit; a non-canonical hit 302s to the event root.
      const resolved = await resolveSlugPath(req.path);
      if (!resolved) {
        await tarpitMiss(req, res, () => sendHtml(404, NOT_FOUND_HTML));
        return;
      }
      if (!isRead) {
        sendHtml(404, NOT_FOUND_HTML);
        return;
      }
      if (!resolved.shape.canonical) {
        res.redirect(302, `/${resolved.shape.slug}${req.originalUrl.slice(req.path.length)}`);
        return;
      }

      sendHtml(
        200,
        await renderEventPage(
          await renderer.loadTemplate(req.originalUrl),
          resolved.event,
          req,
          resolved.shape.sub,
        ),
      );
    } catch (err) {
      if (err instanceof Error) renderer.fixStacktrace?.(err);
      next(err);
    }
  });

  app.use((_req: Request, res: Response) => {
    sendNotFoundPage(res);
  });

  app.use(async (err: unknown, req: Request, res: Response, _next: NextFunction) => {
    const isParseFailure =
      typeof err === "object" && err !== null && "type" in err
        ? err.type === "entity.parse.failed"
        : false;
    const status = statusOf(err) ?? (isParseFailure ? 400 : 500);
    const raw = err instanceof Error ? err.message : "";
    if (status >= 500) {
      console.error(err);
      // redactPath: the first segment of an event-scoped path is the slug.
      logError(raw || "Internal server error", {
        code: errnoCode(err),
        path: redactPath(req.path),
        stack: stackHead(err instanceof Error ? err.stack : undefined),
        eventId: typeof res.locals.eventId === "string" ? res.locals.eventId : undefined,
      });
    }
    const message = status >= 500 ? "Internal server error" : raw || "Bad request";
    // The admin gets the cause; a guest's body stays byte-identical.
    const detail = (await loadSession(req).catch(() => null))
      ? adminDetail(err, raw, message)
      : undefined;
    // Event-scoped paths look like page URLs; `jsonRoute` is their mark.
    if (req.path.startsWith("/api") || res.locals.jsonRoute === true) {
      res.status(status).json({ error: message, ...(detail ? { detail } : {}) });
      return;
    }
    res.status(status).set("Content-Type", "text/plain; charset=utf-8").end(message);
  });

  return app;
}

function errnoCode(err: unknown): string | undefined {
  if (typeof err !== "object" || err === null || !("code" in err)) return undefined;
  return typeof err.code === "string" ? err.code : undefined;
}

/** The filesystem path of an errno error — the operator's own disk, never a slug. */
function errnoPath(err: unknown): string | undefined {
  if (typeof err !== "object" || err === null || !("path" in err)) return undefined;
  return typeof err.path === "string" ? err.path : undefined;
}

/** Admin-only error detail; omitted when it would repeat the public message. */
function adminDetail(
  err: unknown,
  raw: string,
  publicMessage: string,
): ErrorDetail | undefined {
  const code = errnoCode(err);
  const path = errnoPath(err);
  const message = raw || String(err ?? "");
  if (message === publicMessage && !code && !path) return undefined;
  return {
    message,
    ...(code ? { code } : {}),
    ...(path ? { path } : {}),
  };
}

function eventHead(
  event: StoredEvent,
  url: string,
  sub: EventSubpage,
): { title: string; tags: string } {
  const name = escapeHtml(event.name);
  const description = escapeHtml(`Fill in your availability for ${event.name}.`);
  const tags = [
    // Capability links stay out of search indexes (ARCHITECTURE.md § Security); OG tags stay for unfurls.
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
  return { title: eventPageTitle(event, sub), tags };
}

/** An edit key that names nobody still serves the page: the slug is the sole capability. */
async function resolveSlugPath(
  pathname: string,
): Promise<{ event: StoredEvent; shape: EventPagePath } | null> {
  const shape = parseEventPath(pathname);
  if (!shape) return null;
  const links = await readLinks();
  const id = links[shape.slug];
  const event = id ? await readEvent(id) : null;
  return event ? { event, shape } : null;
}

// ---------------------------------------------------------------------------
// listening
// ---------------------------------------------------------------------------

/** Factory form exists so dev can hang Vite's HMR WebSocket off the app's own server. */
export type RendererFactory = (server: Server) => Renderer | Promise<Renderer>;

export interface ServeOptions extends Omit<AppOptions, "renderer"> {
  host: string;
  port: number;
  /** A renderer, or a factory handed the not-yet-listening HTTP server. */
  renderer: Renderer | RendererFactory;
  /** Named in the startup line, e.g. "dev" or "production". */
  mode?: string;
  /** Serve the realtime channel. Defaults to the `TIMEFUL_REALTIME` reading. */
  realtime?: boolean;
}

/** Upgrade client IP via the app's own trust-proxy rule, borrowed off Express's request prototype. */
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
    // Fall through to the peer address.
  }
  return req.socket.remoteAddress || "";
}

/** Builds the app and listens. Resolves once the socket is open. */
export async function serve(options: ServeOptions): Promise<Server> {
  // Server exists before the app so a renderer factory (dev HMR) can be handed it.
  const server = http.createServer();
  const renderer =
    typeof options.renderer === "function"
      ? await options.renderer(server)
      : options.renderer;
  const app = createApp({ trustProxy: options.trustProxy, renderer });
  server.on("request", app);

  const realtime = options.realtime ?? realtimeEnabled();
  await new Promise<void>((resolve, reject) => {
    // Left attached: a later 'error' with no listener would crash the process.
    server.on("error", reject);
    server.listen(options.port, options.host, resolve);
  });

  // Upgrades never reach Express; always registered — it also carries the admin log streams.
  const hub = attachRealtime(server, {
    resolveEvent,
    writeResponse,
    clientIp: (req) => upgradeClientIp(app, req),
    realtime,
    // The same answer `requireAdmin` gives, read from raw headers — no middleware ran.
    verifyAdmin: async (req) => {
      const token = sessionTokenFromHeader(
        Array.isArray(req.headers.cookie) ? req.headers.cookie[0] : req.headers.cookie,
      );
      if (!token) return false;
      return (await touchSession(token)) !== null;
    },
  });
  server.on("close", () => void hub.close());

  for (const line of startupLines(options, realtime)) console.log(line);
  return server;
}

/** Startup printout; the CLI's e2e tests match the loopback line's literal. */
function startupLines(options: ServeOptions, realtime: boolean): string[] {
  const { host, port } = options;
  const wildcard = host === "0.0.0.0" || host === "::";
  const lines = [
    `Timeful ${options.mode ?? "production"} server on http://${wildcard ? "127.0.0.1" : host}:${port}`,
  ];
  if (wildcard) {
    for (const address of lanAddresses())
      lines.push(`  network: http://${address}:${port}`);
  }
  lines.push(`Trusted proxies: ${describeTrustedProxies(options.trustProxy)}`);
  lines.push(`Realtime updates: ${realtime ? "on" : "off"}`);
  return lines;
}

/** Every non-internal IPv4 address this machine holds, for the wildcard bind. */
function lanAddresses(): string[] {
  const seen = new Set<string>();
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === "IPv4" && !entry.internal) seen.add(entry.address);
    }
  }
  return [...seen];
}
