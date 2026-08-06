/**
 * The client half of the canonical-URL guard, pinned against the shared
 * parser: an in-SPA navigation must classify every path exactly as the
 * server does (ARCHITECTURE.md § Routing / SSR) — canonical shapes land on
 * their route, everything else page-like under a slug lands on the event
 * root with the query preserved. Vitest runs with `import.meta.env.SSR`
 * set, so `createRouter` builds on memory history and navigates headlessly.
 */
import { describe, expect, it } from "vitest";
import { createRouter } from "./router";
import { parseEventPath } from "./lib/event-routes";

async function landOn(path: string) {
  const router = createRouter();
  await router.push(path);
  return router.currentRoute.value;
}

describe("event route canonicalization", () => {
  it("lands the canonical shapes on their own routes", async () => {
    expect(await landOn("/happy-hour")).toMatchObject({
      name: "event",
      path: "/happy-hour",
    });
    expect(await landOn("/happy-hour/view")).toMatchObject({
      name: "event-view",
      path: "/happy-hour/view",
    });
    expect(await landOn("/happy-hour/edit/ada-lovelace")).toMatchObject({
      name: "event-edit",
      path: "/happy-hour/edit/ada-lovelace",
      params: { slug: "happy-hour", userKey: "ada-lovelace" },
    });
  });

  it("replays the server's redirect for every non-canonical page path", async () => {
    // The same table the parser test pins as `canonical: false`: in the SPA
    // these must come to rest on the event root, without a server round-trip.
    for (const path of [
      "/happy-hour/",
      "/happy-hour/view/",
      "/happy-hour/edit",
      "/happy-hour/edit/",
      "/happy-hour/view/extra",
      "/happy-hour/edit/key/extra",
      "/happy-hour/junk",
    ]) {
      const landed = await landOn(path);
      expect(landed.name, path).toBe("event");
      expect(landed.path, path).toBe("/happy-hour");
    }
  });

  it("preserves the query across the fallback redirect", async () => {
    const landed = await landOn("/happy-hour/junk?name=Ada%20Lovelace");
    expect(landed.path).toBe("/happy-hour");
    expect(landed.query).toEqual({ name: "Ada Lovelace" });
  });

  it("carries a bare invite token through the fallback intact", async () => {
    // An invite link's whole query is one valueless key to the router; the
    // redirect must not eat or reshape it, or the landing loses its greeting.
    const landed = await landOn("/happy-hour/junk?bmFtZT1BZGE");
    expect(landed.path).toBe("/happy-hour");
    expect(landed.fullPath).toBe("/happy-hour?bmFtZT1BZGE");
  });

  it("agrees with the shared parser on every classification", async () => {
    // Both guards call parseEventPath; this pins that the router's routing
    // table has not drifted from it: a canonical path stays put, a
    // non-canonical one lands on `/<slug>`.
    for (const path of [
      "/happy-hour",
      "/happy-hour/view",
      "/happy-hour/edit/ada-lovelace",
      "/happy-hour/",
      "/happy-hour/edit",
      "/happy-hour/view/extra",
      "/happy-hour/junk",
    ]) {
      const shape = parseEventPath(path);
      const landed = await landOn(path);
      expect(shape, path).not.toBeNull();
      if (shape?.canonical) expect(landed.path, path).toBe(path);
      else expect(landed.path, path).toBe(`/${shape?.slug}`);
    }
  });
});
