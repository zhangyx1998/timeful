import { Router } from "express";
import {
  clearSessionCookie,
  createSession,
  deleteSession,
  loadSession,
  normalizeEmail,
  purgeSessions,
  requireAdmin,
  sessionToken,
  setCredential,
  setSessionCookie,
  verifyPassword,
} from "../auth.ts";
import { asRecord } from "../http.ts";
import { logWarn, redactIp } from "../log.ts";
import {
  allowedEmail,
  beginFlow,
  completeFlow,
  oidcSettings,
  passwordLoginEnabled,
  safeReturnPath,
  takeFlow,
} from "../oidc.ts";
import { readCredential, writeCredential } from "../storage.ts";
import { clientIp, tarpitMiss } from "../tarpit.ts";
import type { Request, Response } from "express";

const MIN_PASSWORD_LENGTH = 8;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Failed auth joins the same per-IP tarpit as slug misses; success is never delayed. */
function authFailure(
  req: Request,
  res: Response,
  status: number,
  error: string,
): Promise<void> {
  // Address prefix only — never the email that was tried.
  logWarn(`Auth failure from ${redactIp(clientIp(req))}: ${error}`);
  return tarpitMiss(req, res, () => {
    res.status(status).json({ error });
  });
}

/** Returns the normalized address, or null when it is not a usable email. */
function validateEmail(email: unknown): string | null {
  const normalized = normalizeEmail(email);
  if (!normalized || !EMAIL_RE.test(normalized)) return null;
  return normalized;
}

export const authRouter = Router();

const PASSWORD_DISABLED = "Password sign-in is disabled";

// GET /api/status
authRouter.get("/status", async (req, res) => {
  const credential = await readCredential();
  const session = await loadSession(req);
  const oidc = oidcSettings();
  const password = passwordLoginEnabled();
  // An OIDC session outlives a missing credential; a password one never existed without it.
  const authed = Boolean(session && (credential || session.oidcEmail));
  const email = session?.oidcEmail ?? credential?.email;
  res.json({
    needsSetup: credential === null && password,
    authed,
    ...(authed && email ? { email } : {}),
    login: { password, ...(oidc ? { oidc: oidc.name } : {}) },
  });
});

// POST /api/auth/setup { email, password, persist? }
authRouter.post("/auth/setup", async (req, res) => {
  if (!passwordLoginEnabled()) {
    await authFailure(req, res, 403, PASSWORD_DISABLED);
    return;
  }
  if ((await readCredential()) !== null) {
    await authFailure(req, res, 403, "Already set up");
    return;
  }
  const { email, password, persist } = asRecord(req.body);
  const normalizedEmail = validateEmail(email);
  if (!normalizedEmail) {
    await authFailure(req, res, 400, "A valid email is required");
    return;
  }
  if (typeof password !== "string" || password.length < MIN_PASSWORD_LENGTH) {
    await authFailure(
      req,
      res,
      400,
      `Password must be at least ${MIN_PASSWORD_LENGTH} characters`,
    );
    return;
  }

  const credential = await setCredential({
    email: normalizedEmail,
    password,
  });
  const persistent = Boolean(persist);
  const token = await createSession({
    userAgent: req.get("user-agent") ?? "",
    persistent,
  });
  setSessionCookie(req, res, token, persistent);
  res.status(201).json({ ok: true, email: credential.email });
});

// POST /api/auth/login { email, password, persist }
authRouter.post("/auth/login", async (req, res) => {
  if (!passwordLoginEnabled()) {
    await authFailure(req, res, 403, PASSWORD_DISABLED);
    return;
  }
  const credential = await readCredential();
  if (!credential) {
    await authFailure(req, res, 403, "Setup required");
    return;
  }
  const { email, password, persist } = asRecord(req.body);
  const ok =
    normalizeEmail(email) === credential.email &&
    typeof password === "string" &&
    (await verifyPassword(password, credential));
  if (!ok) {
    await authFailure(req, res, 401, "Incorrect email or password");
    return;
  }

  const persistent = Boolean(persist);
  const token = await createSession({
    userAgent: req.get("user-agent") ?? "",
    persistent,
  });
  setSessionCookie(req, res, token, persistent);
  res.json({ ok: true, email: credential.email });
});

// POST /api/auth/logout
authRouter.post("/auth/logout", async (req, res) => {
  const token = sessionToken(req);
  if (token) await deleteSession(token);
  clearSessionCookie(req, res);
  res.json({ ok: true });
});

