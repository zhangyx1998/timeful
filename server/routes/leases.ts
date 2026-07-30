/**
 * Slug leases — admin-only, in memory only.
 *
 * The admin UI asks for a lease while the create form is open so it can show
 * the final capability URL before the event exists; creating the event
 * consumes the lease, and cancelling (or typing a custom path) releases it.
 */
import { Router } from "express";
import { requireAdmin } from "../auth.ts";
import { param } from "../http.ts";
import { releaseLease, reserveLease } from "../leases.ts";
import { freeRandomSlug } from "../links.ts";
import { readLinks } from "../storage.ts";

export const leasesRouter = Router();

// POST /api/slug-leases — reserve a fresh random slug. `freeRandomSlug`
// answers the 503 itself after 32 failed attempts.
leasesRouter.post("/slug-leases", requireAdmin, async (_req, res) => {
  const lease = reserveLease(freeRandomSlug(await readLinks()));
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
