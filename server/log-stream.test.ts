/**
 * The admin log streams over a real socket: unauthenticated upgrades are
 * destroyed before the handshake, viewers get replay then live entries, and
 * the streams stay served with the realtime event channel off.
 */
import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket as WsClient } from "ws";

const { MISS_DELAY_MS } = (await import("vitest")).vi.hoisted(() => {
  process.env.MISS_DELAY_MS = "60";
  return { MISS_DELAY_MS: 60 };
});

import { sessionTokenFromHeader, touchSession } from "./auth.ts";
import { logError, logInfo, resetLog } from "./log.ts";
import {
  attachRealtime,
  logViewerCount,
  type RealtimeOptions,
  type RealtimeServer,
} from "./realtime.ts";
import { resolveEvent, writeResponse } from "./routes/events.ts";
import {
  adminCookie,
  apiCall,
  createTestEvent,
  makeVarDir,
  removeVarDir,
  startTestServer,
  type CallFn,
} from "./test-support.ts";
import type { LogEntry, LogStreamMessage } from "./types.ts";

void MISS_DELAY_MS;

let server: Server;
let hub: RealtimeServer | null = null;
let base: string;
let wsBase: string;
let closeServer: () => Promise<void>;
let varDir: string;
const clients: WsClient[] = [];

beforeEach(async () => {
  varDir = await makeVarDir("timeful-log-stream-");
  ({ server, base, wsBase, close: closeServer } = await startTestServer());
  resetLog();
});

afterEach(async () => {
  for (const socket of clients.splice(0)) socket.close();
  await hub?.close();
  hub = null;
  await closeServer();
  await removeVarDir(varDir);
});

const call: CallFn = (method, route, options) => apiCall(base, method, route, options);

/** The listener exactly as `serve()` wires it, realtime on unless said. */
function attach(overrides: Partial<RealtimeOptions> = {}): void {
  hub = attachRealtime(server, {
    resolveEvent,
    writeResponse,
    verifyAdmin: async (req) => {
      const raw = req.headers.cookie;
      const token = sessionTokenFromHeader(Array.isArray(raw) ? raw[0] : raw);
      if (!token) return false;
      return (await touchSession(token)) !== null;
    },
    ...overrides,
  });
}

interface Viewer {
  socket: WsClient;
  messages: LogStreamMessage[];
  /** Resolves once at least `count` frames have arrived. */
  take(count: number): Promise<LogStreamMessage[]>;
  closed(): Promise<{ code: number }>;
}

/** Opens a log-stream socket, optionally with a session cookie. */
function openViewer(path: string, cookie?: string): Promise<Viewer> {
  const socket = new WsClient(`${wsBase}${path}`, {
    headers: cookie ? { Cookie: cookie } : {},
  });
  clients.push(socket);
  const messages: LogStreamMessage[] = [];
  const waiting = new Set<() => void>();
  socket.on("message", (data) => {
    messages.push(JSON.parse(String(data)) as LogStreamMessage);
    for (const notify of [...waiting]) notify();
  });
  const closedEvent = new Promise<{ code: number }>((resolve) => {
    socket.on("close", (code) => resolve({ code }));
  });
  const take = (count: number): Promise<LogStreamMessage[]> =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiting.delete(check);
        reject(new Error(`timed out waiting for ${count} frames (${messages.length})`));
      }, 3000);
      function check() {
        if (messages.length < count) return;
        clearTimeout(timer);
        waiting.delete(check);
        resolve(messages);
      }
      waiting.add(check);
      check();
    });
  return new Promise((resolve, reject) => {
    socket.on("open", () =>
      resolve({ socket, messages, take, closed: () => closedEvent }),
    );
    socket.on("error", () => reject(new Error("upgrade refused")));
  });
}

