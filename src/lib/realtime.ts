/**
 * The realtime wire format and the browser connector. Message types are shared
 * with the server via `server/types.ts` (type-only re-export) so the two
 * halves cannot drift.
 */
import type { EventDoc } from "./event";

export interface PresenceEntry {
  key: string;
  displayName: string;
}

export type RealtimeMessage =
  | { type: "event"; event: EventDoc }
  | { type: "presence"; people: PresenceEntry[] }
  | { type: "gone" }
  | { type: "saved" }
  /** `message` is the same text the REST PUT would have answered with. */
  | { type: "save-failed"; message: string }
  /** Terminal for this session; the close (`4410`) follows immediately. */
  | { type: "replaced" };

/** The only client→server frame, valid only over a named write session. */
export interface SaveMessage {
  type: "save";
  displayName: string;
  availability: string[];
  ifNeeded: string[];
}

export interface SavePayload {
  availability: string[];
  ifNeeded: string[];
}

/** Unrecognised frames yield null; the server drops them without closing. */
export function parseSaveMessage(data: unknown): SaveMessage | null {
  if (typeof data !== "string") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const { type, displayName, availability, ifNeeded } = parsed as Record<string, unknown>;
  if (type !== "save") return null;
  if (typeof displayName !== "string") return null;
  if (availability !== undefined && !Array.isArray(availability)) return null;
  if (ifNeeded !== undefined && !Array.isArray(ifNeeded)) return null;
  return {
    type: "save",
    displayName,
    availability: (availability ?? []) as string[],
    ifNeeded: (ifNeeded ?? []) as string[],
  };
}

// Application close codes (4000–4999): readable by the browser, which an HTTP
// status on a refused upgrade is not.
export const CLOSE_OCCUPIED = 4409;
export const CLOSE_REPLACED = 4410;

function isPresenceEntry(value: unknown): value is PresenceEntry {
  if (typeof value !== "object" || value === null) return false;
  const { key, displayName } = value as { key?: unknown; displayName?: unknown };
  return typeof key === "string" && key !== "" && typeof displayName === "string";
}

/** Unknown or malformed frames yield null and are dropped. */
export function parseRealtimeMessage(data: unknown): RealtimeMessage | null {
  if (typeof data !== "string") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const { type } = parsed as { type?: unknown };
  if (type === "gone") return { type: "gone" };
  if (type === "presence") {
    const { people } = parsed as { people?: unknown };
    if (!Array.isArray(people)) return null;
    // Advisory list: keep the entries that parsed rather than dropping the frame.
    return { type: "presence", people: people.filter(isPresenceEntry) };
  }
  if (type === "saved") return { type: "saved" };
  if (type === "replaced") return { type: "replaced" };
  if (type === "save-failed") {
    const { message } = parsed as { message?: unknown };
    return {
      type: "save-failed",
      message: typeof message === "string" && message ? message : "Could not save",
    };
  }
  if (type !== "event") return null;
  const { event } = parsed as { event?: unknown };
  if (typeof event !== "object" || event === null) return null;
  return { type: "event", event: event as EventDoc };
}

export const BASE_RETRY_MS = 1000;

export const MAX_RETRY_MS = 30_000;

/** Give up after this many straight failures — live updates may have been switched off server-side. */
export const MAX_FAILED_ATTEMPTS = 8;

/** Straight failures before `onDegraded(true)`; any successful open retracts it. */
export const DEGRADED_AFTER_FAILURES = 3;

/** Exponential backoff to a cap, ±25% jitter so a restart's reconnects spread out. */
export function retryDelay(attempt: number, jitter: number): number {
  const base = Math.min(BASE_RETRY_MS * 2 ** Math.max(0, attempt), MAX_RETRY_MS);
  return Math.round(base * (0.75 + 0.5 * jitter));
}

export type RealtimeEvent = MessageEvent | CloseEvent | Event;

/** Narrow slice of `WebSocket`, so a test double can satisfy it. */
export interface RealtimeSocket {
  addEventListener(type: string, listener: (event: RealtimeEvent) => void): void;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export interface RealtimeSession {
  /** `userKey(displayName)`; the socket path segment. */
  key: string;
  displayName: string;
}

/** `retryable` decides whether the caller should retry the same save over REST. */
export class RealtimeSaveError extends Error {
  retryable: boolean;

