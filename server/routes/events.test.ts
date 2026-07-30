/**
 * The event-scoped HTTP surface, end to end.
 *
 * Three things are pinned here at once, and none of them exist until routing,
 * validation and the storage layer have all had their say — so these run
 * against a real Express app on a real socket, over a real temp `VAR_DIR`.
 *
 * **Where an event's endpoints live.** Everything addressed to one event hangs
 * off that event's own URL — `/<slug>/data`, `/<slug>/settings`,
 * `/<slug>/users/<key>` — because the URL is the capability, and hanging those
 * off `/api` only ever hid that. `/api` keeps the global half, the list and the
 * create, and nothing else. The old `/api/events/<id>` spellings are gone
 * outright, with no compatibility shim, which is asserted rather than assumed.
 *
 * **What a response is.** A response is filed under the guest's user key and
 * carries the display name it was typed as. The zero-record invariant survives
 * the move intact (ARCHITECTURE.md § API): an event only ever contains
 * respondents with at least one entry, so a PUT whose `availability` and
 * `ifNeeded` are both empty deletes the response rather than storing a hollow
 * one, and is a no-op when there was nothing there. The DELETE endpoint is
 * public — the capability URL is the auth boundary — so a guest can clear their
 * own record without a session.
 *
 * **What an old file means.** Files written before keys existed are migrated on
 * read rather than by a script, so the last section writes one straight into
 * the temp dir in the pre-key shape and asks the API what it makes of it.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

// The tarpit reads its delay once, when `missTarpit` is constructed at import
// time, so "no delay" has to be in the environment before `app.ts` pulls it in
// — and `vi.hoisted` is the only thing that runs earlier than a hoisted import.
// Misses are tarpitted by design, and *that* they are is asserted below by
// watching the queue itself; how long they sit in it is tarpit.ts's business.
const originalMissDelay = vi.hoisted(() => {
  const previous = process.env.MISS_DELAY_MS;
  process.env.MISS_DELAY_MS = "0";
  return previous;
});

import { createApp, type Renderer } from "../app.ts";
import { createSession, setCredential } from "../auth.ts";
import { missTarpit } from "../tarpit.ts";
import type { StoredEvent } from "../types.ts";

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
  varDir = await fs.mkdtemp(path.join(os.tmpdir(), "timeful-events-"));
  process.env.VAR_DIR = varDir;
});

afterEach(async () => {
  // Spies are taken per test (the tarpit queue, `console.warn`); none of them
  // may outlive the test that wanted them.
  vi.restoreAllMocks();
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

/** The whole document as the public read hands it back. */
async function viaApi(idOrSlug: string): Promise<StoredEvent> {
  const res = await call("GET", `/${idOrSlug}/data`);
  expect(res.status).toBe(200);
  return res.body as StoredEvent;
}

/** Respondent *keys* — not names — as the public read hands them back. */
async function respondentsViaApi(idOrSlug: string): Promise<string[]> {
  return Object.keys((await viaApi(idOrSlug)).responses ?? {});
}

/**
 * Replaces an event's responses with pre-key records: filed under the raw name
 * the guest typed, dashes and all, and carrying no `displayName`.
 *
 * Written to the file directly because there is no other way to produce one —
 * the API has never written this shape, and the missing `displayName` is
 * precisely what marks a record as legacy. This is the file an older release
 * left behind.
 */
async function writeLegacyResponses(
  id: string,
  responses: Record<
    string,
    { availability?: string[]; ifNeeded?: string[]; updatedAt: string }
  >,
): Promise<void> {
  const file = path.join(varDir, "events", `${id}.json`);
  const event = JSON.parse(await fs.readFile(file, "utf8")) as StoredEvent;
  await fs.writeFile(file, JSON.stringify({ ...event, responses }, null, 2) + "\n", "utf8");
}

const SLOTS = ["2026-08-03T13:00:00.000Z", "2026-08-03T13:30:00.000Z"];

// ---------------------------------------------------------------------------
// the two namespaces
// ---------------------------------------------------------------------------

