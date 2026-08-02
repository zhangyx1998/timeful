/**
 * The event page is public, and the admin's respondent-delete controls are the
 * only thing on it that is not. What decides whether they render is
 * `fetchIsAdmin`, so its failure modes are the interesting part: every one of
 * them has to land on "not the admin". A `true` reached by accident — a stray
 * truthy value, an error page from a proxy, an offline fetch — would put
 * management controls in front of a guest.
 *
 * (The controls are cosmetic either way: the server checks the session itself.
 * This keeps the UI from lying about who someone is.)
 *
 * The other half is where a request is sent. There are two namespaces — `/api/*`
 * for what is global and `/<slug>/…` for what belongs to one event — so paths
 * are written out in full and reach `fetch` verbatim, and the event-scoped ones
 * are built by the helpers rather than spelled at each call site.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  api,
  ApiError,
  apiError,
  eventDataPath,
  eventSettingsPath,
  fetchIsAdmin,
  isAuthedStatus,
  request,
  userPath,
} from "./api";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

/** Stubs one `fetch` round trip with a JSON body. */
function respondWith(status: number, body: unknown) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  globalThis.fetch = vi.fn(() =>
    Promise.resolve(
      new Response(text, { status, headers: { "Content-Type": "application/json" } }),
    ),
  ) as unknown as typeof fetch;
}

/** The URL the stubbed `fetch` was called with, and its init. */
function lastCall(): [string, RequestInit] {
  const calls = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls;
  const call = calls[calls.length - 1];
  return [call[0] as string, (call[1] ?? {}) as RequestInit];
}

describe("request", () => {
  it("asks for the path it was given, exactly", async () => {
    // Two namespaces now — `/api/*` for what is global and `/<slug>/…` for what
    // belongs to one event — so a client that guessed a prefix would be
    // guessing between them. Nothing is prepended to either.
    respondWith(200, { ok: true });
    await request("/api/events");
    expect(lastCall()[0]).toBe("/api/events");

    respondWith(200, { ok: true });
    await request("/rainy-otter/data");
    expect(lastCall()[0]).toBe("/rainy-otter/data");
  });

  it("sends the session cookie whatever the namespace", async () => {
    respondWith(200, { ok: true });
    await request("/rainy-otter/data");
    expect(lastCall()[1].credentials).toBe("include");
  });
});

describe("keepalive", () => {
  // The flush on `pagehide`/`visibilitychange` is only worth having if the
  // request it dispatches survives the document that dispatched it — that is
  // what the flag asks the browser for, and it must reach `fetch` verbatim.
  it("passes keepalive through for a small body", async () => {
    respondWith(200, { ok: true });
    const body = { displayName: "Ada Lovelace", availability: ["2026-08-03T13:00:00.000Z"] };
    await api.put("/rainy-otter/users/ada-lovelace", body, { keepalive: true });

    const [, init] = lastCall();
    expect(init.keepalive).toBe(true);
    // The body is untouched by the detour through serialization.
    expect(init.body).toBe(JSON.stringify(body));
    expect(init.method).toBe("PUT");
  });

  it("drops keepalive for a body over the 64 KB quota, and still sends it", async () => {
    // Browsers refuse a keepalive fetch whose body exceeds their in-flight
    // quota — a throw, not a truncation — so an oversized flush goes out as a
    // plain fetch instead. It may lose the race with the closing tab; a
    // guaranteed throw loses it always.
    respondWith(200, { ok: true });
    const body = {
      displayName: "Ada Lovelace",
      availability: Array.from({ length: 3000 }, () => "2026-08-03T13:00:00.000Z"),
    };
    expect(JSON.stringify(body).length).toBeGreaterThan(60_000);
    await api.put("/rainy-otter/users/ada-lovelace", body, { keepalive: true });

    const [, init] = lastCall();
    expect(init.keepalive).toBeUndefined();
    expect(init.body).toBe(JSON.stringify(body));
  });

  it("asks for nothing without the option, exactly as before", async () => {
    respondWith(200, { ok: true });
    await api.put("/rainy-otter/users/ada-lovelace", { displayName: "Ada Lovelace" });
    expect(lastCall()[1].keepalive).toBeUndefined();
  });
});

describe("event-scoped paths", () => {
  it("builds the three endpoints an event has", () => {
    expect(eventDataPath("rainy-otter")).toBe("/rainy-otter/data");
    expect(eventSettingsPath("rainy-otter")).toBe("/rainy-otter/settings");
    expect(userPath("rainy-otter", "ada-lovelace")).toBe(
      "/rainy-otter/users/ada-lovelace",
    );
  });

  it("takes the uuid as readily as the slug", () => {
    const id = "11111111-1111-1111-1111-111111111111";
    expect(eventDataPath(id)).toBe(`/${id}/data`);
    expect(eventSettingsPath(id)).toBe(`/${id}/settings`);
    expect(userPath(id, "ada-lovelace")).toBe(`/${id}/users/ada-lovelace`);
  });

  it("escapes both halves, so neither can reach outside its own segment", () => {
    expect(eventDataPath("a/b")).toBe("/a%2Fb/data");
    expect(eventSettingsPath("a?b")).toBe("/a%3Fb/settings");
    expect(userPath("a/b", "../secret")).toBe("/a%2Fb/users/..%2Fsecret");
    // A key that reached the client un-normalized is still only one segment.
    expect(userPath("rainy-otter", "ada lovelace")).toBe(
      "/rainy-otter/users/ada%20lovelace",
    );
    expect(userPath("rainy-otter", "zoë")).toBe("/rainy-otter/users/zo%C3%AB");
  });
});

