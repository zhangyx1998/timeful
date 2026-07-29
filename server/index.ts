/**
 * Repo entry: `npm run dev` and `npm start`.
 *
 * Reads its settings from argv/env, picks a renderer, and listens. The app
 * itself is in `app.ts`, which the packaged CLI uses too. Built assets are
 * found relative to this file (see paths.ts), so `<repo>/dist` is used no
 * matter which directory the script was launched from; `var/` still follows
 * the working directory.
 */
import net from "node:net";
import { fileURLToPath } from "node:url";
import { serve, createStaticRenderer, type Renderer } from "./app.ts";
import { resolveAssets } from "./paths.ts";
import { parseTrustedProxies, type TrustProxySetting } from "./proxy.ts";

const isDev = process.argv.includes("--dev");
const host = process.env.HOST || "127.0.0.1";

/** True when something is already listening there. */
function portTaken(candidate: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net
      .createServer()
      .once("error", () => resolve(true))
      .once("listening", () => probe.close(() => resolve(false)));
    probe.listen(candidate, host);
  });
}

/**
 * Dev only, and only when PORT was not asked for: walk a small pool upward
 * from 3000 and take the first free port, so a second checkout (or a stray
 * leftover server) never turns into an EADDRINUSE crash or a reason to kill
 * someone else's process. An explicit PORT keeps strict fail-if-taken
 * semantics, as does production.
 */
async function resolvePort(): Promise<number> {
  const asked = Number(process.env.PORT);
  if (asked) return asked;
  if (!isDev) return 3000;
  for (let candidate = 3000; candidate < 3020; candidate++) {
    if (!(await portTaken(candidate))) return candidate;
  }
  console.error("[timeful] no free port in 3000-3019; set PORT explicitly.");
  process.exit(1);
}

const port = await resolvePort();

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
