import { describe, expect, it } from "vitest";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { assetPathsIn, assetRootCandidates, findAssetRoot, resolveAssets } from "./paths.ts";

/** A `exists` stub that only knows about the client builds it was given. */
function only(...roots: string[]) {
  const marker = new Set(roots.map((root) => path.join(root, "client", "index.html")));
  return (file: string) => marker.has(file);
}

const urlOf = (file: string) => pathToFileURL(file).href;

describe("assetPathsIn", () => {
  it("lays the client and SSR trees out beside each other", () => {
    expect(assetPathsIn("/opt/app/dist")).toEqual({
      root: "/opt/app/dist",
      clientDir: path.join("/opt/app/dist", "client"),
      templateFile: path.join("/opt/app/dist", "client", "index.html"),
      serverEntry: path.join("/opt/app/dist", "server", "entry-server.js"),
    });
  });
});

describe("assetRootCandidates", () => {
  it("looks beside the entry first, then up towards a repo dist/", () => {
    expect(assetRootCandidates("/repo/server/cli")).toEqual([
      "/repo/server/cli",
      "/repo/server/cli/dist",
      "/repo/server/dist",
      "/repo/dist",
    ]);
  });
});

describe("findAssetRoot", () => {
  it("finds the packaged layout: cli.js beside client/", () => {
    const root = "/usr/lib/node_modules/timeful";
    expect(findAssetRoot(urlOf(`${root}/cli.js`), only(root))).toBe(root);
  });

  it("finds <repo>/dist from an entry in server/", () => {
    expect(findAssetRoot(urlOf("/repo/server/index.ts"), only("/repo/dist"))).toBe(
      "/repo/dist",
    );
  });

  it("finds <repo>/dist from an entry in server/cli/", () => {
    expect(findAssetRoot(urlOf("/repo/server/cli/index.ts"), only("/repo/dist"))).toBe(
      "/repo/dist",
    );
  });

  it("prefers the nearest build when several exist", () => {
    const url = urlOf("/repo/server/index.ts");
    expect(findAssetRoot(url, only("/repo/server", "/repo/dist"))).toBe("/repo/server");
  });

  it("falls back to the packaged location when nothing is built yet", () => {
    expect(findAssetRoot(urlOf("/repo/server/index.ts"), () => false)).toBe("/repo/server");
  });

  it("ignores the working directory entirely", () => {
    // A webroot with its own dist/ must never shadow the installed assets.
    const cwdDist = path.join(process.cwd(), "dist");
    expect(findAssetRoot(urlOf("/pkg/cli.js"), only("/pkg", cwdDist))).toBe("/pkg");
  });
});

describe("resolveAssets", () => {
  it("resolves a full path set from an entry URL", () => {
    const assets = resolveAssets(urlOf("/pkg/cli.js"), only("/pkg"));
    expect(assets.root).toBe("/pkg");
    expect(assets.serverEntry).toBe(path.join("/pkg", "server", "entry-server.js"));
  });
});