  constructor(message: string, retryable: boolean) {
    super(message);
    this.name = "RealtimeSaveError";
    this.retryable = retryable;
  }
}

/** Ack wait before a save is presumed lost and marked retryable. */
export const SAVE_TIMEOUT_MS = 15_000;

export interface RealtimeOptions {
  onEvent?: (event: EventDoc) => void;
  /** The room's whole list on each change; empty when the connection drops. */
  onPresence?: (people: PresenceEntry[]) => void;
  /** The event was deleted. Called once; the connector then stops for good. */
  onGone?: () => void;
  session?: RealtimeSession | null;
  /** The key is edited elsewhere; the connector has dropped to browsing. */
  onOccupied?: (session: RealtimeSession) => void;
  /** Somebody else took this key's session over. The page is now browsing. */
  onReplaced?: (session: RealtimeSession) => void;
  /** A write session opened and is accepting saves. */
  onSessionOpen?: (session: RealtimeSession) => void;
  /** Fired only on the transition; a stopped connector's `true` stands. */
  onDegraded?: (degraded: boolean) => void;
  /** Test seam: build the socket. Defaults to the global `WebSocket`. */
  createSocket?: (url: string) => RealtimeSocket;
  /** Test seam: the event's socket base, without the sub-path. */
  url?: string;
  /** Test seam: jitter source, in [0, 1). Defaults to `Math.random`. */
  random?: () => number;
  /** Test seam: how long a save waits for its ack. */
  saveTimeoutMs?: number;
}

export interface RealtimeHandle {
  /** Terminal; once true, `setSession` is a no-op. */
  readonly stopped: boolean;
  /** No-op when unchanged. `takeover` only ever answers a prior `onOccupied`. */
  setSession(
    session: RealtimeSession | null,
    options?: { takeover?: boolean },
  ): void;
  /** Null when there is no open write session — the caller's cue to PUT over REST. */
  save(payload: SavePayload): Promise<void> | null;
  /** Stops reconnecting and closes the socket. Idempotent. */
  close(): void;
}

/** A handle that does nothing, for the environments this cannot run in. */
const INERT: RealtimeHandle = {
  stopped: true,
  setSession() {},
  save() {
    return null;
  },
  close() {},
};

/** Null under SSR or without `WebSocket`: the page runs without realtime. */
function defaultUrl(eventId: string): string | null {
  if (typeof window === "undefined" || typeof WebSocket === "undefined") return null;
  const { protocol, host } = window.location;
  const scheme = protocol === "https:" ? "wss:" : "ws:";
  return `${scheme}//${host}/${encodeURIComponent(eventId)}`;
}

function sameSession(a: RealtimeSession | null, b: RealtimeSession | null): boolean {
  if (a === null || b === null) return a === b;
  return a.key === b.key && a.displayName === b.displayName;
}

function normalizeSession(session: RealtimeSession | null | undefined): RealtimeSession | null {
  if (!session) return null;
  const key = session.key.trim();
  if (!key) return null;
  return { key, displayName: session.displayName };
}

/** Identity rides in the handshake, so a key is claimed in exactly one place. */
function urlFor(base: string, session: RealtimeSession | null, takeover: boolean): string {
  if (session === null) return `${base}/ws`;
  const query = new URLSearchParams({ name: session.displayName });
  if (takeover) query.set("takeover", "1");
  return `${base}/users/${encodeURIComponent(session.key)}?${query.toString()}`;
}

/**
 * Subscribes to an event's updates. Silent by design: connection state never
 * surfaces in the UI, and everything degrades to the REST-only app.
 */
export function connectRealtime(
  eventId: string,
  options: RealtimeOptions = {},
): RealtimeHandle {
  const resolved = options.url ?? defaultUrl(eventId);
  if (resolved === null) return INERT;
  const base: string = resolved;

  const create =
    options.createSocket ?? ((target: string): RealtimeSocket => new WebSocket(target));
  const random = options.random ?? Math.random;
  const saveTimeoutMs = options.saveTimeoutMs ?? SAVE_TIMEOUT_MS;

  let session = normalizeSession(options.session);
  /** Set for exactly one connection attempt. */
  let takeover = false;
  let socket: RealtimeSocket | null = null;
  let sessionOpen = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let attempt = 0;
  let failures = 0;
  let degraded = false;
  let stopped = false;

  // A queue of one in practice; FIFO matching so a stray ack can never strand
  // the autosave engine in "syncing".
  let pendingSaves: Array<{
    resolve: () => void;
    reject: (error: RealtimeSaveError) => void;
    timer: ReturnType<typeof setTimeout>;
  }> = [];

  function settleHead(outcome: (entry: (typeof pendingSaves)[number]) => void): void {
    const entry = pendingSaves.shift();
    if (!entry) return;
    clearTimeout(entry.timer);
    outcome(entry);
  }

  function failAllSaves(message: string, retryable: boolean): void {
    const waiting = pendingSaves;
    pendingSaves = [];
    for (const entry of waiting) {
      clearTimeout(entry.timer);
      entry.reject(new RealtimeSaveError(message, retryable));
    }
  }

  function open(): void {
    if (stopped) return;
    const claimed = session;
    const claiming = takeover;
    let current: RealtimeSocket;
    try {
      current = create(urlFor(base, claimed, claiming));
    } catch {
      // A throwing constructor (blocked mixed-content, say) is a failed attempt.
      retry();
      return;
    }
    socket = current;
    sessionOpen = false;

    current.addEventListener("open", () => {
      if (socket !== current) return;
      attempt = 0;
      failures = 0;
      if (degraded) {
        degraded = false;
        options.onDegraded?.(false);
      }
      // Takeover is spent on one attempt, so a reconnect never silently evicts anybody.
      takeover = false;
      if (claimed === null) return;
      sessionOpen = true;
      options.onSessionOpen?.(claimed);
    });

    current.addEventListener("message", (event: RealtimeEvent) => {
      if (stopped || socket !== current) return;
      const message = parseRealtimeMessage((event as MessageEvent).data);
      if (message === null) return;
      if (message.type === "gone") {
        stopped = true;
        clearTimer();
        socket = null;
        sessionOpen = false;
        failAllSaves("This event was deleted", false);
        current.close();
        options.onGone?.();
        return;
      }
      if (message.type === "presence") {
        options.onPresence?.(message.people);
        return;
      }
      if (message.type === "saved") {
        settleHead((entry) => entry.resolve());
        return;
      }
      if (message.type === "save-failed") {
        // Same validator as the REST PUT; retrying over REST would fail identically.
        settleHead((entry) =>
          entry.reject(new RealtimeSaveError(message.message, false)),
        );
        return;
      }
      if (message.type === "replaced") {
        // The close (4410) follows; dropping to browse now makes the close
        // handler reconnect as a watcher rather than fight for the session.
        const lost = claimed;
        session = null;
        takeover = false;
        sessionOpen = false;
        failAllSaves("Your editing session was taken over", true);
        if (lost) options.onReplaced?.(lost);
        return;
      }
      options.onEvent?.(message.event);
    });

    // A socket that errors also closes; the empty handler only keeps some
    // environments from reporting an unhandled event.
    current.addEventListener("error", () => {});

    current.addEventListener("close", (event: RealtimeEvent) => {
      if (stopped || socket !== current) return;
      socket = null;
      sessionOpen = false;
      const code = (event as CloseEvent | undefined)?.code;
      failAllSaves("The connection dropped before the save landed", true);
      options.onPresence?.([]);

      if (code === CLOSE_OCCUPIED && claimed !== null) {
        // Refused, not failed: neither counter moves. Watch instead and let
        // the page decide whether to take the session over.
        session = null;
        takeover = false;
        options.onOccupied?.(claimed);
        open();
        return;
      }
      if (code === CLOSE_REPLACED) {
        // The `replaced` frame did the work; reconnect as a watcher straight away.
        session = null;
        takeover = false;
        open();
        return;
      }
      retry();
    });
  }

  function retry(): void {
    if (stopped || timer !== null) return;
    failures += 1;
    if (!degraded && failures >= DEGRADED_AFTER_FAILURES) {
      degraded = true;
      options.onDegraded?.(true);
    }
    if (failures >= MAX_FAILED_ATTEMPTS) {
      // Most likely live updates were switched off; stop rather than knock forever.
      stopped = true;
      return;
    }
    const delay = retryDelay(attempt, random());
    attempt += 1;
    timer = setTimeout(() => {
      timer = null;
      open();
    }, delay);
  }

  function clearTimer(): void {
    if (timer === null) return;
    clearTimeout(timer);
    timer = null;
  }

  /** Drops the current socket without letting its close handler act on it. */
  function reconnect(): void {
    clearTimer();
    attempt = 0;
    failures = 0;
    const current = socket;
    socket = null;
    sessionOpen = false;
    failAllSaves("The editing session changed before the save landed", true);
    current?.close();
    open();
  }

  open();

  return {
    get stopped() {
      return stopped;
    },
    setSession(next: RealtimeSession | null, opts?: { takeover?: boolean }) {
      const value = normalizeSession(next);
      const wantsTakeover = opts?.takeover === true;
      if (stopped) return;
      if (sameSession(value, session) && !wantsTakeover) return;
      session = value;
      takeover = wantsTakeover && value !== null;
      // Immediately, not on the backoff schedule: a deliberate switch, not a failure.
      reconnect();
    },
    save(payload: SavePayload): Promise<void> | null {
      const claimed = session;
      const current = socket;
      if (stopped || claimed === null || current === null || !sessionOpen) return null;
      const frame: SaveMessage = {
        type: "save",
        displayName: claimed.displayName,
        availability: payload.availability,
        ifNeeded: payload.ifNeeded,
      };
      return new Promise<void>((resolve, reject) => {
        const entry = {
          resolve,
          reject,
          timer: setTimeout(() => {
            pendingSaves = pendingSaves.filter((other) => other !== entry);
            reject(
              new RealtimeSaveError("The server did not acknowledge the save", true),
            );
          }, saveTimeoutMs),
        };
        // Queued before the frame goes out: a test double may ack synchronously inside send().
        pendingSaves.push(entry);
        try {
          current.send(JSON.stringify(frame));
        } catch {
          pendingSaves = pendingSaves.filter((other) => other !== entry);
          clearTimeout(entry.timer);
          reject(new RealtimeSaveError("The socket would not take the save", true));
        }
      });
    },
    close() {
      if (stopped) return;
      stopped = true;
      clearTimer();
      sessionOpen = false;
      failAllSaves("The page stopped listening", true);
      const current = socket;
      socket = null;
      current?.close();
    },
  };
}
