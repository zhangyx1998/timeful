/**
 * Repo entry: `npm run dev` and `npm start`.
 *
 * Reads its settings from argv/env, picks a renderer, and listens. The app
 * itself is in `app.ts`, which the packaged CLI uses too. Built assets are
 * found relative to this file (see paths.ts), so `<repo>/dist` is used no
 * matter which directory the script was launched from; `var/` still follows
 * the working directory.
 */
import { fileURLToPath } from "node:url";
import { serve, createStaticRenderer, type Renderer } from "./app.ts";
import { resolveAssets } from "./paths.ts";
import { parseTrustedProxies, type TrustProxySetting } from "./proxy.ts";

const isDev = process.argv.includes("--dev");
const port = Number(process.env.PORT) || 3000;
const host = process.env.HOST || "127.0.0.1";

/** Parses `--trusted-proxy`, or dies with a readable message. */
function resolveTrustProxy(): TrustProxySetting {
  try {
    return parseTrustedProxies(process.argv.slice(2));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

async function createRenderer(): Promise<Renderer> {
  if (!isDev) return createStaticRenderer(resolveAssets(import.meta.url));
  // Dynamic so the dev server (and vite itself) stays out of production.
  const { createDevRenderer } = await import("./dev.ts");
  return createDevRenderer(fileURLToPath(new URL("..", import.meta.url)));
}

// Nothing in this process or Vite's middleware mode sends termination signals,
// so one arriving means something outside did (a service manager stopping the
// unit — or, in dev, an editor/debugger/shell hook killing the job). Say so
// before going: an attributed exit beats a bare `zsh: terminated`.
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    if (isDev) console.error(`[timeful] ${signal} received from outside (parent pid ${process.ppid}) — exiting.`);
    process.exit(signal === "SIGTERM" ? 143 : 130);
  });
}

await serve({
  host,
  port,
  trustProxy: resolveTrustProxy(),
  renderer: await createRenderer(),
  mode: isDev ? "dev" : "production",
});
