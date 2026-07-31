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

import crypto from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { flushPushDelivery } from "../push/deliver.ts";
import { fromBase64Url, isP256Point, toBase64Url } from "../push/crypto.ts";
import {
  decryptPayload,
  makeTestSubscription,
  type TestSubscription,
} from "../push/test-support.ts";
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
  // Drain anything a previous test left coalescing before the data root moves.
  await flushPushDelivery();
  varDir = await makeVarDir("timeful-push-");
});

afterEach(async () => {
  await flushPushDelivery();
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

// ---------------------------------------------------------------------------
// the full loop: subscribe → trigger → deliver → decrypt
// ---------------------------------------------------------------------------

interface CapturedDelivery {
  path: string;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

interface PushServiceStub {
  origin: string;
  requests: CapturedDelivery[];
  /** Status to answer with, by delivery path. Defaults to 201. */
  statusFor: (path: string) => number;
  close: () => Promise<void>;
}

/** A local HTTP server standing in for the vendor push service. */
function startPushService(): Promise<PushServiceStub> {
  const stub: PushServiceStub = {
    origin: "",
    requests: [],
    statusFor: () => 201,
    close: () => Promise.resolve(),
  };
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      stub.requests.push({
        path: req.url ?? "",
        headers: req.headers,
        body: Buffer.concat(chunks),
      });
      res.statusCode = stub.statusFor(req.url ?? "");
      res.end();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      stub.origin = `http://127.0.0.1:${port}`;
      stub.close = () =>
        new Promise((done) => server.close(() => done()));
      resolve(stub);
    });
  });
}

/** Verifies the `vapid t=…, k=…` header against the server's public key. */
function verifyVapid(header: string, expectedKey: string, origin: string): void {
  const match = /^vapid t=([^,]+), k=(.+)$/.exec(header);
  expect(match).not.toBeNull();
  const [, token, key] = match!;
  expect(key).toBe(expectedKey);
  const [headerPart, claimsPart, signaturePart] = token.split(".");
  const claims = JSON.parse(
    fromBase64Url(claimsPart)!.toString("utf8"),
  ) as { aud: string; exp: number; sub: string };
  expect(claims.aud).toBe(origin);
  expect(claims.exp).toBeGreaterThan(Date.now() / 1000);
  expect(typeof claims.sub).toBe("string");
  const point = fromBase64Url(expectedKey)!;
  const publicKey = crypto.createPublicKey({
    format: "jwk",
    key: {
      kty: "EC",
      crv: "P-256",
      x: toBase64Url(point.subarray(1, 33)),
      y: toBase64Url(point.subarray(33, 65)),
    },
  });
  const verified = crypto.verify(
    "sha256",
    Buffer.from(`${headerPart}.${claimsPart}`, "ascii"),
    { key: publicKey, dsaEncoding: "ieee-p1363" },
    fromBase64Url(signaturePart)!,
  );
  expect(verified).toBe(true);
}

/** Decrypts a captured delivery with the subscriber's own keys. */
function decryptDelivery(
  delivery: CapturedDelivery,
  subscription: TestSubscription,
): { title: string; body: string; url: string } {
  const plaintext = decryptPayload(
    delivery.body,
    subscription.privateKey,
    subscription.authSecret,
  );
  return JSON.parse(plaintext.toString("utf8")) as {
    title: string;
    body: string;
    url: string;
  };
}

