/**
 * Slug allocation, claim and release over `links.json` (slug -> event id);
 * live leases (`leases.ts`) reserve slugs for events that do not exist yet.
 * A refused claim answers `undefined` so nothing is written.
 */
import { BadRequest } from "./http.ts";
import { consumeLease, isLeased } from "./leases.ts";
import { randomSlug } from "./slugs.ts";
import { updateLinks } from "./storage.ts";
import type { LinksMap } from "./types.ts";

/** A random slug free of links and leases; callers hold whatever lock makes the answer trustworthy. */
export function freeRandomSlug(links: LinksMap): string {
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const candidate = randomSlug();
    if (!links[candidate] && !isLeased(candidate)) return candidate;
  }
  // 62^SLUG_LENGTH candidates: only a broken RNG gets here.
  throw new BadRequest("Could not allocate a free slug", 503);
}

/**
 * Claims a slug under the links lock (a null `desired` allocates inside the
 * callback); 409 on conflict without writing. A live lease on the slug is this
 * admin's own reservation and is consumed, for renames exactly as for creates.
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

/** Removes the link only while it is still exactly `slug -> id`. */
export async function releaseSlug(slug: string, id: string): Promise<void> {
  await updateLinks((links) => {
    if (links[slug] !== id) return undefined;
    delete links[slug];
    return links;
  });
}
