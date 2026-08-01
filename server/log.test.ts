/**
 * The in-memory log: the ring buffers, the event tagging, the live
 * subscriptions, and — most load-bearing — the redaction helpers, because the
 * rules they encode are the reason the log is safe to exist at all
 * (ARCHITECTURE.md § Security: no slug in the global buffer, no push endpoint
 * anywhere, IPs down to a prefix).
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  dropEventLog,
  endpointHost,
  EVENT_LOG_CAPACITY,
  eventLogEntries,
  GLOBAL_LOG_CAPACITY,
  globalLogEntries,
  log,
  logError,
  logInfo,
  logWarn,
  redactIp,
  redactPath,
  resetLog,
  stackHead,
  subscribeEventLog,
  subscribeGlobalLog,
} from "./log.ts";

const EVENT_ID = "0f9d59d2-4c6a-4b6e-9a10-2f4f1c8a7b3d";
const OTHER_ID = "1a2b3c4d-5e6f-4a8b-9c0d-1e2f3a4b5c6d";

afterEach(resetLog);

describe("the ring buffers", () => {
  it("records levels, timestamps and detail fields", () => {
    logError("Something broke", { code: "EACCES", path: "/var/x", stack: "at f ()" });
    logWarn("Something odd");
    logInfo("Something happened");

    const entries = globalLogEntries();
    expect(entries.map((e) => e.level)).toEqual(["error", "warn", "info"]);
    expect(entries[0]).toMatchObject({
      message: "Something broke",
      code: "EACCES",
      path: "/var/x",
      stack: "at f ()",
    });
    // A real instant, not a placeholder.
    expect(Date.parse(entries[0].at)).not.toBeNaN();
    // Absent fields are absent, not empty strings: the entry is the wire shape.
    expect(entries[1]).not.toHaveProperty("code");
    expect(entries[1]).not.toHaveProperty("eventId");
  });

  it("caps the global buffer, dropping the oldest", () => {
    for (let i = 0; i < GLOBAL_LOG_CAPACITY + 25; i += 1) logInfo(`entry ${i}`);

    const entries = globalLogEntries();
    expect(entries).toHaveLength(GLOBAL_LOG_CAPACITY);
    expect(entries[0].message).toBe("entry 25");
    expect(entries[entries.length - 1].message).toBe(
      `entry ${GLOBAL_LOG_CAPACITY + 24}`,
    );
  });

  it("caps each per-event buffer independently of the global one", () => {
    for (let i = 0; i < EVENT_LOG_CAPACITY + 10; i += 1)
      logInfo(`entry ${i}`, { eventId: EVENT_ID });

    const entries = eventLogEntries(EVENT_ID);
    expect(entries).toHaveLength(EVENT_LOG_CAPACITY);
    expect(entries[0].message).toBe("entry 10");
    // The global buffer holds the same entries under its own, larger cap.
    expect(globalLogEntries()).toHaveLength(EVENT_LOG_CAPACITY + 10);
  });

  it("files a tagged entry under its event and in the global buffer", () => {
    log("warn", "tagged", { eventId: EVENT_ID });
    log("info", "untagged");

    expect(eventLogEntries(EVENT_ID).map((e) => e.message)).toEqual(["tagged"]);
    expect(eventLogEntries(OTHER_ID)).toEqual([]);
    expect(globalLogEntries().map((e) => e.message)).toEqual(["tagged", "untagged"]);
    expect(globalLogEntries()[0].eventId).toBe(EVENT_ID);
  });

  it("returns copies, not the live buffer", () => {
    logInfo("one");
    const snapshot = globalLogEntries();
    logInfo("two");
    expect(snapshot).toHaveLength(1);
  });
});

describe("subscriptions", () => {
  it("delivers live entries to a global subscriber until it unsubscribes", () => {
    const seen: string[] = [];
    const unsubscribe = subscribeGlobalLog((entry) => seen.push(entry.message));

    logInfo("first");
    unsubscribe();
    logInfo("second");

    expect(seen).toEqual(["first"]);
  });

  it("delivers only the subscribed event's entries to an event subscriber", () => {
    const seen: string[] = [];
    subscribeEventLog(EVENT_ID, (entry) => seen.push(entry.message));

    logInfo("mine", { eventId: EVENT_ID });
    logInfo("theirs", { eventId: OTHER_ID });
    logInfo("global");

    expect(seen).toEqual(["mine"]);
  });

  it("drops an event's buffer and tells its watchers the stream is over", () => {
    logInfo("before", { eventId: EVENT_ID });
    let dropped = 0;
    subscribeEventLog(EVENT_ID, () => {}, () => {
      dropped += 1;
    });

    dropEventLog(EVENT_ID);

    expect(dropped).toBe(1);
    expect(eventLogEntries(EVENT_ID)).toEqual([]);
    // A dropped log does not resurrect its watchers: new entries under the
    // same id start a fresh buffer with nobody listening.
    logInfo("after", { eventId: EVENT_ID });
    expect(dropped).toBe(1);
  });
});

describe("redaction", () => {
  it("reduces an IP to a coarse prefix", () => {
    expect(redactIp("203.0.113.7")).toBe("203.0.x.x");
    expect(redactIp("::ffff:203.0.113.7")).toBe("203.0.x.x");
    expect(redactIp("2001:db8:85a3::8a2e:370:7334")).toBe("2001:db8:…");
    expect(redactIp("::1")).toBe("1:x:…");
    expect(redactIp("")).toBe("unknown");
  });

  it("keeps only the host of a push endpoint", () => {
    const host = endpointHost(
      "https://fcm.googleapis.com/fcm/send/dGhlIHNlY3JldCBwYXJ0",
    );
    expect(host).toBe("fcm.googleapis.com");
    expect(host).not.toContain("send");
    expect(endpointHost("not a url")).toBe("invalid-endpoint");
  });

  it("replaces a slug segment in a request path, and keeps a uuid", () => {
    expect(redactPath("/my-secret-slug/data")).toBe("/:event/data");
    expect(redactPath(`/${EVENT_ID}/users/ada-lovelace`)).toBe(
      `/${EVENT_ID}/users/ada-lovelace`,
    );
    expect(redactPath("/api/events")).toBe("/api/events");
    expect(redactPath("/")).toBe("/");
  });

  it("finds the first call site of a stack, and never the message line", () => {
    const stack = [
      "Error: EACCES: permission denied",
      "    at writeRaw (server/storage.ts:92:5)",
      "    at deeper (server/storage.ts:120:3)",
    ].join("\n");
    expect(stackHead(stack)).toBe("at writeRaw (server/storage.ts:92:5)");
    expect(stackHead(undefined)).toBeUndefined();
    expect(stackHead("Error: nothing else")).toBeUndefined();
  });
});
