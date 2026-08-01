/**
 * End-to-end tests for the CLI as a process: argv in, exit code and streams
 * out. Everything here runs the real entry point, so it also covers the parts
 * that only exist at the top level — the exit codes and the stdin check.
 *
 * No service is ever activated here: everything that would touch the machine
 * runs with --dry-run, and the service tests run against a temporary HOME so
 * the unit scanner sees only what they planted. Activating a service belongs to
 * the operator, not to a test run.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_FILE } from "./config.ts";
import { webrootHash } from "./service.ts";

const CLI = fileURLToPath(new URL("./index.ts", import.meta.url));

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Runs the CLI with stdin closed (the non-interactive case). `waitFor` stops
 * a long-running process — the server — once it has printed enough.
 */
function runCli(
  args: string[],
  options: {
    cwd: string;
    env?: NodeJS.ProcessEnv;
    /** Variables to remove, so a developer's own environment cannot leak in. */
    unsetEnv?: string[];
    waitFor?: RegExp;
  } = { cwd: process.cwd() },
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, ...options.env };
    for (const name of options.unsetEnv ?? []) delete env[name];
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: options.cwd,
      // 'ignore' is /dev/null: no TTY, and no input to read.
      stdio: ["ignore", "pipe", "pipe"],
      env,
    });
    let stdout = "";
    let stderr = "";
    const settle = (code: number | null) => resolve({ code, stdout, stderr });

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
      if (options.waitFor?.test(stdout)) child.kill("SIGTERM");
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", settle);
  });
}

/**
 * A temporary directory, resolved through any symlinks. macOS puts the temp
 * root behind /var -> /private/var, and a webroot that is spelled two ways
 * hashes two ways: the service id would stop matching the unit the test wrote.
 */
async function tempDir(prefix: string): Promise<string> {
  return fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
}

let cwd: string;

beforeEach(async () => {
  cwd = await tempDir("timeful-cli-");
});

afterEach(async () => {
  await fs.rm(cwd, { recursive: true, force: true });
});

const entries = () => fs.readdir(cwd);

describe("timeful (no webroot, no terminal)", () => {
  it("explains itself on stderr, exits non-zero, and writes nothing", async () => {
    const result = await runCli([], { cwd });

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("is not a Timeful webroot");
    expect(result.stderr).toContain(CONFIG_FILE);
    // The two ways forward have to be in the message, or it is just a refusal.
    expect(result.stderr).toContain("Run 'timeful' from a terminal");
    expect(result.stderr).toContain("--yes");
    // Untouched: a directory is only initialized on purpose.
    expect(await entries()).toEqual([]);
  }, 30000);
});

describe("timeful --yes", () => {
  it("initializes the directory and starts the server without asking", async () => {
    const port = 34000 + Math.floor(Math.random() * 1000);
    const result = await runCli(["--yes", "--port", String(port)], {
      cwd,
      waitFor: /server on http:\/\//,
    });

    expect(result.stdout).toContain(`server on http://127.0.0.1:${port}`);
    expect(JSON.parse(await fs.readFile(path.join(cwd, CONFIG_FILE), "utf8"))).toEqual({
      port,
      host: "127.0.0.1",
      varDir: "./",
      trustedProxy: ["127.0.0.1", "::1"],
      realtime: true,
    });
    // The data directory is the webroot itself now, so nothing else appears
    // until the first event is saved.
    expect((await entries()).sort()).toEqual([CONFIG_FILE]);
  }, 30000);

  it("starts an existing webroot without re-initializing it", async () => {
    const port = 35000 + Math.floor(Math.random() * 1000);
    await fs.writeFile(
      path.join(cwd, CONFIG_FILE),
      JSON.stringify({ port, host: "127.0.0.1", varDir: "./data", trustedProxy: "none" }),
      "utf8",
    );

    // No --yes and no terminal: an existing config is all the CLI needs.
    const result = await runCli([], { cwd, waitFor: /Trusted proxies/ });
    expect(result.stdout).toContain(`server on http://127.0.0.1:${port}`);
    expect(result.stdout).toContain("Trusted proxies: none (X-Forwarded-* ignored)");
  }, 30000);

  it("lets a flag override the config file", async () => {
    await fs.writeFile(path.join(cwd, CONFIG_FILE), JSON.stringify({ port: 39999 }), "utf8");
    const port = 36000 + Math.floor(Math.random() * 1000);

    const result = await runCli(["--port", String(port)], {
      cwd,
      waitFor: /server on http:\/\//,
    });
    expect(result.stdout).toContain(`server on http://127.0.0.1:${port}`);
  }, 30000);
});

