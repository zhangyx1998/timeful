/**
 * The Web Push surface, end to end: the global public key, each event's
 * subscribe/unsubscribe pair, and the storage they land in — against the real
 * Express app on a real socket over a temp `VAR_DIR`, per the house pattern.
 */
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it, vi } from "vitest";

// The tarpit reads its delay once at import time; see events.test.ts.
const originalMissDelay = vi.hoisted(() => {
  const previous = process.env.MISS_DELAY_MS;
  process.env.MISS_DELAY_MS = "0";
  return previous;
});

import { fromBase64Url, isP256Point } from "../push/crypto.ts";
import { makeTestSubscription } from "../push/test-support.ts";
import {
  MAX_SUBSCRIPTIONS_PER_EVENT,
  saveSubscription,
} from "../push/subscriptions.ts";
import { readPushStore, readVapidKeys, updatePushStore } from "../storage.ts";
import {
  apiCall,
  eventFixture,
  makeVarDir,
  removeVarDir,
  startTestServer,
  type ApiCallOptions,
  type TestServer,
} from "../test-support.ts";

let api: TestServer;
let varDir: string;

beforeAll(async () => {
  api = await startTestServer();
});

afterAll(async () => {
  await api.close();
  if (originalMissDelay === undefined) delete process.env.MISS_DELAY_MS;
  else process.env.MISS_DELAY_MS = originalMissDelay;
});

beforeEach(async () => {
  varDir = await makeVarDir("timeful-push-");
});

afterEach(async () => {
  await removeVarDir(varDir);
});

const call = (method: string, route: string, options?: ApiCallOptions) =>
  apiCall(api.base, method, route, options);

/** A plausible subscribe body: fresh browser keys, a loopback endpoint. */
function subscribeBody(extra: Record<string, unknown> = {}): Record<string, unknown> {
  const subscription = makeTestSubscription();
  return {
    role: "respondent",
    userKey: "ada-lovelace",
    endpoint: `http://127.0.0.1:9/${Math.random().toString(36).slice(2)}`,
    keys: subscription.keys,
    ...extra,
  };
}

describe("GET /api/push/public-key", () => {
  it("mints a valid P-256 key on first ask and keeps it", async () => {
    const first = await call("GET", "/api/push/public-key");
    expect(first.status).toBe(200);
    const key = (first.body as { key: string }).key;
    const point = fromBase64Url(key);
    expect(point && isP256Point(point)).toBe(true);

    // Stable across asks: subscriptions are bound to it.
    const second = await call("GET", "/api/push/public-key");
    expect((second.body as { key: string }).key).toBe(key);

    // Persisted through the storage layer, private half never served.
    const stored = await readVapidKeys();
    expect(stored?.publicKey).toBe(key);
    expect(JSON.stringify(first.body)).not.toContain(stored!.privateKey);
  });

  it("is public — no session required", async () => {
    const res = await call("GET", "/api/push/public-key");
    expect(res.status).toBe(200);
  });
});

