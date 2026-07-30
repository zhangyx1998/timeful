import { describe, expect, it } from "vitest";
import path from "node:path";
import type { ResolvedConfig } from "./config.ts";
import { scripted } from "./fixtures.ts";
import { runWizard } from "./wizard.ts";

const CWD = "/srv/timeful";

function run(
  answers: string[],
  options: {
    defaults?: Parameters<typeof runWizard>[0]["defaults"];
    endWhenExhausted?: boolean;
    commit?: (config: ResolvedConfig) => Promise<void>;
  } = {},
) {
  const io = scripted(answers, options.endWhenExhausted);
  const committed: ResolvedConfig[] = [];
  const result = runWizard({
    cwd: CWD,
    input: io.input,
    output: io.output,
    defaults: options.defaults,
    commit: async (config) => {
      committed.push(config);
      await options.commit?.(config);
    },
  });
  return { io, committed, result };
}

describe("runWizard", () => {
  it("takes every default when the user just presses Enter", async () => {
    const { result, committed } = run(["", "", "", "", "", "", ""]);
    const answers = await result;

    expect(answers).not.toBeNull();
    expect(answers?.config).toMatchObject({
      port: 3000,
      host: "127.0.0.1",
      varDirRaw: "./var",
      varDir: path.join(CWD, "var"),
      trustedProxy: ["127.0.0.1", "::1"],
    });
    // Start defaults to yes, installing a service defaults to no.
    expect(answers?.startNow).toBe(true);
    expect(answers?.installService).toBe(false);
    expect(committed).toEqual([answers?.config]);
  });

  it("writes the config before offering to start", async () => {
    let transcriptAtCommit = "";
    const { io, result } = run(["y", "", "", "", "", "y", "n"], {
      commit: async () => {
        transcriptAtCommit = io.text();
      },
    });
    await result;
    // Everything in the settings block has been asked by the time the config
    // is written; "start now?" is only offered once the webroot exists.
    expect(transcriptAtCommit).toContain("Trusted proxy");
    expect(transcriptAtCommit).not.toContain("Start the server now?");
    expect(io.text()).toContain("Start the server now?");
  });

  it("records custom answers", async () => {
    const { result } = run([
      "y",
      "8080",
      "0.0.0.0",
      "./data",
      "10.0.0.0/8, 192.168.1.1",
      "n",
      "y",
    ]);
    const answers = await result;
    expect(answers?.config).toMatchObject({
      port: 8080,
      host: "0.0.0.0",
      varDirRaw: "./data",
      varDir: path.join(CWD, "data"),
      trustedProxy: ["10.0.0.0/8", "192.168.1.1"],
    });
    expect(answers?.startNow).toBe(false);
    expect(answers?.installService).toBe(true);
  });

  it("understands 'none' for the trusted proxy", async () => {
    const { result } = run(["", "", "", "", "none", "", ""]);
    expect((await result)?.config.trustedProxy).toBe(false);
  });

  it("returns null and writes nothing when initialization is declined", async () => {
    const { result, committed, io } = run(["n"]);
    expect(await result).toBeNull();
    expect(committed).toEqual([]);
    expect(io.text()).toContain("Nothing was written.");
  });

  it("re-asks until the port is a port", async () => {
    const { result, io } = run(["", "http", "70000", "8080", "", "", "", "", ""]);
    expect((await result)?.config.port).toBe(8080);
    expect(io.text()).toContain("'http' is not a port number");
    expect(io.text()).toContain("'70000' is not a port number");
  });

  it("re-asks until the trusted proxy is an address", async () => {
    const { result, io } = run(["", "", "", "", "proxy.example.com", "10.0.0.1", "", ""]);
    expect((await result)?.config.trustedProxy).toEqual(["10.0.0.1"]);
    expect(io.text()).toContain("hostnames are not allowed");
  });

  it("re-asks until a yes/no question gets a yes or a no", async () => {
    const { result, io } = run(["maybe", "sure", "y", "", "", "", "", "", ""]);
    expect(await result).not.toBeNull();
    expect(io.text()).toContain("Please answer y or n.");
  });

  it("offers command-line settings as the defaults", async () => {
    const { result, io } = run(["", "", "", "", "", "", ""], {
      defaults: { port: 9000, host: "0.0.0.0", varDir: "/srv/data", trustedProxy: "none" },
    });
    const answers = await result;
    expect(answers?.config).toMatchObject({
      port: 9000,
      host: "0.0.0.0",
      varDir: "/srv/data",
      trustedProxy: false,
    });
    expect(io.text()).toContain("Port [9000]");
  });

  it("fails instead of hanging when the input ends mid-wizard", async () => {
    const { result, committed } = run(["y", "8080"], { endWhenExhausted: true });
    await expect(result).rejects.toThrow(/Input ended before the wizard finished/);
    expect(committed).toEqual([]);
  });

  it("says where it is and what it is about to do", async () => {
    const { result, io } = run(["n"]);
    await result;
    expect(io.text()).toContain(`no timeful.config.json in ${CWD}`);
  });
});
