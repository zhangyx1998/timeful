/**
 * The browser half of the realtime channel.
 *
 * What matters about a connector nobody can see is that it never becomes
 * visible: it must not spin, must not reconnect forever after the thing it was
 * watching is gone, must not run at all where there is no browser, and must
 * survive anything arriving on the wire without taking the page down with it.
 * All of that is timing and dispatch, so it is tested against a fake socket and
 * fake timers rather than a server.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BASE_RETRY_MS,
  connectRealtime,
  MAX_RETRY_MS,
  parseRealtimeMessage,
  retryDelay,
  type RealtimeSocket,
} from "./realtime";
import type { EventDoc } from "./event";

const EVENT = {
  id: "1614943a-fb98-4853-9df9-feba252c78ad",
  slug: "eOlSuRgws3kv",
  name: "Realtime Check",
  type: "specific_dates",
  dates: ["2026-08-03T00:00:00.000Z"],
  duration: 8,
  timeIncrement: 30,
  startOnMonday: true,
  createdAt: "2026-07-28T00:00:00.000Z",
  updatedAt: "2026-07-28T00:00:00.000Z",
  responses: {},
} satisfies EventDoc;

/** Every socket the connector has asked for, in order. */
let sockets: FakeSocket[] = [];

/** A `RealtimeSocket` the test drives by hand. */
class FakeSocket implements RealtimeSocket {
  readonly url: string;
  closed = false;
  private listeners = new Map<string, ((event: MessageEvent) => void)[]>();

  // A parameter property would be neater and is not allowed: the repo compiles
  // under `erasableSyntaxOnly`, and that one has a runtime effect.
  constructor(url: string) {
    this.url = url;
    sockets.push(this);
  }

  addEventListener(type: string, listener: (event: MessageEvent) => void): void {
    const existing = this.listeners.get(type) ?? [];
    existing.push(listener);
    this.listeners.set(type, existing);
  }

  close(): void {
    this.closed = true;
  }

  private emit(type: string, event: MessageEvent): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  /** The connection came up. */
  opened(): void {
    this.emit("open", new MessageEvent("open"));
  }

  /** A frame arrived. */
  delivers(data: unknown): void {
    this.emit("message", new MessageEvent("message", { data }));
  }

  /** The connection went away, for whatever reason. */
  dropped(): void {
    this.emit("close", new MessageEvent("close"));
  }
}

const URL_FOR_TESTS = "ws://localhost/api/events/e/ws";

/** Connects with every seam filled in: fixed URL, fake socket, no jitter. */
function connect(options: Parameters<typeof connectRealtime>[1] = {}) {
  return connectRealtime("e", {
    url: URL_FOR_TESTS,
    createSocket: (url: string) => new FakeSocket(url),
    random: () => 0.5,
    ...options,
  });
}

/** The socket the connector is currently using. */
function latest(): FakeSocket {
  const socket = sockets[sockets.length - 1];
  if (!socket) throw new Error("no socket was opened");
  return socket;
}

