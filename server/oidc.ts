/** Owner sign-in through an OpenID Connect provider (ARCHITECTURE.md § OIDC sign-in). */
import crypto, { type JsonWebKey } from "node:crypto";

export interface OidcSettings {
  /** Exact issuer identifier; discovery lives under it. */
  issuer: string;
  clientId: string;
  /** Absent for a public client, which then relies on PKCE alone. */
  clientSecret?: string;
  /** Verified emails allowed in; empty means "the password account's email". */
  allowedEmails: string[];
  /** False hides the password form and sends sign-in straight to the provider. */
  passwordLogin: boolean;
  /** Shown on the sign-in button; defaults to the issuer's host. */
  name: string;
}

export class OidcConfigError extends Error {}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isLoopbackHost(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
}

function readIssuer(value: unknown, source: string): string {
  if (typeof value !== "string" || !value.trim())
    throw new OidcConfigError(`${source}.issuer: expected a URL`);
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new OidcConfigError(`${source}.issuer: not a valid URL: ${JSON.stringify(value)}`);
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopbackHost(url.hostname)))
    throw new OidcConfigError(`${source}.issuer: must be https (http only for localhost)`);
  if (url.search || url.hash)
    throw new OidcConfigError(`${source}.issuer: must not carry a query or fragment`);
  return url.href.replace(/\/$/, "");
}

function readNonEmpty(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim())
    throw new OidcConfigError(`${field}: expected a non-empty string`);
  return value.trim();
}

function readEmails(value: unknown, field: string): string[] {
  const list = typeof value === "string" ? value.split(",") : value;
  if (!Array.isArray(list)) throw new OidcConfigError(`${field}: expected a list of emails`);
  const emails = list.map((entry) => String(entry).trim().toLowerCase()).filter(Boolean);
  for (const email of emails) {
    if (!EMAIL_RE.test(email))
      throw new OidcConfigError(`${field}: not an email: ${JSON.stringify(email)}`);
  }
  return emails;
}

/** The config file's `oidc` object, before environment overrides. */
export interface OidcInput {
  issuer?: unknown;
  clientId?: unknown;
  clientSecret?: unknown;
  allowedEmails?: unknown;
  passwordLogin?: unknown;
  name?: unknown;
}

/** Validates a complete block; `source` names it in errors. */
export function parseOidcSettings(raw: OidcInput, source = "oidc"): OidcSettings {
  const issuer = readIssuer(raw.issuer, source);
  const clientId = readNonEmpty(raw.clientId, `${source}.clientId`);
  const clientSecret =
    raw.clientSecret === undefined || raw.clientSecret === ""
      ? undefined
      : readNonEmpty(raw.clientSecret, `${source}.clientSecret`);
  const allowedEmails =
    raw.allowedEmails === undefined ? [] : readEmails(raw.allowedEmails, `${source}.allowedEmails`);
  if (raw.passwordLogin !== undefined && typeof raw.passwordLogin !== "boolean")
    throw new OidcConfigError(`${source}.passwordLogin: expected true or false`);
  const passwordLogin = raw.passwordLogin ?? true;
  // Without a password account there is no email to fall back on.
  if (!passwordLogin && allowedEmails.length === 0)
    throw new OidcConfigError(`${source}.allowedEmails: required when passwordLogin is false`);
  const name =
    raw.name === undefined ? new URL(issuer).host : readNonEmpty(raw.name, `${source}.name`);
  return { issuer, clientId, clientSecret, allowedEmails, passwordLogin, name };
}

function envBool(raw: string, name: string): boolean {
  const value = raw.trim().toLowerCase();
  if (["0", "false", "no", "off"].includes(value)) return false;
  if (["1", "true", "yes", "on"].includes(value)) return true;
  throw new OidcConfigError(`${name}: expected a boolean, got ${JSON.stringify(raw)}`);
}

