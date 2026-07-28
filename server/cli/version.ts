/**
 * The version reported by `timeful --version`.
 *
 * Rollup replaces `__TIMEFUL_VERSION__` with the string literal from
 * package.json at build time (esbuild `define`), so the packaged CLI carries
 * no package.json read at runtime. Running from source — tests, `node
 * server/cli/index.ts` — leaves the identifier undefined and falls back.
 */
declare const __TIMEFUL_VERSION__: string;

export const VERSION: string =
  typeof __TIMEFUL_VERSION__ === "string" ? __TIMEFUL_VERSION__ : "0.0.0-dev";
