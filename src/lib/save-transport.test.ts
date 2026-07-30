/**
 * Which pipe a save goes down, and what happens when one of them fails.
 *
 * The second half of this file runs the transport underneath the real sync
 * engine, because the thing actually worth protecting is not either piece but
 * the join: the engine's coalescing, baselines and era counter have to behave
 * identically whichever transport kept the promise, and a socket that dies
 * between an edit and its flush has to end with the edit on the server anyway.
 */
import { describe, expect, it, vi } from "vitest";
import { RealtimeSaveError, type SavePayload } from "./realtime";
import { createSaveTransport } from "./save-transport";
import { createSyncEngine, type SyncBaseline } from "./sync";

const PAYLOAD: SavePayload = {
  availability: ["2026-08-03T09:00:00.000Z"],
  ifNeeded: [],
};

const OTHER: SavePayload = {
  availability: ["2026-08-03T10:00:00.000Z"],
  ifNeeded: [],
};

/** A promise the test keeps the far end of, for holding a save mid-flight. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

type OverSocket = (payload: SavePayload) => Promise<void> | null;

/** A transport over the given socket probe, with a REST leg to assert on. */
function transport(
  overSocket: OverSocket,
  overRest: (payload: SavePayload) => Promise<void> = () => Promise.resolve(),
) {
  const rest = vi.fn(overRest);
  return { save: createSaveTransport({ overSocket, overRest: rest }), overRest: rest };
}

/** The same transport under the real sync engine, with no debounce so the
 *  tests drive the clock themselves. */
function engineOver(overSocket: OverSocket, options: { baseline?: SyncBaseline } = {}) {
  const { save, overRest } = transport(overSocket);
  const engine = createSyncEngine({ debounceMs: 0, save, baseline: options.baseline });
  return { engine, overRest };
}

describe("createSaveTransport", () => {
  it("uses the socket when there is one", async () => {
    const overSocket = vi.fn(() => Promise.resolve());
    const { save, overRest } = transport(overSocket);

    await save(PAYLOAD);

    expect(overSocket).toHaveBeenCalledWith(PAYLOAD);
    expect(overRest).not.toHaveBeenCalled();
  });

  it("uses REST when there is no session to send over", async () => {
    // Null is the connector's way of saying so: realtime off at either level,
    // a browse socket, a session refused, or one that has dropped.
    const { save, overRest } = transport(() => null);

    await save(PAYLOAD);

    expect(overRest).toHaveBeenCalledWith(PAYLOAD);
  });

  it("falls back to REST when the socket loses the save", async () => {
    const { save, overRest } = transport(() =>
      Promise.reject(new RealtimeSaveError("connection dropped", true)),
    );

    await expect(save(PAYLOAD)).resolves.toBeUndefined();

    // The guest never has to know the socket went: the same write lands over
    // REST and the indicator says "saved" once, not "failed" and then "saved".
    expect(overRest).toHaveBeenCalledWith(PAYLOAD);
  });

  it("falls back on any error that is not a refusal", async () => {
    // A test double, a bug, an exception from somewhere unexpected — none of
    // them are the server saying no, so none of them cost the guest their edit.
    const { save, overRest } = transport(() => Promise.reject(new Error("kaboom")));

    await save(PAYLOAD);

    expect(overRest).toHaveBeenCalledTimes(1);
  });

  it("does not ask REST a question the server already refused", async () => {
    // REST runs the identical validator and would answer identically, so
    // retrying there would only turn one refusal into two round trips.
    const { save, overRest } = transport(() =>
      Promise.reject(new RealtimeSaveError("A name is required", false)),
    );

    await expect(save(PAYLOAD)).rejects.toThrow("A name is required");
    expect(overRest).not.toHaveBeenCalled();
  });

  it("surfaces a REST failure, whichever way it was reached", async () => {
    const { save } = transport(
      () => Promise.reject(new RealtimeSaveError("dropped", true)),
      () => Promise.reject(new Error("Network down")),
    );

    await expect(save(PAYLOAD)).rejects.toThrow("Network down");
  });
});

// ---------------------------------------------------------------------------
// under the sync engine
// ---------------------------------------------------------------------------

