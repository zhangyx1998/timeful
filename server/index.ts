/** Repo entry (`npm run dev` / `npm start`): assets resolve from this file (paths.ts); `var/` follows the CWD. */
import net from "node:net";
import type { Server } from "node:http";
import { fileURLToPath } from "node:url";
import { serve, createStaticRenderer, type Renderer } from "./app.ts";
import { resolveAssets } from "./paths.ts";
import { probeVarDirWritable } from "./storage.ts";
import { parseTrustedProxies, type TrustProxySetting } from "./proxy.ts";

const isDev = process.argv.includes("--dev");

/** `--host`, following Vite: the bare flag means 0.0.0.0; flag beats HOST beats loopback. */
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
  // `||`, not `??`: an empty HOST means "unset".
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

/** A wildcard bind also probes loopback: on macOS a wildcard socket can bind a port whose loopback address another process holds. */
async function portTaken(candidate: number): Promise<boolean> {
  if (await boundElsewhere(candidate, host)) return true;
  const wildcard = host === "0.0.0.0" || host === "::";
  return wildcard ? boundElsewhere(candidate, "127.0.0.1") : false;
}

/** Dev only, when PORT is unset: take the first free port from 3000; explicit PORT and production stay strict. */
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

/** Dynamic import keeps vite out of production and out of the CLI bundle. */
async function devRenderer(server: Server): Promise<Renderer> {
  const { createDevRenderer } = await import("./dev.ts");
  return createDevRenderer(fileURLToPath(new URL("..", import.meta.url)), server);
}

// Nothing in-process sends these; attribute the exit instead of a bare `zsh: terminated`.
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    if (isDev) console.error(`[timeful] ${signal} received from outside (parent pid ${process.ppid}) — exiting.`);
    process.exit(signal === "SIGTERM" ? 143 : 130);
  });
}

// The same startup write probe the CLI's serve path runs.
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
