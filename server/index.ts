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
import type { Server } from "node:http";
import { fileURLToPath } from "node:url";
import { serve, createStaticRenderer, type Renderer } from "./app.ts";
import { resolveAssets } from "./paths.ts";
import { probeVarDirWritable } from "./storage.ts";
import { parseTrustedProxies, type TrustProxySetting } from "./proxy.ts";

const isDev = process.argv.includes("--dev");

/**
 * `--host [addr]`, following Vite's convention: the bare flag means `0.0.0.0`
 * (every interface — the LAN-testing switch), a value binds that address. The
 * flag beats the `HOST` environment variable, which beats loopback.
 */
function resolveHost(): string {
  const argv = process.argv.slice(2);
  let value: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--host") {
      const next = argv[i + 1];
      // A following flag is not a value: `--host --dev` means every interface.
      if (next === undefined || next.startsWith("-")) value = "0.0.0.0";
      else {
        value = next;
        i += 1;
      }
    } else if (arg.startsWith("--host=")) {
      value = arg.slice("--host=".length);
      if (value === "") {
        console.error("--host= requires an address; bare --host means 0.0.0.0.");
        process.exit(1);
      }
    }
  }
  // `||`, not `??`: an empty HOST in the environment means "unset", as before.
  return value ?? (process.env.HOST || "127.0.0.1");
}

const host = resolveHost();

/** True when something is already listening there. */
function boundElsewhere(candidate: number, address: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net
      .createServer()
      .once("error", () => resolve(true))
      .once("listening", () => probe.close(() => resolve(false)));
    probe.listen(candidate, address);
  });
}

/**
 * True when something is already listening where this server would answer.
 *
 * A wildcard bind also probes loopback: on macOS a wildcard socket can bind a
 * port whose loopback address another process holds, and the two then split
 * the traffic — the startup line would print a 127.0.0.1 URL that reaches the
 * *other* server. A port like that is taken, not free.
 */
async function portTaken(candidate: number): Promise<boolean> {
  if (await boundElsewhere(candidate, host)) return true;
  const wildcard = host === "0.0.0.0" || host === "::";
  return wildcard ? boundElsewhere(candidate, "127.0.0.1") : false;
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

/**
 * The dev renderer, built against the HTTP server `serve()` is about to
 * listen on, so Vite can host its HMR WebSocket there (same port as the app).
 * The import stays dynamic so the dev server (and vite itself) stays out of
 * production — and out of the CLI bundle, whose rollup pass inlines every
 * dynamic import it can reach.
 */
async function devRenderer(server: Server): Promise<Renderer> {
  const { createDevRenderer } = await import("./dev.ts");
  return createDevRenderer(fileURLToPath(new URL("..", import.meta.url)), server);
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

// The same startup write probe the CLI's serve path runs: a data directory
// this process cannot write fails every save, and saying so now — one
// diagnostic, exit non-zero — beats a 500 on the first one.
const unwritable = await probeVarDirWritable();
if (unwritable) {
  console.error(unwritable);
  process.exit(1);
}

await serve({
  host,
  port,
  trustProxy: resolveTrustProxy(),
  renderer: isDev ? devRenderer : createStaticRenderer(resolveAssets(import.meta.url)),
  mode: isDev ? "dev" : "production",
});
