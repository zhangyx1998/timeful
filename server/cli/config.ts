/**
 * `timeful.config.json` — the file that makes a directory a webroot.
 *
 * A webroot holds the operator's data, not the application: this file and the
 * data directory — by default the webroot itself — are all there is, and both
 * resolve from the working directory (the built assets never do — see
 * server/paths.ts).
 *
 * Precedence, lowest first: built-in defaults, the config file, the
 * environment, the command line.
 */
import fs from "node:fs/promises";
import path from "node:path";
import {
  DEFAULT_TRUSTED_PROXIES,
  parseTrustedProxyValue,
  trustedProxyToConfig,
  TrustedProxyError,
  type TrustProxySetting,
} from "../proxy.ts";
import type { Overrides } from "./args.ts";
import { CliError } from "./errors.ts";

export const CONFIG_FILE = "timeful.config.json";

/** What the file may contain. Every key is optional. */
export interface FileConfig {
  port?: number;
  host?: string;
  varDir?: string;
  trustedProxy?: string | string[];
  /**
   * Server-wide kill switch for live updates. Default true.
   *
   * The primary control is per event; this sits above it, and `false` means no
   * event gets a realtime channel whatever its own setting says.
   */
  realtime?: boolean;
}

/** A fully resolved configuration, ready to start a server with. */
export interface ResolvedConfig {
  port: number;
  host: string;
  /** As written in the config: relative paths are kept for display. */
  varDirRaw: string;
  /** Absolute, resolved against the webroot. */
  varDir: string;
  trustedProxy: TrustProxySetting;
  realtime: boolean;
}

export const DEFAULT_PORT = 3000;
export const DEFAULT_HOST = "127.0.0.1";
/**
 * The webroot itself. New webroots used to default to "./var", and existing
 * config files keep whatever they say — nothing migrates. The webroot won:
 * it gives the hardened service one directory to own and one
 * `ReadWritePaths=` line to grant, instead of a writable subdirectory nested
 * inside a read-only parent, and it matches how deployed boxes are actually
 * laid out. (The repo checkout's own dev data stays in `var/` — that default
 * lives in server/storage.ts and is unchanged.)
 */
export const DEFAULT_VAR_DIR = "./";

/**
 * Realtime is on unless it is turned off. It degrades to nothing — a page
 * without a socket is the same page, refreshed by hand — so the safe default
 * is the useful one.
 */
export const DEFAULT_REALTIME = true;

export const configPath = (cwd: string): string => path.join(cwd, CONFIG_FILE);

/** Environment overrides, as a partial config. Absent variables are ignored. */
export function envOverrides(env: NodeJS.ProcessEnv = process.env): Overrides {
  const overrides: Overrides = {};
  if (env.PORT) overrides.port = readPort(env.PORT, "PORT");
  if (env.HOST) overrides.host = env.HOST;
  if (env.VAR_DIR) overrides.varDir = env.VAR_DIR;
  if (env.TIMEFUL_REALTIME) overrides.realtime = envFlag(env.TIMEFUL_REALTIME);
  return overrides;
}

/**
 * `TIMEFUL_REALTIME` as a boolean. Off is `0`, `false`, `no` or `off`, and on
 * is `1`, `true`, `yes` or `on`; anything else is an error rather than a guess,
 * because an operator who wrote something here meant something by it.
 */
function envFlag(raw: string): boolean {
  const value = raw.trim().toLowerCase();
  if (value === "0" || value === "false" || value === "no" || value === "off")
    return false;
  if (value === "1" || value === "true" || value === "yes" || value === "on") return true;
  throw new CliError(
    `TIMEFUL_REALTIME: expected a boolean (1/0, true/false, on/off), got ${JSON.stringify(raw)}`,
  );
}

/** A port out of anything an operator can type; `source` names the culprit. */
export function readPort(value: unknown, source: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new CliError(
      `${source}: port must be an integer between 1 and 65535, got ${JSON.stringify(value)}`,
    );
  return port;
}

function readString(value: unknown, source: string): string {
  if (typeof value !== "string" || value.trim() === "")
    throw new CliError(`${source}: expected a non-empty string, got ${JSON.stringify(value)}`);
  return value.trim();
}

/**
 * Parses the config file. Returns null when the directory is not a webroot;
 * an unreadable or malformed file is an error, never a silent fallback — the
 * operator meant something by it.
 */
