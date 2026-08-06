/**
 * The event page's URL shapes through the real app (ARCHITECTURE.md § Routing
 * / SSR): canonical shapes serve SSR, other page-like paths under a resolving
 * slug 302 to the event root, unknown slugs stay the tarpitted 404.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { wantsCompactPreview, type Renderer } from "./app.ts";
import type { SsrContext } from "../src/entry-server.ts";
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

/** What the page handler last handed the renderer, for the hint assertions. */
let lastSsrContext: SsrContext | undefined;

/** A real template with a title to replace, and a stub render function. */
const STUB_RENDERER: Renderer = {
  loadTemplate: () =>
    Promise.resolve(
      "<!doctype html><html><head><title>Timeful</title><!--app-head--></head>" +
        '<body><div id="app"><!--app-html--></div></body></html>',
    ),
  loadRender: () =>
    Promise.resolve(async (_url: string, ssrContext: SsrContext = {}) => {
      lastSsrContext = ssrContext;
      return { html: "<main>ssr</main>" };
    }),
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
    for (const route of [
      "/nope",
      "/nope/",
      "/nope/view",
      "/nope/edit/ada-lovelace",
      "/nope/junk",
    ]) {
      const res = await page(route);
      expect(res.status, route).toBe(404);
      expect(res.body).toContain("<!DOCTYPE html>");
      expect(res.body).toContain("Event not found");
    }
  });

  it("tarpits an unknown slug on the junk shapes exactly like the bare one", async () => {
    // Never a redirect for a slug that does not resolve — an attacker must
    // not be able to tell a junk shape from a bare miss by the answer or by
    // its timing. The tarpit's floor is 100ms per queued miss.
    const started = Date.now();
    const res = await page("/nope-timing/garbage");
    expect(res.status).toBe(404);
    expect(Date.now() - started).toBeGreaterThanOrEqual(90);
  });

  it("302s every other page-like path under a resolving slug to the root", async () => {
    for (const route of [
      `/${event.slug}/`, // bare trailing slash
      `/${event.slug}/view/`,
      `/${event.slug}/edit`, // edit without a key
      `/${event.slug}/edit/`,
      `/${event.slug}/view/extra`,
      `/${event.slug}/edit/key/extra`,
      `/${event.slug}/junk`,
    ]) {
      const res = await fetch(`${ts.base}${route}`, { redirect: "manual" });
      await res.text();
      expect(res.status, route).toBe(302);
      expect(res.headers.get("location"), route).toBe(`/${event.slug}`);
    }
  });

  it("preserves the query string across the fallback redirect", async () => {
    // The landing's query stays a client-consumed contract: the redirect
    // carries it to the canonical landing rather than eating it — the plain
    // form and the invite dialog's bare base64 token alike.
    const plain = await fetch(
      `${ts.base}/${event.slug}/junk?name=Ada%20Lovelace&x=1`,
      { redirect: "manual" },
    );
    await plain.text();
    expect(plain.status).toBe(302);
    expect(plain.headers.get("location")).toBe(
      `/${event.slug}?name=Ada%20Lovelace&x=1`,
    );

    const token = await fetch(`${ts.base}/${event.slug}/junk?bmFtZT1BZGE`, {
      redirect: "manual",
    });
    await token.text();
    expect(token.status).toBe(302);
    expect(token.headers.get("location")).toBe(`/${event.slug}?bmFtZT1BZGE`);
  });

  it("threads the device hint into the render and inlines it beside the event", async () => {
    const get = async (headers: Record<string, string>) => {
      const res = await fetch(`${ts.base}/${event.slug}`, { headers });
      return { body: await res.text(), vary: res.headers.get("vary") };
    };

    const mobile = await get({ "sec-ch-ua-mobile": "?1" });
    expect(lastSsrContext?.compact).toBe(true);
    expect(mobile.body).toContain("window.__PREVIEW__ = { compact: true }");
    // Caches must key the page on the hint that shaped it.
    expect(mobile.vary).toContain("Sec-CH-UA-Mobile");

    const desktop = await get({ "sec-ch-ua-mobile": "?0" });
    expect(lastSsrContext?.compact).toBe(false);
    expect(desktop.body).toContain("window.__PREVIEW__ = { compact: false }");

    // No client hint: the coarse UA sniff decides.
    await get({ "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) Mobile/15E148" });
    expect(lastSsrContext?.compact).toBe(true);
    await get({ "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)" });
    expect(lastSsrContext?.compact).toBe(false);
  });

  it("reads the hint's three states exactly", () => {
    expect(wantsCompactPreview({ clientHintMobile: "?1" })).toBe(true);
    expect(wantsCompactPreview({ clientHintMobile: "?0", userAgent: "Mobi" })).toBe(false);
    expect(wantsCompactPreview({ userAgent: "Linux; Android 14" })).toBe(true);
    expect(wantsCompactPreview({})).toBe(false);
  });

  it("keeps the API carve-out an API answer, never a page or a redirect", async () => {
    // A reserved sub-segment with extra path on it stays an API 404 (pinned
    // deliberately): `/data/x` is a confused API client, not a person.
    const res = await call("GET", `/${event.slug}/data/x`);
    expect(res).toEqual({ status: 404, body: { error: "Not found" } });
  });
});
