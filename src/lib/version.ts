/**
 * The version the client shows, e.g. in the event page's footer.
 *
 * Vite replaces `__TIMEFUL_VERSION__` with the string literal from
 * package.json at build time (`define` in vite.config.ts), for the client and
 * SSR passes alike — the two have to print the same string or an event page
 * would fail hydration over its own footer. Where the identifier was never
 * defined (a plain Vitest run, an unbundled import) it falls back, mirroring
 * `server/cli/version.ts`.
 */
declare const __TIMEFUL_VERSION__: string;

export const VERSION: string =
  typeof __TIMEFUL_VERSION__ === "string" ? __TIMEFUL_VERSION__ : "0.0.0-dev";
