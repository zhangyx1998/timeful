/** Asset roots resolve from the running module's URL, never the CWD — a packaged install's CWD is the operator's webroot. */
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface AssetPaths {
  /** Directory containing `client/` and `server/`. */
  root: string;
  /** Vite client build; served as static files. */
  clientDir: string;
  /** The SSR template (the built `index.html`). */
  templateFile: string;
  /** The SSR bundle's entry module. */
  serverEntry: string;
}

export function assetPathsIn(root: string): AssetPaths {
  return {
    root,
    clientDir: path.join(root, "client"),
    templateFile: path.join(root, "client", "index.html"),
    serverEntry: path.join(root, "server", "entry-server.js"),
  };
}

/** Candidate asset roots, nearest first: the packaged layout plus every repo entry depth. */
export function assetRootCandidates(entryDir: string): string[] {
  return [
    entryDir, // packaged: dist/cli.js
    path.join(entryDir, "dist"), // an entry at the repo root
    path.join(entryDir, "..", "dist"), // server/index.ts
    path.join(entryDir, "..", "..", "dist"), // server/cli/index.ts
  ].map((dir) => path.normalize(dir));
}

/** Falls back to the nearest candidate so a "missing build" message points at the packaged location. */
export function findAssetRoot(
  entryUrl: string,
  exists: (file: string) => boolean = existsSync,
): string {
  const entryDir = path.dirname(fileURLToPath(entryUrl));
  const candidates = assetRootCandidates(entryDir);
  return (
    candidates.find((dir) => exists(path.join(dir, "client", "index.html"))) ??
    candidates[0]
  );
}

/** `findAssetRoot` + `assetPathsIn`, the form callers actually want. */
export function resolveAssets(
  entryUrl: string,
  exists?: (file: string) => boolean,
): AssetPaths {
  return assetPathsIn(findAssetRoot(entryUrl, exists));
}
