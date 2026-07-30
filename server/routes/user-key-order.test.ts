/**
 * Pins the order of key validation against slug resolution on the two guest
 * record routes, `PUT`/`DELETE /<slug>/users/<userKey>`: **the user key is
 * validated BEFORE the slug resolves.**
 *
 * The order is load-bearing and nothing else asserts it. An illegal key is a
 * fast `400` on the request's own merits. Were the slug resolved first, an
 * illegal key under an unknown slug would flip into a tarpitted `404`
 * (ARCHITECTURE.md § The tarpit — the queue is for slug *misses*, not for
 * requests that disqualified themselves), and one under a valid slug would
 * cost a links and event read before being refused. The route wrapper that
 * owns the order is `publicUserRoute` in `routes/events.ts`.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// The tarpit reads its delay once, when `missTarpit` is constructed at import
// time, so "no delay" has to be in the environment before `app.ts` pulls it
// in — and `vi.hoisted` is the only thing that runs earlier than a hoisted
// import. The delay only matters to the one test that expects a miss.
const originalMissDelay = vi.hoisted(() => {
  const previous = process.env.MISS_DELAY_MS;
  process.env.MISS_DELAY_MS = "0";
  return previous;
});

import { createApp, type Renderer } from "../app.ts";
import { missTarpit } from "../tarpit.ts";

/** The page handler is irrelevant here; only the JSON routes are exercised. */
const renderer: Renderer = {
  loadTemplate: () => Promise.resolve("<!doctype html><div id=\"app\"><!--app-html--></div>"),
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
  if (originalMissDelay === undefined) delete process.env.MISS_DELAY_MS;
  else process.env.MISS_DELAY_MS = originalMissDelay;
});

beforeEach(async () => {
  varDir = await fs.mkdtemp(path.join(os.tmpdir(), "timeful-key-order-"));
  process.env.VAR_DIR = varDir;
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (originalVarDir === undefined) delete process.env.VAR_DIR;
  else process.env.VAR_DIR = originalVarDir;
  await fs.rm(varDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
});

/** A key `userKeyFromParam` rejects: longer than the 100-character cap. */
const ILLEGAL_KEY = "x".repeat(101);

async function call(method: string, apiPath: string): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${base}${apiPath}`, { method });
  return { status: res.status, body: await res.json() };
}

describe("user key validates before the slug resolves", () => {
  it("answers an illegal key under an unknown slug with a fast 400, never the tarpit", async () => {
    const enter = vi.spyOn(missTarpit, "enter");
    const res = await call("PUT", `/no-such-event/users/${ILLEGAL_KEY}`);
    // Resolution-first would make this a (tarpitted) 404: the slug is unknown.
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "A guest key is required" });
    expect(enter).not.toHaveBeenCalled();
  });

  it("holds the same order on DELETE", async () => {
    const enter = vi.spyOn(missTarpit, "enter");
    const res = await call("DELETE", `/no-such-event/users/${ILLEGAL_KEY}`);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "A guest key is required" });
    expect(enter).not.toHaveBeenCalled();
  });

  it("still tarpits the miss once the key is legal", async () => {
    // The companion assertion that keeps the two above honest: with a legal
    // key the very same unknown slug is a slug miss, and slug misses queue.
    const enter = vi.spyOn(missTarpit, "enter");
    const res = await call("PUT", "/no-such-event/users/alice");
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Event not found" });
    expect(enter).toHaveBeenCalledTimes(1);
  });
});
