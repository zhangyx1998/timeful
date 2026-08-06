/**
 * The inline-styles contract (ARCHITECTURE.md § Routing / SSR): every served
 * page carries the built stylesheet as an inline `<style>` block in its head,
 * and no `<link rel="stylesheet">` is left behind for a proxy hiccup, a
 * poisoned cache, or a half-finished deploy to break.
 *
 * The unit half exercises `inlineStylesheets` against a fixture directory.
 * The served half runs the real production renderer against `dist/` and is
 * skipped when the build is absent — CI builds before it tests (the CLI
 * end-to-end tests need `dist/client`), so it always runs there.
 */
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createStaticRenderer, inlineStylesheets } from "./app.ts";
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

const CSS = ":root{--color-bg:light-dark(#fafafa,#1b1b1f)}";

describe("inlineStylesheets", () => {
  let clientDir: string;

  beforeAll(async () => {
    clientDir = await fs.mkdtemp(path.join(os.tmpdir(), "timeful-inline-css-"));
    await fs.mkdir(path.join(clientDir, "assets"));
    await fs.writeFile(path.join(clientDir, "assets", "index-abc.css"), `${CSS}\n`);
  });

  afterAll(async () => {
    await fs.rm(clientDir, { recursive: true, force: true });
  });

  it("replaces the built stylesheet link with its contents", async () => {
    const template =
      '<head><link rel="stylesheet" crossorigin href="/assets/index-abc.css"></head>';
    const out = await inlineStylesheets(template, clientDir);
    expect(out).toBe(`<head><style>${CSS}</style></head>`);
  });

  it("keeps the link when the asset cannot be read", async () => {
    const template = '<head><link rel="stylesheet" href="/assets/missing.css"></head>';
    expect(await inlineStylesheets(template, clientDir)).toBe(template);
  });

  it("leaves a cross-origin stylesheet alone", async () => {
    const template =
      '<head><link rel="stylesheet" href="https://example.com/x.css"></head>';
    expect(await inlineStylesheets(template, clientDir)).toBe(template);
  });

  it("leaves non-stylesheet links alone", async () => {
    const template = '<head><link rel="icon" href="/favicon.ico"></head>';
    expect(await inlineStylesheets(template, clientDir)).toBe(template);
  });
});

// ---------------------------------------------------------------------------
// the real thing, against a built dist/
// ---------------------------------------------------------------------------

const distRoot = fileURLToPath(new URL("../dist", import.meta.url));
const assets = assetPathsIn(distRoot);
const built =
  fsSync.existsSync(assets.templateFile) && fsSync.existsSync(assets.serverEntry);

describe.skipIf(!built)("served pages inline the stylesheet", () => {
  let varDir: string;
  let ts: TestServer;
  let event: StoredEvent;

  async function page(route: string): Promise<{ status: number; body: string }> {
    const res = await apiCall(ts.base, "GET", route);
    return { status: res.status, body: String(res.body) };
  }

  beforeAll(async () => {
    varDir = await makeVarDir("timeful-inline-css-served-");
    ts = await startTestServer(createStaticRenderer(assets));
    ({ event } = await eventFixture((method, route, options) =>
      apiCall(ts.base, method, route, options),
    ));
  });

  afterAll(async () => {
    await ts.close();
    await removeVarDir(varDir);
  });

  it("serves the '/' shell with the styles inline and no stylesheet link", async () => {
    const res = await page("/");
    expect(res.status).toBe(200);
    expect(res.body).toContain("--color-bg:");
    // The token must sit inside an inline <style> block (the CSS itself may
    // contain `<` in svg data URIs, so the match is non-greedy over anything).
    expect(res.body).toMatch(/<style>[\s\S]*?--color-bg:[\s\S]*?<\/style>/);
    expect(res.body).not.toMatch(/<link[^>]*rel="stylesheet"/);
  });

  it("serves the SSR event page the same way", async () => {
    const res = await page(`/${event.slug}`);
    expect(res.status).toBe(200);
    expect(res.body).toContain('<div id="app" data-ssr>');
    expect(res.body).toContain("window.__EVENT__");
    // The token must sit inside an inline <style> block (the CSS itself may
    // contain `<` in svg data URIs, so the match is non-greedy over anything).
    expect(res.body).toMatch(/<style>[\s\S]*?--color-bg:[\s\S]*?<\/style>/);
    expect(res.body).not.toMatch(/<link[^>]*rel="stylesheet"/);
  });
});
