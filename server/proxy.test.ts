import { describe, expect, it } from "vitest";
import {
  DEFAULT_TRUSTED_PROXIES,
  describeTrustedProxies,
  parseTrustedProxies,
  TrustedProxyError,
} from "./proxy.ts";

describe("parseTrustedProxies", () => {
  it("defaults to loopback when the flag is absent", () => {
    expect(parseTrustedProxies([])).toEqual(["127.0.0.1", "::1"]);
    expect(parseTrustedProxies(["--dev"])).toEqual(DEFAULT_TRUSTED_PROXIES);
  });

  it("returns a fresh array so callers cannot mutate the default", () => {
    const first = parseTrustedProxies([]);
    if (first === false) throw new Error("expected a list");
    first.push("10.0.0.1");
    expect(parseTrustedProxies([])).toEqual(["127.0.0.1", "::1"]);
  });

  it("accepts single addresses, CIDRs and comma lists", () => {
    expect(parseTrustedProxies(["--trusted-proxy=10.0.0.1"])).toEqual(["10.0.0.1"]);
    expect(parseTrustedProxies(["--trusted-proxy=10.0.0.0/8"])).toEqual(["10.0.0.0/8"]);
    expect(parseTrustedProxies(["--trusted-proxy=::1"])).toEqual(["::1"]);
    expect(parseTrustedProxies(["--trusted-proxy=fd00::/8"])).toEqual(["fd00::/8"]);
    expect(
      parseTrustedProxies(["--trusted-proxy=127.0.0.1, 10.0.0.0/8 ,::1"]),
    ).toEqual(["127.0.0.1", "10.0.0.0/8", "::1"]);
  });

  it("accepts the space-separated form and repeated flags", () => {
    expect(parseTrustedProxies(["--trusted-proxy", "10.0.0.1"])).toEqual(["10.0.0.1"]);
    expect(
      parseTrustedProxies(["--trusted-proxy=10.0.0.1", "--dev", "--trusted-proxy=::1"]),
    ).toEqual(["10.0.0.1", "::1"]);
  });

  it("disables forwarded-header trust with 'none'", () => {
    expect(parseTrustedProxies(["--trusted-proxy=none"])).toBe(false);
    expect(parseTrustedProxies(["--trusted-proxy=NONE"])).toBe(false);
  });

  it("rejects hostnames", () => {
    expect(() => parseTrustedProxies(["--trusted-proxy=evil.com"])).toThrow(
      TrustedProxyError,
    );
    expect(() => parseTrustedProxies(["--trusted-proxy=evil.com"])).toThrow(
      /hostnames are not allowed/,
    );
    expect(() => parseTrustedProxies(["--trusted-proxy=localhost"])).toThrow(
      TrustedProxyError,
    );
    // Express would accept these keywords; the contract says IPs/CIDRs only.
    expect(() => parseTrustedProxies(["--trusted-proxy=loopback"])).toThrow(
      TrustedProxyError,
    );
  });

  it("rejects malformed addresses and prefixes", () => {
    expect(() => parseTrustedProxies(["--trusted-proxy=10.0.0.256"])).toThrow(
      /not an IP address/,
    );
    expect(() => parseTrustedProxies(["--trusted-proxy=10.0.0.0/33"])).toThrow(
      /between 0 and 32/,
    );
    expect(() => parseTrustedProxies(["--trusted-proxy=::1/129"])).toThrow(
      /between 0 and 128/,
    );
    expect(() => parseTrustedProxies(["--trusted-proxy=10.0.0.0/x"])).toThrow(
      /malformed CIDR prefix/,
    );
    expect(() => parseTrustedProxies(["--trusted-proxy="])).toThrow(/requires a value/);
    expect(() => parseTrustedProxies(["--trusted-proxy"])).toThrow(/requires a value/);
    expect(() => parseTrustedProxies(["--trusted-proxy", "--dev"])).toThrow(
      /requires a value/,
    );
  });

  it("refuses to mix 'none' with real addresses", () => {
    expect(() => parseTrustedProxies(["--trusted-proxy=none,127.0.0.1"])).toThrow(
      /cannot be combined/,
    );
  });

  it("describes the setting for the startup log", () => {
    expect(describeTrustedProxies(false)).toMatch(/none/);
    expect(describeTrustedProxies(["127.0.0.1", "::1"])).toBe("127.0.0.1, ::1");
  });
});
