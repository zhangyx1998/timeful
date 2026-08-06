/** Password hashing (scrypt) and session tokens for the single owner account. */
import crypto from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import {
  readCredential,
  readSessions,
  updateSessions,
  writeCredential,
} from "./storage.ts";
import type { Credential, SessionRecord } from "./types.ts";

const KEY_LENGTH = 64;
const SALT_BYTES = 16;
const TOKEN_BYTES = 32;

export const COOKIE_NAME = "session";
export const PERSISTENT_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000; // 90 days

/** Promise wrapper around `crypto.scrypt` (keeps the Buffer type intact). */
function scrypt(plain: string, salt: string, keyLength: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    crypto.scrypt(plain, salt, keyLength, (err, derived) => {
      if (err) reject(err);
      else resolve(derived);
    });
  });
}

// ---------------------------------------------------------------------------
// passwords
// ---------------------------------------------------------------------------

export interface PasswordHash {
  /** Derived key, hex. */
  password: string;
  /** Salt, hex. */
  salt: string;
}

export async function hashPassword(plain: string, salt?: string): Promise<PasswordHash> {
  const useSalt = salt ?? crypto.randomBytes(SALT_BYTES).toString("hex");
  const derived = await scrypt(plain, useSalt, KEY_LENGTH);
  return { password: derived.toString("hex"), salt: useSalt };
}

/** Constant-time comparison against a stored credential. */
export async function verifyPassword(
  plain: string,
  credential: Credential | null,
): Promise<boolean> {
  if (!credential?.password || !credential?.salt) return false;
  const stored = Buffer.from(credential.password, "hex");
  const derived = await scrypt(plain, credential.salt, KEY_LENGTH);
  if (stored.length !== derived.length) return false;
  return crypto.timingSafeEqual(stored, derived);
}

export async function setCredential({
  email,
  password,
}: {
  email: string;
  password: string;
}): Promise<Credential> {
  const hashed = await hashPassword(password);
  const credential: Credential = {
    email: normalizeEmail(email),
    password: hashed.password,
    salt: hashed.salt,
  };
  await writeCredential(credential);
  return credential;
}

export function normalizeEmail(email: unknown): string {
  return String(email ?? "")
    .trim()
    .toLowerCase();
}

// ---------------------------------------------------------------------------
// sessions
// ---------------------------------------------------------------------------

export function newToken(): string {
  return crypto.randomBytes(TOKEN_BYTES).toString("hex");
}

export async function createSession({
  userAgent = "",
  persistent = false,
}: {
  userAgent?: string;
  persistent?: boolean;
}): Promise<string> {
  const token = newToken();
  const now = new Date().toISOString();
  await updateSessions((sessions) => {
    sessions[token] = {
      createdAt: now,
      lastSeenAt: now,
      userAgent: String(userAgent).slice(0, 400),
      persistent: Boolean(persistent),
    };
    return sessions;
  });
  return token;
}

/** Look up a session and refresh `lastSeenAt`. Returns null when unknown. */
export async function touchSession(token: string): Promise<SessionRecord | null> {
  if (!token) return null;
  const sessions = await readSessions();
  const session = sessions[token];
  if (!session) return null;
  const now = new Date().toISOString();
  // Only pay for a write when the clock has actually moved on.
  if (session.lastSeenAt !== now) {
    updateSessions((current) => {
      const existing = current[token];
      if (!existing) return undefined;
      existing.lastSeenAt = now;
      return current;
    }).catch(() => {});
  }
  return { ...session, lastSeenAt: now };
}

export async function deleteSession(token: string): Promise<boolean> {
  let deleted = false;
  await updateSessions((sessions) => {
    if (!sessions[token]) return undefined;
    delete sessions[token];
    deleted = true;
    return sessions;
  });
  return deleted;
}

/** Delete every session, optionally sparing one token. Returns the count. */
export async function purgeSessions({
  except = null,
}: { except?: string | null } = {}): Promise<number> {
  let deleted = 0;
  await updateSessions((sessions) => {
    const next: typeof sessions = {};
    for (const [token, value] of Object.entries(sessions)) {
      if (except && token === except) next[token] = value;
      else deleted += 1;
    }
    if (deleted === 0) return undefined;
    return next;
  });
  return deleted;
}

// ---------------------------------------------------------------------------
// cookies + middleware
// ---------------------------------------------------------------------------

/** Parses a raw `Cookie` header. Shared by the middleware and the upgrade path. */
export function parseCookieHeader(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = Object.create(null);
  if (header) {
    for (const part of header.split(";")) {
      const eq = part.indexOf("=");
      if (eq < 0) continue;
      const key = part.slice(0, eq).trim();
      if (!key) continue;
      const raw = part.slice(eq + 1).trim();
      try {
        cookies[key] = decodeURIComponent(raw);
      } catch {
        cookies[key] = raw;
      }
    }
  }
  return cookies;
}

/** Minimal cookie header parser; avoids a dependency for ~10 lines. */
export function cookieParser(req: Request, _res: Response, next: NextFunction): void {
  req.cookies = parseCookieHeader(req.headers.cookie);
  next();
}

/** For the WebSocket upgrade path, which never runs the cookie middleware. */
export function sessionTokenFromHeader(header: string | undefined): string | null {
  const token = parseCookieHeader(header)[COOKIE_NAME];
  return typeof token === "string" && token ? token : null;
}

/** `req.secure` honours X-Forwarded-Proto only from a trusted proxy; never read the header directly. */
function isSecureRequest(req: Request): boolean {
  return req.secure;
}

export function setSessionCookie(
  req: Request,
  res: Response,
  token: string,
  persistent: boolean,
): void {
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    secure: isSecureRequest(req),
    ...(persistent ? { maxAge: PERSISTENT_MAX_AGE_MS } : {}),
  });
}

export function clearSessionCookie(req: Request, res: Response): void {
  res.clearCookie(COOKIE_NAME, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    secure: isSecureRequest(req),
  });
}

export function sessionToken(req: Request): string | null {
  const cookies: unknown = req.cookies;
  if (typeof cookies !== "object" || cookies === null) return null;
  const token = (cookies as Record<string, unknown>)[COOKIE_NAME];
  return typeof token === "string" ? token : null;
}

/** Resolves the request's session, attaching it to `req`. Never throws. */
export async function loadSession(req: Request): Promise<SessionRecord | null> {
  if (req.session !== undefined) return req.session;
  const token = sessionToken(req);
  const session = token ? await touchSession(token) : null;
  req.session = session;
  req.sessionToken = session ? token : null;
  return session;
}

/** Express middleware: 401 unless a valid session cookie is present. */
export async function requireAdmin(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const session = await loadSession(req);
  if (!session) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }
  next();
}

/** True when no credential has been created yet (first run). */
export async function needsSetup(): Promise<boolean> {
  return (await readCredential()) === null;
}
