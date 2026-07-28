import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSyncEngine, type SyncPayload } from "./sync";

function payload(...slots: string[]): SyncPayload {
  return { availability: slots, ifNeeded: [] };
}

/** A save function whose calls are resolved by hand, so overlapping requests
 *  can be reproduced deterministically. */
function controllableSave() {
  const calls: SyncPayload[] = [];
  const resolvers: Array<{ resolve: () => void; reject: (reason: unknown) => void }> = [];
  let inFlight = 0;
  let maxConcurrent = 0;

  const save = (body: SyncPayload) => {
    calls.push(body);
    inFlight += 1;
    maxConcurrent = Math.max(maxConcurrent, inFlight);
    return new Promise<void>((resolve, reject) => {
      resolvers.push({
        resolve: () => {
          inFlight -= 1;
          resolve();
        },
        reject: (reason: unknown) => {
          inFlight -= 1;
          reject(reason);
        },
      });
    });
  };

  return {
    save,
    calls,
    get maxConcurrent() {
      return maxConcurrent;
    },
    settle: async (index: number) => {
      resolvers[index].resolve();
      await vi.advanceTimersByTimeAsync(0);
    },
    fail: async (index: number, reason: unknown) => {
      resolvers[index].reject(reason);
      await vi.advanceTimersByTimeAsync(0);
    },
  };
}

