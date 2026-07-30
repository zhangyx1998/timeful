/**
 * `GET /api/update-check` against the real Express app.
 *
 * The registry is stubbed at the global `fetch` — the same seam the handler
 * reaches through — so the one outbound call the app can make is never made
 * from a test run. Calls the test itself makes to its own server pass straight
 * through, which is also how the "was the registry asked at all?" assertions
 * work.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, type Renderer } from "../app.ts";
import { createSession, setCredential } from "../auth.ts";
import { REGISTRY_URL } from "../registry.ts";
import { VERSION } from "../cli/version.ts";

const renderer: Renderer = {
  loadTemplate: () => Promise.resolve("<!doctype html><div id=\"app\"></div>"),
  loadRender: () => Promise.reject(new Error("SSR is not used in these tests")),
};

let server: Server;
let base: string;
let varDir: string;
const originalVarDir = process.env.VAR_DIR;

beforeAll(async () => {
  const app = createApp({ trustProxy: false, renderer });
  server = await new Promise<Server>((resolve, reject) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
    listening.on("error", reject);
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(async () => {
  varDir = await fs.mkdtemp(path.join(os.tmpdir(), "timeful-update-"));
  process.env.VAR_DIR = varDir;
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (originalVarDir === undefined) delete process.env.VAR_DIR;
  else process.env.VAR_DIR = originalVarDir;
  await fs.rm(varDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
});

/** A signed-in owner, as a cookie header. */
async function admin(): Promise<string> {
  await setCredential({ email: "owner@example.com", password: "password123" });
  return `session=${await createSession({})}`;
}

/**
 * Stubs the registry and nothing else: any other URL — the test's own request
 * to the app under test — goes to the real `fetch`.
 */
function stubRegistry(
  answer: { status?: number; body?: unknown } | { throws: Error },
): { calls: number } {
  const real = globalThis.fetch;
  const state = { calls: 0 };
  vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    if (String(input) !== REGISTRY_URL) return real(input, init);
    state.calls += 1;
    if ("throws" in answer) return Promise.reject(answer.throws);
    return Promise.resolve(
      new Response(JSON.stringify(answer.body ?? {}), {
        status: answer.status ?? 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
  });
  return state;
}

async function check(cookie?: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}/api/update-check`, {
    headers: cookie ? { Cookie: cookie } : {},
  });
  return { status: res.status, body: await res.json() };
}

describe("GET /api/update-check", () => {
  it("is admin-only, and does not ask npm on behalf of a stranger", async () => {
    const registry = stubRegistry({ body: { version: "9.9.9" } });
    await setCredential({ email: "owner@example.com", password: "password123" });

    const anonymous = await check();
    expect(anonymous.status).toBe(401);
    expect(anonymous.body).toEqual({ error: "Not authenticated" });
    // The point of the gate: no unauthenticated caller can make this server
    // talk to the internet.
    expect(registry.calls).toBe(0);

    const stale = await check("session=not-a-real-token");
    expect(stale.status).toBe(401);
    expect(registry.calls).toBe(0);
  });

  it("reports the running version and the published one", async () => {
    stubRegistry({ body: { name: "timeful", version: "99.0.0" } });
    const { status, body } = await check(await admin());

    expect(status).toBe(200);
    expect(body.current).toBe(VERSION);
    expect(body.latest).toBe("99.0.0");
    expect(body.webroot).toBe(process.cwd());
    expect(body.problem).toBeUndefined();
  });

  it("never calls a source checkout out of date", async () => {
    // Running from source, `VERSION` is the dev fallback: it is not on the
    // release line, so nothing published is an "update" to it.
    stubRegistry({ body: { version: "99.0.0" } });
    const { body } = await check(await admin());

    expect(body.development).toBe(true);
    expect(body.updateAvailable).toBe(false);
    // The version is still reported, so the panel can say what is running.
    expect(body.current).toBe("0.0.0-dev");
  });

  it("answers a timeout as an answer, not as a 500", async () => {
    const timeout = new Error("aborted");
    timeout.name = "AbortError";
    stubRegistry({ throws: timeout });

    const { status, body } = await check(await admin());
    expect(status).toBe(200);
    expect(body.latest).toBeNull();
    expect(body.updateAvailable).toBe(false);
    expect(body.problem).toContain("did not answer in time");
  });

  it("answers an unreachable registry the same way", async () => {
    stubRegistry({ throws: new TypeError("fetch failed") });

    const { status, body } = await check(await admin());
    expect(status).toBe(200);
    expect(body.latest).toBeNull();
    expect(body.problem).toContain("could not be reached");
  });

  it("says nothing about the request in what it hands back", async () => {
    stubRegistry({ status: 500 });
    const { body } = await check(await admin());

    expect(Object.keys(body).sort()).toEqual([
      "current",
      "development",
      "latest",
      "problem",
      "updateAvailable",
      "webroot",
    ]);
  });
});
