/**
 * Asking npm what the latest published version is.
 *
 * This is **the only outbound network call in the entire application**, and it
 * is never made on its own initiative: the admin presses a button, or an
 * operator types `timeful upgrade`. Nothing polls, nothing phones home on
 * startup, and no page load reaches the network. Timeful is a self-hosted app
 * whose whole promise is that it depends on no third party at runtime; a
 * background version check would quietly break that promise, and an
 * admin-triggered one does not.
 *
 * Everything here fails soft. The registry being unreachable is the normal
 * state of an air-gapped or firewalled box, not an error worth a stack trace,
 * so `fetchLatestVersion` never throws and never returns anything derived from
 * the caller's request.
 */
import { VERSION } from "./cli/version.ts";

/** The `latest` dist-tag document for our own package. */
export const REGISTRY_URL = "https://registry.npmjs.org/timeful/latest";

/** Short: an operator watching a spinner would rather be told than wait. */
export const REGISTRY_TIMEOUT_MS = 5000;

/** The version a build that never went through rollup reports. */
export const DEV_VERSION = "0.0.0-dev";

/** True when the running code is a source checkout rather than a published build. */
export const isDevelopmentBuild = (version: string = VERSION): boolean =>
  version === DEV_VERSION;

export interface RegistryLookup {
  /** The published version, or null when the registry could not be read. */
  latest: string | null;
  /**
   * Why `latest` is null, in words safe to show anyone. Present only then, and
   * never carrying anything from the request that asked.
   */
  problem?: string;
}

export interface LookupOptions {
  /** Milliseconds before the request is abandoned. */
  timeoutMs?: number;
  /** Injected in tests; the global `fetch` otherwise. */
  fetchImpl?: typeof globalThis.fetch;
  url?: string;
}

/**
 * The published version of `timeful`, or a reason there is none to report.
 *
 * Deliberately not a throw: every caller wants to carry on regardless — the
 * CLI still re-points and restarts the service offline, and the admin panel
 * still shows the running version.
 */
export async function fetchLatestVersion(
  options: LookupOptions = {},
): Promise<RegistryLookup> {
  const {
    timeoutMs = REGISTRY_TIMEOUT_MS,
    fetchImpl = globalThis.fetch,
    url = REGISTRY_URL,
  } = options;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
    if (!res.ok)
      return { latest: null, problem: `The npm registry answered ${res.status}.` };

    const body: unknown = await res.json();
    const version =
      typeof body === "object" && body !== null
        ? (body as { version?: unknown }).version
        : undefined;
    if (typeof version !== "string" || !version.trim())
      return { latest: null, problem: "The npm registry answered with no version." };
    return { latest: version.trim() };
  } catch (err) {
    // An abort is the timeout firing; anything else is DNS, TLS or no route at
    // all. Both read the same to whoever asked, so both say the same thing.
    const timedOut = err instanceof Error && err.name === "AbortError";
    return {
      latest: null,
      problem: timedOut
        ? "The npm registry did not answer in time."
        : "The npm registry could not be reached.",
    };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// comparing versions
// ---------------------------------------------------------------------------

/**
 * Enough of semver to answer one question, and no more.
 *
 * Only the release triple is compared numerically; a prerelease sorts *before*
 * the release it leads to, and build metadata is ignored. Timeful publishes
 * plain `x.y.z` releases, so anything cleverer would be untested code guarding
 * a case that does not arise — and the failure mode here is deliberately the
 * quiet one: an unparseable version is simply never "newer".
 */
export function isNewerVersion(candidate: string, current: string): boolean {
  const a = parseVersion(candidate);
  const b = parseVersion(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i += 1) {
    if (a.release[i] !== b.release[i]) return a.release[i] > b.release[i];
  }
  // Same triple: 1.2.3 is newer than 1.2.3-rc.1, and nothing else is newer.
  return !a.prerelease && b.prerelease;
}

interface ParsedVersion {
  release: [number, number, number];
  prerelease: boolean;
}

function parseVersion(raw: string): ParsedVersion | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/.exec(
    raw.trim(),
  );
  if (!match) return null;
  return {
    release: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4] !== undefined,
  };
}