describe("timeful --help / --version", () => {
  it("prints usage and exits cleanly", async () => {
    const result = await runCli(["--help"], { cwd });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Usage:");
    expect(await entries()).toEqual([]);
  }, 30000);

  it("prints a version", async () => {
    const result = await runCli(["--version"], { cwd });
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  }, 30000);

  it("rejects an unknown option with a hint", async () => {
    const result = await runCli(["--nope"], { cwd });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Unknown option '--nope'");
  }, 30000);
});

describe("timeful init", () => {
  it("initializes without starting the server", async () => {
    const result = await runCli(["init", "--yes"], { cwd });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Run 'timeful serve'");
    expect(result.stdout).not.toContain("server on http://");
    // The data directory defaults to the webroot itself, so init creates
    // nothing beside the config.
    expect((await entries()).sort()).toEqual([CONFIG_FILE]);
  }, 30000);

  it("refuses a directory that is already a webroot", async () => {
    await fs.writeFile(path.join(cwd, CONFIG_FILE), JSON.stringify({ port: 3999 }), "utf8");
    const result = await runCli(["init", "--yes"], { cwd });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("already a Timeful webroot");
    expect(result.stderr).toContain(CONFIG_FILE);
    expect(result.stderr).toContain("timeful serve");
    // The existing config is the operator's; re-running init must not touch it.
    expect(JSON.parse(await fs.readFile(path.join(cwd, CONFIG_FILE), "utf8"))).toEqual({
      port: 3999,
    });
  }, 30000);

  it("says what it would write under --dry-run, and writes nothing", async () => {
    const result = await runCli(["init", "--yes", "--dry-run", "--port", "4100"], { cwd });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain(`would write ${path.join(cwd, CONFIG_FILE)}`);
    expect(result.stdout).toContain(`would create ${cwd}`);
    // The contents are printed in full, so there is nothing to find out later.
    expect(result.stdout).toContain(`"port": 4100`);
    expect(await entries()).toEqual([]);
  }, 30000);

  it("explains itself without a terminal and no --yes", async () => {
    const result = await runCli(["init"], { cwd });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("stdin is not a terminal");
    expect(await entries()).toEqual([]);
  }, 30000);
});

