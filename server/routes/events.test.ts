/**
 * The zero-record invariant, end to end over HTTP.
 *
 * ARCHITECTURE.md § API: an event only ever contains respondents with at least
 * one entry. A PUT whose `availability` and `ifNeeded` are both empty deletes
 * the response rather than storing a hollow one, and is a no-op when there was
 * nothing there. The DELETE endpoint is public — the capability URL is the auth
 * boundary — so a guest can clear their own record without a session.
 *
 * These run against a real Express app on a real socket: the invariant is about
 * what ends up on disk and what the API hands back, and both only exist once
 * routing, validation and the storage layer have all had their say.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp, type Renderer } from "../app.ts";
import { createSession, setCredential } from "../auth.ts";
import type { StoredEvent } from "../types.ts";

/** The page handler is irrelevant here; only `/api` is exercised. */
const renderer: Renderer = {
  loadTemplate: () => Promise.resolve("<!doctype html><div id=\"app\"><!--app-html--></div>"),
  loadRender: () => Promise.reject(new Error("SSR is not used in these tests")),
};

let server: Server;
let base: string;
let varDir: string;
const originalVarDir = process.env.VAR_DIR;
const originalMissDelay = process.env.MISS_DELAY_MS;

beforeAll(async () => {
  // Misses are tarpitted by design; the delay is not what is under test here.
  process.env.MISS_DELAY_MS = "0";
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
  varDir = await fs.mkdtemp(path.join(os.tmpdir(), "timeful-events-"));
  process.env.VAR_DIR = varDir;
});

afterEach(async () => {
  if (originalVarDir === undefined) delete process.env.VAR_DIR;
  else process.env.VAR_DIR = originalVarDir;
  // Retries because a request can outlive its own response: `touchSession`
  // refreshes `lastSeenAt` fire-and-forget (ARCHITECTURE.md § Passwords and
  // sessions), so an authenticated call may still be landing a write in here
  // when the directory goes. Without the retries that surfaces, rarely and
  // only under load, as ENOTEMPTY from a test that has already passed.
  await fs.rm(varDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

interface Call {
  status: number;
  body: unknown;
}

async function call(
  method: string,
  path: string,
  { body, cookie }: { body?: unknown; cookie?: string } = {},
): Promise<Call> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(cookie ? { Cookie: cookie } : {}),
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
async function adminCookie(): Promise<string> {
  await setCredential({ email: "owner@example.com", password: "hunter2hunter2" });
  return `session=${await createSession({})}`;
}

/** Creates an event straight through the admin API and returns it. */
async function createEvent(cookie: string): Promise<StoredEvent> {
  const res = await call("POST", "/api/events", {
    cookie,
    body: {
      name: "Team Offsite",
      type: "specific_dates",
      dates: ["2026-08-03T00:00:00.000Z", "2026-08-04T00:00:00.000Z"],
      duration: 8,
      timeIncrement: 30,
      startOnMonday: true,
    },
  });
  expect(res.status).toBe(201);
  return res.body as StoredEvent;
}

/** The event exactly as it sits on disk. */
async function onDisk(id: string): Promise<StoredEvent> {
  const text = await fs.readFile(path.join(varDir, "events", `${id}.json`), "utf8");
  return JSON.parse(text) as StoredEvent;
}

/** Respondent names the public GET hands back. */
async function respondentsViaApi(id: string): Promise<string[]> {
  const res = await call("GET", `/api/events/${id}`);
  expect(res.status).toBe(200);
  return Object.keys((res.body as StoredEvent).responses ?? {});
}

const SLOTS = ["2026-08-03T13:00:00.000Z", "2026-08-03T13:30:00.000Z"];

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

describe("PUT /api/events/:id/responses/:name", () => {
  it("stores a response that has entries", async () => {
    const cookie = await adminCookie();
    const event = await createEvent(cookie);

    const res = await call("PUT", `/api/events/${event.id}/responses/Alice`, {
      body: { availability: SLOTS, ifNeeded: [] },
    });

    expect(res.status).toBe(200);
    expect((res.body as { response: { availability: string[] } }).response.availability)
      .toEqual(SLOTS);
    expect((await onDisk(event.id)).responses.Alice.availability).toEqual(SLOTS);
    expect(await respondentsViaApi(event.id)).toEqual(["Alice"]);
  });

  it("stores a response carrying only if-needed entries", async () => {
    const cookie = await adminCookie();
    const event = await createEvent(cookie);

    const res = await call("PUT", `/api/events/${event.id}/responses/Bob`, {
      body: { availability: [], ifNeeded: SLOTS },
    });

    expect(res.status).toBe(200);
    expect((await onDisk(event.id)).responses.Bob.ifNeeded).toEqual(SLOTS);
  });

  it("deletes the record when both arrays come back empty", async () => {
    const cookie = await adminCookie();
    const event = await createEvent(cookie);
    await call("PUT", `/api/events/${event.id}/responses/Alice`, {
      body: { availability: SLOTS, ifNeeded: [] },
    });

    const res = await call("PUT", `/api/events/${event.id}/responses/Alice`, {
      body: { availability: [], ifNeeded: [] },
    });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, name: "Alice", response: null });
    // Gone from the file, not merely emptied.
    const stored = await onDisk(event.id);
    expect(Object.keys(stored.responses)).toEqual([]);
    expect("Alice" in stored.responses).toBe(false);
    expect(await respondentsViaApi(event.id)).toEqual([]);
  });

  it("is a no-op when the name was never on the event", async () => {
    const cookie = await adminCookie();
    const event = await createEvent(cookie);
    const before = await onDisk(event.id);

    const res = await call("PUT", `/api/events/${event.id}/responses/Nobody`, {
      body: { availability: [], ifNeeded: [] },
    });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, name: "Nobody", response: null });
    // Nothing created, and not even a touched `updatedAt`.
    expect(await onDisk(event.id)).toEqual(before);
  });

  it("leaves the other respondents alone when one clears", async () => {
    const cookie = await adminCookie();
    const event = await createEvent(cookie);
    for (const name of ["Alice", "Bob", "Carol"]) {
      await call("PUT", `/api/events/${event.id}/responses/${name}`, {
        body: { availability: SLOTS, ifNeeded: [] },
      });
    }

    await call("PUT", `/api/events/${event.id}/responses/Bob`, {
      body: { availability: [], ifNeeded: [] },
    });

    expect(await respondentsViaApi(event.id)).toEqual(["Alice", "Carol"]);
  });

  it("treats a body with no arrays at all as a clear", async () => {
    const cookie = await adminCookie();
    const event = await createEvent(cookie);
    await call("PUT", `/api/events/${event.id}/responses/Alice`, {
      body: { availability: SLOTS, ifNeeded: [] },
    });

    const res = await call("PUT", `/api/events/${event.id}/responses/Alice`, {
      body: {},
    });

    expect(res.status).toBe(200);
    expect(await respondentsViaApi(event.id)).toEqual([]);
  });

  it("keeps a record whose entries all collapse into availability", async () => {
    const cookie = await adminCookie();
    const event = await createEvent(cookie);

    // The same slot in both arrays: availability wins, ifNeeded ends up empty,
    // but the record still has an entry and must survive.
    const res = await call("PUT", `/api/events/${event.id}/responses/Dana`, {
      body: { availability: [SLOTS[0]], ifNeeded: [SLOTS[0]] },
    });

    expect(res.status).toBe(200);
    const stored = await onDisk(event.id);
    expect(stored.responses.Dana.availability).toEqual([SLOTS[0]]);
    expect(stored.responses.Dana.ifNeeded).toEqual([]);
    expect(await respondentsViaApi(event.id)).toEqual(["Dana"]);
  });

  it("404s an empty clear against an event that does not exist", async () => {
    const res = await call("PUT", "/api/events/not-an-event/responses/Alice", {
      body: { availability: [], ifNeeded: [] },
    });
    expect(res.status).toBe(404);
  });
});

