/** Replaced at build time (esbuild define) so the packaged CLI reads no package.json at runtime; running from source falls back. */
declare const __TIMEFUL_VERSION__: string;

export const VERSION: string =
  typeof __TIMEFUL_VERSION__ === "string" ? __TIMEFUL_VERSION__ : "0.0.0-dev";
