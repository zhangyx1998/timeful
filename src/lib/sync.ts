/**
 * Autosave engine for guest responses; no Save button. Coalescing: at most
 * one request in flight, edits made meanwhile collapse into one follow-up
 * carrying the latest state. Retry resends the newest state, not the payload
 * that failed. The resting state is a caller-declared baseline (`SyncBaseline`).
 */
import { ref, type Ref } from "vue";
import { ApiError, formatErrorDetail } from "./api";

/**
 * The two resting states differ in what the server already holds, which only
 * the caller knows: `empty` — nothing saved under this name; `current` — what
 * is on screen is what the server has.
 */
export type SyncBaseline = "empty" | "current";

export type SyncStatus = SyncBaseline | "syncing" | "saved" | "error";

export interface SyncPayload {
  availability: string[];
  ifNeeded: string[];
}

export interface SyncEngineOptions {
  /** Performs one save. Rejecting puts the engine into the error state. */
  save: (payload: SyncPayload) => Promise<unknown>;
  /** Quiet period after the last edit before saving. */
  debounceMs?: number;
  /** Resting state before the first edit. Defaults to `empty`. */
  baseline?: SyncBaseline;
}

export interface SyncEngine {
  status: Ref<SyncStatus>;
  error: Ref<string | null>;
  /** Formatted admin-only elaboration; null for guests always. */
  errorDetail: Ref<string | null>;
  /** True while edits are waiting to be sent or a request is in flight. */
  pending: Ref<boolean>;
  /** Records new state and (re)starts the debounce timer. */
  schedule: (payload: SyncPayload) => void;
  /** Sends the latest state now, skipping the debounce. */
  flush: () => void;
  /** Clears the error and resends the latest state. */
  retry: () => void;
  /**
   * Declares a new starting point: drops the queue, forgets a request already
   * on the wire, and rests at the given baseline.
   */
  reset: (baseline: SyncBaseline) => void;
  /** Resolves once nothing is queued or in flight. */
  settled: () => Promise<void>;
  dispose: () => void;
}

const DEFAULT_DEBOUNCE_MS = 800;

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error) return error;
  return "Could not save your availability";
}

function errorDetailText(error: unknown): string | null {
  if (error instanceof ApiError && error.detail)
    return formatErrorDetail(error.detail);
  return null;
}

export function createSyncEngine(options: SyncEngineOptions): SyncEngine {
  const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;

  let baseline: SyncBaseline = options.baseline ?? "empty";

  const status = ref<SyncStatus>(baseline);
  const error = ref<string | null>(null);
  const errorDetail = ref<string | null>(null);
  const pending = ref(false);

  /** Newest state the caller has given us. */
  let latest: SyncPayload | null = null;
  /** The payload currently being sent, if any. */
  let inFlight: SyncPayload | null = null;
  /** State that still needs to reach the server. */
  let dirty = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;
  let settledWaiters: Array<() => void> = [];
  /** Bumped by `reset()`; a request from an earlier era reports to nobody. */
  let era = 0;

  function clearTimer() {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  // "Settled" means nothing further happens on its own; after a failure the
  // state stays dirty and waits for retry().
  function notifySettled() {
    if (inFlight || timer !== null) return;
    pending.value = dirty;
    const waiters = settledWaiters;
    settledWaiters = [];
    for (const resolve of waiters) resolve();
  }

  function run() {
    clearTimer();
    if (disposed || inFlight || !dirty || latest === null) {
      notifySettled();
      return;
    }

    const payload = latest;
    const sentIn = era;
    inFlight = payload;
    // Anything scheduled from here marks the state dirty again, queueing
    // exactly one follow-up however many edits arrive.
    dirty = false;
    status.value = "syncing";
    pending.value = true;

    void Promise.resolve()
      .then(() => options.save(payload))
      .then(
        () => {
          if (disposed || sentIn !== era) return;
          inFlight = null;
          error.value = null;
          errorDetail.value = null;
          if (dirty) {
            // Newer state arrived mid-flight: send it straight away.
            run();
          } else {
            status.value = "saved";
            notifySettled();
          }
        },
        (reason: unknown) => {
          if (disposed || sentIn !== era) return;
          inFlight = null;
          // Keep the state dirty so retry() resends it.
          dirty = true;
          status.value = "error";
          error.value = errorMessage(reason);
          errorDetail.value = errorDetailText(reason);
          notifySettled();
        },
      );
  }

  function schedule(payload: SyncPayload) {
    if (disposed) return;
    latest = payload;
    dirty = true;
    pending.value = true;
    if (status.value !== "error") status.value = "syncing";
    clearTimer();
    timer = setTimeout(run, debounceMs);
  }

  function flush() {
    if (disposed) return;
    clearTimer();
    run();
  }

  function retry() {
    if (disposed) return;
    error.value = null;
    errorDetail.value = null;
    if (!dirty && latest === null) {
      status.value = baseline;
      return;
    }
    dirty = true;
    status.value = "syncing";
    pending.value = true;
    flush();
  }

  function reset(next: SyncBaseline) {
    if (disposed) return;
    // A dispatched request keeps going — the server should still receive the
    // last edit under the old state — but it no longer reports back.
    era += 1;
    clearTimer();
    latest = null;
    inFlight = null;
    dirty = false;
    baseline = next;
    status.value = next;
    error.value = null;
    errorDetail.value = null;
    notifySettled();
  }

  function settled(): Promise<void> {
    if (!inFlight && timer === null) return Promise.resolve();
    return new Promise<void>((resolve) => {
      settledWaiters.push(resolve);
    });
  }

  function dispose() {
    disposed = true;
    clearTimer();
    settledWaiters = [];
  }

  return {
    status,
    error,
    errorDetail,
    pending,
    schedule,
    flush,
    retry,
    reset,
    settled,
    dispose,
  };
}
