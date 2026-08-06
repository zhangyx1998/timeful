/**
 * Which pipe one autosave goes down; the sync engine works off this single
 * `save` promise and knows nothing else. Socket first when a write session
 * exists; a *transport* failure falls through to REST, a *refusal* does not —
 * REST runs the identical validator and would refuse in the same words.
 */
import { RealtimeSaveError, type SavePayload } from "./realtime";

export interface SaveTransportOptions {
  /** Sends over the write session, or null when there is no session. */
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
