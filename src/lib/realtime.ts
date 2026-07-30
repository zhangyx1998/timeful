/**
 * The realtime channel: the wire format, and the browser half of it.
 *
 * A page holding an event open is pushed a **full event snapshot** whenever
 * anything about that event changes — someone answered, someone was removed,
 * the owner renamed it. No deltas: the snapshot is byte-for-byte what
 * `GET /<slug>/data` would return, so it flows through exactly the path a
 * refresh already takes and there is no second way for the page to be wrong.
 *
 * There are **two sockets**, and which one a page holds is decided by whether
 * it has adopted a name:
 *
 * - `GET /<slug>/ws` — the browse socket. Read-only in the strictest sense:
 *   the server registers no `message` listener on it at all, so nothing a
 *   client sends down it reaches any state. A page that is only looking holds
 *   this one, and it contributes nothing to presence.
 * - `GET /<slug>/users/<userKey>` — the **named write session**. This socket
 *   *is* the edit session for that key: it carries the page's saves up as well
 *   as the room's snapshots down, and there may be only one of it per key per
 *   event. A second one is refused (`4409`) unless it asks to take over, in
 *   which case the first is told `replaced` and closed (`4410`).
 *
 * Writes over the session socket are a **sanctioned exception** to "REST is
 * the only write path", and only that: they are validated by the same code the
 * REST `PUT` runs, and the REST `PUT` stays fully functional as the write API
 * whenever there is no session — realtime switched off at either level, the
 * connection refused, the network gone. Everything degrades to the app it was
 * before this file existed, with zero feature loss.
 *
 * The message types are shared with the server through `server/types.ts`, which
 * re-exports them type-only, so the two halves cannot drift.
 */
import type { EventDoc } from "./event";

/** One person in a room: the key that identifies them, the name to show. */
export interface PresenceEntry {
  key: string;
  displayName: string;
}

/**
 * What the server pushes.
 *
 * - `event`    — the current state of the event, fully hydrated.
 * - `presence` — who holds a write session on this event right now, by key,
 *                with the name to render beside it. Sorted, deduped, and never
 *                persisted anywhere.
 * - `gone`     — the event was deleted. Terminal: nothing further is coming and
 *                the client stops reconnecting.
 */
export type RealtimeMessage =
  | { type: "event"; event: EventDoc }
  | { type: "presence"; people: PresenceEntry[] }
  | { type: "gone" }
  /** One `save` frame landed. The autosave engine's success signal. */
  | { type: "saved" }
  /** One `save` frame was refused; `message` is the same text the REST PUT
   *  would have answered with. */
  | { type: "save-failed"; message: string }
  /** Another window took this key's write session. Terminal for this session;
   *  the close (`4410`) follows immediately. */
  | { type: "replaced" };

/** The one thing a client may send, and only over a named write session. */
export interface SaveMessage {
  type: "save";
  displayName: string;
  availability: string[];
  ifNeeded: string[];
}

/** What one save carries, beyond the identity the socket already fixed. */
export interface SavePayload {
  availability: string[];
  ifNeeded: string[];
}

/**
 * Parses a client frame. Anything else — a stray text frame, a message type
 * from a newer client, an availability array that is not one — yields null,
 * and the server drops it without closing the socket.
 */
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

/**
 * Close codes the named write session uses.
 *
 * Both are in the 4000–4999 range the protocol reserves for the application,
 * and both are readable by the browser — which an HTTP status on a refused
 * upgrade is not, and is why the handshake completes before either is sent.
 */
export const CLOSE_OCCUPIED = 4409;
export const CLOSE_REPLACED = 4410;

/**
 * Parses a frame off the wire. Anything unrecognised — a truncated payload, a
 * message type from a newer server, a binary frame — yields null and is
 * dropped, so an unknown message can never be worse than no message at all.
 */