describe("PUT /<slug>/push", () => {
  it("subscribes a respondent by the event's slug or uuid", async () => {
    const { event } = await eventFixture(call);
    const bySlug = await call("PUT", `/${event.slug}/push`, { body: subscribeBody() });
    expect(bySlug.status).toBe(200);
    expect(bySlug.body).toEqual({ ok: true });

    const byId = await call("PUT", `/${event.id}/push`, {
      body: subscribeBody({ userKey: "grace-hopper" }),
    });
    expect(byId.status).toBe(200);

    const store = await readPushStore();
    expect(store.subscriptions).toHaveLength(2);
    for (const entry of store.subscriptions) {
      expect(entry.eventId).toBe(event.id);
      expect(entry.role).toBe("respondent");
    }
  });

  it("re-normalizes the claimed user key like a path key", async () => {
    const { event } = await eventFixture(call);
    const res = await call("PUT", `/${event.slug}/push`, {
      body: subscribeBody({ userKey: "  Ada   Lovelace " }),
    });
    expect(res.status).toBe(200);
    const store = await readPushStore();
    expect(store.subscriptions[0]?.userKey).toBe("ada-lovelace");
  });

  it("upserts on the same endpoint and role rather than duplicating", async () => {
    const { event } = await eventFixture(call);
    const body = subscribeBody();
    await call("PUT", `/${event.slug}/push`, { body });
    const again = await call("PUT", `/${event.slug}/push`, {
      body: { ...body, userKey: "grace-hopper" },
    });
    expect(again.status).toBe(200);
    const store = await readPushStore();
    expect(store.subscriptions).toHaveLength(1);
    expect(store.subscriptions[0]?.userKey).toBe("grace-hopper");
  });

  it("requires the admin session for the owner role", async () => {
    const { cookie, event } = await eventFixture(call);
    const body = subscribeBody({ role: "owner", userKey: undefined });

    const anonymous = await call("PUT", `/${event.slug}/push`, { body });
    expect(anonymous.status).toBe(401);
    expect((await readPushStore()).subscriptions).toHaveLength(0);

    const authed = await call("PUT", `/${event.slug}/push`, { body, cookie });
    expect(authed.status).toBe(200);
    const store = await readPushStore();
    expect(store.subscriptions[0]?.role).toBe("owner");
    expect(store.subscriptions[0]?.userKey).toBeUndefined();
  });

  it("refuses an owner subscription carrying a user key", async () => {
    const { cookie, event } = await eventFixture(call);
    const res = await call("PUT", `/${event.slug}/push`, {
      cookie,
      body: subscribeBody({ role: "owner" }),
    });
    expect(res.status).toBe(400);
  });

  it("refuses a respondent subscription without a user key", async () => {
    const { event } = await eventFixture(call);
    const res = await call("PUT", `/${event.slug}/push`, {
      body: subscribeBody({ userKey: undefined }),
    });
    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toBe("A guest key is required");
  });

  it("refuses malformed roles, endpoints and keys", async () => {
    const { event } = await eventFixture(call);
    const cases: Record<string, unknown>[] = [
      { role: "admin" },
      { endpoint: "not a url" },
      // https is required away from loopback: this is the one client-chosen
      // URL the server will POST to.
      { endpoint: "http://push.example.net/w/abc" },
      { endpoint: `https://push.example.net/${"x".repeat(2100)}` },
      { keys: { p256dh: "AAAA", auth: "AAAA" } },
      { keys: { ...makeTestSubscription().keys, auth: "AAAA" } },
      { keys: undefined },
    ];
    for (const extra of cases) {
      const res = await call("PUT", `/${event.slug}/push`, {
        body: subscribeBody(extra),
      });
      expect(res.status, JSON.stringify(extra)).toBe(400);
    }
    expect((await readPushStore()).subscriptions).toHaveLength(0);
  });

  it("caps subscriptions per event", async () => {
    const { event } = await eventFixture(call);
    const keys = makeTestSubscription().keys;
    await updatePushStore(() => ({
      subscriptions: Array.from({ length: MAX_SUBSCRIPTIONS_PER_EVENT }, (_, i) => ({
        eventId: event.id,
        role: "respondent" as const,
        userKey: `guest-${i}`,
        endpoint: `https://push.example.net/w/${i}`,
        keys,
        createdAt: new Date().toISOString(),
      })),
    }));

    const res = await call("PUT", `/${event.slug}/push`, { body: subscribeBody() });
    expect(res.status).toBe(429);

    // An endpoint already among the subscribers may still renew itself.
    const renewed = await saveSubscription({
      eventId: event.id,
      role: "respondent",
      userKey: "guest-0",
      endpoint: "https://push.example.net/w/0",
      keys,
      createdAt: new Date().toISOString(),
    });
    expect(renewed).toBe(true);
  });

  it("answers 404 for an event that does not resolve", async () => {
    const res = await call("PUT", "/nEver-a-slug/push", { body: subscribeBody() });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Event not found" });
  });

  it("keeps unknown methods on /push as JSON 404s", async () => {
    const { event } = await eventFixture(call);
    const res = await call("GET", `/${event.slug}/push`);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Not found" });
  });
});

describe("DELETE /<slug>/push", () => {
  it("removes exactly the named role's subscription, idempotently", async () => {
    const { cookie, event } = await eventFixture(call);
    const endpoint = "https://push.example.net/w/one";
    const keys = makeTestSubscription().keys;
    await call("PUT", `/${event.slug}/push`, {
      body: subscribeBody({ endpoint, keys }),
    });
    await call("PUT", `/${event.slug}/push`, {
      cookie,
      body: subscribeBody({ role: "owner", userKey: undefined, endpoint, keys }),
    });
    expect((await readPushStore()).subscriptions).toHaveLength(2);

    const res = await call("DELETE", `/${event.slug}/push`, {
      body: { role: "respondent", endpoint },
    });
    expect(res.status).toBe(200);
    const store = await readPushStore();
    expect(store.subscriptions).toHaveLength(1);
    expect(store.subscriptions[0]?.role).toBe("owner");

    const again = await call("DELETE", `/${event.slug}/push`, {
      body: { role: "respondent", endpoint },
    });
    expect(again.status).toBe(200);
  });
});
