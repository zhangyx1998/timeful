/**
 * The caching contract (ARCHITECTURE.md § Routing / SSR): served HTML is
 * no-cache and links the stylesheet; hashed assets are immutable for a year.
 * Runs against a built `dist/`; skipped when the build is absent.
 */
import fsSync from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createStaticRenderer } from "./app.ts";
import { assetPathsIn } from "./paths.ts";
import {
  apiCall,
  eventFixture,
  makeVarDir,
  removeVarDir,
  startTestServer,
  type TestServer,
} from "./test-support.ts";
import type { StoredEvent } from "./types.ts";

const distRoot = fileURLToPath(new URL("../dist", import.meta.url));
const assets = assetPathsIn(distRoot);
const built =
  fsSync.existsSync(assets.templateFile) && fsSync.existsSync(assets.serverEntry);

describe.skipIf(!built)("cache headers on the built app", () => {
  let varDir: string;
  let ts: TestServer;
  let event: StoredEvent;

  beforeAll(async () => {
    varDir = await makeVarDir("timeful-cache-headers-");
    ts = await startTestServer(createStaticRenderer(assets));
    ({ event } = await eventFixture((method, route, options) =>
      apiCall(ts.base, method, route, options),
    ));
  });

  afterAll(async () => {
    await ts.close();
    await removeVarDir(varDir);
  });

  it("serves the '/' shell no-cache, with a blocking stylesheet link", async () => {
    const res = await fetch(`${ts.base}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-cache");
    const body = await res.text();
    expect(body).toMatch(/<link[^>]*rel="stylesheet"[^>]*href="\/assets\/[^"]+\.css"/);
    expect(body).not.toMatch(/<style>[\s\S]*?--color-bg:/);
  });

  it("serves the SSR event page the same way", async () => {
    const res = await fetch(`${ts.base}/${event.slug}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-cache");
    const body = await res.text();
    expect(body).toContain('<div id="app" data-ssr>');
    expect(body).toMatch(/<link[^>]*rel="stylesheet"[^>]*href="\/assets\/[^"]+\.css"/);
  });

  it("serves hashed assets as immutable for a year", async () => {
    const template = fsSync.readFileSync(assets.templateFile, "utf8");
    const href = /<link[^>]*rel="stylesheet"[^>]*href="(\/assets\/[^"]+\.css)"/.exec(
      template,
    )?.[1];
    expect(href).toBeTruthy();
    const res = await fetch(`${ts.base}${href}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
  });
});