/** `TIMEFUL_OIDC_*` overrides laid over the file's block; null when neither configures OIDC. */
export function resolveOidcSettings(
  file: OidcInput | undefined,
  env: NodeJS.ProcessEnv = process.env,
): OidcSettings | null {
  const merged: OidcInput = { ...file };
  if (env.TIMEFUL_OIDC_ISSUER) merged.issuer = env.TIMEFUL_OIDC_ISSUER;
  if (env.TIMEFUL_OIDC_CLIENT_ID) merged.clientId = env.TIMEFUL_OIDC_CLIENT_ID;
  if (env.TIMEFUL_OIDC_CLIENT_SECRET) merged.clientSecret = env.TIMEFUL_OIDC_CLIENT_SECRET;
  if (env.TIMEFUL_OIDC_ALLOWED_EMAILS) merged.allowedEmails = env.TIMEFUL_OIDC_ALLOWED_EMAILS;
  if (env.TIMEFUL_OIDC_NAME) merged.name = env.TIMEFUL_OIDC_NAME;
  if (env.TIMEFUL_PASSWORD_LOGIN)
    merged.passwordLogin = envBool(env.TIMEFUL_PASSWORD_LOGIN, "TIMEFUL_PASSWORD_LOGIN");
  if (merged.issuer === undefined && merged.clientId === undefined) return null;
  return parseOidcSettings(merged, file ? "oidc" : "TIMEFUL_OIDC");
}

// ---------------------------------------------------------------------------
// active settings
// ---------------------------------------------------------------------------

let active: OidcSettings | null = null;

export function setOidcSettings(settings: OidcSettings | null): void {
  active = settings;
  discoveryCache = null;
  jwksCache = null;
  flows.clear();
}

export function oidcSettings(): OidcSettings | null {
  return active;
}

export function passwordLoginEnabled(): boolean {
  return active?.passwordLogin ?? true;
}

// ---------------------------------------------------------------------------
// discovery + keys
// ---------------------------------------------------------------------------

interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
}

const FETCH_TIMEOUT_MS = 10_000;
const DISCOVERY_TTL_MS = 60 * 60 * 1000;
/** A kid we have never seen refetches the key set, but no more often than this. */
const JWKS_REFRESH_MIN_MS = 60 * 1000;

let discoveryCache: { at: number; value: Discovery } | null = null;
let jwksCache: { at: number; keys: JsonWebKey[] } | null = null;

async function fetchJson(url: string, init?: RequestInit): Promise<unknown> {
  const res = await fetch(url, {
    ...init,
    redirect: "error",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  const text = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`${new URL(url).host} answered ${res.status} with non-JSON`);
  }
  if (!res.ok) {
    const error =
      typeof body === "object" && body !== null && "error" in body ? String(body.error) : "";
    throw new Error(`${new URL(url).host} answered ${res.status}${error ? ` (${error})` : ""}`);
  }
  return body;
}

function sameSchemeUrl(value: unknown, field: string, issuer: string): string {
  if (typeof value !== "string") throw new Error(`Discovery document lacks ${field}`);
  const url = new URL(value);
  const issuerUrl = new URL(issuer);
  if (url.protocol !== issuerUrl.protocol) throw new Error(`Discovery ${field} changes scheme`);
  return url.href;
}

async function discovery(settings: OidcSettings): Promise<Discovery> {
  if (discoveryCache && Date.now() - discoveryCache.at < DISCOVERY_TTL_MS)
    return discoveryCache.value;
  const doc = await fetchJson(`${settings.issuer}/.well-known/openid-configuration`);
  if (typeof doc !== "object" || doc === null) throw new Error("Discovery document is not an object");
  const raw = doc as Record<string, unknown>;
  // OIDC Discovery §4.3: the advertised issuer must be the one configured, exactly.
  if (typeof raw.issuer !== "string" || raw.issuer.replace(/\/$/, "") !== settings.issuer)
    throw new Error("Discovery issuer does not match the configured issuer");
  const value: Discovery = {
    issuer: raw.issuer,
    authorization_endpoint: sameSchemeUrl(raw.authorization_endpoint, "authorization_endpoint", settings.issuer),
    token_endpoint: sameSchemeUrl(raw.token_endpoint, "token_endpoint", settings.issuer),
    jwks_uri: sameSchemeUrl(raw.jwks_uri, "jwks_uri", settings.issuer),
  };
  discoveryCache = { at: Date.now(), value };
  return value;
}

