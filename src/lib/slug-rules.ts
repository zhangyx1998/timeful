/**
 * What makes a slug legal. Pure rules; both halves import this one module so
 * the form's inline message is literally the server's answer. Generation of
 * the random capability slug stays on the server in `slugs.ts`, which
 * re-exports these.
 */

export const MAX_SLUG_LENGTH = 80;

/** Paths the server itself owns. Case-insensitive: Express routes `/API` as `/api`. */
export const RESERVED_SLUGS: ReadonlySet<string> = new Set(["api", "assets"]);

/**
 * The sub-segments an event's own path spends on its API. They constrain
 * nothing about slugs (`/data` is a fine event page); they decide whether a
 * miss under a slug answers JSON or the 404 page.
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

/** Letters, digits and hyphens only — what keeps a slug a single path segment. */
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
