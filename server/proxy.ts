/**
 * `--trusted-proxy` parsing: which peers may speak X-Forwarded-*. Literal IPs
 * and CIDRs only — a hostname would need per-request resolution.
 */
import net from "node:net";

export const FLAG = "--trusted-proxy";
export const DEFAULT_TRUSTED_PROXIES = ["127.0.0.1", "::1"];

/** What Express wants for `trust proxy`: a trust list, or `false` for none. */
export type TrustProxySetting = string[] | false;

/** Thrown for a malformed `--trusted-proxy` value; fatal at startup. */
export class TrustedProxyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TrustedProxyError";
  }
}

/** Validates one `ip` or `ip/prefix` entry. Returns an error string or null. */
function entryProblem(entry: string): string | null {
  const slash = entry.indexOf("/");
  const address = slash < 0 ? entry : entry.slice(0, slash);
  const prefix = slash < 0 ? null : entry.slice(slash + 1);

  const family = net.isIP(address);
  if (family === 0)
    return `'${entry}' is not an IP address or CIDR range (hostnames are not allowed)`;

  if (prefix !== null) {
    if (!/^\d{1,3}$/.test(prefix)) return `'${entry}' has a malformed CIDR prefix`;
    const bits = Number(prefix);
    const max = family === 4 ? 32 : 128;
    if (bits > max) return `'${entry}' prefix must be between 0 and ${max}`;
  }
  return null;
}

/** Each value may itself be a comma-separated list; throws `TrustedProxyError`. */
export function parseTrustedProxyValue(
  value: string | readonly string[],
): TrustProxySetting {
  const raw = typeof value === "string" ? [value] : value;
  const entries = raw
    .flatMap((item) => String(item).split(","))
    .map((item) => item.trim())
    .filter((item) => item !== "");
  if (entries.length === 0) throw new TrustedProxyError(`${FLAG} requires a value (or 'none')`);

  if (entries.some((entry) => entry.toLowerCase() === "none")) {
    if (entries.length > 1)
      throw new TrustedProxyError(`${FLAG}=none cannot be combined with other values`);
    return false;
  }

  for (const entry of entries) {
    const problem = entryProblem(entry);
    if (problem) throw new TrustedProxyError(`${FLAG}: ${problem}`);
  }
  return entries;
}

/** Reads every occurrence, in both `--flag=value` and `--flag value` forms. */
export function parseTrustedProxies(argv: readonly string[]): TrustProxySetting {
  const raw: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === FLAG) {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("-"))
        throw new TrustedProxyError(`${FLAG} requires a value (or 'none')`);
      raw.push(next);
      i += 1;
    } else if (arg.startsWith(`${FLAG}=`)) {
      raw.push(arg.slice(FLAG.length + 1));
    }
  }
  if (raw.length === 0) return [...DEFAULT_TRUSTED_PROXIES];
  return parseTrustedProxyValue(raw);
}

/** Human-readable form for the startup log. */
export function describeTrustedProxies(setting: TrustProxySetting): string {
  return setting === false ? "none (X-Forwarded-* ignored)" : setting.join(", ");
}

/** The `trustedProxy` form written to `timeful.config.json`. */
export function trustedProxyToConfig(setting: TrustProxySetting): string | string[] {
  return setting === false ? "none" : [...setting];
}