describe("the sync engine over a write session", () => {
  it("saves over the socket and rests at 'saved'", async () => {
    const overSocket = vi.fn(() => Promise.resolve());
    const { engine, overRest } = engineOver(overSocket);

    engine.schedule(PAYLOAD);
    engine.flush();
    await engine.settled();

    expect(engine.status.value).toBe("saved");
    expect(overSocket).toHaveBeenCalledTimes(1);
    expect(overRest).not.toHaveBeenCalled();
  });

  it("coalesces over the socket exactly as it does over REST", async () => {
    // One request in flight at a time, and everything typed while it runs
    // collapses into a single follow-up carrying the latest state.
    const held = deferred();
    const sent: SavePayload[] = [];
    const overSocket = vi.fn((payload: SavePayload) => {
      sent.push(payload);
      return sent.length > 1 ? Promise.resolve() : held.promise;
    });
    const { engine } = engineOver(overSocket);

    engine.schedule(PAYLOAD);
    engine.flush();
    // The engine dispatches on a microtask, so the frame is not out yet.
    await Promise.resolve();
    await Promise.resolve();
    engine.schedule(OTHER);
    engine.schedule(PAYLOAD);
    expect(sent).toEqual([PAYLOAD]);

    held.resolve();
    await engine.settled();

    expect(sent).toEqual([PAYLOAD, PAYLOAD]);
    expect(engine.status.value).toBe("saved");
  });

  it("keeps the era counter's promise across the socket", async () => {
    // A save dispatched before `reset()` still reaches the server — it was the
    // last edit somebody made — but it no longer reports back, so it cannot
    // drag the indicator off the baseline the grid was just re-seeded to.
    const held = deferred();
    const overSocket = vi.fn(() => held.promise);
    const { engine } = engineOver(overSocket);

    engine.schedule(PAYLOAD);
    engine.flush();
    expect(engine.status.value).toBe("syncing");

    engine.reset("current");
    held.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(overSocket).toHaveBeenCalledTimes(1);
    expect(engine.status.value).toBe("current");
  });

  it("delivers over REST when the socket dies between the edit and the flush", async () => {
    // The failover the whole arrangement exists for. The session was open when
    // the edit was made and gone by the time it was sent, and the answer still
    // lands — with the indicator never showing a failure.
    let sessionOpen = true;
    const overSocket = vi.fn(() => (sessionOpen ? Promise.resolve() : null));
    const { engine, overRest } = engineOver(overSocket);

    engine.schedule(PAYLOAD);
    sessionOpen = false;
    engine.flush();
    await engine.settled();

    expect(overRest).toHaveBeenCalledWith(PAYLOAD);
    expect(engine.status.value).toBe("saved");
    expect(engine.error.value).toBeNull();
  });

  it("delivers over REST when the socket dies mid-flight", async () => {
    // The narrower window: the frame went out and the connection died before
    // the ack came back. The transport calls that retryable, so REST finishes
    // the job without the guest being told anything happened.
    const { engine, overRest } = engineOver(() =>
      Promise.reject(
        new RealtimeSaveError("The connection dropped before the save landed", true),
      ),
    );

    engine.schedule(PAYLOAD);
    engine.flush();
    await engine.settled();

    expect(engine.status.value).toBe("saved");
    expect(overRest).toHaveBeenCalledTimes(1);
  });

  it("shows a refused save, and retries it over whatever is open then", async () => {
    let sessionOpen = true;
    const overSocket = vi.fn(() =>
      sessionOpen
        ? Promise.reject(new RealtimeSaveError("A name may not contain a dash", false))
        : null,
    );
    const { engine, overRest } = engineOver(overSocket);

    engine.schedule(PAYLOAD);
    engine.flush();
    await engine.settled();

    expect(engine.status.value).toBe("error");
    expect(engine.error.value).toBe("A name may not contain a dash");
    expect(overRest).not.toHaveBeenCalled();

    // Retry resends the newest state, over whichever transport is available by
    // then — which is the point of `retry()` not holding on to a payload.
    sessionOpen = false;
    engine.schedule(OTHER);
    engine.retry();
    await engine.settled();

    expect(engine.status.value).toBe("saved");
    expect(overRest).toHaveBeenCalledWith(OTHER);
  });

  it("still saves with no realtime at all", async () => {
    // Live updates off at either level: there is never a session, and this is
    // exactly the app as it was before write sessions existed.
    const { engine, overRest } = engineOver(() => null, { baseline: "current" });

    expect(engine.status.value).toBe("current");
    engine.schedule(PAYLOAD);
    engine.flush();
    await engine.settled();

    expect(engine.status.value).toBe("saved");
    expect(overRest).toHaveBeenCalledTimes(1);
  });
});
