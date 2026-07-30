/**
 * `GET /api/update-check` — is there a newer Timeful?
 *
 * Admin-only, and **only ever on request**. Nothing on this route runs unless
 * the owner presses the button in the panel: there is no interval, no check on
 * page load and no startup probe. That is the whole reason it is a route rather
 * than something the client does for itself — a self-hosted app that reaches
 * the internet when nobody asked it to is not the same app.
 *
 * The fetch happens here rather than in the browser for two reasons: the
 * registry sets no CORS headers the page could use, and the visitor's browser
 * has no business talking to npm on the server's behalf.
 */
import { Router } from "express";
import { requireAdmin } from "../auth.ts";
import { VERSION } from "../cli/version.ts";
import { fetchLatestVersion, isDevelopmentBuild, isNewerVersion } from "../registry.ts";
import type { UpdateCheck } from "../types.ts";

export const updateRouter = Router();

// NOTE: mounted at /api alongside the other routers, so `requireAdmin` is
// attached per route rather than to the router — see routes/sessions.ts.
updateRouter.get("/update-check", requireAdmin, async (_req, res) => {
  const { latest, problem } = await fetchLatestVersion();
  const development = isDevelopmentBuild(VERSION);

  const body: UpdateCheck = {
    current: VERSION,
    latest,
    // A source checkout is not "behind": it is not on the release line at all,
    // and telling its developer to npx an older published build would be wrong.
    updateAvailable: !development && latest !== null && isNewerVersion(latest, VERSION),
    // The working directory *is* the webroot for an installed copy
    // (ARCHITECTURE.md § Static assets), and it is what the upgrade command has
    // to be run from. Nothing else about the filesystem is disclosed, and no
    // event slug ever appears here.
    webroot: process.cwd(),
    development,
    ...(problem ? { problem } : {}),
  };

  // A registry that cannot be reached is an answer, not a failure: 200 with
  // `latest: null` and a sentence the panel can render. A 500 here would put a
  // stack trace in the log every time somebody checked from behind a firewall.
  res.json(body);
});