describe("timeful serve", () => {
  it("refuses a directory that is not a webroot, and never asks", async () => {
    const result = await runCli(["serve"], { cwd });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("is not a Timeful webroot");
    expect(result.stderr).toContain("timeful init");
    // The wizard is for `init`. `serve` serves or fails.
    expect(result.stdout).toBe("");
    expect(await entries()).toEqual([]);
  }, 30000);

  it("serves a webroot", async () => {
    const port = 37000 + Math.floor(Math.random() * 1000);
    await fs.writeFile(path.join(cwd, CONFIG_FILE), JSON.stringify({ port }), "utf8");

    const result = await runCli(["serve"], { cwd, waitFor: /server on http:\/\// });
    expect(result.stdout).toContain(`server on http://127.0.0.1:${port}`);
  }, 30000);

  it("says what it would serve under --dry-run, and binds nothing", async () => {
    await fs.writeFile(path.join(cwd, CONFIG_FILE), JSON.stringify({ port: 4200 }), "utf8");
    const result = await runCli(["serve", "--dry-run"], { cwd });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("would serve http://127.0.0.1:4200");
    expect(result.stdout).toContain("Dry run: no server was started.");
  }, 30000);
});

// ---------------------------------------------------------------------------
// services
//
// Every one of these runs against a temporary HOME, so the scanner sees the
// units the test planted and never the developer's own. Anything that would
// touch the machine runs with --dry-run: activating a service belongs to the
// operator, not to a test run.
// ---------------------------------------------------------------------------

let home: string;

/** The environment that makes this process's HOME the temporary one. */
function sandbox(): { env: NodeJS.ProcessEnv; unsetEnv: string[] } {
  return {
    env: { HOME: home, USERPROFILE: home },
    unsetEnv: ["XDG_CONFIG_HOME", "LOCALAPPDATA", "TIMEFUL_SERVICE_DRY_RUN"],
  };
}

/**
 * Writes a unit for `webroot` where this platform keeps them, as if installed.
 *
 * `cliPath` pins an ExecStart (or its plist/launcher equivalent), which is what
 * `timeful upgrade` reads back and rewrites; the service verbs never look at it
 * and pass nothing.
 */
async function plantUnit(webroot: string, cliPath?: string): Promise<string> {
  const hash = webrootHash(webroot);
  if (process.platform === "darwin") {
    const file = path.join(home, "Library", "LaunchAgents", `app.timeful.${hash}.plist`);
    await fs.mkdir(path.dirname(file), { recursive: true });
    const programArguments = cliPath
      ? `    <key>ProgramArguments</key>
    <array>
      <string>/usr/bin/node</string>
      <string>${cliPath}</string>
      <string>serve</string>
    </array>
`
      : "";
    await fs.writeFile(
      file,
      `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>app.timeful.${hash}</string>
${programArguments}    <key>WorkingDirectory</key>
    <string>${webroot}</string>
  </dict>
</plist>
`,
      "utf8",
    );
    return file;
  }
  if (process.platform === "win32") {
    const file = path.join(home, "AppData", "Local", "Timeful", `Timeful-${hash}.cmd`);
    await fs.mkdir(path.dirname(file), { recursive: true });
    const exec = cliPath ? `"/usr/bin/node" "${cliPath}" serve\r\n` : "";
    await fs.writeFile(file, `@echo off\r\ncd /d "${webroot}"\r\n${exec}`, "utf8");
    return file;
  }
  const file = path.join(home, ".config", "systemd", "user", `timeful-${hash}.service`);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const exec = cliPath ? `ExecStart=/usr/bin/node ${cliPath} serve\n` : "";
  await fs.writeFile(file, `[Service]\nWorkingDirectory=${webroot}\n${exec}`, "utf8");
  return file;
}

describe("timeful service", () => {
  beforeEach(async () => {
    home = await tempDir("timeful-home-");
    await fs.writeFile(path.join(cwd, CONFIG_FILE), JSON.stringify({ port: 4300 }), "utf8");
  });

  afterEach(async () => {
    await fs.rm(home, { recursive: true, force: true });
  });

  it("refuses to manage a directory that is not a webroot", async () => {
    const empty = await tempDir("timeful-empty-");
    const result = await runCli(["service", "status"], { cwd: empty, ...sandbox() });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("no Timeful services are installed");
    expect(await fs.readdir(empty)).toEqual([]);
    await fs.rm(empty, { recursive: true, force: true });
  }, 30000);

  it("reports a webroot with nothing installed", async () => {
    const result = await runCli(["service", "status"], { cwd, ...sandbox() });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("user tier: not installed");
    expect(result.stdout).toContain("configured to serve http://127.0.0.1:4300");
  }, 30000);

  it("says nothing is installed when nothing is", async () => {
    const result = await runCli(["service"], { cwd, ...sandbox() });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("No Timeful services are installed");
  }, 30000);

  it("lists what the scan finds, with the webroot read out of the unit", async () => {
    const file = await plantUnit(cwd);
    const result = await runCli(["service"], { cwd, ...sandbox() });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Installed Timeful services:");
    expect(result.stdout).toContain(cwd);
    expect(result.stdout).toContain(file);
    // The port comes from that webroot's own config, not from this directory.
    expect(result.stdout).toContain("http://127.0.0.1:4300");
  }, 30000);

  it("prints the unit and every command under --dry-run, and touches nothing", async () => {
    const result = await runCli(["service", "install", "--user", "--dry-run"], {
      cwd,
      ...sandbox(),
    });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Dry run: nothing below is written or executed.");
    expect(result.stdout).toContain("Service file:");
    expect(result.stdout).toContain("Commands to activate it:");
    expect(result.stdout).toContain("would write ");
    expect(result.stdout).toContain("would run: ");
    expect(result.stdout).toContain("was not installed");
    expect(result.stdout).toContain("To undo:");
    // Nothing ran and nothing was written; every effect is announced instead.
    expect((await entries()).sort()).toEqual([CONFIG_FILE]);
    expect(await fs.readdir(home)).toEqual([]);
  }, 30000);

  it("still honours TIMEFUL_SERVICE_DRY_RUN, which came first", async () => {
    const box = sandbox();
    const result = await runCli(["service", "install", "--user"], {
      cwd,
      env: { ...box.env, TIMEFUL_SERVICE_DRY_RUN: "1" },
      unsetEnv: ["XDG_CONFIG_HOME", "LOCALAPPDATA"],
    });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("would run: ");
    expect(await fs.readdir(home)).toEqual([]);
  }, 30000);

  it("starts, stops and restarts an installed service by naming its commands", async () => {
    const file = await plantUnit(cwd);

    for (const verb of ["stop", "start", "restart"]) {
      const result = await runCli(["service", verb, "--dry-run"], { cwd, ...sandbox() });
      expect(result.code).toBe(0);
      expect(result.stdout).toContain("would run: ");
      expect(result.stdout).toContain("was left alone");
    }
    // A dry run leaves the installation exactly as it found it.
    expect(await fs.readFile(file, "utf8")).toContain(cwd);
  }, 30000);

  it("uninstalls what the scan found, without removing it in a dry run", async () => {
    const file = await plantUnit(cwd);
    const result = await runCli(["service", "uninstall", "--dry-run"], { cwd, ...sandbox() });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("would run: ");
    expect(result.stdout).toContain(`would remove ${file}`);
    expect(await fs.readFile(file, "utf8")).toContain(cwd);
  }, 30000);

  it("takes a webroot as an argument, and checks it is one", async () => {
    await plantUnit(cwd);
    const elsewhere = await tempDir("timeful-other-");

    const named = await runCli(["service", "status", cwd, "--dry-run"], {
      cwd: elsewhere,
      ...sandbox(),
    });
    expect(named.code).toBe(0);
    expect(named.stdout).toContain(cwd);
    expect(named.stdout).toContain("user tier: installed");

    const wrong = await runCli(["service", "status", elsewhere], { cwd, ...sandbox() });
    expect(wrong.code).toBe(1);
    expect(wrong.stderr).toContain("is not a Timeful webroot");

    await fs.rm(elsewhere, { recursive: true, force: true });
  }, 30000);

  it("applies -A to every installed webroot", async () => {
    const second = await tempDir("timeful-second-");
    await fs.writeFile(path.join(second, CONFIG_FILE), JSON.stringify({ port: 4400 }), "utf8");
    await plantUnit(cwd);
    await plantUnit(second);

    const result = await runCli(["service", "stop", "-A", "--dry-run"], { cwd, ...sandbox() });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(cwd);
    expect(result.stdout).toContain(second);

    await fs.rm(second, { recursive: true, force: true });
  }, 30000);

  it("refuses -A for install, which needs one webroot", async () => {
    const result = await runCli(["service", "install", "-A"], { cwd, ...sandbox() });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("works on one webroot");
  }, 30000);

  it("says so when a webroot has no service to control", async () => {
    const result = await runCli(["service", "restart", "--dry-run"], { cwd, ...sandbox() });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("no Timeful service is installed");
  }, 30000);

  it("names the candidates instead of guessing, with no terminal to ask at", async () => {
    const second = await tempDir("timeful-second-");
    await fs.writeFile(path.join(second, CONFIG_FILE), "{}", "utf8");
    await plantUnit(cwd);
    await plantUnit(second);
    const elsewhere = await tempDir("timeful-other-");

    const result = await runCli(["service", "restart"], { cwd: elsewhere, ...sandbox() });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("several are installed");
    expect(result.stderr).toContain(cwd);
    expect(result.stderr).toContain(second);
    expect(result.stderr).toContain("timeful service restart <path-to-webroot>");

    await fs.rm(second, { recursive: true, force: true });
    await fs.rm(elsewhere, { recursive: true, force: true });
  }, 30000);
});

// ---------------------------------------------------------------------------
// upgrade
//
// Same rules as above: a temporary HOME, and --dry-run everywhere, so no
// service is ever activated and — because a dry run touches nothing at all —
// the npm registry is never contacted from a test run either.
// ---------------------------------------------------------------------------

describe("timeful upgrade", () => {
  const OLD_CLI = "/home/ada/.npm/_npx/0123456789abcdef/node_modules/timeful/cli.js";

  beforeEach(async () => {
    home = await tempDir("timeful-home-");
    await fs.writeFile(path.join(cwd, CONFIG_FILE), JSON.stringify({ port: 4500 }), "utf8");
  });

  afterEach(async () => {
    await fs.rm(home, { recursive: true, force: true });
  });

  it("re-points the unit at the running CLI and restarts it", async () => {
    const file = await plantUnit(cwd, OLD_CLI);
    const result = await runCli(["upgrade", "--dry-run"], { cwd, ...sandbox() });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain(`was ${OLD_CLI}`);
    expect(result.stdout).toContain(`now ${CLI}`);
    // The new unit is printed in full before anything would happen to it.
    expect(result.stdout).toContain(CLI);
    expect(result.stdout).toContain("would write ");
    expect(result.stdout).toContain("would run: ");
    // A dry run leaves the installed unit exactly as it found it.
    expect(await fs.readFile(file, "utf8")).toContain(OLD_CLI);
  }, 30000);

  it("never contacts the registry in a dry run", async () => {
    await plantUnit(cwd, OLD_CLI);
    const result = await runCli(["upgrade", "--dry-run"], { cwd, ...sandbox() });
    expect(result.stdout).toContain("the npm registry was not contacted");
  }, 30000);

  it("explains how a serve-only webroot upgrades, and writes nothing", async () => {
    const result = await runCli(["upgrade", "--dry-run"], { cwd, ...sandbox() });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("No Timeful service is installed");
    expect(result.stdout).toContain(`cd ${cwd} && npx timeful@latest`);
    expect(result.stdout).not.toContain("would write ");
    expect((await entries()).sort()).toEqual([CONFIG_FILE]);
    expect(await fs.readdir(home)).toEqual([]);
  }, 30000);

  it("applies -A to every webroot the scan found", async () => {
    const second = await tempDir("timeful-second-");
    await fs.writeFile(path.join(second, CONFIG_FILE), JSON.stringify({ port: 4600 }), "utf8");
    await plantUnit(cwd, OLD_CLI);
    await plantUnit(second, OLD_CLI);

    const result = await runCli(["upgrade", "-A", "--dry-run"], { cwd, ...sandbox() });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(cwd);
    expect(result.stdout).toContain(second);
    // Swept up rather than named: one line each, not the serve-only lecture.
    expect(result.stdout).not.toContain("npx timeful@latest");

    await fs.rm(second, { recursive: true, force: true });
  }, 30000);

  it("takes a webroot as an argument, and checks it is one", async () => {
    await plantUnit(cwd, OLD_CLI);
    const elsewhere = await tempDir("timeful-other-");

    const named = await runCli(["upgrade", cwd, "--dry-run"], {
      cwd: elsewhere,
      ...sandbox(),
    });
    expect(named.code).toBe(0);
    expect(named.stdout).toContain(`was ${OLD_CLI}`);

    const wrong = await runCli(["upgrade", elsewhere, "--dry-run"], { cwd, ...sandbox() });
    expect(wrong.code).toBe(1);
    expect(wrong.stderr).toContain("is not a Timeful webroot");

    await fs.rm(elsewhere, { recursive: true, force: true });
  }, 30000);

  it("names the candidates instead of guessing, with no terminal to ask at", async () => {
    const second = await tempDir("timeful-second-");
    await fs.writeFile(path.join(second, CONFIG_FILE), "{}", "utf8");
    await plantUnit(cwd, OLD_CLI);
    await plantUnit(second, OLD_CLI);
    const elsewhere = await tempDir("timeful-other-");

    const result = await runCli(["upgrade"], { cwd: elsewhere, ...sandbox() });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("several are installed");
    expect(result.stderr).toContain("timeful upgrade <path-to-webroot>");

    await fs.rm(second, { recursive: true, force: true });
    await fs.rm(elsewhere, { recursive: true, force: true });
  }, 30000);
});
