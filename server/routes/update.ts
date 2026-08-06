/**
 * `GET /api/update-check` — admin-only and only ever on request: no interval,
 * no page-load check, no startup probe. Server-side because the registry sets
 * no CORS headers and a visitor's browser has no business talking to npm.
 */
import { Router } from "express";
import { requireAdmin } from "../auth.ts";
import { VERSION } from "../cli/version.ts";
import { fetchLatestVersion, isDevelopmentBuild, isNewerVersion } from "../registry.ts";
import type { UpdateCheck } from "../types.ts";

export const updateRouter = Router();

// Mounted at /api alongside the others: `requireAdmin` attaches per route.
updateRouter.get("/update-check", requireAdmin, async (_req, res) => {
  const { latest, problem } = await fetchLatestVersion();
  const development = isDevelopmentBuild(VERSION);

  const body: UpdateCheck = {
    current: VERSION,
    latest,
    // A source checkout is not "behind": it is not on the release line at all.
    updateAvailable: !development && latest !== null && isNewerVersion(latest, VERSION),
    // The CWD is the webroot for an installed copy (ARCHITECTURE.md § Static assets); nothing else is disclosed.
    webroot: process.cwd(),
    development,
    ...(problem ? { problem } : {}),
  };

  // An unreachable registry is an answer (200, `latest: null`), not a 500.
  res.json(body);
});