describe("the /api and event-scoped namespaces", () => {
  it("keeps the list and the create under /api, admin-only", async () => {
    const cookie = await adminCookie();
    const event = await createEvent(cookie);

    const listed = await call("GET", "/api/events", { cookie });
    expect(listed.status).toBe(200);
    expect(listed.body).toEqual([
      expect.objectContaining({ id: event.id, slug: event.slug, responseCount: 0 }),
    ]);

    // Neither half is public: the event list names every slug on the server.
    expect(await call("GET", "/api/events")).toEqual({
      status: 401,
      body: { error: "Not authenticated" },
    });
    expect((await call("POST", "/api/events", { body: { name: "x" } })).status).toBe(401);
  });

  it("moved every event-scoped endpoint off /api, with nothing left behind", async () => {
    const cookie = await adminCookie();
    const event = await createEvent(cookie);

    // Each row is one endpoint's old spelling and its new one. Ordered so the
    // second pass is a legal sequence of operations on one event, ending by
    // deleting it.
    const moved: Array<{ method: string; from: string; to: string; body?: unknown }> = [
      { method: "GET", from: `/api/events/${event.id}`, to: `/${event.slug}/data` },
      {
        method: "PUT",
        from: `/api/events/${event.id}/responses/Alice`,
        to: `/${event.slug}/users/alice`,
        body: { displayName: "Alice", availability: SLOTS },
      },
      {
        method: "DELETE",
        from: `/api/events/${event.id}/responses/Alice`,
        to: `/${event.slug}/users/alice`,
      },
      {
        method: "PATCH",
        from: `/api/events/${event.id}`,
        to: `/${event.slug}/settings`,
        body: { name: "Renamed" },
      },
      { method: "DELETE", from: `/api/events/${event.id}`, to: `/${event.slug}/settings` },
    ];

    // Gone, and gone for the owner too: a 404 here is the route no longer
    // existing, not the caller being turned away. `/api/events/<id>` now falls
    // through to the `/api` catch-all like any other unknown API path.
    for (const { method, from, body } of moved) {
      expect(await call(method, from, { cookie, body }), `${method} ${from}`).toEqual({
        status: 404,
        body: { error: "Not found" },
      });
    }

    // And they moved rather than vanished.
    for (const { method, to, body } of moved) {
      expect((await call(method, to, { cookie, body })).status, `${method} ${to}`).toBe(200);
    }
  });
});

// ---------------------------------------------------------------------------
// misses under an event's URL
// ---------------------------------------------------------------------------