/** Waits for a condition the server reaches on its own, or gives up. */
async function until(predicate: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 100; i += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${label}`);
}

const entryMessages = (viewer: Viewer): string[] =>
  viewer.messages
    .filter((m): m is { type: "entry"; entry: LogEntry } => m.type === "entry")
    .map((m) => m.entry.message);

describe("the admin log streams", () => {
  it("destroys an upgrade with no session cookie, on both paths", async () => {
    attach();
    const event = await createTestEvent(call, await adminCookie());

    await expect(openViewer("/api/logs")).rejects.toThrow("upgrade refused");
    await expect(openViewer(`/${event.id}/logs`)).rejects.toThrow("upgrade refused");
    expect(logViewerCount()).toBe(0);
  });

  it("destroys an upgrade whose cookie names no live session", async () => {
    attach();
    await adminCookie();

    await expect(
      openViewer("/api/logs", "session=0000forged0000"),
    ).rejects.toThrow("upgrade refused");
    expect(logViewerCount()).toBe(0);
  });

  it("replays the global buffer and then streams live entries", async () => {
    attach();
    const cookie = await adminCookie();
    logInfo("before the viewer connected");

    const viewer = await openViewer("/api/logs", cookie);

    const [replay] = await viewer.take(1);
    if (replay.type !== "replay") throw new Error("expected a replay first");
    expect(replay.entries.map((entry) => entry.message)).toContain(
      "before the viewer connected",
    );

    logError("after the viewer connected");
    await viewer.take(2);
    expect(entryMessages(viewer)).toEqual(["after the viewer connected"]);
    expect(logViewerCount()).toBe(1);
  });

  it("serves an event stream only its own event's entries", async () => {
    attach();
    const cookie = await adminCookie();
    const mine = await createTestEvent(call, cookie);
    const other = await createTestEvent(call, cookie);
    logInfo("mine, before", { eventId: mine.id });
    logInfo("other, before", { eventId: other.id });

    // By slug and by uuid alike — the same resolution the routes use.
    const viewer = await openViewer(`/${mine.slug}/logs`, cookie);

    const [replay] = await viewer.take(1);
    if (replay.type !== "replay") throw new Error("expected a replay first");
    expect(replay.entries.map((entry) => entry.message)).toEqual(["mine, before"]);

    logInfo("other, live", { eventId: other.id });
    logInfo("global, live");
    logInfo("mine, live", { eventId: mine.id });
    await viewer.take(2);
    expect(entryMessages(viewer)).toEqual(["mine, live"]);
  });

  it("streams the failure an admin's broken request just logged", async () => {
    attach();
    const cookie = await adminCookie();
    const event = await createTestEvent(call, cookie);
    const viewer = await openViewer(`/${event.id}/logs`, cookie);
    await viewer.take(1);

    // A real 500 on this event: the document resolves, and then the write
    // fails — the events directory has gone read-only under the server.
    const { default: fs } = await import("node:fs/promises");
    const { default: path } = await import("node:path");
    const eventsDir = path.join(varDir, "events");
    await fs.chmod(eventsDir, 0o555);
    try {
      const res = await call("PUT", `/${event.id}/users/ada-lovelace`, {
        body: {
          displayName: "Ada Lovelace",
          availability: ["2026-08-03T13:00:00.000Z"],
        },
      });
      expect(res.status).toBe(500);
    } finally {
      await fs.chmod(eventsDir, 0o755);
    }

    const frames = await viewer.take(2);
    const entry = frames.find((m) => m.type === "entry");
    if (entry?.type !== "entry") throw new Error("expected a live entry");
    expect(entry.entry.level).toBe("error");
    expect(entry.entry.eventId).toBe(event.id);
    // The redaction held on the way through: uuid, never the slug.
    expect(JSON.stringify(frames)).not.toContain(event.slug);
  });

  it("destroys an admin's stream upgrade for an event that is not there", async () => {
    attach();
    const cookie = await adminCookie();

    await expect(openViewer("/Nx7Kq2mWx9Az/logs", cookie)).rejects.toThrow(
      "upgrade refused",
    );
    expect(logViewerCount()).toBe(0);
  });

  it("ends an event stream in words when the event is deleted", async () => {
    attach();
    const cookie = await adminCookie();
    const event = await createTestEvent(call, cookie);
    const viewer = await openViewer(`/${event.id}/logs`, cookie);
    await viewer.take(1);

    expect((await call("DELETE", `/${event.id}/settings`, { cookie })).status).toBe(200);

    await viewer.closed();
    expect(viewer.messages.some((m) => m.type === "gone")).toBe(true);
    await until(() => logViewerCount() === 0, "the viewer to be reaped");
  });

  it("drops the server side when the viewer hangs up", async () => {
    attach();
    const cookie = await adminCookie();
    const viewer = await openViewer("/api/logs", cookie);
    await viewer.take(1);
    expect(logViewerCount()).toBe(1);

    viewer.socket.close();

    await until(() => logViewerCount() === 0, "the socket count to drop");
    // A late entry reaches nobody and breaks nothing.
    logInfo("into the void");
  });

  it("keeps serving the log streams with the realtime channel off", async () => {
    attach({ realtime: false });
    const cookie = await adminCookie();
    const event = await createTestEvent(call, cookie);

    const viewer = await openViewer("/api/logs", cookie);
    await viewer.take(1);
    expect(logViewerCount()).toBe(1);

    // The event channel stays as closed as the absent listener left it.
    await expect(openViewer(`/${event.slug}/ws`, cookie)).rejects.toThrow(
      "upgrade refused",
    );
  });

  it("ignores anything a viewer sends", async () => {
    attach();
    const cookie = await adminCookie();
    const event = await createTestEvent(call, cookie);
    const viewer = await openViewer("/api/logs", cookie);
    await viewer.take(1);

    // A viewer is read-only like the browse socket: no message listener, so
    // bytes sent here reach no state — including a forged save frame.
    viewer.socket.send(
      JSON.stringify({ type: "save", displayName: "Mallory", availability: [] }),
    );
    viewer.socket.send("not json");
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(viewer.socket.readyState).toBe(WsClient.OPEN);
    const stored = await call("GET", `/${event.id}/data`);
    expect((stored.body as { responses: object }).responses).toEqual({});
  });
});
