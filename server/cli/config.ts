/** The config and data directory resolve from the CWD; built assets never do (server/paths.ts). Precedence, lowest first: defaults, file, environment, command line. */
import fs from "node:fs/promises";
import path from "node:path";
import {
  DEFAULT_TRUSTED_PROXIES,
  parseTrustedProxyValue,
  trustedProxyToConfig,
  TrustedProxyError,
  type TrustProxySetting,
} from "../proxy.ts";
import {
  OidcConfigError,
  resolveOidcSettings,
  type OidcInput,
  type OidcSettings,
} from "../oidc.ts";
import type { Overrides } from "./args.ts";
import { CliError } from "./errors.ts";

export const CONFIG_FILE = "timeful.config.json";

/** What the file may contain. Every key is optional. */
export interface FileConfig {
  port?: number;
  host?: string;
  varDir?: string;
  trustedProxy?: string | string[];
  /** Server-wide kill switch above the per-event setting; false means no event gets realtime. */
  realtime?: boolean;
  /** Owner sign-in through an OIDC provider; hand-written, the wizard never asks. */
  oidc?: OidcInput;
}

export interface ResolvedConfig {
  port: number;
  host: string;
  /** As written in the config: relative paths are kept for display. */
  varDirRaw: string;
  /** Absolute, resolved against the webroot. */
  varDir: string;
  trustedProxy: TrustProxySetting;
  realtime: boolean;
  oidc: OidcSettings | null;
}

export const DEFAULT_PORT = 3000;
export const DEFAULT_HOST = "127.0.0.1";
// Was "./var"; existing files keep what they say, nothing migrates. The webroot gives the
// hardened service one directory to own and one ReadWritePaths= line.
export const DEFAULT_VAR_DIR = "./";

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

// Anything unrecognised is an error, not a guess.
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

/** Null when the directory is not a webroot; an unreadable or malformed file is an error, never a silent fallback. */
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
  if (raw.oidc !== undefined) {
    if (typeof raw.oidc !== "object" || raw.oidc === null || Array.isArray(raw.oidc))
      throw new CliError(`${CONFIG_FILE} oidc: expected an object.`);
    config.oidc = raw.oidc as OidcInput;
  }
  return config;
}

export interface MergeInput {
  cwd: string;
  file?: FileConfig | null;
  env?: Overrides;
  flags?: Overrides;
  /** Where `TIMEFUL_OIDC_*` is read from; tests pass their own. */
  processEnv?: NodeJS.ProcessEnv;
}

/** Applies the precedence chain and validates the result. */
export function mergeConfig({
  cwd,
  file,
  env,
  flags,
  processEnv = {},
}: MergeInput): ResolvedConfig {
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
    oidc: resolveOidc(file?.oidc, processEnv),
  };
}

function resolveOidc(file: OidcInput | undefined, env: NodeJS.ProcessEnv): OidcSettings | null {
  try {
    return resolveOidcSettings(file, env);
  } catch (err) {
    if (err instanceof OidcConfigError) throw new CliError(`${CONFIG_FILE} ${err.message}`);
    throw err;
  }
}

// `loopback` is expanded to the two literal addresses here: only IPs and CIDRs ever reach
// Express, whose own `loopback` keyword means the wider 127.0.0.0/8.
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
  const body: Required<Omit<FileConfig, "oidc">> = {
    port: config.port,
    host: config.host,
    varDir: config.varDirRaw,
    trustedProxy: trustedProxyToConfig(config.trustedProxy),
    realtime: config.realtime,
  };
  return JSON.stringify(body, null, 2) + "\n";
}

export async function writeConfigFile(
  cwd: string,
  config: ResolvedConfig,
): Promise<string> {
  const file = configPath(cwd);
  await fs.writeFile(file, serializeConfig(config), "utf8");
  return file;
}

export async function isWebroot(cwd: string): Promise<boolean> {
  try {
    await fs.access(configPath(cwd));
    return true;
  } catch {
    return false;
  }
}
