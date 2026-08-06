/** Admin-only, in-memory slug leases: reserved while the create form is open, consumed on create, released on cancel. */
import { Router } from "express";
import { requireAdmin } from "../auth.ts";
import { param } from "../http.ts";
import { releaseLease, reserveLease } from "../leases.ts";
import { freeRandomSlug } from "../links.ts";
import { readLinks } from "../storage.ts";

export const leasesRouter = Router();

// POST /api/slug-leases — reserve a fresh random slug.
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
