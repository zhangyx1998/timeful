/**
 * The realtime channel: the wire format, and the browser half of it.
 *
 * A page holding an event open subscribes to `GET /api/events/:idOrSlug/ws` and
 * is pushed a **full event snapshot** whenever anything about that event
 * changes — someone answered, someone was removed, the owner renamed it. No
 * deltas: the snapshot is byte-for-byte what `GET /api/events/:idOrSlug` would
 * return, so it flows through exactly the path a refresh already takes and
 * there is no second way for the page to be wrong.
 *
 * **The socket is read-only.** It carries server→client notifications and
 * nothing else. Every write in the app still goes through the REST API, and the
 * server ignores anything a client sends down this pipe (see server/realtime.ts).
 * That is what keeps this a pure enhancement: with the event's live updates
 * switched off, the server-wide switch off, the connection refused, or the
 * network gone, the page is exactly the app it was before — the same REST
 * calls, the same features, one fewer courtesy.
 *
 * The message types are shared with the server through `server/types.ts`, which
 * re-exports them type-only, so the two halves cannot drift.
 */
import type { EventDoc } from "./event";

/**
 * What the server pushes.
 *
 * - `event`    — the current state of the event, fully hydrated.
 * - `presence` — who is looking at this event right now, by the name each of
 *                them adopted. Sorted, deduped, and never persisted anywhere.
 * - `gone`     — the event was deleted. Terminal: nothing further is coming and
 *                the client stops reconnecting.
 */
export type RealtimeMessage =
  | { type: "event"; event: EventDoc }
  | { type: "presence"; names: string[] }
  | { type: "gone" };

/**
 * Parses a frame off the wire. Anything unrecognised — a truncated payload, a
 * message type from a newer server, a binary frame — yields null and is
 * dropped, so an unknown message can never be worse than no message at all.
 */
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
    const { names } = parsed as { names?: unknown };
    if (!Array.isArray(names)) return null;
    // A single bad entry does not cost the frame: the list is advisory, and
    // showing the names that did parse beats showing none of them.
    return { type: "presence", names: names.filter((n): n is string => typeof n === "string") };
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
 * The slice of `WebSocket` this module uses. Narrow on purpose: it is what a
 * test double has to implement, and `WebSocket` itself satisfies it.
 */
export interface RealtimeSocket {
  addEventListener(type: string, listener: (event: MessageEvent) => void): void;
  close(code?: number, reason?: string): void;
}

export interface RealtimeOptions {
  /** A fresh snapshot arrived. */
  onEvent?: (event: EventDoc) => void;
  /**
   * Who else is looking at this event. Called with the room's whole list every
   * time it changes, and with an empty one when the connection drops — a page
   * that is no longer being told cannot keep claiming anyone is there.
   */
  onPresence?: (names: string[]) => void;
  /** The event was deleted. Called once; the connector then stops for good. */
  onGone?: () => void;
  /**
   * The name this page has adopted, announced in the upgrade URL so the rest of
   * the room can see it. Absent for a visitor who is only browsing.
   */
  name?: string | null;
  /** Test seam: build the socket. Defaults to the global `WebSocket`. */
  createSocket?: (url: string) => RealtimeSocket;
  /** Test seam: the URL to open. Defaults to one derived from `location`. */
  url?: string;
  /** Test seam: jitter source, in [0, 1). Defaults to `Math.random`. */
  random?: () => number;
}

export interface RealtimeHandle {
  /**
   * Announces a new identity, reconnecting under it. A no-op when the name has
   * not actually changed, so it is safe to call on every identity event.
   */
  setName(name: string | null): void;
  /** Stops reconnecting and closes the socket. Idempotent. */
  close(): void;
}

/** A handle that does nothing, for the environments this cannot run in. */
const INERT: RealtimeHandle = { setName() {}, close() {} };