export async function readConfigFile(cwd: string): Promise<FileConfig | null> {
  const file = configPath(cwd);
  let text: string;
  try {
    text = await fs.readFile(file, "utf8");
  } catch (err) {
    if (typeof err === "object" && err !== null && "code" in err && err.code === "ENOENT")
      return null;
    throw new CliError(`Cannot read ${file}: ${err instanceof Error ? err.message : err}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new CliError(`${file} is not valid JSON: ${err instanceof Error ? err.message : err}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    throw new CliError(`${file} must contain a JSON object.`);

  const raw = parsed as Record<string, unknown>;
  const config: FileConfig = {};
  if (raw.port !== undefined) config.port = readPort(raw.port, `${CONFIG_FILE} port`);
  if (raw.host !== undefined) config.host = readString(raw.host, `${CONFIG_FILE} host`);
  if (raw.varDir !== undefined) config.varDir = readString(raw.varDir, `${CONFIG_FILE} varDir`);
  if (raw.realtime !== undefined) {
    if (typeof raw.realtime !== "boolean")
      throw new CliError(
        `${CONFIG_FILE} realtime: expected true or false, got ${JSON.stringify(raw.realtime)}`,
      );
    config.realtime = raw.realtime;
  }
  if (raw.trustedProxy !== undefined) {
    const value = raw.trustedProxy;
    if (typeof value !== "string" && !Array.isArray(value))
      throw new CliError(`${CONFIG_FILE} trustedProxy: expected a string or an array of strings.`);
    config.trustedProxy = value as string | string[];
  }
  return config;
}

export interface MergeInput {
  cwd: string;
  file?: FileConfig | null;
  env?: Overrides;
  flags?: Overrides;
}

/** Applies the precedence chain and validates the result. */
export function mergeConfig({ cwd, file, env, flags }: MergeInput): ResolvedConfig {
  const port = flags?.port ?? env?.port ?? file?.port ?? DEFAULT_PORT;
  const host = flags?.host ?? env?.host ?? file?.host ?? DEFAULT_HOST;
  const varDirRaw = flags?.varDir ?? env?.varDir ?? file?.varDir ?? DEFAULT_VAR_DIR;
  const trustedProxyRaw = flags?.trustedProxy ?? file?.trustedProxy;
  const realtime = flags?.realtime ?? env?.realtime ?? file?.realtime ?? DEFAULT_REALTIME;

  return {
    port: readPort(port, "port"),
    host: readString(host, "host"),
    varDirRaw: readString(varDirRaw, "varDir"),
    varDir: path.resolve(cwd, readString(varDirRaw, "varDir")),
    trustedProxy: resolveTrustedProxy(trustedProxyRaw),
    realtime,
  };
}

/**
 * The trusted-proxy value as the CLI accepts it: everything `--trusted-proxy`
 * takes, plus `loopback` as a name for the default pair.
 *
 * The alias lives here rather than in proxy.ts because it is expanded to the
 * two literal addresses before anything sees it. `loopback` is also an Express
 * `trust proxy` keyword with its own, wider meaning (127.0.0.0/8), and the
 * contract is that only IPs and CIDRs ever reach Express — so the flag parser
 * itself keeps rejecting the word.
 */
export function parseTrustedProxyChoice(value: string | string[]): TrustProxySetting {
  const single = typeof value === "string" ? value.trim().toLowerCase() : null;
  if (single === "loopback") return [...DEFAULT_TRUSTED_PROXIES];
  try {
    return parseTrustedProxyValue(value);
  } catch (err) {
    if (err instanceof TrustedProxyError) throw new CliError(err.message);
    throw err;
  }
}

function resolveTrustedProxy(value: string | string[] | undefined): TrustProxySetting {
  if (value === undefined) return [...DEFAULT_TRUSTED_PROXIES];
  return parseTrustedProxyChoice(value);
}

/** The JSON written to disk: defaults included, so the file documents itself. */
export function serializeConfig(config: ResolvedConfig): string {
  const body: Required<FileConfig> = {
    port: config.port,
    host: config.host,
    varDir: config.varDirRaw,
    trustedProxy: trustedProxyToConfig(config.trustedProxy),
    realtime: config.realtime,
  };
  return JSON.stringify(body, null, 2) + "\n";
}

/** Writes `timeful.config.json` into `cwd`. Returns the path written. */
export async function writeConfigFile(
  cwd: string,
  config: ResolvedConfig,
): Promise<string> {
  const file = configPath(cwd);
  await fs.writeFile(file, serializeConfig(config), "utf8");
  return file;
}

/** True when `cwd` is a webroot. */
export async function isWebroot(cwd: string): Promise<boolean> {
  try {
    await fs.access(configPath(cwd));
    return true;
  } catch {
    return false;
  }
}