function isPresenceEntry(value: unknown): value is PresenceEntry {
  if (typeof value !== "object" || value === null) return false;
  const { key, displayName } = value as { key?: unknown; displayName?: unknown };
  return typeof key === "string" && key !== "" && typeof displayName === "string";
}

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
    // A single bad entry does not cost the frame: the list is advisory, and
    // showing the people who did parse beats showing none of them.
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

// ---------------------------------------------------------------------------
// backoff
// ---------------------------------------------------------------------------

/** First reconnect wait, doubling from here. */
export const BASE_RETRY_MS = 1000;

/** Ceiling on the reconnect wait. A tab left open all day sits here. */
export const MAX_RETRY_MS = 30_000;

/**
 * Consecutive attempts that never connected before the page stops trying.
 *
 * An event can have live updates switched off while a page is watching it: the
 * server hangs up and then refuses every reconnection. Backoff alone would
 * leave that page knocking every 30 seconds for as long as it stayed open, so
 * the connector gives up instead. Any successful open resets the count, and at
 * the current schedule eight failures span about two minutes — long enough to
 * ride out a restart, short enough not to be a background hum. The cost of
 * being wrong is a page that has to be reloaded to get live updates back,
 * which is the behaviour it would have had without them at all.
 */
export const MAX_FAILED_ATTEMPTS = 8;

/**
 * Consecutive failed attempts before the connector says so out loud.
 *
 * The channel is silent by design — one dropped connection and the reconnect
 * a second later must never surface anywhere. But a connection that keeps
 * failing is a page quietly going stale, and the reader deserves a sentence
 * about it. Three straight failures is past every ordinary blip (the first
 * two retries land within about three seconds) while still early enough that
 * the notice appears long before the connector gives up for good; any
 * successful open withdraws it. The cost of showing it during a slow server
 * restart is a true sentence — live updates really are down — that retracts
 * itself the moment the reconnect lands.
 */
export const DEGRADED_AFTER_FAILURES = 3;

/**
 * How long to wait before reconnect attempt number `attempt` (0-based).
 *
 * Doubles to a cap — 1s, 2s, 4s … 30s — and then spreads each wait over
 * ±25% of it. The jitter is the point of the exercise: a server restart drops
 * every open page at the same instant, and without it they would all come back
 * at the same instant too, and again on the next attempt.
 */
export function retryDelay(attempt: number, jitter: number): number {
  const base = Math.min(BASE_RETRY_MS * 2 ** Math.max(0, attempt), MAX_RETRY_MS);
  return Math.round(base * (0.75 + 0.5 * jitter));
}

// ---------------------------------------------------------------------------
// the connector
// ---------------------------------------------------------------------------

/**
 * The slice of a socket event this module reads. `MessageEvent` carries `data`,
 * `CloseEvent` carries `code`, and the connector asks for whichever it needs.
 */
export type RealtimeEvent = MessageEvent | CloseEvent | Event;

/**
 * The slice of `WebSocket` this module uses. Narrow on purpose: it is what a
 * test double has to implement, and `WebSocket` itself satisfies it.
 */
export interface RealtimeSocket {
  addEventListener(type: string, listener: (event: RealtimeEvent) => void): void;
  /** Only ever called on a named write session; a browse socket never sends. */
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

/** Who this page is editing as. Both halves matter: one matches, one renders. */
export interface RealtimeSession {
  /** `userKey(displayName)`; the path segment, and the room's identity for it. */
  key: string;
  /** Exactly what the guest typed. Announced so the room can render it. */
  displayName: string;
}

/**
 * Why a save over the socket did not land.
 *
 * `retryable` is the only interesting bit, and it decides one thing: whether
 * the caller should try the same save over REST instead. A dropped connection
 * is retryable and REST will very likely work; a payload the server refused is
 * not, because REST runs the identical validator and would refuse it again.
 */
export class RealtimeSaveError extends Error {
  retryable: boolean;