describe("DELETE /api/events/:id/responses/:name", () => {
  it("is public: a guest with no session may clear their own record", async () => {
    const cookie = await adminCookie();
    const event = await createEvent(cookie);
    await call("PUT", `/api/events/${event.id}/responses/Alice`, {
      body: { availability: SLOTS, ifNeeded: [] },
    });

    const res = await call("DELETE", `/api/events/${event.id}/responses/Alice`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(await respondentsViaApi(event.id)).toEqual([]);
  });

  it("also works for the admin, and by slug as well as id", async () => {
    const cookie = await adminCookie();
    const event = await createEvent(cookie);
    await call("PUT", `/api/events/${event.id}/responses/Bob`, {
      body: { availability: SLOTS, ifNeeded: [] },
    });

    const res = await call("DELETE", `/api/events/${event.slug}/responses/Bob`, {
      cookie,
    });

    expect(res.status).toBe(200);
    expect(await respondentsViaApi(event.id)).toEqual([]);
  });

  it("404s a name that is not on the event", async () => {
    const cookie = await adminCookie();
    const event = await createEvent(cookie);

    const res = await call("DELETE", `/api/events/${event.id}/responses/Ghost`);

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Response not found" });
  });

  it("404s an event that does not resolve", async () => {
    const res = await call("DELETE", "/api/events/nope/responses/Alice");
    expect(res.status).toBe(404);
  });
});

/**
 * A lease is a reservation the admin's own form took a moment ago, so claiming
 * it is what both writes do — a create always did, and a rename now does too.
 * Before, the edit form could reserve a link and then be refused it, which is
 * the one case a lease can never legitimately be about.
 */
describe("PATCH /api/events/:id renaming onto a leased slug", () => {
  it("consumes the lease instead of colliding with it", async () => {
    const cookie = await adminCookie();
    const event = await createEvent(cookie);

    const lease = await call("POST", "/api/slug-leases", { cookie });
    expect(lease.status).toBe(201);
    const reserved = (lease.body as { slug: string }).slug;

    const patched = await call("PATCH", `/api/events/${event.id}`, {
      cookie,
      body: { slug: reserved },
    });

    expect(patched.status).toBe(200);
    expect((patched.body as StoredEvent).slug).toBe(reserved);
    expect((await onDisk(event.id)).slug).toBe(reserved);
    // The reservation is spent, not merely ignored: a later create cannot be
    // handed the same path.
    expect((await call("GET", `/api/events/${reserved}`)).status).toBe(200);
  });

  it("still refuses a slug another event already holds", async () => {
    const cookie = await adminCookie();
    const first = await createEvent(cookie);
    const second = await createEvent(cookie);

    const res = await call("PATCH", `/api/events/${second.id}`, {
      cookie,
      body: { slug: first.slug },
    });

    expect(res.status).toBe(409);
    expect((await onDisk(second.id)).slug).toBe(second.slug);
  });

  it("refuses an illegal path with the shared rules' own wording", async () => {
    const cookie = await adminCookie();
    const event = await createEvent(cookie);

    const res = await call("PATCH", `/api/events/${event.id}`, {
      cookie,
      body: { slug: "abc/def" },
    });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: "Slug may only contain letters, numbers and hyphens",
    });
  });
});
