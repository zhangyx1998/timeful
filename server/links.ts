/**
 * The slug side of `links.json`: allocation, claim and release.
 *
 * `links.json` maps slug -> event id and is the authority on which slugs are
 * spoken for; live leases (`leases.ts`) reserve slugs for events that do not
 * exist yet. Everything here that writes goes through `updateLinks`'s per-file
 * lock, and answers `undefined` from the update callback — storage.ts's
 * "do not write" signal — whenever nothing changed, so a refused claim never
 * persists a phantom write.
 */
import { BadRequest } from "./http.ts";
import { consumeLease, isLeased } from "./leases.ts";
import { randomSlug } from "./slugs.ts";
import { updateLinks } from "./storage.ts";
import type { LinksMap } from "./types.ts";

/**
 * A random capability slug that collides with neither stored links nor live
 * leases. Callers hold whatever lock makes the answer trustworthy: the create
 * path calls this inside `updateLinks`, the lease route only ever *reserves*
 * the result.
 */
export function freeRandomSlug(links: LinksMap): string {
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const candidate = randomSlug();
    if (!links[candidate] && !isLeased(candidate)) return candidate;
  }
  // 62^SLUG_LENGTH candidates: only a broken RNG gets here.
  throw new BadRequest("Could not allocate a free slug", 503);
}

/**
 * Claims a slug for event `id`, atomically. Returns the slug now linked.
 *
 * The claim happens under the links lock so two concurrent claims cannot both
 * win the same path — which is also why a `null` `desired` allocates the
 * random slug *inside* the callback rather than before it. Throws
 * `409 "Slug is already taken"` when another event holds the slug, without
 * writing anything.
 *
 * A live lease on the claimed slug is this admin's own reservation: claiming
 * the slug consumes it. That holds for a rename (`from` set) exactly as for a
 * create — blocking a rename on a lease instead was an asymmetry with no
 * reason behind it: the edit form can now reserve a fresh random link too, so
 * the only lease a rename ever meets is the one the form took a moment ago
 * for this very rename. The old link, when it is still this event's, goes in
 * the same write.
 */
export async function claimSlug(
  desired: string | null,
  id: string,
  from?: string,
): Promise<string> {
  let slug = desired ?? "";
  let conflict = false;
  await updateLinks((links) => {
    if (!slug) slug = freeRandomSlug(links);
    if (links[slug] && links[slug] !== id) {
      conflict = true;
      return undefined;
    }
    consumeLease(slug);
    if (from !== undefined && links[from] === id) delete links[from];
    links[slug] = id;
    return links;
  });
  if (conflict) throw new BadRequest("Slug is already taken", 409);
  return slug;
}

/**
 * Removes the `slug -> id` link — but only while it is still exactly that
 * pair. The create rollback and the delete route both release only what they
 * own, so a slug someone else claimed in the meantime is left alone.
 */
export async function releaseSlug(slug: string, id: string): Promise<void> {
  await updateLinks((links) => {
    if (links[slug] !== id) return undefined;
    delete links[slug];
    return links;
  });
}