async function signingKey(settings: OidcSettings, kid: string | undefined): Promise<JsonWebKey> {
  const pick = (keys: JsonWebKey[]) =>
    keys.find(
      (key) =>
        (kid === undefined || (key as { kid?: string }).kid === kid) &&
        ((key as { use?: string }).use ?? "sig") === "sig",
    );
  if (jwksCache) {
    const hit = pick(jwksCache.keys);
    if (hit) return hit;
    if (Date.now() - jwksCache.at < JWKS_REFRESH_MIN_MS) throw new Error("Unknown signing key");
  }
  const { jwks_uri } = await discovery(settings);
  const doc = await fetchJson(jwks_uri);
  const keys =
    typeof doc === "object" && doc !== null && Array.isArray((doc as { keys?: unknown }).keys)
      ? ((doc as { keys: JsonWebKey[] }).keys)
      : [];
  jwksCache = { at: Date.now(), keys };
  const hit = pick(keys);
  if (!hit) throw new Error("Unknown signing key");
  return hit;
}

// ---------------------------------------------------------------------------
// id_token verification
// ---------------------------------------------------------------------------

const ALGS: Record<string, { hash: string; kty: string; dsaEncoding?: "ieee-p1363" }> = {
  RS256: { hash: "sha256", kty: "RSA" },
  ES256: { hash: "sha256", kty: "EC", dsaEncoding: "ieee-p1363" },
};

/** Allowed clock disagreement with the provider, in seconds. */
const CLOCK_SKEW_S = 60;

function decodeSegment(segment: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    throw new Error("Malformed ID token");
  return parsed as Record<string, unknown>;
}

export interface IdTokenClaims {
  sub: string;
  email?: string;
  email_verified?: boolean;
}

/** Signature, issuer, audience, expiry and nonce — OIDC Core §3.1.3.7. */
export async function verifyIdToken(
  token: string,
  settings: OidcSettings,
  nonce: string,
  getKey: (kid: string | undefined) => Promise<JsonWebKey> = (kid) => signingKey(settings, kid),
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<IdTokenClaims> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Malformed ID token");
  const header = decodeSegment(parts[0]);
  const alg = typeof header.alg === "string" ? ALGS[header.alg] : undefined;
  if (!alg) throw new Error(`Unsupported ID token algorithm ${JSON.stringify(header.alg)}`);
  const jwk = await getKey(typeof header.kid === "string" ? header.kid : undefined);
  if (jwk.kty !== alg.kty || (jwk.alg !== undefined && jwk.alg !== header.alg))
    throw new Error("Signing key does not match the token's algorithm");
  const key = crypto.createPublicKey({ key: jwk, format: "jwk" });
  const valid = crypto.verify(
    alg.hash,
    Buffer.from(`${parts[0]}.${parts[1]}`),
    alg.dsaEncoding ? { key, dsaEncoding: alg.dsaEncoding } : key,
    Buffer.from(parts[2], "base64url"),
  );
  if (!valid) throw new Error("ID token signature is invalid");

  const claims = decodeSegment(parts[1]);
  if (typeof claims.iss !== "string" || claims.iss.replace(/\/$/, "") !== settings.issuer)
    throw new Error("ID token issuer mismatch");
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(settings.clientId)) throw new Error("ID token audience mismatch");
  if (aud.length > 1 && claims.azp !== settings.clientId)
    throw new Error("ID token authorized party mismatch");
  if (typeof claims.exp !== "number" || claims.exp + CLOCK_SKEW_S < nowSeconds)
    throw new Error("ID token expired");
  if (typeof claims.iat === "number" && claims.iat - CLOCK_SKEW_S > nowSeconds)
    throw new Error("ID token issued in the future");
  if (typeof claims.nonce !== "string" || !safeEqual(claims.nonce, nonce))
    throw new Error("ID token nonce mismatch");
  if (typeof claims.sub !== "string" || !claims.sub) throw new Error("ID token has no subject");
  return {
    sub: claims.sub,
    email: typeof claims.email === "string" ? claims.email : undefined,
    email_verified: claims.email_verified === true,
  };
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

