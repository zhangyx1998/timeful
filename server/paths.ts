/**
 * Where the built assets live.
 *
 * One codebase has to find them in two shapes:
 *  - packaged: `dist/cli.js` sits beside `dist/client/` and `dist/server/`
 *  - repo: an entry under `server/` (or `server/cli/`) with builds in `<repo>/dist`
 *
 * Both resolve from the running module's own URL, never from the working
 * directory. For a packaged install the CWD is the operator's webroot — it
 * holds `timeful.config.json` and `var/`, and has no reason to contain the
 * application's assets.
 */
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

/**
 * Places an entry module in `entryDir` may find the asset root, nearest first.
 * The list covers the packaged layout and every depth a repo entry lives at.
 */
export function assetRootCandidates(entryDir: string): string[] {
  return [
    entryDir, // packaged: dist/cli.js
    path.join(entryDir, "dist"), // an entry at the repo root
    path.join(entryDir, "..", "dist"), // server/index.ts
    path.join(entryDir, "..", "..", "dist"), // server/cli/index.ts
  ].map((dir) => path.normalize(dir));
}

/**
 * The first candidate that actually holds a client build. Falls back to the
 * nearest candidate so a "missing build" message points at the packaged
 * location rather than at whichever directory happened to be checked last.
 */
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