afterEach(() => {
  sockets = [];
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// the wire format
// ---------------------------------------------------------------------------

describe("parseRealtimeMessage", () => {
  it("reads the two messages the server sends", () => {
    expect(parseRealtimeMessage(JSON.stringify({ type: "gone" }))).toEqual({
      type: "gone",
    });
    expect(
      parseRealtimeMessage(JSON.stringify({ type: "event", event: EVENT })),
    ).toEqual({ type: "event", event: EVENT });
  });

  it("drops anything it cannot make sense of", () => {
    // A dropped frame is only ever as bad as no frame at all, so everything
    // unrecognised — a binary frame, a truncated payload, a message type from
    // a newer server, an `event` that is not one — lands on null.
    for (const input of [
      "not json",
      "",
      "null",
      "[1,2,3]",
      new ArrayBuffer(4),
      JSON.stringify({ type: "something-new" }),
      JSON.stringify({ type: "event" }),
      JSON.stringify({ type: "event", event: "nope" }),
    ]) {
      expect(parseRealtimeMessage(input)).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// backoff
// ---------------------------------------------------------------------------

describe("retryDelay", () => {
  it("doubles to a ceiling", () => {
    const mid = (attempt: number) => retryDelay(attempt, 0.5);
    expect([0, 1, 2, 3, 4, 5].map(mid)).toEqual([1000, 2000, 4000, 8000, 16000, 30000]);
    // Once at the cap it stays there, however long the outage runs.
    expect(mid(20)).toBe(MAX_RETRY_MS);
    expect(mid(0)).toBe(BASE_RETRY_MS);
  });

  it("spreads each wait over a window around it", () => {
    // A restart drops every open page at once; without this they would all
    // come back at once too, and again on the next attempt. The window is the
    // base ±25%, closed at the bottom and open at the top — `Math.random`
    // never returns 1, so the upper figure is the edge rather than a value.
    expect(retryDelay(0, 0)).toBe(750);
    expect(retryDelay(0, 1)).toBe(1250);
    expect(retryDelay(5, 0)).toBe(22_500);
    expect(retryDelay(5, 1)).toBe(37_500);
  });
});

// ---------------------------------------------------------------------------
// dispatch
// ---------------------------------------------------------------------------

describe("connectRealtime", () => {
  it("hands snapshots to onEvent and ignores the rest", () => {
    const onEvent = vi.fn();
    const onGone = vi.fn();
    connect({ onEvent, onGone });

    latest().opened();
    latest().delivers(JSON.stringify({ type: "event", event: EVENT }));
    latest().delivers("garbage");
    latest().delivers(JSON.stringify({ type: "unknown" }));

    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(onEvent).toHaveBeenCalledWith(EVENT);
    expect(onGone).not.toHaveBeenCalled();
  });

  it("stops for good when the event is gone", () => {
    vi.useFakeTimers();
    const onGone = vi.fn();
    connect({ onGone });
    latest().opened();

    latest().delivers(JSON.stringify({ type: "gone" }));

    expect(onGone).toHaveBeenCalledTimes(1);
    expect(latest().closed).toBe(true);
    // Terminal: there is nothing left to reconnect to, so it does not try.
    latest().dropped();
    vi.advanceTimersByTime(10 * MAX_RETRY_MS);
    expect(sockets).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // reconnecting
  // -------------------------------------------------------------------------

  it("reconnects on the backoff schedule", () => {
    vi.useFakeTimers();
    connect();
    expect(sockets).toHaveLength(1);

    for (const [attempt, wait] of [1000, 2000, 4000, 8000].entries()) {
      latest().dropped();
      // Nothing happens a tick early …
      vi.advanceTimersByTime(wait - 1);
      expect(sockets).toHaveLength(attempt + 1);
      // … and exactly one socket is opened on time.
      vi.advanceTimersByTime(1);
      expect(sockets).toHaveLength(attempt + 2);
      expect(latest().url).toBe(URL_FOR_TESTS);
    }
  });

  it("starts the schedule over once a connection succeeds", () => {
    vi.useFakeTimers();
    connect();

    // Three failures in: the next wait would be 8s.
    for (const wait of [1000, 2000, 4000]) {
      latest().dropped();
      vi.advanceTimersByTime(wait);
    }
    expect(sockets).toHaveLength(4);

    latest().opened();
    latest().dropped();

    // Reaching the server resets it: back to one second, not eight.
    vi.advanceTimersByTime(BASE_RETRY_MS);
    expect(sockets).toHaveLength(5);
  });

  it("keeps one reconnect in flight, however the drop arrived", () => {
    vi.useFakeTimers();
    connect();
    const first = latest();

    // A socket that errors also closes, and a stale socket may report late.
    first.dropped();
    first.dropped();
    vi.advanceTimersByTime(BASE_RETRY_MS);

    expect(sockets).toHaveLength(2);
    // The replaced socket no longer speaks for the connector.
    first.dropped();
    vi.advanceTimersByTime(10 * MAX_RETRY_MS);
    expect(sockets).toHaveLength(2);
  });

  it("stops when the caller closes it", () => {
    vi.useFakeTimers();
    const onEvent = vi.fn();
    const handle = connect({ onEvent });
    latest().opened();

    handle.close();

    expect(latest().closed).toBe(true);
    // No reconnect, and nothing still arriving is acted on.
    latest().dropped();
    vi.advanceTimersByTime(10 * MAX_RETRY_MS);
    expect(sockets).toHaveLength(1);
    latest().delivers(JSON.stringify({ type: "event", event: EVENT }));
    expect(onEvent).not.toHaveBeenCalled();

    handle.close(); // idempotent
  });

  it("treats a constructor that throws as a failed attempt", () => {
    vi.useFakeTimers();
    let attempts = 0;
    connectRealtime("e", {
      url: URL_FOR_TESTS,
      random: () => 0.5,
      createSocket: (url: string) => {
        attempts += 1;
        if (attempts === 1) throw new Error("blocked");
        return new FakeSocket(url);
      },
    });

    expect(sockets).toHaveLength(0);
    vi.advanceTimersByTime(BASE_RETRY_MS);
    expect(sockets).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // where there is no browser
  // -------------------------------------------------------------------------

  it("does nothing at all during SSR", () => {
    // These tests run in Node, which is the environment `render()` runs in:
    // no `window`, so no URL to derive and nothing to connect to. Opening a
    // socket per rendered page would be a denial of service against ourselves.
    expect(typeof window).toBe("undefined");
    const created = vi.fn();

    const handle = connectRealtime("e", {
      createSocket: (url: string) => {
        created();
        return new FakeSocket(url);
      },
    });

    expect(created).not.toHaveBeenCalled();
    expect(sockets).toHaveLength(0);
    expect(() => handle.close()).not.toThrow();
  });
});
