import { fileURLToPath } from "node:url";
import { mergeConfig } from "vite";
import { defineConfig } from "vitest/config";
import viteConfig from "./vite.config.ts";

/** Vitest inherits the app's Vite config (so SFCs compile) and limits discovery
 *  to the two source trees, `src/` and `server/`. The app config is a function
 *  (its SSR settings differ per build), so it is resolved for a dev-like run
 *  first — tests never go through the SSR build path. */
export default mergeConfig(
  viteConfig({ command: "serve", mode: "test" }),
  defineConfig({
    test: {
      include: ["src/**/*.{test,spec}.ts", "server/**/*.{test,spec}.ts"],
      exclude: ["**/node_modules/**", "dist/**"],
      root: fileURLToPath(new URL(".", import.meta.url)),
    },
  }),
);
