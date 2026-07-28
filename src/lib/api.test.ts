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
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, apiError, fetchIsAdmin, isAuthedStatus } from "./api";

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
    const call = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toBe("/api/status");
    expect((call[1] as RequestInit).credentials).toBe("include");
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
    });
  });

  it("reports status 0 for anything that never reached the server", () => {
    expect(apiError(new TypeError("Failed to fetch"), "fallback")).toEqual({
      message: "Failed to fetch",
      status: 0,
    });
    expect(apiError(null, "fallback")).toEqual({ message: "fallback", status: 0 });
  });
});
