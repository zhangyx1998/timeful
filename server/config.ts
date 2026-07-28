/**
 * Runtime knobs read from the environment.
 *
 * Every getter reads `process.env` on each call so a value can be changed by
 * tests (and so the server picks up whatever the operator exported) without a
 * module-load ordering dance.
 */

/** A positive integer from the environment, or `fallback`. */
export function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return fallback;
  return Math.floor(value);
}

/** Delay applied to each queued miss before its 404, in ms. */
export const MISS_DELAY_DEFAULT_MS = 100;

/** Pending misses one IP may have queued before further ones get a 429. */
export const MISS_QUEUE_CAP_DEFAULT = 10;

/** Lifetime of a slug lease, in ms. */
export const LEASE_TTL_DEFAULT_MS = 15 * 60 * 1000;

export const missDelayMs = (): number => envInt("MISS_DELAY_MS", MISS_DELAY_DEFAULT_MS);

export const missQueueCap = (): number =>
  Math.max(1, envInt("MISS_QUEUE_CAP", MISS_QUEUE_CAP_DEFAULT));

export const leaseTtlMs = (): number =>
  Math.max(1, envInt("LEASE_TTL_MS", LEASE_TTL_DEFAULT_MS));

/**
 * A boolean from the environment, or `fallback`.
 *
 * Off is `0`, `false`, `no` or `off`; on is `1`, `true`, `yes` or `on`. An
 * empty or unset variable means "not configured here", and anything else is
 * ignored rather than guessed at — a typo should not quietly turn a feature
 * off.
 */
export function envFlag(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (raw === undefined || raw === "") return fallback;
  if (raw === "0" || raw === "false" || raw === "no" || raw === "off") return false;
  if (raw === "1" || raw === "true" || raw === "yes" || raw === "on") return true;
  return fallback;
}

/**
 * The server-wide kill switch for live updates. On by default.
 *
 * Live updates are configured per event; this sits above that. Off means no
 * upgrade listener is registered at all, so no event gets a channel whatever
 * its own setting says, and every page works on the REST API alone.
 */
export const realtimeEnabled = (): boolean => envFlag("TIMEFUL_REALTIME", true);