describe("paths that do not resolve", () => {
  it("tarpits an unknown first segment, whatever follows it", async () => {
    const enter = vi.spyOn(missTarpit, "enter");

    const misses: Array<[string, string, unknown?]> = [
      ["GET", "/nope/data"],
      ["PUT", "/nope/users/alice", { displayName: "Alice", availability: SLOTS }],
      ["DELETE", "/nope/users/alice"],
    ];

    for (const [method, route, body] of misses) {
      expect(await call(method, route, { body }), `${method} ${route}`).toEqual({
        status: 404,
        body: { error: "Event not found" },
      });
    }

    // An unknown sub-segment under an unknown slug is still a scan — but it is
    // a person following a bad link rather than an API client, so it gets the
    // same 404 *page* a bad single-segment URL gets rather than raw JSON.
    const page = await call("GET", "/nope/nonsense");
    expect(page.status).toBe(404);
    expect(String(page.body)).toContain("Event not found");
    expect(String(page.body)).toContain("<!DOCTYPE html>");

    expect(enter).toHaveBeenCalledTimes(misses.length + 1);
  });

  it("plain-404s an unknown sub-segment under a slug that does resolve", async () => {
    const cookie = await adminCookie();
    const event = await createEvent(cookie);
    const enter = vi.spyOn(missTarpit, "enter");

    // Whoever asked has already proved they hold the capability URL, so this is
    // an ordinary mistake and gets an ordinary, undelayed answer. `/ws` and
    // `/users/<key>` are WebSocket upgrade paths: a plain GET of one is not a
    // route at all, and neither is a verb no endpoint serves.
    // A reserved sub-segment is an API client asking for something that is not
    // there, and gets JSON.
    for (const route of [
      `/${event.slug}/ws`,
      `/${event.slug}/users/ada-lovelace`,
      `/${event.slug}/settings`,
      `/${event.id}/data/extra`,
    ]) {
      expect(await call("GET", route), route).toEqual({
        status: 404,
        body: { error: "Not found" },
      });
    }

    // Anything else is a browser, and gets the page. This router sits in front
    // of the page handler for every multi-segment path, so without the
    // distinction a mistyped link would answer a person with raw JSON.
    const page = await call("GET", `/${event.slug}/nonsense`);
    expect(page.status).toBe(404);
    expect(String(page.body)).toContain("<!DOCTYPE html>");

    expect(enter).not.toHaveBeenCalled();
  });

  it("answers an unknown slug on /settings without queueing the owner", async () => {
    const cookie = await adminCookie();
    const enter = vi.spyOn(missTarpit, "enter");

    // Admin-only routes never call the tarpit (docs § The tarpit): the caller
    // is already authenticated, so delaying them buys nothing and only makes
    // the panel feel broken when a stale tab asks about a deleted event.
    for (const method of ["PATCH", "DELETE"]) {
      expect(
        await call(method, "/nope/settings", { cookie, body: { name: "Renamed" } }),
        method,
      ).toEqual({ status: 404, body: { error: "Event not found" } });
    }
    expect(enter).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// GET /<slug>/data
// ---------------------------------------------------------------------------

describe("GET /<slug>/data", () => {
  it("hands the whole document to anyone holding the link", async () => {
    const cookie = await adminCookie();
    const event = await createEvent(cookie);

    // No session anywhere in here: the URL is the credential.
    expect(await viaApi(event.slug)).toEqual(event);
    // The uuid addresses it too, which is what a page open across a rename uses.
    expect(await viaApi(event.id)).toEqual(event);
  });
});

// ---------------------------------------------------------------------------
// PATCH and DELETE /<slug>/settings
// ---------------------------------------------------------------------------

describe("PATCH /<slug>/settings", () => {
  it("takes the slug as well as the uuid", async () => {
    const cookie = await adminCookie();
    const event = await createEvent(cookie);

    const bySlug = await call("PATCH", `/${event.slug}/settings`, {
      cookie,
      body: { name: "By slug" },
    });
    expect(bySlug.status).toBe(200);
    expect((bySlug.body as StoredEvent).name).toBe("By slug");

    const byId = await call("PATCH", `/${event.id}/settings`, {
      cookie,
      body: { name: "By uuid" },
    });
    expect(byId.status).toBe(200);
    expect((await onDisk(event.id)).name).toBe("By uuid");
  });

  it("is admin-only, on a known slug and an unknown one alike", async () => {
    const cookie = await adminCookie();
    const event = await createEvent(cookie);

    for (const route of [`/${event.slug}/settings`, "/nope/settings"]) {
      expect(await call("PATCH", route, { body: { name: "Renamed" } }), route).toEqual({
        status: 401,
        body: { error: "Not authenticated" },
      });
    }
    expect((await onDisk(event.id)).name).toBe("Team Offsite");
  });
});

describe("DELETE /<slug>/settings", () => {
  it("deletes by the slug as well as by the uuid", async () => {
    const cookie = await adminCookie();
    const bySlug = await createEvent(cookie);
    const byId = await createEvent(cookie);

    expect(await call("DELETE", `/${bySlug.slug}/settings`, { cookie })).toEqual({
      status: 200,
      body: { ok: true },
    });
    expect(await call("DELETE", `/${byId.id}/settings`, { cookie })).toEqual({
      status: 200,
      body: { ok: true },
    });

    // Off the disk and out of links.json, both of them.
    expect((await call("GET", "/api/events", { cookie })).body).toEqual([]);
    expect((await call("GET", `/${bySlug.slug}/data`)).status).toBe(404);
    expect((await call("GET", `/${byId.id}/data`)).status).toBe(404);
  });

  it("is admin-only", async () => {
    const cookie = await adminCookie();
    const event = await createEvent(cookie);

    expect(await call("DELETE", `/${event.slug}/settings`)).toEqual({
      status: 401,
      body: { error: "Not authenticated" },
    });
    expect((await viaApi(event.id)).id).toBe(event.id);
  });
});

/**
 * A lease is a reservation the admin's own form took a moment ago, so claiming
 * it is what both writes do — a create always did, and a rename now does too.
 * Before, the edit form could reserve a link and then be refused it, which is
 * the one case a lease can never legitimately be about.
 */
describe("PATCH /<slug>/settings renaming onto a leased slug", () => {
  it("consumes the lease instead of colliding with it", async () => {
    const cookie = await adminCookie();
    const event = await createEvent(cookie);

    const lease = await call("POST", "/api/slug-leases", { cookie });
    expect(lease.status).toBe(201);
    const reserved = (lease.body as { slug: string }).slug;

    const patched = await call("PATCH", `/${event.id}/settings`, {
      cookie,
      body: { slug: reserved },
    });

    expect(patched.status).toBe(200);
    expect((patched.body as StoredEvent).slug).toBe(reserved);
    expect((await onDisk(event.id)).slug).toBe(reserved);
    // The reservation is spent, not merely ignored: a later create cannot be
    // handed the same path.
    expect((await call("GET", `/${reserved}/data`)).status).toBe(200);
  });

  it("still refuses a slug another event already holds", async () => {
    const cookie = await adminCookie();
    const first = await createEvent(cookie);
    const second = await createEvent(cookie);

    const res = await call("PATCH", `/${second.id}/settings`, {
      cookie,
      body: { slug: first.slug },
    });

    expect(res.status).toBe(409);
    expect((await onDisk(second.id)).slug).toBe(second.slug);
  });

  it("refuses an illegal path with the shared rules' own wording", async () => {
    const cookie = await adminCookie();
    const event = await createEvent(cookie);

    const res = await call("PATCH", `/${event.id}/settings`, {
      cookie,
      body: { slug: "abc/def" },
    });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: "Slug may only contain letters, numbers and hyphens",
    });
  });
});

// ---------------------------------------------------------------------------
// PUT /<slug>/users/<userKey>
// ---------------------------------------------------------------------------

describe("PUT /<slug>/users/<userKey>", () => {
  it("stores a response that has entries", async () => {
    const cookie = await adminCookie();
    const event = await createEvent(cookie);

    const res = await call("PUT", `/${event.id}/users/alice`, {
      body: { displayName: "Alice", availability: SLOTS, ifNeeded: [] },
    });

    expect(res.status).toBe(200);
    expect((res.body as { response: { availability: string[] } }).response.availability)
      .toEqual(SLOTS);
    expect((await onDisk(event.id)).responses.alice.availability).toEqual(SLOTS);
    // Filed under the key; the typed spelling is kept beside it, not as the key.
    expect((await onDisk(event.id)).responses.alice.displayName).toBe("Alice");
    expect(await respondentsViaApi(event.id)).toEqual(["alice"]);
  });

  it("stores a response carrying only if-needed entries", async () => {
    const cookie = await adminCookie();
    const event = await createEvent(cookie);

    const res = await call("PUT", `/${event.id}/users/bob`, {
      body: { displayName: "Bob", availability: [], ifNeeded: SLOTS },
    });

    expect(res.status).toBe(200);
    expect((await onDisk(event.id)).responses.bob.ifNeeded).toEqual(SLOTS);
  });

  it("deletes the record when both arrays come back empty", async () => {
    const cookie = await adminCookie();
    const event = await createEvent(cookie);
    await call("PUT", `/${event.id}/users/alice`, {
      body: { displayName: "Alice", availability: SLOTS, ifNeeded: [] },
    });

    const res = await call("PUT", `/${event.id}/users/alice`, {
      body: { displayName: "Alice", availability: [], ifNeeded: [] },
    });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, key: "alice", response: null });
    // Gone from the file, not merely emptied.
    const stored = await onDisk(event.id);
    expect(Object.keys(stored.responses)).toEqual([]);
    expect("alice" in stored.responses).toBe(false);
    expect(await respondentsViaApi(event.id)).toEqual([]);
  });

  it("is a no-op when the key was never on the event", async () => {
    const cookie = await adminCookie();
    const event = await createEvent(cookie);
    const before = await onDisk(event.id);

    const res = await call("PUT", `/${event.id}/users/nobody`, {
      body: { displayName: "Nobody", availability: [], ifNeeded: [] },
    });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, key: "nobody", response: null });
    // Nothing created, and not even a touched `updatedAt`.
    expect(await onDisk(event.id)).toEqual(before);
  });

  it("leaves the other respondents alone when one clears", async () => {
    const cookie = await adminCookie();
    const event = await createEvent(cookie);
    for (const name of ["Alice", "Bob", "Carol"]) {
      await call("PUT", `/${event.id}/users/${name.toLowerCase()}`, {
        body: { displayName: name, availability: SLOTS, ifNeeded: [] },
      });
    }

    await call("PUT", `/${event.id}/users/bob`, {
      body: { displayName: "Bob", availability: [], ifNeeded: [] },
    });

    expect(await respondentsViaApi(event.id)).toEqual(["alice", "carol"]);
  });

  it("treats a body with no arrays at all as a clear", async () => {
    const cookie = await adminCookie();
    const event = await createEvent(cookie);
    await call("PUT", `/${event.id}/users/alice`, {
      body: { displayName: "Alice", availability: SLOTS, ifNeeded: [] },
    });

    const res = await call("PUT", `/${event.id}/users/alice`, {
      body: { displayName: "Alice" },
    });

    expect(res.status).toBe(200);
    expect(await respondentsViaApi(event.id)).toEqual([]);
  });

  it("keeps a record whose entries all collapse into availability", async () => {
    const cookie = await adminCookie();
    const event = await createEvent(cookie);

    // The same slot in both arrays: availability wins, ifNeeded ends up empty,
    // but the record still has an entry and must survive.
    const res = await call("PUT", `/${event.id}/users/dana`, {
      body: { displayName: "Dana", availability: [SLOTS[0]], ifNeeded: [SLOTS[0]] },
    });

    expect(res.status).toBe(200);
    const stored = await onDisk(event.id);
    expect(stored.responses.dana.availability).toEqual([SLOTS[0]]);
    expect(stored.responses.dana.ifNeeded).toEqual([]);
    expect(await respondentsViaApi(event.id)).toEqual(["dana"]);
  });

  it("404s an empty clear against an event that does not exist", async () => {
    const res = await call("PUT", "/not-an-event/users/alice", {
      body: { displayName: "Alice", availability: [], ifNeeded: [] },
    });
    expect(res.status).toBe(404);
  });

  it("requires a display name", async () => {
    const cookie = await adminCookie();
    const event = await createEvent(cookie);

    // The key alone says how to file the record, not what to render for it.
    for (const body of [
      { availability: SLOTS },
      { displayName: 42, availability: SLOTS },
      { displayName: "   ", availability: SLOTS },
    ]) {
      expect(await call("PUT", `/${event.id}/users/alice`, { body })).toEqual({
        status: 400,
        body: { error: "A name is required" },
      });
    }
    expect(await respondentsViaApi(event.id)).toEqual([]);
  });

  it("refuses a dash in the display name, in the identity dialog's words", async () => {
    const cookie = await adminCookie();
    const event = await createEvent(cookie);

    // A dash in a key can only ever have come from whitespace; allowing one in
    // a name would make "ada-lovelace" and "ada lovelace" one key with two
    // spellings and no way to tell which was meant.
    const res = await call("PUT", `/${event.id}/users/ada-lovelace`, {
      body: { displayName: "Ada-Lovelace", availability: SLOTS },
    });

    expect(res).toEqual({
      status: 400,
      body: { error: "A name may not contain a dash — use spaces instead" },
    });
    expect(await respondentsViaApi(event.id)).toEqual([]);
  });

  it("refuses a name that does not normalize to the key in the path", async () => {
    const cookie = await adminCookie();
    const event = await createEvent(cookie);

    // A record whose name does not match its own key would show up twice or
    // not at all: the page renders names and matches on keys.
    const res = await call("PUT", `/${event.id}/users/ada-lovelace`, {
      body: { displayName: "Grace Hopper", availability: SLOTS },
    });

    expect(res).toEqual({
      status: 400,
      body: { error: "The name does not match the key in the path" },
    });
    expect(await respondentsViaApi(event.id)).toEqual([]);
  });

  it("refuses an over-long display name", async () => {
    const cookie = await adminCookie();
    const event = await createEvent(cookie);

    const res = await call("PUT", `/${event.id}/users/alice`, {
      body: { displayName: "a".repeat(101), availability: SLOTS },
    });

    // The length rule is checked before the key match, so this is the answer a
    // guest gets for typing too much rather than a confusing mismatch.
    expect(res).toEqual({
      status: 400,
      body: { error: "A name must be at most 100 characters" },
    });
  });

  it("re-normalizes the key in the path", async () => {
    const cookie = await adminCookie();
    const event = await createEvent(cookie);

    // `/users/Ada%20Lovelace` is not a second person: a key arriving from a URL
    // is normalized like any other, so a hand-written path cannot invent a
    // second spelling of somebody.
    const res = await call("PUT", `/${event.id}/users/Ada%20Lovelace`, {
      body: { displayName: "Ada Lovelace", availability: SLOTS },
    });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, key: "ada-lovelace" });
    expect(await respondentsViaApi(event.id)).toEqual(["ada-lovelace"]);
    // Same record, addressed the ordinary way.
    expect((await call("DELETE", `/${event.id}/users/ada-lovelace`)).status).toBe(200);
    expect(await respondentsViaApi(event.id)).toEqual([]);
  });

  it("files two spellings of one name as one record", async () => {
    const cookie = await adminCookie();
    const event = await createEvent(cookie);

    await call("PUT", `/${event.id}/users/ada-lovelace`, {
      body: { displayName: "Ada Lovelace", availability: [SLOTS[0]] },
    });
    const res = await call("PUT", `/${event.id}/users/ada-lovelace`, {
      body: { displayName: "ada  LOVELACE", availability: SLOTS },
    });

    expect(res.status).toBe(200);
    const stored = await onDisk(event.id);
    // One row on the event, not two people who typed their name differently.
    expect(Object.keys(stored.responses)).toEqual(["ada-lovelace"]);
    expect(stored.responses["ada-lovelace"].availability).toEqual(SLOTS);
    // The last save says how the name is spelled from now on.
    expect(stored.responses["ada-lovelace"].displayName).toBe("ada  LOVELACE");
  });
});

