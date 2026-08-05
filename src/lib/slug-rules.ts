/**
 * What makes a slug legal. Pure rules, no crypto and no I/O, so **both halves
 * import this one module**: the server validates with it before writing
 * anything, and the event form validates with it as the admin types.
 *
 * They used to be the server's alone, which meant the form could only find out
 * a path was illegal by sending it — and the wording of the two answers could
 * drift apart the moment either side was edited. One definition means the
 * inline message is literally the message the server would have returned.
 *
 * Generation (the random capability slug) stays on the server in `slugs.ts`,
 * which re-exports these so nothing else has to know they moved.
 */

export const MAX_SLUG_LENGTH = 80;

/**
 * Paths the server itself owns. Compared case-insensitively: Express routes and
 * the static mounts are not case sensitive, so `/API` is `/api`.
 */
export const RESERVED_SLUGS: ReadonlySet<string> = new Set(["api", "assets"]);

/**
 * The sub-segments an event's own path spends on its API: `/<slug>/data`,
 * `/<slug>/details`, `/<slug>/settings`, `/<slug>/users/<key>`,
 * `/<slug>/push`, `/<slug>/ws` and `/<slug>/logs`.
 *
 * They are **sub**-segments and constrain nothing about slugs, which are single
 * segments — `/data` is a perfectly good event page. What they decide is how a
 * miss under a slug answers: one of these is somebody's API client and gets
 * JSON, anything else is somebody's browser and gets the 404 page.
 */
export const RESERVED_SUBPATHS: ReadonlySet<string> = new Set([
  "data",
  "details",
  "settings",
  "users",
  "push",
  "ws",
  "logs",
]);

/**
 * The sub-segments an event's path spends on its own **pages**: `/<slug>/view`
 * and `/<slug>/edit/<userKey>` (ARCHITECTURE.md § Routing / SSR). Reserved
 * like the API set above, but kept apart from it on purpose: a miss under one
 * of these is somebody's *browser* and gets the 404 page, never JSON — which
 * is exactly the distinction `RESERVED_SUBPATHS` exists to draw. The
 * event-scoped catch-all passes these through to the page handler instead of
 * answering them.
 */
export const PAGE_SUBPATHS: ReadonlySet<string> = new Set(["view", "edit"]);

/**
 * Letters, digits and hyphens, starting with a letter or a digit. Everything
 * else a path might carry — a slash, a dot, a space, a percent-escape — is out,
 * which is what keeps a slug a single path segment.
 */
const SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9-]*$/;

/** Returns an error string, or null when the slug is usable. */
export function slugProblem(slug: string): string | null {
  if (!slug) return "Slug is required";
  if (slug.length > MAX_SLUG_LENGTH)
    return `Slug must be at most ${MAX_SLUG_LENGTH} characters`;
  if (slug.startsWith("_") || slug.startsWith("."))
    return "Slug may not start with '_' or '.'";
  if (!SLUG_RE.test(slug))
    return "Slug may only contain letters, numbers and hyphens";
  if (RESERVED_SLUGS.has(slug.toLowerCase())) return `'${slug}' is a reserved slug`;
  return null;
}