// PUT /api/auth/credentials { email?, password?, currentPassword }
// Always purges every session, including the caller's.
authRouter.put("/auth/credentials", requireAdmin, async (req, res) => {
  if (!passwordLoginEnabled()) {
    res.status(403).json({ error: PASSWORD_DISABLED });
    return;
  }
  const credential = await readCredential();
  if (!credential) {
    res.status(403).json({ error: "Setup required" });
    return;
  }
  const { email, password, currentPassword } = asRecord(req.body);
  if (
    typeof currentPassword !== "string" ||
    !(await verifyPassword(currentPassword, credential))
  ) {
    res.status(401).json({ error: "Current password is incorrect" });
    return;
  }

  let nextEmail = credential.email;
  if (email !== undefined) {
    const normalized = validateEmail(email);
    if (!normalized) {
      res.status(400).json({ error: "A valid email is required" });
      return;
    }
    nextEmail = normalized;
  }

  if (password !== undefined) {
    if (typeof password !== "string" || password.length < MIN_PASSWORD_LENGTH) {
      res.status(400).json({
        error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters`,
      });
      return;
    }
    await setCredential({ email: nextEmail, password });
  } else if (nextEmail !== credential.email) {
    // Email-only change: keep the existing hash/salt untouched.
    await writeCredential({ ...credential, email: nextEmail });
  }

  await purgeSessions();
  clearSessionCookie(req, res);
  res.json({ ok: true, email: nextEmail });
});

// ---------------------------------------------------------------------------
// OIDC (ARCHITECTURE.md § OIDC sign-in)
// ---------------------------------------------------------------------------

const STATE_COOKIE = "oidc_state";
const STATE_COOKIE_PATH = "/api/auth/oidc";
const STATE_COOKIE_MAX_AGE_MS = 10 * 60 * 1000;

function callbackUrl(req: Request): string {
  return `${req.protocol}://${req.get("host") ?? "localhost"}${STATE_COOKIE_PATH}/callback`;
}

function clearStateCookie(req: Request, res: Response): void {
  res.clearCookie(STATE_COOKIE, {
    httpOnly: true,
    sameSite: "lax",
    path: STATE_COOKIE_PATH,
    secure: req.secure,
  });
}

/** Failures land on the sign-in screen, which then does not bounce straight back. */
function oidcFailure(req: Request, res: Response, reason: string): Promise<void> {
  logWarn(`OIDC sign-in failed from ${redactIp(clientIp(req))}: ${reason}`);
  clearStateCookie(req, res);
  return tarpitMiss(req, res, () => {
    res.redirect(302, "/?signin=failed");
  });
}

// GET /api/auth/oidc/start?persist=1&return=/path
authRouter.get("/auth/oidc/start", async (req, res) => {
  const settings = oidcSettings();
  if (!settings) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  let flow: { state: string; url: string };
  try {
    flow = await beginFlow(settings, {
      redirectUri: callbackUrl(req),
      persist: req.query.persist === "1",
      returnTo: safeReturnPath(req.query.return),
    });
  } catch (err) {
    logWarn(`OIDC provider unreachable: ${err instanceof Error ? err.message : String(err)}`);
    res.redirect(302, "/?signin=unavailable");
    return;
  }
  res.cookie(STATE_COOKIE, flow.state, {
    httpOnly: true,
    sameSite: "lax",
    path: STATE_COOKIE_PATH,
    secure: req.secure,
    maxAge: STATE_COOKIE_MAX_AGE_MS,
  });
  res.set("Cache-Control", "no-store");
  res.redirect(302, flow.url);
});

// GET /api/auth/oidc/callback?code&state
authRouter.get("/auth/oidc/callback", async (req, res) => {
  const settings = oidcSettings();
  if (!settings) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.set("Cache-Control", "no-store");
  const { code, state, error } = req.query;
  if (typeof error === "string") {
    await oidcFailure(req, res, `provider returned ${error.slice(0, 64)}`);
    return;
  }
  // The state must come back to the same browser that set off: login CSRF.
  const cookieState = (req.cookies as Record<string, string | undefined>)[STATE_COOKIE];
  if (typeof state !== "string" || !state || state !== cookieState) {
    await oidcFailure(req, res, "state mismatch");
    return;
  }
  const flow = takeFlow(state);
  if (!flow || typeof code !== "string" || !code) {
    await oidcFailure(req, res, "unknown or expired state");
    return;
  }

  let email: string | null;
  try {
    const claims = await completeFlow(settings, flow, code);
    const credential = await readCredential();
    email = allowedEmail(claims, settings, credential?.email ?? null);
  } catch (err) {
    await oidcFailure(req, res, err instanceof Error ? err.message : String(err));
    return;
  }
  if (!email) {
    // Never the address itself: the server log stays free of who tried.
    await oidcFailure(req, res, "account is not allowed");
    return;
  }

  clearStateCookie(req, res);
  const token = await createSession({
    userAgent: req.get("user-agent") ?? "",
    persistent: flow.persist,
    oidcEmail: email,
  });
  setSessionCookie(req, res, token, flow.persist);
  res.redirect(302, flow.returnTo);
});
