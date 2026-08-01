/**
 * The admin-only `detail` on error bodies.
 *
 * Two properties, and the first is the contract: a **guest's error bodies do
 * not change at all** — byte-identical to what they were before the field
 * existed, asserted against the raw response text, because the generic body is
 * the security boundary and "an extra field nobody notices" is exactly how a
 * boundary erodes. The second is the point: the signed-in admin is told the
 * cause of a 500 (message, errno code, path) that the public body summarises
 * as "Internal server error", and is *not* told anything twice — a 4xx whose
 * message is already the whole story carries no detail.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  adminCookie,
  apiCall,
  createTestEvent,
  makeVarDir,
  removeVarDir,
  startTestServer,
  type CallFn,
  type TestServer,
} from "../test-support.ts";
import { resetLog, globalLogEntries } from "../log.ts";

let ts: TestServer;
let varDir: string;

beforeEach(async () => {
  varDir = await makeVarDir("timeful-error-detail-");
  ts = await startTestServer();
  resetLog();
});

afterEach(async () => {
  await ts.close();
  await removeVarDir(varDir);
});

const call: CallFn = (method, route, options) => apiCall(ts.base, method, route, options);

/** The raw response text — the byte-identity assertions read this, not JSON. */
async function rawBody(
  method: string,
  route: string,
  init: { cookie?: string; body?: unknown } = {},
): Promise<{ status: number; text: string }> {
  const res = await fetch(`${ts.base}${route}`, {
    method,
    headers: {
      ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(init.cookie ? { Cookie: init.cookie } : {}),
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  return { status: res.status, text: await res.text() };
}

/** Breaks `links.json` so any slug resolution throws — a deterministic 500. */
async function corruptLinks(): Promise<void> {
  await fs.writeFile(path.join(varDir, "links.json"), "{ not json", "utf8");
}

describe("error detail", () => {
  it("keeps a guest's 500 body byte-identical to the old shape", async () => {
    const { event } = { event: await createTestEvent(call, await adminCookie()) };
    await corruptLinks();

    const res = await rawBody("GET", `/${event.slug}/data`);

    expect(res.status).toBe(500);
    expect(res.text).toBe('{"error":"Internal server error"}');
  });

  it("keeps a guest's 400 body byte-identical to the old shape", async () => {
    const event = await createTestEvent(call, await adminCookie());

    const res = await rawBody("PUT", `/${event.slug}/users/ada-lovelace`, {
      body: { displayName: "Ada-Lovelace" },
    });

    expect(res.status).toBe(400);
    expect(res.text).toBe(
      '{"error":"A name may not contain a dash — use spaces instead"}',
    );
  });

  it("tells the admin why a 500 happened", async () => {
    const cookie = await adminCookie();
    const event = await createTestEvent(call, cookie);
    await corruptLinks();

    const res = await call("GET", `/${event.slug}/data`, { cookie });

    expect(res.status).toBe(500);
    const body = res.body as { error: string; detail?: { message: string } };
    expect(body.error).toBe("Internal server error");
    // The cause, which the public body deliberately does not say.
    expect(body.detail?.message).toMatch(/JSON/i);
  });

  it("carries the errno code and path when the cause has them", async () => {
    const cookie = await adminCookie();
    // A *file* where the events directory should be: the next event write
    // fails with a real coded errno rather than a synthetic throw.
    await fs.writeFile(path.join(varDir, "events"), "in the way", "utf8");

    const res = await call("POST", "/api/events", {
      cookie,
      body: {
        name: "Doomed",
        type: "specific_dates",
        dates: ["2026-08-03T00:00:00.000Z"],
        duration: 8,
        timeIncrement: 30,
      },
    });

    expect(res.status).toBe(500);
    const body = res.body as {
      error: string;
      detail?: { message: string; code?: string; path?: string };
    };
    expect(body.error).toBe("Internal server error");
    expect(body.detail?.code).toMatch(/^(EEXIST|ENOTDIR)$/);
    expect(body.detail?.path).toContain(varDir);

    // And the failure reached the owner's log, from the storage layer or the
    // error middleware — with a code either way.
    expect(
      globalLogEntries().some((entry) => entry.level === "error" && entry.code),
    ).toBe(true);
  });

  it("does not repeat a 4xx message as its own detail", async () => {
    const cookie = await adminCookie();
    const event = await createTestEvent(call, cookie);

    const res = await rawBody("PUT", `/${event.slug}/users/ada-lovelace`, {
      cookie,
      body: { displayName: "Ada-Lovelace" },
    });

    // The message is already the whole story, so the admin body is the same
    // bytes a guest gets.
    expect(res.status).toBe(400);
    expect(res.text).toBe(
      '{"error":"A name may not contain a dash — use spaces instead"}',
    );
  });

  it("redacts the slug out of the 500's own log entry", async () => {
    const event = await createTestEvent(call, await adminCookie());
    await corruptLinks();

    await call("GET", `/${event.slug}/data`);

    const logged = globalLogEntries().filter((entry) => entry.level === "error");
    expect(logged.length).toBeGreaterThan(0);
    for (const entry of logged) {
      expect(JSON.stringify(entry)).not.toContain(event.slug);
    }
    expect(logged.some((entry) => entry.path === "/:event/data")).toBe(true);
  });
});
