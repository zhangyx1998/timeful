/**
 * The published bundle must not contain the dev server: the CLI's module graph never reaches
 * server/dev.ts, and these tests pin that property to the artifact. Skipped when dist/ has not
 * been built. `vite-hmr` is deliberately not a telltale — that subprotocol check ships.
 */
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const distDir = fileURLToPath(new URL("../../dist/", import.meta.url));
const cliFile = fileURLToPath(new URL("../../dist/cli.js", import.meta.url));
const pkgFile = fileURLToPath(new URL("../../dist/package.json", import.meta.url));
const vendorDir = fileURLToPath(new URL("../../dist/vendor/", import.meta.url));

/** Every JavaScript file the CLI build emitted: the entry plus vendor/. */
function emittedScripts(): string[] {
  const vendor = fs.existsSync(vendorDir)
    ? fs.readdirSync(vendorDir).map((name) => `vendor/${name}`)
    : [];
  return ["cli.js", ...vendor].filter((name) => name.endsWith(".js"));
}

describe.skipIf(!fs.existsSync(cliFile))("dist/cli.js", () => {
  it("contains no dev-server code, in any emitted chunk", () => {
    const telltales = [
      "createDevRenderer", // server/dev.ts's export
      "middlewareMode", // the option dev.ts passes to Vite
      "ssrLoadModule", // the dev renderer's module loader
      "transformIndexHtml", // the dev renderer's template hook
      "24678", // Vite's default HMR port
    ];
    for (const script of emittedScripts()) {
      const chunk = fs.readFileSync(`${distDir}${script}`, "utf8");
      for (const telltale of telltales) {
        expect(chunk.includes(telltale), `${script} contains "${telltale}"`).toBe(false);
      }
    }
  });

  it("keeps the optional ws natives behind require, never an import", () => {
    // `commonjs({ ignoreTryCatch: true })` leaves ws's guarded requires for
    // bufferutil and utf-8-validate unconverted; converted, they would become
    // top-level imports of packages an install never has — a startup crash
    // instead of ws's JavaScript fallback (ARCHITECTURE.md § Packaging).
    for (const script of emittedScripts()) {
      const chunk = fs.readFileSync(`${distDir}${script}`, "utf8");
      for (const native of ["bufferutil", "utf-8-validate"]) {
        expect(
          new RegExp(`import[^;]{0,80}["']${native}["']`).test(chunk),
          `${script} imports "${native}" at the top level`,
        ).toBe(false);
      }
    }
  });

  it("is the only JavaScript at the top of dist/", () => {
    // The entry is the one chunk outside vendor/. A second .js file beside it
    // would mean the graph started splitting somewhere unaccounted for — the
    // shape a stray dev chunk would take.
    const scripts = fs
      .readdirSync(distDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".js"))
      .map((entry) => entry.name);
    expect(scripts).toEqual(["cli.js"]);
  });

  it("mirrors the root manifest's dependencies exactly", () => {
    // Root `dependencies` is reserved for packages the published artifact
    // must have installed — packages bundled at build time live in
    // devDependencies — and packageMeta forwards the field verbatim. Both
    // sides are empty today; if one stops being empty, the other must match.
    const pkg = JSON.parse(fs.readFileSync(pkgFile, "utf8")) as Record<string, unknown>;
    const root = JSON.parse(
      fs.readFileSync(fileURLToPath(new URL("../../package.json", import.meta.url)), "utf8"),
    ) as Record<string, unknown>;
    expect(pkg.dependencies ?? {}).toEqual(root.dependencies ?? {});
    expect("devDependencies" in pkg).toBe(false);
  });
});