// ---------------------------------------------------------------------------
// DELETE /<slug>/users/<userKey>
// ---------------------------------------------------------------------------

describe("DELETE /<slug>/users/<userKey>", () => {
  it("is public: a guest with no session may clear their own record", async () => {
    const cookie = await adminCookie();
    const event = await createEvent(cookie);
    await call("PUT", `/${event.id}/users/alice`, {
      body: { displayName: "Alice", availability: SLOTS, ifNeeded: [] },
    });

    const res = await call("DELETE", `/${event.id}/users/alice`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(await respondentsViaApi(event.id)).toEqual([]);
  });

  it("also works for the admin, and by slug as well as id", async () => {
    const cookie = await adminCookie();
    const event = await createEvent(cookie);
    await call("PUT", `/${event.id}/users/bob`, {
      body: { displayName: "Bob", availability: SLOTS, ifNeeded: [] },
    });

    const res = await call("DELETE", `/${event.slug}/users/bob`, { cookie });

    expect(res.status).toBe(200);
    expect(await respondentsViaApi(event.id)).toEqual([]);
  });

  it("404s a key that is not on the event", async () => {
    const cookie = await adminCookie();
    const event = await createEvent(cookie);

    const res = await call("DELETE", `/${event.id}/users/ghost`);

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Response not found" });
  });

  it("404s an event that does not resolve", async () => {
    const res = await call("DELETE", "/nope/users/alice");
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// event files written before keys existed
// ---------------------------------------------------------------------------

/**
 * There are no migration scripts and no schema version, so an old file has to
 * be readable exactly as it stands. Every read normalizes it, and the next
 * ordinary write is what makes that stick.
 */
describe("legacy response files", () => {
  it("keys a pre-key file on read, keeping the spelling it was written with", async () => {
    const cookie = await adminCookie();
    const event = await createEvent(cookie);
    await writeLegacyResponses(event.id, {
      // A legacy dash stands in for the space it replaced, so this is the same
      // person a new "Ada Lovelace" would be — not a second row in the list.
      "Ada-Lovelace": { availability: SLOTS, updatedAt: "2026-01-01T00:00:00.000Z" },
      "Grace Hopper": { ifNeeded: SLOTS, updatedAt: "2026-01-02T00:00:00.000Z" },
    });

    const responses = (await viaApi(event.slug)).responses;

    expect(Object.keys(responses)).toEqual(["ada-lovelace", "grace-hopper"]);
    // Grandfathered: re-deriving the name from the key would rewrite somebody's
    // capitalisation on their behalf.
    expect(responses["ada-lovelace"].displayName).toBe("Ada-Lovelace");
    expect(responses["ada-lovelace"].availability).toEqual(SLOTS);
    expect(responses["ada-lovelace"].ifNeeded).toEqual([]);
    expect(responses["grace-hopper"].displayName).toBe("Grace Hopper");
    expect(responses["grace-hopper"].ifNeeded).toEqual(SLOTS);

    // Nothing was rewritten: a read migrates, it does not persist.
    expect(Object.keys((await onDisk(event.id)).responses)).toEqual([
      "Ada-Lovelace",
      "Grace Hopper",
    ]);
  });

  it("keeps the more recently updated of two legacy names that collide", async () => {
    const cookie = await adminCookie();
    const event = await createEvent(cookie);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const newer = { availability: SLOTS, updatedAt: "2026-02-02T00:00:00.000Z" };
    const older = { availability: [SLOTS[0]], updatedAt: "2026-01-01T00:00:00.000Z" };

    // Written newer-first and then older-first: it is the timestamp that
    // decides, not whichever record happens to sit further down the file.
    for (const order of [
      { "Ada Lovelace": newer, "ada-lovelace": older },
      { "ada-lovelace": older, "Ada Lovelace": newer },
    ]) {
      await writeLegacyResponses(event.id, order);
      const responses = (await viaApi(event.slug)).responses;
      expect(Object.keys(responses)).toEqual(["ada-lovelace"]);
      expect(responses["ada-lovelace"].displayName).toBe("Ada Lovelace");
      expect(responses["ada-lovelace"].availability).toEqual(SLOTS);
    }

    // Somebody has to be told a record was dropped, but a warning is not a
    // place to put a guest's name.
    expect(warn).toHaveBeenCalled();
    for (const [message] of warn.mock.calls) {
      expect(String(message).toLowerCase()).not.toContain("ada");
      expect(String(message).toLowerCase()).not.toContain("lovelace");
    }
  });

  it("persists the normalized form on the next ordinary write", async () => {
    const cookie = await adminCookie();
    const event = await createEvent(cookie);
    await writeLegacyResponses(event.id, {
      "Ada-Lovelace": { availability: SLOTS, updatedAt: "2026-01-01T00:00:00.000Z" },
    });

    // Somebody else answering the event is the next ordinary write; the
    // migration rides along with it rather than needing a pass of its own.
    const res = await call("PUT", `/${event.id}/users/grace-hopper`, {
      body: { displayName: "Grace Hopper", availability: SLOTS },
    });
    expect(res.status).toBe(200);

    const stored = await onDisk(event.id);
    expect(Object.keys(stored.responses)).toEqual(["ada-lovelace", "grace-hopper"]);
    expect(stored.responses["ada-lovelace"].displayName).toBe("Ada-Lovelace");
    expect(stored.responses["ada-lovelace"].availability).toEqual(SLOTS);
    // The write that carried it may not disturb what it migrated.
    expect(stored.responses["ada-lovelace"].updatedAt).toBe("2026-01-01T00:00:00.000Z");
  });
});
