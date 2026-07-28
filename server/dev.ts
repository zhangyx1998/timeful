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
import { createServer } from "vite";
import type { Renderer, RenderFn } from "./app.ts";

/** `root` is the repo root: the directory holding index.html and vite.config.ts. */
export async function createDevRenderer(root: string): Promise<Renderer> {
  const vite = await createServer({
    root,
    appType: "custom",
    server: { middlewareMode: true },
  });

  return {
    attach(app) {
      app.use(vite.middlewares);
    },
    async loadTemplate(url) {
      const raw = await fs.readFile(path.join(root, "index.html"), "utf8");
      return vite.transformIndexHtml(url, raw);
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
