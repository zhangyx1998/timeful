import { describe, expect, it } from "vitest";
import { createTarpit } from "./tarpit.ts";

/** Wall-clock ms since `start`. */
const since = (start: number): number => Date.now() - start;

describe("tarpit queue", () => {
  it("delays a single miss by delayMs", async () => {
    const tarpit = createTarpit({ delayMs: 30, cap: 10 });
    const start = Date.now();
    await expect(tarpit.enter("1.2.3.4")).resolves.toBe(true);
    expect(since(start)).toBeGreaterThanOrEqual(25);
  });

  it("serializes misses from the same IP", async () => {
    const tarpit = createTarpit({ delayMs: 30, cap: 10 });
    const start = Date.now();
    const order: number[] = [];
    const done = await Promise.all(
      [0, 1, 2].map(async (n) => {
        const ok = await tarpit.enter("10.0.0.1");
        order.push(n);
        return { ok, at: since(start) };
      }),
    );

    expect(done.map((d) => d.ok)).toEqual([true, true, true]);
    // Each waits its own delay only after the previous one is through.
    expect(done[0].at).toBeGreaterThanOrEqual(25);
    expect(done[1].at).toBeGreaterThanOrEqual(55);
    expect(done[2].at).toBeGreaterThanOrEqual(85);
    expect(order).toEqual([0, 1, 2]);
  });

  it("does not make one IP wait for another", async () => {
    const tarpit = createTarpit({ delayMs: 40, cap: 10 });
    const start = Date.now();
    await Promise.all(
      ["10.0.0.1", "10.0.0.2", "10.0.0.3", "10.0.0.4"].map((ip) => tarpit.enter(ip)),
    );
    // Four IPs in parallel cost one delay, not four.
    expect(since(start)).toBeLessThan(120);
  });

  it("refuses immediately once the IP is at its pending cap", async () => {
    const tarpit = createTarpit({ delayMs: 40, cap: 3 });
    const start = Date.now();
    const results = [1, 2, 3, 4, 5].map(() => tarpit.enter("172.16.0.9"));

    // The over-cap answers land without waiting for the queue.
    const refusedAt: number[] = [];
    const settled = await Promise.all(
      results.map(async (promise) => {
        const ok = await promise;
        if (!ok) refusedAt.push(since(start));
        return ok;
      }),
    );

    expect(settled.filter(Boolean)).toHaveLength(3);
    expect(settled.filter((ok) => !ok)).toHaveLength(2);
    for (const at of refusedAt) expect(at).toBeLessThan(30);
  });

  it("frees capacity again as the queue drains", async () => {
    const tarpit = createTarpit({ delayMs: 10, cap: 2 });
    const first = await Promise.all([
      tarpit.enter("192.168.1.5"),
      tarpit.enter("192.168.1.5"),
      tarpit.enter("192.168.1.5"),
    ]);
    expect(first).toEqual([true, true, false]);

    // Drained: the same IP is welcome back.
    await expect(tarpit.enter("192.168.1.5")).resolves.toBe(true);
  });

  it("tracks pending counts and drops empty entries", async () => {
    const tarpit = createTarpit({ delayMs: 20, cap: 10 });
    expect(tarpit.size()).toBe(0);

    const inflight = [tarpit.enter("8.8.8.8"), tarpit.enter("8.8.8.8")];
    expect(tarpit.pending("8.8.8.8")).toBe(2);
    expect(tarpit.size()).toBe(1);

    await Promise.all(inflight);
    expect(tarpit.pending("8.8.8.8")).toBe(0);
    expect(tarpit.size()).toBe(0);
  });

  it("leaves no map entries behind after many distinct IPs", async () => {
    const tarpit = createTarpit({ delayMs: 1, cap: 10 });
    await Promise.all(
      Array.from({ length: 50 }, (_unused, n) => tarpit.enter(`10.1.${n}.7`)),
    );
    expect(tarpit.size()).toBe(0);
  });

  it("buckets blank addresses together instead of leaking entries", async () => {
    const tarpit = createTarpit({ delayMs: 1, cap: 10 });
    const inflight = [tarpit.enter(""), tarpit.enter("")];
    expect(tarpit.pending("")).toBe(2);
    expect(tarpit.size()).toBe(1);
    await Promise.all(inflight);
    expect(tarpit.size()).toBe(0);
  });

  it("keeps waiting even when a delay rejects, so the queue cannot stall", async () => {
    let call = 0;
    const tarpit = createTarpit({
      delayMs: 5,
      cap: 10,
      sleep: async () => {
        call += 1;
        if (call === 1) throw new Error("timer blew up");
      },
    });

    await expect(tarpit.enter("203.0.113.4")).rejects.toThrow("timer blew up");
    await expect(tarpit.enter("203.0.113.4")).resolves.toBe(true);
    expect(tarpit.size()).toBe(0);
  });

  it("advises a Retry-After of at least a second", () => {
    expect(createTarpit({ delayMs: 100, cap: 10 }).retryAfterSeconds()).toBe(1);
    expect(createTarpit({ delayMs: 500, cap: 10 }).retryAfterSeconds()).toBe(5);
    expect(createTarpit({ delayMs: 1, cap: 1 }).retryAfterSeconds()).toBe(1);
  });
});
