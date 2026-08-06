/**
 * In-memory slug reservations so the UI can show the URL before the event
 * exists. Never persisted — a restart safely drops them; swept lazily, no timers.
 */
import { leaseTtlMs } from "./config.ts";

export interface Lease {
  slug: string;
  /** Epoch ms at which the lease stops counting as taken. */
  expiresAt: number;
}

/** slug -> expiry (epoch ms). */
const leases = new Map<string, number>();

/** Drops every lease whose deadline has passed. */
export function sweepLeases(now: number = Date.now()): void {
  for (const [slug, expiresAt] of leases) {
    if (expiresAt <= now) leases.delete(slug);
  }
}

/** True when `slug` is held by a lease that has not expired yet. */
export function isLeased(slug: string, now: number = Date.now()): boolean {
  const expiresAt = leases.get(slug);
  if (expiresAt === undefined) return false;
  if (expiresAt <= now) {
    leases.delete(slug);
    return false;
  }
  return true;
}

/** Reserves `slug` (renewing it when already leased). */
export function reserveLease(
  slug: string,
  ttlMs: number = leaseTtlMs(),
  now: number = Date.now(),
): Lease {
  sweepLeases(now);
  const expiresAt = now + ttlMs;
  leases.set(slug, expiresAt);
  return { slug, expiresAt };
}

/** True when a live lease existed; expired ones report false. */
export function consumeLease(slug: string, now: number = Date.now()): boolean {
  const live = isLeased(slug, now);
  leases.delete(slug);
  return live;
}

/** Releases a lease early. Returns true when a live lease was released. */
export function releaseLease(slug: string, now: number = Date.now()): boolean {
  return consumeLease(slug, now);
}

/** Number of leases still live. Sweeps first. */
export function activeLeaseCount(now: number = Date.now()): number {
  sweepLeases(now);
  return leases.size;
}

/** Every live slug, for dup-checks that want the whole set. */
export function leasedSlugs(now: number = Date.now()): string[] {
  sweepLeases(now);
  return [...leases.keys()];
}

/** Test helper: forget every lease. */
export function clearLeases(): void {
  leases.clear();
}
