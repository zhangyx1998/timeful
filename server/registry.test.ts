/**
 * The one outbound call in the app, and the comparison that decides what to
 * say about its answer.
 *
 * Nothing here touches the network: the registry is a stub, because a test that
 * needed npm to be up would be a test that failed on a train.
 */
import { describe, expect, it } from "vitest";
import {
  fetchLatestVersion,
  isDevelopmentBuild,
  isNewerVersion,
  REGISTRY_URL,
} from "./registry.ts";

/** A `fetch` that answers one canned reply. */
function stubFetch(reply: {
  ok?: boolean;
  status?: number;
  body?: unknown;
  throws?: Error;
}): { impl: typeof globalThis.fetch; urls: string[] } {
  const urls: string[] = [];
  const impl = (async (input: RequestInfo | URL) => {
    urls.push(String(input));
    if (reply.throws) throw reply.throws;
    return {
      ok: reply.ok ?? true,
      status: reply.status ?? 200,
      json: async () => reply.body,
    } as Response;
  }) as typeof globalThis.fetch;
  return { impl, urls };
}

describe("fetchLatestVersion", () => {
  it("reads the version out of the latest dist-tag document", async () => {
    const { impl, urls } = stubFetch({ body: { name: "timeful", version: "1.4.0" } });
    expect(await fetchLatestVersion({ fetchImpl: impl })).toEqual({ latest: "1.4.0" });
    expect(urls).toEqual([REGISTRY_URL]);
  });

  it("reports an unreachable registry rather than throwing", async () => {
    const { impl } = stubFetch({ throws: new TypeError("fetch failed") });
    const result = await fetchLatestVersion({ fetchImpl: impl });

    expect(result.latest).toBeNull();
    expect(result.problem).toContain("could not be reached");
  });

  it("reports a timeout as a timeout, and abandons the request", async () => {
    let aborted = false;
    const impl = ((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          aborted = true;
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        });
      })) as typeof globalThis.fetch;

    const result = await fetchLatestVersion({ fetchImpl: impl, timeoutMs: 5 });
    expect(aborted).toBe(true);
    expect(result.latest).toBeNull();
    expect(result.problem).toContain("did not answer in time");
  });

  it("reports a non-2xx answer with its status and nothing else", async () => {
    const { impl } = stubFetch({ ok: false, status: 503 });
    const result = await fetchLatestVersion({ fetchImpl: impl });

    expect(result.latest).toBeNull();
    expect(result.problem).toBe("The npm registry answered 503.");
  });

  it("refuses a document with no usable version", async () => {
    for (const body of [{}, { version: 3 }, { version: "  " }, null, "nope"]) {
      const { impl } = stubFetch({ body });
      const result = await fetchLatestVersion({ fetchImpl: impl });
      expect(result.latest).toBeNull();
      expect(result.problem).toBeTruthy();
    }
  });

  it("survives a body that is not JSON at all", async () => {
    const impl = (async () =>
      ({
        ok: true,
        status: 200,
        json: async () => {
          throw new SyntaxError("Unexpected token <");
        },
      }) as unknown as Response) as typeof globalThis.fetch;

    expect(await fetchLatestVersion({ fetchImpl: impl })).toEqual({
      latest: null,
      problem: "The npm registry could not be reached.",
    });
  });
});

describe("isNewerVersion", () => {
  it("compares the release triple numerically, not as text", () => {
    expect(isNewerVersion("1.10.0", "1.9.0")).toBe(true);
    expect(isNewerVersion("1.9.0", "1.10.0")).toBe(false);
    expect(isNewerVersion("2.0.0", "1.99.99")).toBe(true);
    expect(isNewerVersion("1.2.4", "1.2.3")).toBe(true);
    expect(isNewerVersion("1.2.3", "1.2.3")).toBe(false);
  });

  it("puts a prerelease before the release it leads to", () => {
    expect(isNewerVersion("1.2.3", "1.2.3-rc.1")).toBe(true);
    expect(isNewerVersion("1.2.3-rc.1", "1.2.3")).toBe(false);
    expect(isNewerVersion("1.2.3-rc.2", "1.2.3-rc.1")).toBe(false);
  });

  it("never calls something newer when it cannot read it", () => {
    expect(isNewerVersion("latest", "1.0.0")).toBe(false);
    expect(isNewerVersion("2.0.0", "0.0.0-dev")).toBe(true);
    expect(isNewerVersion("2.0", "1.0.0")).toBe(false);
    expect(isNewerVersion("", "1.0.0")).toBe(false);
  });
});

describe("isDevelopmentBuild", () => {
  it("recognises the source-checkout fallback and nothing else", () => {
    expect(isDevelopmentBuild("0.0.0-dev")).toBe(true);
    expect(isDevelopmentBuild("1.0.0")).toBe(false);
  });
});