describe("sync engine", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    return () => vi.useRealTimers();
  });

  it("rests at the empty baseline by default", () => {
    const engine = createSyncEngine({ save: async () => {} });
    expect(engine.status.value).toBe("empty");
    expect(engine.pending.value).toBe(false);
  });

  it("can be started on an answer the server already holds", () => {
    const engine = createSyncEngine({ save: async () => {}, baseline: "current" });
    expect(engine.status.value).toBe("current");
    expect(engine.pending.value).toBe(false);
  });

  it("leaves a resting state on the first edit", async () => {
    const backend = controllableSave();
    const engine = createSyncEngine({
      save: backend.save,
      debounceMs: 10,
      baseline: "current",
    });

    engine.schedule(payload("a"));
    expect(engine.status.value).toBe("syncing");
    await vi.advanceTimersByTimeAsync(10);
    await backend.settle(0);
    expect(engine.status.value).toBe("saved");
  });

  it("debounces a burst of edits into one request", async () => {
    const backend = controllableSave();
    const engine = createSyncEngine({ save: backend.save, debounceMs: 800 });

    engine.schedule(payload("a"));
    await vi.advanceTimersByTimeAsync(400);
    engine.schedule(payload("a", "b"));
    await vi.advanceTimersByTimeAsync(400);
    // The timer restarted on the second edit, so nothing has been sent yet.
    expect(backend.calls).toHaveLength(0);
    expect(engine.status.value).toBe("syncing");

    await vi.advanceTimersByTimeAsync(400);
    expect(backend.calls).toHaveLength(1);
    expect(backend.calls[0].availability).toEqual(["a", "b"]);

    await backend.settle(0);
    expect(engine.status.value).toBe("saved");
    expect(engine.pending.value).toBe(false);
  });

  it("coalesces edits made while a request is in flight", async () => {
    const backend = controllableSave();
    const engine = createSyncEngine({ save: backend.save, debounceMs: 800 });

    engine.schedule(payload("a"));
    await vi.advanceTimersByTimeAsync(800);
    expect(backend.calls).toHaveLength(1);

    // Two more edits land while the first request is still open.
    engine.schedule(payload("a", "b"));
    await vi.advanceTimersByTimeAsync(800);
    engine.schedule(payload("a", "b", "c"));
    await vi.advanceTimersByTimeAsync(800);
    expect(backend.calls).toHaveLength(1);
    expect(engine.status.value).toBe("syncing");

    // Releasing the first request sends exactly one follow-up, carrying the
    // newest state — the intermediate edit never hits the wire.
    await backend.settle(0);
    expect(backend.calls).toHaveLength(2);
    expect(backend.calls[1].availability).toEqual(["a", "b", "c"]);

    await backend.settle(1);
    expect(backend.calls).toHaveLength(2);
    expect(engine.status.value).toBe("saved");
    expect(backend.maxConcurrent).toBe(1);
  });

  it("never lets a stale request overwrite a newer one", async () => {
    const backend = controllableSave();
    const engine = createSyncEngine({ save: backend.save, debounceMs: 10 });

    engine.schedule(payload("first"));
    await vi.advanceTimersByTimeAsync(10);
    engine.schedule(payload("second"));
    await vi.advanceTimersByTimeAsync(10);
    engine.schedule(payload("third"));
    await vi.advanceTimersByTimeAsync(10);

    // Requests are serialised, so the server can only ever receive them in the
    // order they were issued, ending with the latest state.
    expect(backend.maxConcurrent).toBe(1);
    await backend.settle(0);
    await backend.settle(1);
    expect(backend.calls.map((call) => call.availability[0])).toEqual(["first", "third"]);
    expect(engine.status.value).toBe("saved");
  });

  it("surfaces failures and keeps the state for a retry", async () => {
    const backend = controllableSave();
    const engine = createSyncEngine({ save: backend.save, debounceMs: 10 });

    engine.schedule(payload("a"));
    await vi.advanceTimersByTimeAsync(10);
    await backend.fail(0, new Error("Network unreachable"));

    expect(engine.status.value).toBe("error");
    expect(engine.error.value).toBe("Network unreachable");
    // The edit is still unsaved.
    expect(engine.pending.value).toBe(true);

    engine.retry();
    await vi.advanceTimersByTimeAsync(0);
    expect(engine.status.value).toBe("syncing");
    expect(backend.calls).toHaveLength(2);
    expect(backend.calls[1].availability).toEqual(["a"]);

    await backend.settle(1);
    expect(engine.status.value).toBe("saved");
    expect(engine.error.value).toBeNull();
  });

  it("retries with the newest state, not the payload that failed", async () => {
    const backend = controllableSave();
    const engine = createSyncEngine({ save: backend.save, debounceMs: 10 });

    engine.schedule(payload("a"));
    await vi.advanceTimersByTimeAsync(10);
    await backend.fail(0, new Error("offline"));
    expect(engine.status.value).toBe("error");

    // The guest keeps editing while the error is on screen. The debounce alone
    // is enough to attempt the save again.
    engine.schedule(payload("a", "b"));
    await vi.advanceTimersByTimeAsync(10);
    expect(backend.calls).toHaveLength(2);
    expect(backend.calls[1].availability).toEqual(["a", "b"]);

    await backend.settle(1);
    expect(engine.status.value).toBe("saved");
  });

  it("gives a fallback message when the failure has none", async () => {
    const backend = controllableSave();
    const engine = createSyncEngine({ save: backend.save, debounceMs: 10 });

    engine.schedule(payload("a"));
    await vi.advanceTimersByTimeAsync(10);
    await backend.fail(0, {});
    expect(engine.error.value).toBe("Could not save your availability");
  });

  it("flushes on demand, skipping the debounce", async () => {
    const backend = controllableSave();
    const engine = createSyncEngine({ save: backend.save, debounceMs: 5000 });

    engine.schedule(payload("a"));
    engine.flush();
    await vi.advanceTimersByTimeAsync(0);
    expect(backend.calls).toHaveLength(1);

    await backend.settle(0);
    await expect(engine.settled()).resolves.toBeUndefined();
  });

  it("does nothing when retried with nothing to save", async () => {
    const backend = controllableSave();
    const engine = createSyncEngine({ save: backend.save, debounceMs: 10 });

    engine.retry();
    await vi.advanceTimersByTimeAsync(50);
    expect(backend.calls).toHaveLength(0);
    expect(engine.status.value).toBe("empty");
  });

  it("falls back to the current baseline when retried with nothing to save", async () => {
    const backend = controllableSave();
    const engine = createSyncEngine({ save: backend.save, debounceMs: 10 });

    engine.reset("current");
    engine.retry();
    await vi.advanceTimersByTimeAsync(50);
    expect(backend.calls).toHaveLength(0);
    expect(engine.status.value).toBe("current");
  });

  it("drops queued edits when reset to a new starting point", async () => {
    const backend = controllableSave();
    const engine = createSyncEngine({ save: backend.save, debounceMs: 10 });

    engine.schedule(payload("a"));
    expect(engine.status.value).toBe("syncing");

    // The grid was re-seeded under someone else: what was queued describes a
    // state nobody is looking at any more.
    engine.reset("current");
    await vi.advanceTimersByTimeAsync(100);
    expect(backend.calls).toHaveLength(0);
    expect(engine.status.value).toBe("current");
    expect(engine.pending.value).toBe(false);
    await expect(engine.settled()).resolves.toBeUndefined();
  });

  it("clears an error when reset", async () => {
    const backend = controllableSave();
    const engine = createSyncEngine({ save: backend.save, debounceMs: 10 });

    engine.schedule(payload("a"));
    await vi.advanceTimersByTimeAsync(10);
    await backend.fail(0, new Error("offline"));
    expect(engine.status.value).toBe("error");

    engine.reset("empty");
    expect(engine.status.value).toBe("empty");
    expect(engine.error.value).toBeNull();

    // The parked state went with it: a retry has nothing left to resend.
    engine.retry();
    await vi.advanceTimersByTimeAsync(50);
    expect(backend.calls).toHaveLength(1);
  });

  it("keeps a request already on the wire from reporting back after a reset", async () => {
    const backend = controllableSave();
    const engine = createSyncEngine({ save: backend.save, debounceMs: 10 });

    engine.schedule(payload("a"));
    await vi.advanceTimersByTimeAsync(10);
    expect(backend.calls).toHaveLength(1);

    // Flushed on the way out of a name, then the grid is re-seeded. The request
    // still lands — the edit belongs on the server — but its outcome says
    // nothing about the answer now on screen.
    engine.reset("empty");
    await backend.settle(0);
    expect(engine.status.value).toBe("empty");

    // A failure is just as silent, and does not park a payload for retry.
    engine.schedule(payload("b"));
    await vi.advanceTimersByTimeAsync(10);
    engine.reset("current");
    await backend.fail(1, new Error("offline"));
    expect(engine.status.value).toBe("current");
    expect(engine.error.value).toBeNull();
    expect(engine.pending.value).toBe(false);
  });

  it("sends the new state without waiting for the abandoned request", async () => {
    const backend = controllableSave();
    const engine = createSyncEngine({ save: backend.save, debounceMs: 10 });

    // Serialisation protects one response document from being overtaken by its
    // own stale payload. A reset means the next edit is a different answer —
    // usually a different person's — so it goes out straight away rather than
    // queueing behind a request that can no longer conflict with it.
    engine.schedule(payload("a"));
    await vi.advanceTimersByTimeAsync(10);
    engine.reset("empty");
    engine.schedule(payload("b"));
    await vi.advanceTimersByTimeAsync(10);
    expect(backend.calls).toHaveLength(2);

    await backend.settle(0);
    await backend.settle(1);
    expect(engine.status.value).toBe("saved");
    expect(backend.calls.map((call) => call.availability[0])).toEqual(["a", "b"]);
  });

  it("stops saving once disposed", async () => {
    const backend = controllableSave();
    const engine = createSyncEngine({ save: backend.save, debounceMs: 10 });

    engine.schedule(payload("a"));
    engine.dispose();
    await vi.advanceTimersByTimeAsync(100);
    expect(backend.calls).toHaveLength(0);

    engine.schedule(payload("b"));
    await vi.advanceTimersByTimeAsync(100);
    expect(backend.calls).toHaveLength(0);
  });
});
