import commonjs from "@rollup/plugin-commonjs";
import json from "@rollup/plugin-json";
import { nodeResolve } from "@rollup/plugin-node-resolve";
import terser from "@rollup/plugin-terser";
import { chmodSync, readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { resolve } from "node:path";
import { defineConfig, type Plugin } from "rollup";
import esbuild from "rollup-plugin-esbuild";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(import.meta.url), "..");
const $ = (...p: string[]) => resolve(ROOT, ...p);

function pick(input: Record<string, any>, ...keys: string[]) {
  return Object.fromEntries(
    keys.filter((k) => k in input).map((k) => [k, input[k]]),
  );
}

function read(file: string) {
  return readFileSync($(file), "utf-8");
}

const pkg = JSON.parse(read("package.json"));

// Keys carried over from the root package.json into the bare dist/package.json.
// dependencies are intentionally omitted: everything is bundled into cli.js.
const distKeys = [
  "name",
  "version",
  "description",
  "engines",
  "license",
  "author",
  "repository",
  "homepage",
  "bugs",
  "keywords",
];

/**
 * Emit the publishable, dist-folder-as-root metadata: a bare package.json
 * (with the CLI `bin`), plus LICENSE and the npm README. In debug builds only a stub
 * package.json is written so a stray `npm publish` from dist can't succeed.
 */
function packageMeta(isProduction: boolean): Plugin {
  const bin = { timeful: "cli.js" };
  const packageJSON = isProduction
    ? {
        ...pick(pkg, ...distKeys),
        type: "module",
        bin,
        publishConfig: { access: "public" },
      }
    : { private: true, type: "module", bin };
  return {
    name: "package-meta",
    buildStart() {
      this.emitFile({
        type: "asset",
        fileName: "package.json",
        source: JSON.stringify(packageJSON, null, 2),
      });
      if (!isProduction) return;
      this.emitFile({
        type: "asset",
        fileName: "LICENSE",
        source: read("LICENSE"),
      });
      // Not the root README: that one is an untracked pointer stub, so CI
      // cannot rely on it existing. docs/npm-README.md is tracked and is
      // written for the npm listing page rather than for a checkout.
      this.emitFile({
        type: "asset",
        fileName: "README.md",
        source: read("docs/npm-README.md"),
      });
    },
  };
}

export default defineConfig((commandLineArgs) => {
  const dst = "dist";
  // Unlike a plain CLI package, dist/ is shared: `vite build` has already put
  // the client and SSR trees there, and cli.js is published beside them. The
  // clean belongs to the `prebuild` script, not here.
  const isProduction = commandLineArgs.configDebug !== true;
  const sourcemap = isProduction ? false : "inline";

  const external = [
    ...builtinModules,
    ...builtinModules.map((m) => `node:${m}`),
  ];

  const plugins = [
    nodeResolve({ preferBuiltins: true, exportConditions: ["node"] }),
    commonjs(),
    // express's dependency chain requires JSON data files (statuses, mime-db).
    json(),
    esbuild({
      target: "node22",
      // Read back by server/cli/version.ts; running from source leaves the
      // identifier undefined and falls back to a dev version.
      define: { __TIMEFUL_VERSION__: JSON.stringify(pkg.version) },
    }),
    packageMeta(isProduction),
  ];
  if (isProduction) plugins.push(terser());

  const outFile = $(dst, "cli.js");

  // Rollup does not carry an executable bit; a `bin` entry must be runnable
  // directly (npm link / npx) without relying on npm's install-time chmod.
  plugins.push({
    name: "chmod-bin",
    writeBundle() {
      chmodSync(outFile, 0o755);
    },
  });

  return {
    input: $("server", "cli", "index.ts"),
    output: {
      format: "esm",
      file: outFile,
      banner: "#!/usr/bin/env node",
      sourcemap,
      // The SSR bundle is loaded at runtime by path, not linked at build time.
      inlineDynamicImports: true,
    },
    external,
    plugins,
  };
});
