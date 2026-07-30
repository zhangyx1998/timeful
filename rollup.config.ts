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
  // The contract: root `dependencies` = published dependencies, forwarded
  // verbatim. Packages bundled at build time live in `devDependencies`; the
  // field here is reserved for anything that must be installed alongside the
  // artifact — none today, so nothing is emitted.
  const dependencies = pkg.dependencies ?? {};
  const packageJSON = isProduction
    ? {
        ...pick(pkg, ...distKeys),
        ...(Object.keys(dependencies).length > 0 ? { dependencies } : {}),
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
    // `ignoreTryCatch: true` is the plugin's own default, pinned here because
    // the bundle now depends on it. `ws` reaches for two optional native
    // addons — bufferutil and utf-8-validate — inside try/catch, and falls
    // back to its JavaScript implementations when they are absent. They are
    // absent: they are native builds, and a published bundle installs nothing.
    //
    // Converting those requires would resolve them as externals, and a bare
    // `import 'bufferutil'` at the top of cli.js is a crash on startup, not a
    // fallback. Left unconverted, the `require` is simply not defined in an ESM
    // bundle, the try/catch catches that, and ws uses its own code — which is
    // the outcome an operator without a compiler wants anyway. Express's
    // chain does the same thing with `ejs` and `supports-color`.
    commonjs({ ignoreTryCatch: true }),
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

  /**
   * One vendor chunk per third-party package, first-party code in the entry.
   * The names are deliberately un-hashed: dist/ is published wholesale and
   * loaded by path, so a content hash would only churn every release.
   */
  function vendorChunk(id: string): string | undefined {
    const match = /node_modules\/((?:@[^/]+\/)?[^/]+)/.exec(id);
    if (!match) return undefined; // first-party: stays in cli.js
    return match[1].replace("/", "-");
  }

  return {
    input: { cli: $("server", "cli", "index.ts") },
    output: {
      format: "esm",
      dir: $(dst),
      entryFileNames: "cli.js",
      chunkFileNames: "vendor/[name].js",
      // Only the entry is a bin; a shebang on a vendor chunk would be noise.
      banner: (chunk) => (chunk.isEntry ? "#!/usr/bin/env node" : ""),
      sourcemap,
      manualChunks: vendorChunk,
    },
    external,
    plugins,
  };
});