describe("isAuthedStatus", () => {
  it("accepts only an explicit authed: true", () => {
    expect(isAuthedStatus({ needsSetup: false, authed: true })).toBe(true);
  });

  it("rejects everything else, including truthy stand-ins", () => {
    const rejected: unknown[] = [
      { needsSetup: false, authed: false },
      { needsSetup: false },
      { authed: "true" },
      { authed: 1 },
      {},
      null,
      undefined,
      "authed",
      42,
      [{ authed: true }],
    ];
    for (const value of rejected) {
      expect(isAuthedStatus(value)).toBe(false);
    }
  });
});

describe("fetchIsAdmin", () => {
  it("is true for a signed-in owner", async () => {
    respondWith(200, { needsSetup: false, authed: true, email: "owner@example.com" });
    await expect(fetchIsAdmin()).resolves.toBe(true);
  });

  it("is false for a guest", async () => {
    respondWith(200, { needsSetup: false, authed: false });
    await expect(fetchIsAdmin()).resolves.toBe(false);
  });

  it("is false when the request fails outright", async () => {
    globalThis.fetch = vi.fn(() =>
      Promise.reject(new TypeError("Failed to fetch")),
    ) as unknown as typeof fetch;
    await expect(fetchIsAdmin()).resolves.toBe(false);
  });

  it("is false on a 401", async () => {
    respondWith(401, { error: "Not authenticated" });
    await expect(fetchIsAdmin()).resolves.toBe(false);
  });

  it("is false when something upstream answers with a non-JSON page", async () => {
    globalThis.fetch = vi.fn(() =>
      Promise.resolve(
        new Response("<html>502 Bad Gateway</html>", {
          status: 502,
          headers: { "Content-Type": "text/html" },
        }),
      ),
    ) as unknown as typeof fetch;
    await expect(fetchIsAdmin()).resolves.toBe(false);
  });

  it("is false when a 200 carries something that is not a status object", async () => {
    respondWith(200, "\"authed\"");
    await expect(fetchIsAdmin()).resolves.toBe(false);
  });

  it("asks the status endpoint with credentials, since the session is a cookie", async () => {
    respondWith(200, { needsSetup: false, authed: true });
    await fetchIsAdmin();
    // Written out in full and passed through as it stands: the global surface
    // spells its own `/api`, and nothing here adds one.
    const [url, init] = lastCall();
    expect(url).toBe("/api/status");
    expect(init.credentials).toBe("include");
  });

  it("never throws, so a caller cannot forget to handle the failure", async () => {
    globalThis.fetch = vi.fn(() => {
      throw new Error("synchronous explosion");
    }) as unknown as typeof fetch;
    await expect(fetchIsAdmin()).resolves.toBe(false);
  });
});

describe("apiError", () => {
  it("carries the status through so a caller can react to a lapsed session", () => {
    expect(apiError(new ApiError("Not authenticated", 401), "fallback")).toEqual({
      message: "Not authenticated",
      status: 401,
      detail: "",
    });
  });

  it("reports status 0 for anything that never reached the server", () => {
    expect(apiError(new TypeError("Failed to fetch"), "fallback")).toEqual({
      message: "Failed to fetch",
      status: 0,
      detail: "",
    });
    expect(apiError(null, "fallback")).toEqual({
      message: "fallback",
      status: 0,
      detail: "",
    });
  });

  it("formats the admin-only detail when the body carried one", () => {
    const body = {
      error: "Internal server error",
      detail: { message: "EACCES: permission denied", code: "EACCES", path: "/var/x" },
    };
    const err = new ApiError("Internal server error", 500, body);
    // The code is already inside the message, so it is not printed twice.
    expect(apiError(err, "fallback").detail).toBe(
      "EACCES: permission denied /var/x",
    );
  });

  it("reads no detail out of a body that has none — a guest's, always", () => {
    const err = new ApiError("Event not found", 404, { error: "Event not found" });
    expect(err.detail).toBeNull();
    expect(apiError(err, "fallback").detail).toBe("");
  });

  it("refuses a malformed detail rather than rendering rubbish", () => {
    for (const detail of [null, "text", { code: "E" }, { message: "" }, 7]) {
      const err = new ApiError("x", 500, { error: "x", detail });
      expect(err.detail).toBeNull();
    }
  });
});