  constructor(message: string, retryable: boolean) {
    super(message);
    this.name = "RealtimeSaveError";
    this.retryable = retryable;
  }
}

/**
 * How long a save waits for its `saved` before the transport is presumed lost.
 *
 * Not a correctness bound — a lost ack is already an anomaly — but the engine
 * must not sit in "syncing" forever if one goes missing. Timing out marks the
 * save retryable, so it goes out over REST and the page catches up.
 */
export const SAVE_TIMEOUT_MS = 15_000;

export interface RealtimeOptions {
  /** A fresh snapshot arrived. */
  onEvent?: (event: EventDoc) => void;
  /**
   * Who holds a write session on this event. Called with the room's whole list
   * every time it changes, and with an empty one when the connection drops — a
   * page that is no longer being told cannot keep claiming anyone is there.
   */
  onPresence?: (people: PresenceEntry[]) => void;
  /** The event was deleted. Called once; the connector then stops for good. */
  onGone?: () => void;
  /**
   * The write session this page is claiming. Absent for a visitor who is only
   * browsing, which is also what the connector falls back to when a claim is
   * refused or taken away.
   */
  session?: RealtimeSession | null;
  /**
   * The key is already being edited somewhere else and this page did not ask
   * to take it over. The connector has dropped to the browse socket; whether to
   * ask again with `takeover` is the page's decision, not this module's.
   */
  onOccupied?: (session: RealtimeSession) => void;
  /** Somebody else took this key's session over. The page is now browsing. */
  onReplaced?: (session: RealtimeSession) => void;
  /** A write session opened and is accepting saves. */
  onSessionOpen?: (session: RealtimeSession) => void;
  /**
   * The connection has been failing long enough to be worth a sentence
   * (`true`), or came back after saying so (`false`).
   *
   * Fired only on the transition, `true` after `DEGRADED_AFTER_FAILURES`
   * consecutive failed attempts and `false` on the next successful open — so
   * a single dropped connection and its quick reconnect fire nothing at all.
   * Once the connector gives up (`MAX_FAILED_ATTEMPTS`) the `true` already
   * fired stands, and nothing retracts it short of a reload: that is exactly
   * the state the callback exists to report.
   */
  onDegraded?: (degraded: boolean) => void;
  /** Test seam: build the socket. Defaults to the global `WebSocket`. */
  createSocket?: (url: string) => RealtimeSocket;
  /**
   * Test seam: the event's socket base, without the sub-path — `/ws` and
   * `/users/<key>` are appended to it. Defaults to one derived from `location`.
   */
  url?: string;
  /** Test seam: jitter source, in [0, 1). Defaults to `Math.random`. */
  random?: () => number;
  /** Test seam: how long a save waits for its ack. */
  saveTimeoutMs?: number;
}

export interface RealtimeHandle {
  /**
   * Claims a write session, gives one up (`null`), or switches to another. A
   * no-op when nothing has actually changed, so it is safe to call on every
   * identity event.
   *
   * `takeover` is the answer to a previous `onOccupied`: it asks the server to
   * evict whoever holds the key. Nothing else ever sets it — a page never takes
   * a session away from another one without being told to.
   */
  setSession(
    session: RealtimeSession | null,
    options?: { takeover?: boolean },
  ): void;
  /**
   * Sends one save over the open write session.
   *
   * Returns **null** when there is no session to send it over — no socket, a
   * browse socket, or one that has not opened — which is the caller's signal to
   * use the REST `PUT` instead. Otherwise a promise that settles when the
   * server acknowledges, rejecting with a `RealtimeSaveError`.
   */
  save(payload: SavePayload): Promise<void> | null;
  /** Stops reconnecting and closes the socket. Idempotent. */
  close(): void;
}

/** A handle that does nothing, for the environments this cannot run in. */
const INERT: RealtimeHandle = {
  setSession() {},
  save() {
    return null;
  },
  close() {},
};

/**
 * The socket base for an event, or null where there is no socket to open.
 *
 * Null is the SSR answer — `render()` runs in Node, where there is no `window`
 * and opening a connection per rendered page would be a denial of service
 * against ourselves — and also the answer for a browser old enough to lack
 * `WebSocket`. Both land on the same place: the page runs without realtime.
 */
function defaultUrl(eventId: string): string | null {
  if (typeof window === "undefined" || typeof WebSocket === "undefined") return null;
  const { protocol, host } = window.location;
  const scheme = protocol === "https:" ? "wss:" : "ws:";
  return `${scheme}//${host}/${encodeURIComponent(eventId)}`;
}

/** Two sessions are the same claim when both halves of them match. */
function sameSession(a: RealtimeSession | null, b: RealtimeSession | null): boolean {
  if (a === null || b === null) return a === b;
  return a.key === b.key && a.displayName === b.displayName;
}

/** An empty key is no session at all: a page that is browsing. */
function normalizeSession(session: RealtimeSession | null | undefined): RealtimeSession | null {
  if (!session) return null;
  const key = session.key.trim();
  if (!key) return null;
  return { key, displayName: session.displayName };
}

/**
 * The URL for one connection.
 *
 * The identity rides in the handshake rather than in a frame, which is what
 * makes the session a property of the connection: there is exactly one place
 * a key can be claimed, and it is the only place the server can refuse it.
 */
function urlFor(base: string, session: RealtimeSession | null, takeover: boolean): string {
  if (session === null) return `${base}/ws`;
  const query = new URLSearchParams({ name: session.displayName });
  if (takeover) query.set("takeover", "1");
  return `${base}/users/${encodeURIComponent(session.key)}?${query.toString()}`;
}

/**
 * Subscribes to an event's updates for as long as the returned handle is open,
 * holding a write session for the adopted identity while there is one.
 *
 * Silent by design: there is no connection indicator anywhere in the UI. A page
 * whose socket never opened, or dropped and is waiting to retry, looks and
 * behaves exactly like one that never had a socket — which is the only way an
 * optional channel can be optional. The two dialogs this can raise are the
 * exception that proves it: they are about somebody *else* having the edit
 * session, which is a fact about the group and not about the network.
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

  /** The claim every connection from here makes, until it changes. */
  let session = normalizeSession(options.session);
  /** Set for exactly one connection attempt, by an answered `onOccupied`. */
  let takeover = false;
  let socket: RealtimeSocket | null = null;
  /** True once the current socket is a session socket that has opened. */
  let sessionOpen = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  /** Consecutive failed attempts; zeroed the moment a connection opens. */
  let attempt = 0;
  /** The same count, against `MAX_FAILED_ATTEMPTS` rather than the schedule. */
  let failures = 0;
  /** Whether `onDegraded(true)` has been said and not yet taken back. */
  let degraded = false;
  /** Set by `close()` and by `gone`. Both are final. */
  let stopped = false;

