/**
 * Vite `define` replaces `__TIMEFUL_VERSION__` for client and SSR alike — the
 * two must print the same string or the footer fails hydration. The fallback
 * mirrors `server/cli/version.ts` for undefined contexts (plain Vitest run).
 */
declare const __TIMEFUL_VERSION__: string;

export const VERSION: string =
  typeof __TIMEFUL_VERSION__ === "string" ? __TIMEFUL_VERSION__ : "0.0.0-dev";