/**
 * The socket URL for an event, or null where there is no socket to open.
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
  return `${scheme}//${host}/api/events/${encodeURIComponent(eventId)}/ws`;
}

/** An empty name and no name are the same thing: a page that is browsing. */
function normalizeName(name: string | null | undefined): string | null {
  const trimmed = name?.trim();
  return trimmed ? trimmed : null;
}

/**
 * The URL for one identity.
 *
 * The name rides in the handshake rather than in a frame, which is what lets
 * presence exist without giving the socket an inbound path: there is nothing to
 * receive, so there is still no `message` listener on the server side.
 */
function urlFor(base: string, name: string | null): string {
  if (name === null) return base;
  return `${base}?name=${encodeURIComponent(name)}`;
}

/**
 * Subscribes to an event's updates for as long as the returned handle is open.
 *
 * Silent by design: there is no connection indicator anywhere in the UI. A page
 * whose socket never opened, or dropped and is waiting to retry, looks and
 * behaves exactly like one that never had a socket — which is the only way an
 * optional channel can be optional.
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

  /** The identity every connection from here announces, until it changes. */
  let name = normalizeName(options.name);
  let socket: RealtimeSocket | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  /** Consecutive failed attempts; zeroed the moment a connection opens. */
  let attempt = 0;
  /** The same count, against `MAX_FAILED_ATTEMPTS` rather than the schedule. */
  let failures = 0;
  /** Set by `close()` and by `gone`. Both are final. */
  let stopped = false;

  function open(): void {
    if (stopped) return;
    let current: RealtimeSocket;
    try {
      current = create(urlFor(base, name));
    } catch {
      // A constructor that throws (a blocked mixed-content upgrade, say) is a
      // failed attempt like any other, not an exception for the caller.
      retry();
      return;
    }
    socket = current;

    current.addEventListener("open", () => {
      // Reaching the server resets both counters: the next outage starts its
      // own backoff at 1s rather than inheriting the last one's ceiling, and
      // gets the full budget of attempts again.
      attempt = 0;
      failures = 0;
    });

    current.addEventListener("message", (event: MessageEvent) => {
      if (stopped) return;
      const message = parseRealtimeMessage(event.data);
      if (message === null) return;
      if (message.type === "gone") {
        // Terminal: the event is not coming back, so neither are we.
        stopped = true;
        clearTimer();
        socket = null;
        current.close();
        options.onGone?.();
        return;
      }
      if (message.type === "presence") {
        options.onPresence?.(message.names);
        return;
      }
      options.onEvent?.(message.event);
    });

    // `error` needs no handler of its own: a socket that errors also closes,
    // and the close is where the retry belongs. Registering one anyway keeps
    // the failure from surfacing as an unhandled event in some environments.
    current.addEventListener("error", () => {});

    current.addEventListener("close", () => {
      if (stopped || socket !== current) return;
      socket = null;
      // Nobody is telling this page who is here any more, so it stops saying.
      // Stale dots beside a name are worse than none: they claim something the
      // page has no way to know is still true.
      options.onPresence?.([]);
      retry();
    });
  }

  function retry(): void {
    if (stopped || timer !== null) return;
    failures += 1;
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

  open();

  return {
    setName(next: string | null) {
      const value = normalizeName(next);
      if (stopped || value === name) return;
      name = value;
      // Straight away rather than on the backoff schedule: the switch is a
      // deliberate act by somebody who is watching the list, and the room
      // cannot learn about it any other way. Both counters reset with it — this
      // is a new connection attempt on purpose, not a recovery from a failure.
      clearTimer();
      attempt = 0;
      failures = 0;
      const current = socket;
      // Dropped from the connector before it is closed, so its own `close`
      // handler sees a socket that no longer speaks here and leaves the
      // reconnect — and the presence it would have cleared — alone.
      socket = null;
      current?.close();
      open();
    },
    close() {
      if (stopped) return;
      stopped = true;
      clearTimer();
      const current = socket;
      socket = null;
      current?.close();
    },
  };
}