describe("delivery", () => {
  let service: PushServiceStub;

  beforeEach(async () => {
    service = await startPushService();
  });

  afterEach(async () => {
    await service.close();
  });

  /** Subscribes one fresh browser in `role` at `path` on the stub service. */
  async function subscribe(
    slug: string,
    role: "owner" | "respondent",
    path: string,
    cookie?: string,
  ): Promise<TestSubscription> {
    const subscription = makeTestSubscription();
    const res = await call("PUT", `/${slug}/push`, {
      cookie,
      body: {
        role,
        ...(role === "respondent" ? { userKey: "ada-lovelace" } : {}),
        endpoint: `${service.origin}${path}`,
        keys: subscription.keys,
      },
    });
    expect(res.status).toBe(200);
    return subscription;
  }

  it("carries a response change to the owner, encrypted end to end", async () => {
    const { cookie, event } = await eventFixture(call);
    const owner = await subscribe(event.slug, "owner", "/owner", cookie);
    await subscribe(event.slug, "respondent", "/respondent");

    const put = await call("PUT", `/${event.slug}/users/ada-lovelace`, {
      body: {
        displayName: "Ada Lovelace",
        availability: ["2026-08-03T09:00:00.000Z"],
      },
    });
    expect(put.status).toBe(200);
    await flushPushDelivery();

    // The owner heard; the respondent — whose subscription is about the event
    // changing, not about answers — did not.
    expect(service.requests.map((r) => r.path)).toEqual(["/owner"]);
    const [delivery] = service.requests;

    // The delivery contract: aes128gcm framing, a day's TTL, normal urgency,
    // and a VAPID assertion the advertised public key verifies.
    expect(delivery.headers["content-encoding"]).toBe("aes128gcm");
    expect(delivery.headers["content-type"]).toBe("application/octet-stream");
    expect(delivery.headers.ttl).toBe("86400");
    expect(delivery.headers.urgency).toBe("normal");
    const advertised = (await call("GET", "/api/push/public-key")).body as {
      key: string;
    };
    verifyVapid(String(delivery.headers.authorization), advertised.key, service.origin);

    // The body decrypts with the subscription's own keys, and only says what
    // the subscriber is entitled to hear anyway: they hold the URL already.
    expect(decryptDelivery(delivery, owner)).toEqual({
      title: "Team Offsite",
      body: "Ada Lovelace updated their availability.",
      url: `/${event.slug}`,
    });
  });

  it("coalesces a burst of writes into one notice naming everyone", async () => {
    const { cookie, event } = await eventFixture(call);
    const owner = await subscribe(event.slug, "owner", "/owner", cookie);

    for (const [key, name] of [
      ["ada-lovelace", "Ada Lovelace"],
      ["ada-lovelace", "Ada Lovelace"],
      ["grace-hopper", "Grace Hopper"],
    ] as const) {
      const res = await call("PUT", `/${event.slug}/users/${key}`, {
        body: { displayName: name, availability: ["2026-08-03T09:00:00.000Z"] },
      });
      expect(res.status).toBe(200);
    }
    await flushPushDelivery();

    expect(service.requests).toHaveLength(1);
    expect(decryptDelivery(service.requests[0], owner).body).toBe(
      "Ada Lovelace and Grace Hopper updated their availability.",
    );
  });

  it("does not notify for a clear that cleared nothing", async () => {
    const { cookie, event } = await eventFixture(call);
    await subscribe(event.slug, "owner", "/owner", cookie);
    const res = await call("PUT", `/${event.slug}/users/nobody-yet`, {
      body: { displayName: "Nobody Yet", availability: [] },
    });
    expect(res.status).toBe(200);
    await flushPushDelivery();
    expect(service.requests).toHaveLength(0);
  });

  it("carries a settings change to respondents, with the renamed slug", async () => {
    const { cookie, event } = await eventFixture(call);
    await subscribe(event.slug, "owner", "/owner", cookie);
    const respondent = await subscribe(event.slug, "respondent", "/respondent");

    const patched = await call("PATCH", `/${event.id}/settings`, {
      cookie,
      body: { name: "Team Onsite", slug: "renamed-offsite" },
    });
    expect(patched.status).toBe(200);
    await flushPushDelivery();

    expect(service.requests.map((r) => r.path)).toEqual(["/respondent"]);
    expect(decryptDelivery(service.requests[0], respondent)).toEqual({
      title: "Team Onsite",
      body: "The event was updated — your availability may need another look.",
      url: "/renamed-offsite",
    });
  });

  it("says nothing for a PATCH that changes nothing meaningful", async () => {
    const { cookie, event } = await eventFixture(call);
    await subscribe(event.slug, "respondent", "/respondent");

    // Restating the current name, and flipping the realtime plumbing, are not
    // changes to the plan.
    const restated = await call("PATCH", `/${event.id}/settings`, {
      cookie,
      body: { name: event.name },
    });
    expect(restated.status).toBe(200);
    const plumbing = await call("PATCH", `/${event.id}/settings`, {
      cookie,
      body: { realtime: false },
    });
    expect(plumbing.status).toBe(200);
    await flushPushDelivery();
    expect(service.requests).toHaveLength(0);
  });

  it("announces deletion to respondents and drops every subscription", async () => {
    const { cookie, event } = await eventFixture(call);
    await subscribe(event.slug, "owner", "/owner", cookie);
    const respondent = await subscribe(event.slug, "respondent", "/respondent");

    const deleted = await call("DELETE", `/${event.id}/settings`, { cookie });
    expect(deleted.status).toBe(200);
    await flushPushDelivery();

    expect(service.requests.map((r) => r.path)).toEqual(["/respondent"]);
    expect(decryptDelivery(service.requests[0], respondent)).toEqual({
      title: "Team Offsite",
      body: "The event was deleted.",
      url: `/${event.slug}`,
    });
    expect((await readPushStore()).subscriptions).toHaveLength(0);
  });

  it("prunes a subscription the push service says is gone", async () => {
    const { cookie, event } = await eventFixture(call);
    await subscribe(event.slug, "owner", "/gone", cookie);
    service.statusFor = (path) => (path === "/gone" ? 410 : 201);

    const put = await call("PUT", `/${event.slug}/users/ada-lovelace`, {
      body: { displayName: "Ada Lovelace", availability: ["2026-08-03T09:00:00.000Z"] },
    });
    expect(put.status).toBe(200);
    await flushPushDelivery();

    expect(service.requests.map((r) => r.path)).toEqual(["/gone"]);
    expect((await readPushStore()).subscriptions).toHaveLength(0);
  });

  it("keeps a subscription through a transient delivery failure", async () => {
    const { cookie, event } = await eventFixture(call);
    // A closed port: connection refused, which is a network failure, not a
    // statement that the subscription is dead.
    await service.close();
    await subscribe(event.slug, "owner", "/owner", cookie);

    const put = await call("PUT", `/${event.slug}/users/ada-lovelace`, {
      body: { displayName: "Ada Lovelace", availability: ["2026-08-03T09:00:00.000Z"] },
    });
    expect(put.status).toBe(200);
    await flushPushDelivery();
    expect((await readPushStore()).subscriptions).toHaveLength(1);
  });
});