/** The verified email when it is on the allowlist, else null. */
export function allowedEmail(
  claims: IdTokenClaims,
  settings: OidcSettings,
  passwordAccountEmail: string | null,
): string | null {
  if (!claims.email || !claims.email_verified) return null;
  const email = claims.email.trim().toLowerCase();
  const allowed = settings.allowedEmails.length
    ? settings.allowedEmails
    : passwordAccountEmail
      ? [passwordAccountEmail]
      : [];
  return allowed.includes(email) ? email : null;
}

// ---------------------------------------------------------------------------
// the authorization-code flow
// ---------------------------------------------------------------------------

export interface PendingFlow {
  nonce: string;
  verifier: string;
  redirectUri: string;
  persist: boolean;
  /** Same-origin path to land on afterwards; never sent to the provider. */
  returnTo: string;
  expiresAt: number;
}

const FLOW_TTL_MS = 10 * 60 * 1000;
/** Unauthenticated callers can start flows, so the map is bounded. */
const FLOW_CAP = 200;
const flows = new Map<string, PendingFlow>();

function sweepFlows(now: number): void {
  for (const [state, flow] of flows) {
    if (flow.expiresAt <= now) flows.delete(state);
  }
  while (flows.size >= FLOW_CAP) {
    const oldest = flows.keys().next().value;
    if (oldest === undefined) break;
    flows.delete(oldest);
  }
}

const random = (bytes = 32) => crypto.randomBytes(bytes).toString("base64url");

/** A path on this origin, or "/" — never `//host` or a backslash trick. */
export function safeReturnPath(value: unknown): string {
  if (typeof value !== "string" || !value.startsWith("/")) return "/";
  if (value.startsWith("//") || value.includes("\\") || /[\u0000-\u001f]/.test(value)) return "/";
  return value;
}

/** Registers a flow and returns its state and the provider URL to send the browser to. */
export async function beginFlow(
  settings: OidcSettings,
  options: { redirectUri: string; persist: boolean; returnTo: string },
): Promise<{ state: string; url: string }> {
  const meta = await discovery(settings);
  const now = Date.now();
  sweepFlows(now);
  const state = random();
  const nonce = random();
  const verifier = random(48);
  flows.set(state, { nonce, verifier, ...options, expiresAt: now + FLOW_TTL_MS });
  const url = new URL(meta.authorization_endpoint);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: settings.clientId,
    redirect_uri: options.redirectUri,
    scope: "openid email",
    state,
    nonce,
    code_challenge: crypto.createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
  }).toString();
  return { state, url: url.href };
}

/** One use only: the flow is consumed whether or not what follows succeeds. */
export function takeFlow(state: string): PendingFlow | null {
  const flow = flows.get(state);
  if (!flow) return null;
  flows.delete(state);
  return flow.expiresAt > Date.now() ? flow : null;
}

/** Trades the code for tokens and returns the verified ID token's claims. */
export async function completeFlow(
  settings: OidcSettings,
  flow: PendingFlow,
  code: string,
): Promise<IdTokenClaims> {
  const meta = await discovery(settings);
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: flow.redirectUri,
    code_verifier: flow.verifier,
  });
  const headers: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded",
    Accept: "application/json",
  };
  if (settings.clientSecret) {
    // RFC 6749 §2.3.1: both halves are form-encoded before joining.
    const id = encodeURIComponent(settings.clientId);
    const secret = encodeURIComponent(settings.clientSecret);
    headers.Authorization = `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`;
  } else {
    body.set("client_id", settings.clientId);
  }
  const tokens = await fetchJson(meta.token_endpoint, { method: "POST", headers, body });
  const idToken =
    typeof tokens === "object" && tokens !== null ? (tokens as { id_token?: unknown }).id_token : undefined;
  if (typeof idToken !== "string") throw new Error("Token response has no ID token");
  return verifyIdToken(idToken, settings, flow.nonce);
}

/** Test seam: forget cached discovery, keys and flows. */
export function resetOidcState(): void {
  discoveryCache = null;
  jwksCache = null;
  flows.clear();
}
