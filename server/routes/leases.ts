/**
 * Slug leases — admin-only, in memory only.
 *
 * The admin UI asks for a lease while the create form is open so it can show
 * the final capability URL before the event exists; creating the event
 * consumes the lease, and cancelling (or typing a custom path) releases it.
 */
import { Router } from "express";
import { requireAdmin } from "../auth.ts";
import { BadRequest, param } from "../http.ts";
import { isLeased, releaseLease, reserveLease } from "../leases.ts";
import { randomSlug } from "../slugs.ts";
import { readLinks } from "../storage.ts";

export const leasesRouter = Router();

const MAX_ATTEMPTS = 32;

// POST /api/slug-leases — reserve a fresh random slug
leasesRouter.post("/slug-leases", requireAdmin, async (_req, res) => {
  const links = await readLinks();
  let slug: string | null = null;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const candidate = randomSlug();
    if (!links[candidate] && !isLeased(candidate)) {
      slug = candidate;
      break;
    }
  }
  // 62^SLUG_LENGTH candidates: only a broken RNG gets here.
  if (!slug) throw new BadRequest("Could not allocate a free slug", 503);

  const lease = reserveLease(slug);
  res.status(201).json({
    slug: lease.slug,
    expiresAt: new Date(lease.expiresAt).toISOString(),
  });
});

// DELETE /api/slug-leases/:slug — release early (idempotent)
leasesRouter.delete("/slug-leases/:slug", requireAdmin, (req, res) => {
  releaseLease(param(req.params.slug));
  res.status(204).end();
});
