import { Router } from "express";
import {
  clearSessionCookie,
  deleteSession,
  purgeSessions,
  requireAdmin,
  sessionToken,
} from "../auth.ts";
import { param } from "../http.ts";
import { readSessions } from "../storage.ts";
import type { SessionInfo } from "../types.ts";

// NOTE: this router is mounted at /api alongside the others, so auth must be
// attached per route — a router-level `use(requireAdmin)` would gate every
// /api request, including the public event endpoints.
export const sessionsRouter = Router();

// GET /api/sessions
sessionsRouter.get("/sessions", requireAdmin, async (req, res) => {
  const current = sessionToken(req);
  const sessions = await readSessions();
  const list: SessionInfo[] = Object.entries(sessions)
    .map(([token, session]) => ({
      token,
      createdAt: session.createdAt,
      lastSeenAt: session.lastSeenAt,
      userAgent: session.userAgent ?? "",
      persistent: Boolean(session.persistent),
      current: token === current,
    }))
    .sort((a, b) => String(b.lastSeenAt).localeCompare(String(a.lastSeenAt)));
  res.json(list);
});

// DELETE /api/sessions — sign out everywhere else
sessionsRouter.delete("/sessions", requireAdmin, async (req, res) => {
  const deleted = await purgeSessions({ except: sessionToken(req) });
  res.json({ ok: true, deleted });
});

// DELETE /api/sessions/:token
sessionsRouter.delete("/sessions/:token", requireAdmin, async (req, res) => {
  const token = param(req.params.token);
  const deleted = await deleteSession(token);
  if (!deleted) {
    res.status(404).json({ error: "Session not found" });
    return;
  }
  if (token === sessionToken(req)) clearSessionCookie(req, res);
  res.json({ ok: true, deleted: 1 });
});
