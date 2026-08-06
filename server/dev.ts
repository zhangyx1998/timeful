/**
 * The development renderer: Vite in middleware mode, with HMR.
 *
 * Deliberately a separate module. It is the only server file that imports
 * `vite` at runtime, and `server/index.ts` only reaches it through a dynamic
 * import behind `--dev` — so the packaged CLI bundle never pulls the dev
 * server, its plugins, or the source tree in.
 */
import fs from "node:fs/promises";
import path from "node:path";
import type { Server } from "node:http";
import { createServer } from "vite";
import type { Renderer, RenderFn } from "./app.ts";

/**
 * `root` is the repo root: the directory holding index.html and vite.config.ts.
 * `server` is the app's own HTTP server, not yet listening.
 */
export async function createDevRenderer(root: string, server: Server): Promise<Renderer> {
  const vite = await createServer({
    root,
    appType: "custom",
    // Handed the app's HTTP server, Vite attaches its own `upgrade` listener
    // to it and serves the HMR WebSocket on the app's port — no fixed second
    // port (24678) for parallel checkouts to fight over, and a phone on the
    // LAN gets hot reload through the one address it can already reach. Vite
    // tags these upgrades with the `vite-hmr` subprotocol; the realtime
    // listener steps aside on that token (see server/realtime.ts).
    server: { middlewareMode: true, hmr: { server } },
  });

  return {
    attach(app) {
      app.use(vite.middlewares);
    },
    async loadTemplate(url) {
      const raw = await fs.readFile(path.join(root, "index.html"), "utf8");
      const html = await vite.transformIndexHtml(url, raw);
      // Dev-only softening of the style flash. In production the whole built
      // stylesheet is inlined into the template (`inlineStylesheets` in
      // app.ts); dev has no built asset — Vite injects styles from JS modules
      // well after first paint — so the page briefly renders bare. Inlining
      // tokens.css, the palette and base html rule, paints the right colors
      // and font immediately; the real copy Vite injects later in <head> wins
      // by document order, so an HMR edit of the tokens still applies.
      const tokens = await fs.readFile(
        path.join(root, "src", "styles", "tokens.css"),
        "utf8",
      );
      return html.replace("</head>", () => `<style>${tokens}</style>\n  </head>`);
    },
    async loadRender() {
      const mod = await vite.ssrLoadModule("/src/entry-server.ts");
      return mod.render as RenderFn;
    },
    fixStacktrace(err) {
      vite.ssrFixStacktrace(err);
    },
  };
}
