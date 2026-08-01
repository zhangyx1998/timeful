import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  CONFIG_FILE,
  envOverrides,
  isWebroot,
  mergeConfig,
  readConfigFile,
  serializeConfig,
  writeConfigFile,
} from "./config.ts";
import { CliError } from "./errors.ts";

let cwd: string;

beforeEach(async () => {
  cwd = await fs.mkdtemp(path.join(os.tmpdir(), "timeful-config-"));
});

afterEach(async () => {
  await fs.rm(cwd, { recursive: true, force: true });
});

const write = (body: unknown) =>
  fs.writeFile(path.join(cwd, CONFIG_FILE), JSON.stringify(body), "utf8");

describe("readConfigFile", () => {
  it("returns null when the directory is not a webroot", async () => {
    expect(await readConfigFile(cwd)).toBeNull();
    expect(await isWebroot(cwd)).toBe(false);
  });

  it("reads the four settings", async () => {
    await write({ port: 8080, host: "0.0.0.0", varDir: "/srv/d", trustedProxy: "none" });
    expect(await readConfigFile(cwd)).toEqual({
      port: 8080,
      host: "0.0.0.0",
      varDir: "/srv/d",
      trustedProxy: "none",
    });
    expect(await isWebroot(cwd)).toBe(true);
  });

  it("refuses malformed JSON instead of silently defaulting", async () => {
    await fs.writeFile(path.join(cwd, CONFIG_FILE), "{ nope", "utf8");
    await expect(readConfigFile(cwd)).rejects.toThrow(/not valid JSON/);
  });

  it("refuses a non-object document", async () => {
    await write([1, 2]);
    await expect(readConfigFile(cwd)).rejects.toThrow(/must contain a JSON object/);
  });

  it("refuses bad values with the offending key named", async () => {
    await write({ port: "http" });
    await expect(readConfigFile(cwd)).rejects.toThrow(/port must be an integer/);
    await write({ host: "" });
    await expect(readConfigFile(cwd)).rejects.toThrow(/host: expected a non-empty string/);
    await write({ trustedProxy: 5 });
    await expect(readConfigFile(cwd)).rejects.toThrow(/trustedProxy/);
  });
});

describe("mergeConfig", () => {
  it("falls back to the documented defaults", () => {
    const config = mergeConfig({ cwd });
    expect(config).toMatchObject({
      port: 3000,
      host: "127.0.0.1",
      // The webroot itself, since the default stopped being "./var": one
      // directory to own, one ReadWritePaths= line for the hardened unit.
      varDirRaw: "./",
      varDir: cwd,
      trustedProxy: ["127.0.0.1", "::1"],
    });
  });

  it("applies the file over the defaults", () => {
    const config = mergeConfig({ cwd, file: { port: 8080, varDir: "data" } });
    expect(config.port).toBe(8080);
    expect(config.varDir).toBe(path.join(cwd, "data"));
    expect(config.host).toBe("127.0.0.1");
  });

  it("applies the environment over the file", () => {
    const config = mergeConfig({ cwd, file: { port: 8080 }, env: { port: 9090 } });
    expect(config.port).toBe(9090);
  });

  it("applies flags over everything", () => {
    const config = mergeConfig({
      cwd,
      file: { port: 8080, host: "10.0.0.1" },
      env: { port: 9090 },
      flags: { port: 7070 },
    });
    expect(config.port).toBe(7070);
    // Untouched by the flags, so the file still wins over the default.
    expect(config.host).toBe("10.0.0.1");
  });

  it("resolves a relative data directory against the webroot", () => {
    expect(mergeConfig({ cwd, flags: { varDir: "./state" } }).varDir).toBe(
      path.join(cwd, "state"),
    );
  });

  it("keeps an absolute data directory as given", () => {
    const abs = path.join(os.tmpdir(), "elsewhere");
    expect(mergeConfig({ cwd, flags: { varDir: abs } }).varDir).toBe(abs);
  });

  it("understands every trusted-proxy spelling", () => {
    expect(mergeConfig({ cwd, file: { trustedProxy: "none" } }).trustedProxy).toBe(false);
    expect(mergeConfig({ cwd, file: { trustedProxy: "loopback" } }).trustedProxy).toEqual([
      "127.0.0.1",
      "::1",
    ]);
    expect(
      mergeConfig({ cwd, file: { trustedProxy: ["10.0.0.0/8", "192.168.1.1"] } }).trustedProxy,
    ).toEqual(["10.0.0.0/8", "192.168.1.1"]);
    expect(
      mergeConfig({ cwd, file: { trustedProxy: "10.0.0.0/8, 192.168.1.1" } }).trustedProxy,
    ).toEqual(["10.0.0.0/8", "192.168.1.1"]);
  });

  it("rejects a hostname as a trusted proxy", () => {
    expect(() => mergeConfig({ cwd, file: { trustedProxy: "proxy.example.com" } })).toThrow(
      CliError,
    );
  });

  it("lets a flag override the file's trusted proxies", () => {
    const config = mergeConfig({
      cwd,
      file: { trustedProxy: "10.0.0.0/8" },
      flags: { trustedProxy: "none" },
    });
    expect(config.trustedProxy).toBe(false);
  });
});

describe("envOverrides", () => {
  it("picks up only the variables that are set", () => {
    expect(envOverrides({})).toEqual({});
    expect(envOverrides({ PORT: "8080", VAR_DIR: "/srv/d" })).toEqual({
      port: 8080,
      varDir: "/srv/d",
    });
  });

  it("refuses a nonsense PORT rather than falling back", () => {
    expect(() => envOverrides({ PORT: "eight" })).toThrow(/PORT/);
  });
});

describe("writeConfigFile", () => {
  it("writes every setting, so the file documents itself", async () => {
    const config = mergeConfig({ cwd, flags: { port: 8080, trustedProxy: "none" } });
    const file = await writeConfigFile(cwd, config);
    expect(file).toBe(path.join(cwd, CONFIG_FILE));
    expect(await fs.readFile(file, "utf8")).toBe(
      `{
  "port": 8080,
  "host": "127.0.0.1",
  "varDir": "./",
  "trustedProxy": "none",
  "realtime": true
}
`,
    );
  });

  it("round-trips through readConfigFile", async () => {
    const config = mergeConfig({
      cwd,
      flags: { port: 4000, host: "0.0.0.0", varDir: "data", trustedProxy: "10.0.0.0/8" },
    });
    await writeConfigFile(cwd, config);
    expect(mergeConfig({ cwd, file: await readConfigFile(cwd) })).toEqual(config);
  });

  it("serializes relative data directories as written, not resolved", () => {
    const config = mergeConfig({ cwd, flags: { varDir: "./data" } });
    expect(serializeConfig(config)).toContain(`"varDir": "./data"`);
  });
});
