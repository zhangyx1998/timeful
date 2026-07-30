/**
 * Shared plumbing for the server tests that exercise the real Express app on
 * a real socket over a temporary `VAR_DIR` (docs § Testing).
 *
 * Everything here is a plain function, deliberately not a registered hook:
 * `routes/events.test.ts` and `routes/update.test.ts` want one server per
 * file (`beforeAll`) while `realtime.test.ts` needs a fresh server per test
 * because the test body attaches the upgrade listener — and their teardowns
 * differ in whether mocks are restored. Each file composes its own hooks from
 * these pieces.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { expect } from "vitest";
import { createApp, type Renderer } from "./app.ts";
import { createSession, setCredential } from "./auth.ts";
import type { StoredEvent } from "./types.ts";

/** No page is rendered by these tests; only the JSON and upgrade paths. */
export const NULL_RENDERER: Renderer = {
  loadTemplate: () =>
    Promise.resolve("<!doctype html><div id=\"app\"><!--app-html--></div>"),
  loadRender: () => Promise.reject(new Error("SSR is not used in these tests")),
};

export interface TestServer {
  server: Server;
  base: string;
  wsBase: string;
  close(): Promise<void>;
}

/** Boots the real app on an ephemeral loopback port. */
export async function startTestServer(
  renderer: Renderer = NULL_RENDERER,
): Promise<TestServer> {
  const app = createApp({ trustProxy: false, renderer });
  const server = await new Promise<Server>((resolve, reject) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
    listening.on("error", reject);
  });
  const { port } = server.address() as AddressInfo;
  return {
    server,
    base: `http://127.0.0.1:${port}`,
    wsBase: `ws://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const ORIGINAL_VAR_DIR = process.env.VAR_DIR;

/** Makes a fresh temp data root and points `VAR_DIR` at it. */
export async function makeVarDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  process.env.VAR_DIR = dir;
  return dir;
}

/** Restores `VAR_DIR` to what it was and deletes the temp data root. */
export async function removeVarDir(dir: string): Promise<void> {
  if (ORIGINAL_VAR_DIR === undefined) delete process.env.VAR_DIR;
  else process.env.VAR_DIR = ORIGINAL_VAR_DIR;
  // Retries because a request can outlive its own response: `touchSession`
  // refreshes `lastSeenAt` fire-and-forget (ARCHITECTURE.md § Passwords and
  // sessions), so an authenticated call may still be landing a write in here
  // when the directory goes. Without the retries that surfaces, rarely and
  // only under load, as ENOTEMPTY from a test that has already passed.
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
}

export interface ApiResponse {
  status: number;
  body: unknown;
}

export interface ApiCallOptions {
  body?: unknown;
  cookie?: string;
  headers?: Record<string, string>;
}

/** `apiCall` with the base already applied — each file's one-line adapter. */
export type CallFn = (
  method: string,
  route: string,
  options?: ApiCallOptions,
) => Promise<ApiResponse>;

/** One request against a test server, with the answer parsed leniently. */
export async function apiCall(
  base: string,
  method: string,
  route: string,
  { body, cookie, headers }: ApiCallOptions = {},
): Promise<ApiResponse> {
  const res = await fetch(`${base}${route}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(cookie ? { Cookie: cookie } : {}),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  return { status: res.status, body: parsed };
}

/** A session cookie for the one owner account. */
export async function adminCookie(password = "hunter2hunter2"): Promise<string> {
  await setCredential({ email: "owner@example.com", password });
  return `session=${await createSession({})}`;
}

/** Creates an event straight through the admin API and returns it. */
export async function createTestEvent(
  call: CallFn,
  cookie: string,
  extra: Record<string, unknown> = {},
): Promise<StoredEvent> {
  const res = await call("POST", "/api/events", {
    cookie,
    body: {
      name: "Team Offsite",
      type: "specific_dates",
      dates: ["2026-08-03T00:00:00.000Z", "2026-08-04T00:00:00.000Z"],
      duration: 8,
      timeIncrement: 30,
      startOnMonday: true,
      ...extra,
    },
  });
  expect(res.status).toBe(201);
  return res.body as StoredEvent;
}

/** The common opener: a signed-in owner and one event of theirs. */
export async function eventFixture(
  call: CallFn,
  extra: Record<string, unknown> = {},
): Promise<{ cookie: string; event: StoredEvent }> {
  const cookie = await adminCookie();
  const event = await createTestEvent(call, cookie, extra);
  return { cookie, event };
}
