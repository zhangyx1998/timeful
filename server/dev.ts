/**
 * Dev renderer: the only server file importing `vite`, reached only via a
 * dynamic import behind `--dev` so the CLI bundle never pulls it in.
 */
import fs from "node:fs/promises";
import path from "node:path";
import type { Server } from "node:http";
import { createServer } from "vite";
import type { Renderer, RenderFn } from "./app.ts";

/** `root` is the repo root; `server` is the app's own not-yet-listening HTTP server. */
export async function createDevRenderer(root: string, server: Server): Promise<Renderer> {
  const vite = await createServer({
    root,
    appType: "custom",
    // HMR rides the app's own server; Vite tags its upgrades `vite-hmr` and realtime steps aside.
    server: { middlewareMode: true, hmr: { server } },
  });

  return {
    attach(app) {
      app.use(vite.middlewares);
    },
    async loadTemplate(url) {
      const raw = await fs.readFile(path.join(root, "index.html"), "utf8");
      const html = await vite.transformIndexHtml(url, raw);
      // Dev-only style-flash softening: inline tokens.css for first paint; Vite's later copy wins by document order.
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
