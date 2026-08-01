/**
 * Autosave engine for guest responses.
 *
 * There is no Save button: every grid mutation calls `schedule()` with the
 * complete new state, which is debounced and then PUT to
 * `/api/events/:id/responses/:name`.
 *
 * Two properties matter and are covered by tests:
 *
 * - **Coalescing.** Requests are serialised — at most one is ever in flight.
 *   Edits made while a request is running are collapsed into a single follow-up
 *   carrying the latest state, so the server can never be overtaken by a stale
 *   payload arriving late.
 * - **Retry.** A failure parks the latest state and surfaces it; `retry()`
 *   resends whatever the newest state is by then, not the payload that failed.
 * - **Resting state.** Before the first edit there is still something true to
 *   say — whether the server holds an answer for this name or nothing at all —
 *   so the engine rests at a caller-declared baseline rather than at a single
 *   blank "idle". See `SyncBaseline`.
 */
import { ref, type Ref } from "vue";
import { ApiError, formatErrorDetail } from "./api";

/**
 * The two resting states: nothing is queued, nothing is in flight, and nothing
 * has been sent yet. They differ in what the server is already holding, which
 * the engine cannot know and the caller must say — `reset()` is how.
 *
 * - `empty` — there is nothing to save and nothing saved. A name nobody has
 *   answered under yet.
 * - `current` — what is on screen is what the server has. An existing
 *   respondent's answer, just loaded.
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
  /**
   * The admin-only elaboration under the error, already formatted for print.
   * Null for everyone else — a guest's failures never carry one, because the
   * server only adds the field for a request holding the admin session.
   */
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
   * Declares a new starting point: the grid was re-seeded from the server, so
   * whatever was queued belongs to a state nobody is looking at any more.
   * Drops it, forgets a request already on the wire (its result no longer says
   * anything about what is on screen) and rests at the given baseline.
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

/** The formatted admin-only detail a failed save carried, or null. */
function errorDetailText(error: unknown): string | null {
  if (error instanceof ApiError && error.detail)
    return formatErrorDetail(error.detail);
  return null;
}

export function createSyncEngine(options: SyncEngineOptions): SyncEngine {
  const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;

  /** Where the engine comes to rest with nothing to do. `reset()` moves it. */
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

  /**
   * "Settled" means nothing further will happen on its own: no request in
   * flight, no timer armed. After a failure that is still true — the state
   * stays dirty and waits for `retry()`.
   */
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
    // Anything scheduled from here on marks the state dirty again, which queues
    // exactly one follow-up request no matter how many edits arrive.
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
            // Newer state arrived mid-flight: send it straight away so the
            // server always converges on the latest edit.
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
    // Anything already dispatched keeps going — the server should still receive
    // the last edit made under the old state — but it no longer reports back.
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