  /**
   * Saves sent and not yet acknowledged, oldest first.
   *
   * The autosave engine keeps at most one request in flight, so this is a queue
   * of one in practice and FIFO matching is exact. It exists as a queue anyway
   * because the alternative — dropping an ack on the floor if two ever overlap
   * — would leave the engine stuck in "syncing" with no way out.
   */
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

  /** Every save still waiting gives up, and says whether REST should try. */
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
      // A constructor that throws (a blocked mixed-content upgrade, say) is a
      // failed attempt like any other, not an exception for the caller.
      retry();
      return;
    }
    socket = current;
    sessionOpen = false;

    current.addEventListener("open", () => {
      if (socket !== current) return;
      // Reaching the server resets both counters: the next outage starts its
      // own backoff at 1s rather than inheriting the last one's ceiling, and
      // gets the full budget of attempts again.
      attempt = 0;
      failures = 0;
      // And takes back anything said about the connection being down. Only an
      // open does: a session switch resets the counters too, but resetting a
      // count is not the same as the server answering.
      if (degraded) {
        degraded = false;
        options.onDegraded?.(false);
      }
      // The takeover was for this one attempt. Spent whether or not it was
      // needed, so a later reconnect never silently evicts anybody.
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
        // Terminal: the event is not coming back, so neither are we.
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
        // The server ran the same validator REST would have. Sending it again
        // over REST would fail identically, so this is the guest's problem to
        // see rather than the transport's to work around.
        settleHead((entry) =>
          entry.reject(new RealtimeSaveError(message.message, false)),
        );
        return;
      }
      if (message.type === "replaced") {
        // Somebody else claimed this key. The close (4410) is right behind
        // this frame; dropping to browse here means the close handler
        // reconnects as a watcher rather than fighting for the session back.
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

    // `error` needs no handler of its own: a socket that errors also closes,
    // and the close is where the retry belongs. Registering one anyway keeps
    // the failure from surfacing as an unhandled event in some environments.
    current.addEventListener("error", () => {});

    current.addEventListener("close", (event: RealtimeEvent) => {
      if (stopped || socket !== current) return;
      socket = null;
      sessionOpen = false;
      const code = (event as CloseEvent | undefined)?.code;
      failAllSaves("The connection dropped before the save landed", true);
      // Nobody is telling this page who is here any more, so it stops saying.
      // Stale dots beside a name are worse than none: they claim something the
      // page has no way to know is still true.
      options.onPresence?.([]);

      if (code === CLOSE_OCCUPIED && claimed !== null) {
        // Refused, not failed: somebody is editing as this key. Watch the event
        // instead and let the page ask whether to take the session away. Not a
        // failed attempt, so neither counter moves.
        session = null;
        takeover = false;
        options.onOccupied?.(claimed);
        open();
        return;
      }
      if (code === CLOSE_REPLACED) {
        // The `replaced` frame did the work; this is only its close. Come back
        // as a watcher straight away rather than on the backoff schedule.
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
    // Enough straight failures to say so — once, on the way past the
    // threshold. A run that goes on to exhaust the budget below has already
    // said everything there is to say.
    if (!degraded && failures >= DEGRADED_AFTER_FAILURES) {
      degraded = true;
      options.onDegraded?.(true);
    }
    if (failures >= MAX_FAILED_ATTEMPTS) {
      // Nothing here is coming back on its own — most likely this event's live
      // updates were switched off. Stop rather than knock forever.
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
    // Dropped from the connector before it is closed, so its own `close`
    // handler sees a socket that no longer speaks here and leaves the
    // reconnect — and the presence it would have cleared — alone.
    socket = null;
    sessionOpen = false;
    failAllSaves("The editing session changed before the save landed", true);
    current?.close();
    open();
  }

  open();

  return {
    setSession(next: RealtimeSession | null, opts?: { takeover?: boolean }) {
      const value = normalizeSession(next);
      const wantsTakeover = opts?.takeover === true;
      if (stopped) return;
      if (sameSession(value, session) && !wantsTakeover) return;
      session = value;
      takeover = wantsTakeover && value !== null;
      // Straight away rather than on the backoff schedule: the switch is a
      // deliberate act by somebody who is watching the list, and the room
      // cannot learn about it any other way. Both counters reset with it — this
      // is a new connection attempt on purpose, not a recovery from a failure.
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
        // Queued *before* the frame goes out. A promise executor runs
        // synchronously, but an ack does not have to arrive asynchronously —
        // a test double answers inside `send()` — and an ack with nothing
        // waiting for it would be dropped and leave the engine syncing.
        pendingSaves.push(entry);
        try {
          current.send(JSON.stringify(frame));
        } catch {
          pendingSaves = pendingSaves.filter((other) => other !== entry);
          clearTimeout(entry.timer);
          // Retryable: the socket went between the check and the send, and the
          // REST PUT is right there.
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
