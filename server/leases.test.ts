import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { leaseTtlMs } from "./config.ts";
import {
  activeLeaseCount,
  clearLeases,
  consumeLease,
  isLeased,
  leasedSlugs,
  releaseLease,
  reserveLease,
  sweepLeases,
} from "./leases.ts";

const originalTtl = process.env.LEASE_TTL_MS;

beforeEach(() => {
  clearLeases();
});

afterEach(() => {
  clearLeases();
  if (originalTtl === undefined) delete process.env.LEASE_TTL_MS;
  else process.env.LEASE_TTL_MS = originalTtl;
});

describe("slug leases", () => {
  it("reserves a slug and reports it as taken", () => {
    const now = 1_000_000;
    const lease = reserveLease("abc", 60_000, now);
    expect(lease.slug).toBe("abc");
    expect(lease.expiresAt).toBe(now + 60_000);
    expect(isLeased("abc", now)).toBe(true);
    expect(isLeased("other", now)).toBe(false);
    expect(activeLeaseCount(now)).toBe(1);
    expect(leasedSlugs(now)).toEqual(["abc"]);
  });

  it("is consumed exactly once", () => {
    const now = 2_000_000;
    reserveLease("once", 60_000, now);
    expect(consumeLease("once", now)).toBe(true);
    expect(isLeased("once", now)).toBe(false);
    expect(consumeLease("once", now)).toBe(false);
    expect(activeLeaseCount(now)).toBe(0);
  });

  it("releases early", () => {
    const now = 3_000_000;
    reserveLease("bye", 60_000, now);
    expect(releaseLease("bye", now)).toBe(true);
    expect(isLeased("bye", now)).toBe(false);
    // Releasing an unknown slug is a no-op, not an error.
    expect(releaseLease("never-leased", now)).toBe(false);
  });

  it("frees a slug again once the lease expires", () => {
    const now = 4_000_000;
    reserveLease("ephemeral", 1_000, now);
    expect(isLeased("ephemeral", now + 999)).toBe(true);
    expect(isLeased("ephemeral", now + 1_000)).toBe(false);
    // An expired lease cannot be consumed — the slug was already free.
    reserveLease("ephemeral", 1_000, now);
    expect(consumeLease("ephemeral", now + 5_000)).toBe(false);
  });

  it("sweeps expired entries lazily instead of holding timers", () => {
    const now = 5_000_000;
    reserveLease("short", 1_000, now);
    reserveLease("long", 60_000, now);
    expect(activeLeaseCount(now)).toBe(2);

    sweepLeases(now + 2_000);
    expect(leasedSlugs(now + 2_000)).toEqual(["long"]);
    expect(activeLeaseCount(now + 2_000)).toBe(1);

    // Touching any lease also drops whatever else has expired.
    expect(isLeased("long", now + 90_000)).toBe(false);
    expect(activeLeaseCount(now + 90_000)).toBe(0);
  });

  it("renews an existing lease rather than duplicating it", () => {
    const now = 6_000_000;
    reserveLease("renew", 1_000, now);
    const renewed = reserveLease("renew", 10_000, now + 500);
    expect(renewed.expiresAt).toBe(now + 10_500);
    expect(activeLeaseCount(now + 2_000)).toBe(1);
    expect(isLeased("renew", now + 2_000)).toBe(true);
  });

  it("defaults its TTL to LEASE_TTL_MS", () => {
    delete process.env.LEASE_TTL_MS;
    expect(leaseTtlMs()).toBe(15 * 60 * 1000);

    process.env.LEASE_TTL_MS = "1000";
    expect(leaseTtlMs()).toBe(1000);
    const now = 7_000_000;
    const lease = reserveLease("env-ttl", undefined, now);
    expect(lease.expiresAt).toBe(now + 1000);

    // Garbage falls back to the default rather than disabling leases.
    process.env.LEASE_TTL_MS = "not-a-number";
    expect(leaseTtlMs()).toBe(15 * 60 * 1000);
  });
});
