/**
 * OIDC sign-in against a fake provider on loopback: discovery, JWKS, token
 * endpoint. The authorize step is skipped — the test plays the browser and
 * walks straight from `/start`'s redirect to the callback.
 */
import crypto from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "./app.ts";
import { setCredential } from "./auth.ts";
import {
  allowedEmail,
  parseOidcSettings,
  resolveOidcSettings,
  safeReturnPath,
  setOidcSettings,
  verifyIdToken,
  type OidcSettings,
} from "./oidc.ts";
import { NULL_RENDERER, makeVarDir, removeVarDir } from "./test-support.ts";

const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const JWK = { ...publicKey.export({ format: "jwk" }), kid: "k1", alg: "RS256", use: "sig" };

function sign(claims: Record<string, unknown>, key = privateKey, kid = "k1"): string {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT", kid })).toString("base64url");
  const body = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signature = crypto.sign("sha256", Buffer.from(`${header}.${body}`), key).toString("base64url");
  return `${header}.${body}.${signature}`;
}

async function listen(app: express.Express): Promise<{ server: Server; base: string }> {
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  return { server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

const close = (server: Server) => new Promise<void>((resolve) => server.close(() => resolve()));

// --- the fake provider ------------------------------------------------------

let idp: { server: Server; base: string };
/** What the token endpoint will put in the next ID token, keyed by code. */
const codes = new Map<string, Record<string, unknown>>();
let lastTokenRequest: { auth?: string; body: Record<string, string> } | null = null;

beforeAll(async () => {
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.get("/.well-known/openid-configuration", (_req, res) => {
    res.json({
      issuer: idp.base,
      authorization_endpoint: `${idp.base}/authorize`,
      token_endpoint: `${idp.base}/token`,
      jwks_uri: `${idp.base}/jwks`,
    });
  });
  app.get("/jwks", (_req, res) => res.json({ keys: [JWK] }));
  app.post("/token", (req, res) => {
    lastTokenRequest = { auth: req.get("authorization"), body: req.body as Record<string, string> };
    const claims = codes.get(String(req.body.code));
    if (!claims) {
      res.status(400).json({ error: "invalid_grant" });
      return;
    }
    res.json({ access_token: "a", token_type: "Bearer", id_token: sign(claims) });
  });
  idp = await listen(app);
});

afterAll(async () => {
  await close(idp.server);
});

function settings(overrides: Partial<OidcSettings> = {}): OidcSettings {
  return {
    issuer: idp.base,
    clientId: "timeful",
    clientSecret: "s3cret",
    allowedEmails: ["owner@example.com"],
    passwordLogin: false,
    name: "Example ID",
    ...overrides,
  };
}

// --- settings ---------------------------------------------------------------

describe("parseOidcSettings", () => {
  it("normalises and defaults", () => {
    const parsed = parseOidcSettings({
      issuer: "https://id.example.com/",
      clientId: "abc",
      allowedEmails: ["Owner@Example.com"],
    });
    expect(parsed).toEqual({
      issuer: "https://id.example.com",
      clientId: "abc",
      clientSecret: undefined,
      allowedEmails: ["owner@example.com"],
      passwordLogin: true,
      name: "id.example.com",
    });
  });

  it("refuses plain http off loopback", () => {
    expect(() => parseOidcSettings({ issuer: "http://id.example.com", clientId: "a" })).toThrow(
      /https/,
    );
  });

  it("needs an allowlist once passwords are off", () => {
    expect(() =>
      parseOidcSettings({ issuer: "https://id.example.com", clientId: "a", passwordLogin: false }),
    ).toThrow(/allowedEmails/);
  });

  it("lets the environment fill or override the file", () => {
    expect(resolveOidcSettings(undefined, {})).toBeNull();
    const resolved = resolveOidcSettings(
      { issuer: "https://id.example.com", clientId: "a" },
      { TIMEFUL_OIDC_CLIENT_SECRET: "x", TIMEFUL_PASSWORD_LOGIN: "0", TIMEFUL_OIDC_ALLOWED_EMAILS: "a@b.co, c@d.co" },
    );
    expect(resolved?.clientSecret).toBe("x");
    expect(resolved?.passwordLogin).toBe(false);
    expect(resolved?.allowedEmails).toEqual(["a@b.co", "c@d.co"]);
  });
});

describe("safeReturnPath", () => {
  it("keeps same-origin paths and drops everything else", () => {
    expect(safeReturnPath("/abc/edit?x=1")).toBe("/abc/edit?x=1");
    for (const bad of ["//evil.com", "/\\evil.com", "https://evil.com", "", undefined, "/a\nb"])
      expect(safeReturnPath(bad)).toBe("/");
  });
});

describe("allowedEmail", () => {
  it("falls back to the password account and insists on a verified email", () => {
    expect(allowedEmail({ sub: "1", email: "Owner@example.com", email_verified: true }, settings({ allowedEmails: [] }), "owner@example.com")).toBe("owner@example.com");
    expect(allowedEmail({ sub: "1", email: "owner@example.com", email_verified: false }, settings({ allowedEmails: [] }), "owner@example.com")).toBeNull();
    expect(allowedEmail({ sub: "1", email: "owner@example.com", email_verified: true }, settings({ allowedEmails: [] }), null)).toBeNull();
  });
});

// --- verification -----------------------------------------------------------

describe("verifyIdToken", () => {
  const now = 1_800_000_000;
  const good = () => ({
    iss: idp.base,
    aud: "timeful",
    sub: "u1",
    exp: now + 300,
    iat: now,
    nonce: "n",
    email: "owner@example.com",
    email_verified: true,
  });
  const key = async () => JWK;

  it("accepts a well-formed token", async () => {
    const claims = await verifyIdToken(sign(good()), settings(), "n", key, now);
    expect(claims).toEqual({ sub: "u1", email: "owner@example.com", email_verified: true });
  });

  it.each([
    ["issuer", { iss: "https://other.example" }],
    ["audience", { aud: "someone-else" }],
    ["expired", { exp: now - 120 }],
    ["nonce", { nonce: "other" }],
  ])("rejects a bad %s", async (_name, patch) => {
    await expect(verifyIdToken(sign({ ...good(), ...patch }), settings(), "n", key, now)).rejects.toThrow();
  });

  it("rejects a token signed by another key", async () => {
    const other = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
    await expect(verifyIdToken(sign(good(), other), settings(), "n", key, now)).rejects.toThrow(/signature/);
  });

  it("rejects alg none", async () => {
    const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
    const body = Buffer.from(JSON.stringify(good())).toString("base64url");
    await expect(verifyIdToken(`${header}.${body}.`, settings(), "n", key, now)).rejects.toThrow(/algorithm/);
  });
});

// --- the routes -------------------------------------------------------------

describe("the sign-in flow", () => {
  let app: { server: Server; base: string };
  let varDir: string;
  const originalDelay = process.env.MISS_DELAY_MS;

  async function boot(oidc: OidcSettings): Promise<void> {
    app = await listen(createApp({ trustProxy: false, renderer: NULL_RENDERER, oidc }));
  }

  beforeEach(async () => {
    varDir = await makeVarDir("timeful-oidc-");
    process.env.MISS_DELAY_MS = "0";
    codes.clear();
    lastTokenRequest = null;
  });

  afterEach(async () => {
    await close(app.server);
    setOidcSettings(null);
    if (originalDelay === undefined) delete process.env.MISS_DELAY_MS;
    else process.env.MISS_DELAY_MS = originalDelay;
    await removeVarDir(varDir);
  });

  const get = (path: string, cookie?: string) =>
    fetch(`${app.base}${path}`, { redirect: "manual", headers: cookie ? { cookie } : {} });

  /** `/start`, then the callback the provider would have sent the browser to. */
  async function roundTrip(
    claims: (nonce: string) => Record<string, unknown>,
    start = "/api/auth/oidc/start",
  ): Promise<Response> {
    const started = await get(start);
    expect(started.status).toBe(302);
    const location = new URL(started.headers.get("location") ?? "");
    expect(location.origin + location.pathname).toBe(`${idp.base}/authorize`);
    expect(location.searchParams.get("code_challenge_method")).toBe("S256");
    const stateCookie = (started.headers.get("set-cookie") ?? "").split(";")[0];
    const state = location.searchParams.get("state") ?? "";
    const nonce = location.searchParams.get("nonce") ?? "";
    codes.set("the-code", claims(nonce));
    return get(`/api/auth/oidc/callback?code=the-code&state=${state}`, stateCookie);
  }

  const owner = (nonce: string) => ({
    iss: idp.base,
    aud: "timeful",
    sub: "u1",
    exp: Math.floor(Date.now() / 1000) + 300,
    nonce,
    email: "owner@example.com",
    email_verified: true,
  });

  it("redirects a signed-out visitor at / straight to the provider", async () => {
    await boot(settings());
    const res = await get("/");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/api/auth/oidc/start");
    // After a failure the screen shows instead of looping.
    expect((await get("/?signin=failed")).status).toBe(200);
  });

  it("signs the owner in and returns where they started", async () => {
    await boot(settings());
    const res = await roundTrip(owner, "/api/auth/oidc/start?return=/some-event/edit");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/some-event/edit");
    // The slug never left for the provider.
    expect(JSON.stringify(lastTokenRequest)).not.toContain("some-event");
    expect(lastTokenRequest?.auth).toBe(`Basic ${Buffer.from("timeful:s3cret").toString("base64")}`);
    expect(lastTokenRequest?.body.code_verifier).toBeTruthy();

    const session = (res.headers.getSetCookie().find((c) => c.startsWith("session=")) ?? "").split(";")[0];
    const status = (await (await get("/api/status", session)).json()) as Record<string, unknown>;
    expect(status).toMatchObject({
      authed: true,
      needsSetup: false,
      email: "owner@example.com",
      login: { password: false, oidc: "Example ID" },
    });
    expect((await get("/", session)).status).toBe(200);
  });

  it("turns away anyone not on the allowlist", async () => {
    await boot(settings());
    const res = await roundTrip((nonce) => ({ ...owner(nonce), email: "stranger@example.com" }));
    expect(res.headers.get("location")).toBe("/?signin=failed");
    expect(res.headers.getSetCookie().some((c) => c.startsWith("session="))).toBe(false);
  });

  it("refuses a callback without the browser's state cookie", async () => {
    await boot(settings());
    const started = await get("/api/auth/oidc/start");
    const state = new URL(started.headers.get("location") ?? "").searchParams.get("state");
    const res = await get(`/api/auth/oidc/callback?code=x&state=${state}`);
    expect(res.headers.get("location")).toBe("/?signin=failed");
  });

  it("closes the password routes when password sign-in is off", async () => {
    await setCredential({ email: "owner@example.com", password: "password123" });
    await boot(settings());
    const res = await fetch(`${app.base}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "owner@example.com", password: "password123" }),
    });
    expect(res.status).toBe(403);
  });

  it("keeps the password form alongside, falling back to its email", async () => {
    await setCredential({ email: "owner@example.com", password: "password123" });
    await boot(settings({ passwordLogin: true, allowedEmails: [] }));
    expect((await get("/")).status).toBe(200);
    const res = await roundTrip(owner);
    expect(res.headers.get("location")).toBe("/");
    expect(res.headers.getSetCookie().some((c) => c.startsWith("session="))).toBe(true);
  });
});
