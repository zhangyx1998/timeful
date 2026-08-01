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
import { readCredential, writeCredential } from "../storage.ts";
import { clientIp, tarpitMiss } from "../tarpit.ts";
import type { Request, Response } from "express";

const MIN_PASSWORD_LENGTH = 8;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * A failed login/setup attempt. Passwords are the weakest secret in the
 * system, so rejections go through the same per-IP tarpit (and pending cap)
 * as slug misses: serial, 100ms apiece, 429 past the cap. Successful auth is
 * never delayed.
 */
function authFailure(
  req: Request,
  res: Response,
  status: number,
  error: string,
): Promise<void> {
  // The refusal and a coarse address prefix — never the email that was tried,
  // which is a guess at the owner's identity and nobody else's business.
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

// GET /api/status
authRouter.get("/status", async (req, res) => {
  const credential = await readCredential();
  const session = await loadSession(req);
  const authed = Boolean(session && credential);
  res.json({
    needsSetup: credential === null,
    authed,
    ...(authed && credential ? { email: credential.email } : {}),
  });
});

// POST /api/auth/setup { email, password, persist? }
authRouter.post("/auth/setup", async (req, res) => {
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
