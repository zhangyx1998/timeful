/**
 * Which pipe one autosave goes down.
 *
 * The [sync engine](./sync.ts) knows nothing about this and must not: its job
 * is coalescing, baselines and the era counter, and all of that works off a
 * single `save` promise. This is that promise, composed from the two ways there
 * are to keep it.
 *
 * - **The write session**, when this page holds one. `overSocket` returns null
 *   when it does not — no socket, a browse socket, a session that has not
 *   opened or has dropped — and null is simply "use the other one".
 * - **The REST `PUT`**, always. It is the write API when realtime is off at
 *   either level, and the fallback whenever the socket lets a save down.
 *
 * The rule for falling back is the interesting part, and it is one line: a
 * **transport** failure falls through to REST, a **refusal** does not. Losing
 * the connection mid-edit is something the guest should never have to notice,
 * and REST will almost certainly work. A payload the server refused is
 * different — REST runs the identical validator and would refuse it in the same
 * words — so it goes up to the indicator, where a bad answer belongs.
 */
import { RealtimeSaveError, type SavePayload } from "./realtime";

export interface SaveTransportOptions {
  /**
   * Sends the save over the page's write session, or returns null when there
   * is no session to send it over.
   */
  overSocket: (payload: SavePayload) => Promise<void> | null;
  /** Sends the save over the REST `PUT`. Never optional. */
  overRest: (payload: SavePayload) => Promise<unknown>;
}

/** Builds the `save` the sync engine calls. */
export function createSaveTransport(
  options: SaveTransportOptions,
): (payload: SavePayload) => Promise<void> {
  return async function save(payload: SavePayload): Promise<void> {
    const overSocket = options.overSocket(payload);
    if (overSocket) {
      try {
        await overSocket;
        return;
      } catch (err) {
        if (err instanceof RealtimeSaveError && !err.retryable) throw err;
        // Transport trouble. REST is right there, and it is the same write.
      }
    }
    await options.overRest(payload);
  };
}
