/**
 * The event page's three URL shapes, through the real Express app
 * (ARCHITECTURE.md § Routing / SSR): `/<slug>`, `/<slug>/view` and
 * `/<slug>/edit/<key>` all serve the SSR page; every other shape is the miss
 * it always was; the `<title>` is the one `event-routes.ts` decides; and the
 * served bytes never vary on the query string.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Renderer } from "./app.ts";
import {
  apiCall,
  eventFixture,
  makeVarDir,
  removeVarDir,
  startTestServer,
  type ApiCallOptions,
  type ApiResponse,
  type TestServer,
} from "./test-support.ts";
import type { StoredEvent } from "./types.ts";

/** A real template with a title to replace, and a stub render function. */
const STUB_RENDERER: Renderer = {
  loadTemplate: () =>
    Promise.resolve(
      "<!doctype html><html><head><title>Timeful</title><!--app-head--></head>" +
        '<body><div id="app"><!--app-html--></div></body></html>',
    ),
  loadRender: () => Promise.resolve(async () => ({ html: "<main>ssr</main>" })),
};

let varDir: string;
let ts: TestServer;
let event: StoredEvent;

const call = (method: string, route: string, options?: ApiCallOptions) =>
  apiCall(ts.base, method, route, options);

/** GET a page as text, without the JSON parsing `apiCall` attempts. */
async function page(route: string): Promise<{ status: number; body: string }> {
  const res = (await call("GET", route)) as ApiResponse;
  return { status: res.status, body: String(res.body) };
}

function titleOf(html: string): string | null {
  return /<title>([\s\S]*?)<\/title>/.exec(html)?.[1] ?? null;
}

beforeAll(async () => {
  varDir = await makeVarDir("timeful-page-routes-");
  ts = await startTestServer(STUB_RENDERER);
  ({ event } = await eventFixture(call));
  // One respondent, so the edit shape has a stored spelling to name.
  const put = await call("PUT", `/${event.slug}/users/ada-lovelace`, {
    body: {
      displayName: "Ada Lovelace",
      availability: ["2026-08-03T09:00:00.000Z"],
    },
  });
  expect(put.status).toBe(200);
});

afterAll(async () => {
  await ts.close();
  await removeVarDir(varDir);
});

describe("event page shapes", () => {
  it("serves the page for all three shapes of a resolvable slug", async () => {
    for (const route of [
      `/${event.slug}`,
      `/${event.slug}/view`,
      `/${event.slug}/edit/ada-lovelace`,
      `/${event.slug}/edit/nobody-yet`,
    ]) {
      const res = await page(route);
      expect(res.status).toBe(200);
      expect(res.body).toContain("<main>ssr</main>");
      expect(res.body).toContain("window.__EVENT__");
    }
  });

  it("titles the root and the view by the event, the edit by its person", async () => {
    expect(titleOf((await page(`/${event.slug}`)).body)).toBe("Team Offsite · Timeful");
    expect(titleOf((await page(`/${event.slug}/view`)).body)).toBe(
      "Team Offsite · Timeful",
    );
    expect(titleOf((await page(`/${event.slug}/edit/ada-lovelace`)).body)).toBe(
      "Ada Lovelace’s availability for Team Offsite · Timeful",
    );
    // A key nobody answered under still serves the page, named by the event
    // alone — the client fills the person in once an identity is confirmed.
    expect(titleOf((await page(`/${event.slug}/edit/nobody-yet`)).body)).toBe(
      "Team Offsite · Timeful",
    );
  });

  it("never varies the served bytes on the query string", async () => {
    // The identity layer is client-only; `?name=` must not exist for SSR.
    const bare = await page(`/${event.slug}`);
    const named = await page(`/${event.slug}?name=Ada%20Lovelace`);
    expect(named.status).toBe(200);
    expect(named.body).toBe(bare.body);
  });

  it("404s every shape of an unknown slug with the page, not JSON", async () => {
    for (const route of ["/nope", "/nope/view", "/nope/edit/ada-lovelace"]) {
      const res = await page(route);
      expect(res.status).toBe(404);
      expect(res.body).toContain("<!DOCTYPE html>");
      expect(res.body).toContain("Event not found");
    }
  });

  it("404s the near-miss shapes under a slug that does resolve", async () => {
    for (const route of [
      `/${event.slug}/edit`, // edit without a key
      `/${event.slug}/view/extra`,
      `/${event.slug}/edit/key/extra`,
    ]) {
      const res = await page(route);
      expect(res.status).toBe(404);
      expect(res.body).toContain("<!DOCTYPE html>");
    }
  });
});
