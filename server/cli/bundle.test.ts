/**
 * The published bundle must not contain the dev server.
 *
 * `dist/cli.js` is bundled from `server/cli/index.ts`, whose module graph
 * never reaches `server/index.ts` — the only importer of `server/dev.ts` — so
 * Vite and the dev renderer stay out *by construction*, not by an external
 * rule in the rollup config. Construction can regress silently: rollup does
 * follow dynamic imports, and `inlineDynamicImports: true` would inline one,
 * so a future import edge from the CLI graph to the dev seam would ship Vite
 * without any build error. These tests pin the property to the artifact.
 *
 * Skipped when `dist/` has not been built. CI builds before it tests (the CLI
 * end-to-end tests need `dist/client`), so they always run there; locally they
 * run after any `npm run build`.
 *
 * Note `vite-hmr` is deliberately not on the telltale list: the realtime
 * listener names that subprotocol so it can step aside for Vite in dev
 * (server/realtime.ts), and that check ships. What must not ship is Vite
 * itself and the dev renderer around it.
 */
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const distDir = fileURLToPath(new URL("../../dist/", import.meta.url));
const cliFile = fileURLToPath(new URL("../../dist/cli.js", import.meta.url));
const pkgFile = fileURLToPath(new URL("../../dist/package.json", import.meta.url));

describe.skipIf(!fs.existsSync(cliFile))("dist/cli.js", () => {
  it("contains no dev-server code", () => {
    const bundle = fs.readFileSync(cliFile, "utf8");
    const telltales = [
      "createDevRenderer", // server/dev.ts's export
      "middlewareMode", // the option dev.ts passes to Vite
      "ssrLoadModule", // the dev renderer's module loader
      "transformIndexHtml", // the dev renderer's template hook
      "24678", // Vite's default HMR port
    ];
    for (const telltale of telltales) {
      expect(bundle.includes(telltale), `bundle contains "${telltale}"`).toBe(false);
    }
  });

  it("is the only JavaScript at the top of dist/", () => {
    // `inlineDynamicImports` makes cli.js the single chunk. A second .js file
    // beside it would mean rollup started splitting the graph — the shape a
    // stray dev chunk would take.
    const scripts = fs
      .readdirSync(distDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".js"))
      .map((entry) => entry.name);
    expect(scripts).toEqual(["cli.js"]);
  });

  it("declares no dependencies", () => {
    // Everything runtime is bundled; a dependencies key appearing here means
    // something started resolving as external (ARCHITECTURE.md § Packaging).
    const pkg = JSON.parse(fs.readFileSync(pkgFile, "utf8")) as Record<string, unknown>;
    expect("dependencies" in pkg).toBe(false);
    expect("devDependencies" in pkg).toBe(false);
  });
});
