import { describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";
import { CliError } from "./errors.ts";
import {
  availableTiers,
  controlFor,
  controlService,
  describeRunState,
  detectSystemd,
  formatCommand,
  installService,
  probeFor,
  readRunReport,
  readRunState,
  refFor,
  serviceId,
  serviceStatus,
  uninstallService,
  unitFor,
  webrootHash,
  type ServiceCommand,
  type ServiceHost,
  type ServiceRef,
  type ServiceSpec,
  type ServiceTier,
} from "./service.ts";

const WEBROOT = "/srv/timeful";
const HASH = webrootHash(WEBROOT);

function spec(overrides: Partial<ServiceSpec> = {}): ServiceSpec {
  return {
    platform: "linux",
    tier: "user",
    webroot: WEBROOT,
    varDir: "/srv/timeful/var",
    nodePath: "/usr/bin/node",
    cliPath: "/usr/lib/node_modules/timeful/cli.js",
    home: "/home/ada",
    uid: 501,
    ...overrides,
  };
}

/** A host that records everything instead of touching the machine. */
function fakeHost(
  options: {
    existing?: string[];
    which?: (bin: string) => boolean;
    fail?: string;
    /** Mirrors the real host: narrate, change nothing. */
    dryRun?: boolean;
  } = {},
) {
  const files = new Map<string, string>();
  const ran: ServiceCommand[] = [];
  const lines: string[] = [];
  const existing = new Set(options.existing ?? []);
  const host: ServiceHost = {
    dryRun: options.dryRun,
    async writeFile(file, contents) {
      if (options.dryRun) return;
      files.set(file, contents);
      existing.add(file);
    },
    async readFile(file) {
      // Reads are honoured in a dry run too, exactly as the real host does.
      return files.get(file) ?? null;
    },
    async removeFile(file) {
      if (options.dryRun) return;
      files.delete(file);
      existing.delete(file);
    },
    async exists(file) {
      return existing.has(file);
    },
    async run(cmd) {
      if (options.dryRun) {
        lines.push(`  would run: ${formatCommand(cmd)}`);
        return { code: 0, stdout: "", stderr: "" };
      }
      ran.push(cmd);
      const failed = options.fail && formatCommand(cmd).includes(options.fail);
      return { code: failed ? 3 : 0, stdout: failed ? "" : "active (running)", stderr: "" };
    },
    async which(binary) {
      return options.which ? options.which(binary) : true;
    },
    log(line = "") {
      lines.push(line);
    },
  };
  return { host, files, ran, text: () => lines.join("\n") };
}

const commands = (cmds: ServiceCommand[]) => cmds.map(formatCommand);

describe("webrootHash", () => {
  it("is stable, short, and specific to the directory", () => {
    expect(HASH).toMatch(/^[0-9a-f]{10}$/);
    expect(webrootHash(WEBROOT)).toBe(HASH);
    expect(webrootHash("/srv/other")).not.toBe(HASH);
  });

  it("ignores how the path was spelled", () => {
    expect(webrootHash("/srv/timeful/")).toBe(HASH);
    expect(webrootHash("/srv/./timeful")).toBe(HASH);
  });
});

describe("serviceId", () => {
  it("follows each platform's naming convention", () => {
    expect(serviceId(spec({ platform: "darwin" }))).toBe(`app.timeful.${HASH}`);
    expect(serviceId(spec({ platform: "linux" }))).toBe(`timeful-${HASH}`);
    expect(serviceId(spec({ platform: "win32" }))).toBe(`Timeful-${HASH}`);
  });
});

describe("availableTiers", () => {
  it("offers the hardened tier on Linux only", () => {
    expect(availableTiers("linux")).toEqual(["user", "system"]);
    expect(availableTiers("darwin")).toEqual(["user"]);
    expect(availableTiers("win32")).toEqual(["user"]);
  });
});

describe("unitFor: macOS launchd", () => {
  const unit = unitFor(spec({ platform: "darwin", home: "/Users/ada" }));

  it("writes a LaunchAgent named after the webroot", () => {
    expect(unit.id).toBe(`app.timeful.${HASH}`);
    expect(unit.file).toBe(`/Users/ada/Library/LaunchAgents/app.timeful.${HASH}.plist`);
    expect(unit.privileged).toBe(false);
  });

  it("generates the plist", () => {
    expect(unit.contents).toBe(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>app.timeful.${HASH}</string>
    <key>ProgramArguments</key>
    <array>
      <string>/usr/bin/node</string>
      <string>/usr/lib/node_modules/timeful/cli.js</string>
      <string>serve</string>
    </array>
    <key>WorkingDirectory</key>
    <string>/srv/timeful</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ProcessType</key>
    <string>Background</string>
    <key>StandardOutPath</key>
    <string>/srv/timeful/var/timeful.out.log</string>
    <key>StandardErrorPath</key>
    <string>/srv/timeful/var/timeful.err.log</string>
  </dict>
</plist>
`);
  });

  it("drives launchctl in the user's gui domain", () => {
    expect(commands(unit.activate)).toEqual([
      `launchctl bootstrap gui/501 /Users/ada/Library/LaunchAgents/app.timeful.${HASH}.plist`,
    ]);
    expect(commands(unit.deactivate)).toEqual([`launchctl bootout gui/501/app.timeful.${HASH}`]);
    expect(commands(unit.status)).toEqual([`launchctl print gui/501/app.timeful.${HASH}`]);
  });

  it("escapes paths that would break the XML", () => {
    const odd = unitFor(spec({ platform: "darwin", webroot: `/srv/a&b<c>` }));
    expect(odd.contents).toContain("<string>/srv/a&amp;b&lt;c&gt;</string>");
  });
});

describe("unitFor: Linux systemd user unit", () => {
  const unit = unitFor(spec({ tier: "user" }));

  it("writes into the user unit directory", () => {
    expect(unit.id).toBe(`timeful-${HASH}.service`);
    expect(unit.file).toBe(`/home/ada/.config/systemd/user/timeful-${HASH}.service`);
    expect(unit.privileged).toBe(false);
    expect(unit.staging).toBeUndefined();
  });

  it("honours XDG_CONFIG_HOME", () => {
    const moved = unitFor(spec({ configHome: "/home/ada/.cfg" }));
    expect(moved.file).toBe(`/home/ada/.cfg/systemd/user/timeful-${HASH}.service`);
  });

  it("generates the unit", () => {
    expect(unit.contents).toBe(`[Unit]
Description=Timeful (/srv/timeful)
After=network.target

[Service]
Type=simple
WorkingDirectory=/srv/timeful
ExecStart=/usr/bin/node /usr/lib/node_modules/timeful/cli.js serve
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`);
  });

  it("drives systemctl --user, never sudo", () => {
    expect(commands(unit.activate)).toEqual([
      "systemctl --user daemon-reload",
      `systemctl --user enable --now timeful-${HASH}.service`,
    ]);
    expect(commands(unit.deactivate)).toEqual([
      `systemctl --user disable --now timeful-${HASH}.service`,
    ]);
    expect(commands(unit.status)).toEqual([`systemctl --user status timeful-${HASH}.service`]);
  });
});

describe("unitFor: Linux hardened system unit", () => {
  const unit = unitFor(spec({ tier: "system" }));

  it("targets /etc/systemd/system through a staging file", () => {
    expect(unit.id).toBe(`timeful-${HASH}.service`);
    expect(unit.file).toBe(`/etc/systemd/system/timeful-${HASH}.service`);
    expect(unit.privileged).toBe(true);
    // Written somewhere unprivileged first, then installed with sudo.
    expect(unit.staging).toBe(path.join(os.tmpdir(), unit.id));
  });

  it("generates the sandboxed unit", () => {
    expect(unit.contents).toBe(`[Unit]
Description=Timeful (/srv/timeful)
After=network.target

[Service]
Type=simple
DynamicUser=yes
WorkingDirectory=/srv/timeful
ExecStart=/usr/bin/node /usr/lib/node_modules/timeful/cli.js serve
ReadWritePaths=/srv/timeful
ProtectSystem=strict
ProtectHome=yes
NoNewPrivileges=yes
PrivateTmp=yes
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
`);
  });

  it("grants write access to the webroot and nowhere else", () => {
    // ProtectSystem=strict makes everything read-only, so the webroot has to
    // be named explicitly or the server cannot write var/.
    expect(unit.contents).toContain(`ReadWritePaths=${WEBROOT}`);
    expect(unit.contents.match(/^ReadWritePaths=.*$/gm)).toHaveLength(1);
  });

  it("starts at boot rather than at login", () => {
    expect(unit.contents).toContain("WantedBy=multi-user.target");
  });

  it("drives systemctl with sudo", () => {
    expect(commands(unit.activate)).toEqual([
      `sudo install -m 0644 ${unit.staging} /etc/systemd/system/timeful-${HASH}.service`,
      "sudo systemctl daemon-reload",
      `sudo systemctl enable --now timeful-${HASH}.service`,
    ]);
    expect(commands(unit.deactivate)).toEqual([
      `sudo systemctl disable --now timeful-${HASH}.service`,
      `sudo rm -f /etc/systemd/system/timeful-${HASH}.service`,
      "sudo systemctl daemon-reload",
    ]);
    // Reading status needs no privileges.
    expect(commands(unit.status)).toEqual([`systemctl status timeful-${HASH}.service`]);
  });
});

describe("unitFor: Windows schtasks", () => {
  const unit = unitFor(
    spec({ platform: "win32", localAppData: "C:\\Users\\Ada\\AppData\\Local" }),
  );

  it("writes a launcher, because schtasks has no working directory", () => {
    expect(unit.id).toBe(`Timeful-${HASH}`);
    expect(unit.file).toBe(path.join("C:\\Users\\Ada\\AppData\\Local", "Timeful", `Timeful-${HASH}.cmd`));
    expect(unit.contents).toBe(
      `@echo off\r\ncd /d "/srv/timeful"\r\n"/usr/bin/node" "/usr/lib/node_modules/timeful/cli.js" serve\r\n`,
    );
  });

  it("registers a logon task", () => {
    expect(commands(unit.activate)).toEqual([
      `schtasks /create /tn Timeful-${HASH} /tr '"${unit.file}"' /sc onlogon /f`,
    ]);
    expect(commands(unit.deactivate)).toEqual([`schtasks /delete /tn Timeful-${HASH} /f`]);
    expect(commands(unit.status)).toEqual([`schtasks /query /tn Timeful-${HASH}`]);
  });
});

describe("unitFor: unsupported platforms", () => {
  it("says so instead of generating nonsense", () => {
    expect(() => unitFor(spec({ platform: "aix" }))).toThrow(CliError);
  });
});

describe("installService", () => {
  it("writes the unit, activates it, and says how to undo it", async () => {
    const unit = unitFor(spec({ tier: "user" }));
    const { host, files, ran, text } = fakeHost();

    expect(await installService(unit, host)).toBe(true);
    expect(files.get(unit.file)).toBe(unit.contents);
    expect(commands(ran)).toEqual(commands(unit.activate));
    expect(text()).toContain(`Wrote ${unit.file}`);
    expect(text()).toContain("To undo:");
    expect(text()).toContain("timeful service uninstall");
  });

  it("prints the whole unit before doing anything", async () => {
    const unit = unitFor(spec({ tier: "system" }));
    const { host, text } = fakeHost();
    await installService(unit, host, { confirmPrivileged: async () => true });
    expect(text()).toContain("DynamicUser=yes");
    expect(text()).toContain("sudo systemctl enable --now");
    expect(text()).toContain("ephemeral system user");
    expect(text()).toContain("will be written by that user, not by you");
  });

  it("suggests '--system' in the undo line for the hardened tier", async () => {
    const unit = unitFor(spec({ tier: "system" }));
    const { host, text } = fakeHost();
    await installService(unit, host, { confirmPrivileged: async () => true });
    expect(text()).toContain("timeful service uninstall --system");
  });

  it("stages the unit and runs nothing when sudo is declined", async () => {
    const unit = unitFor(spec({ tier: "system" }));
    const { host, files, ran, text } = fakeHost();

    expect(await installService(unit, host, { confirmPrivileged: async () => false })).toBe(
      false,
    );
    expect(ran).toEqual([]);
    expect(files.get(unit.staging ?? "")).toBe(unit.contents);
    expect(files.has(unit.file)).toBe(false);
    expect(text()).toContain("run the commands above to finish");
  });

  it("stages the unit and runs nothing when sudo is missing", async () => {
    const unit = unitFor(spec({ tier: "system" }));
    const { host, ran, text } = fakeHost({ which: () => false });

    expect(await installService(unit, host)).toBe(false);
    expect(ran).toEqual([]);
    expect(text()).toContain("sudo is not available");
  });

  it("says nothing happened when the host is only pretending", async () => {
    const unit = unitFor(spec({ tier: "user" }));
    const { host, text } = fakeHost();
    await installService(unit, { ...host, dryRun: true });
    expect(text()).toContain(`would write ${unit.file}`);
    expect(text()).toContain(`Dry run: ${unit.id} was not installed.`);
    expect(text()).not.toContain("Installed and started");
  });

  it("reports a failed activation instead of claiming success", async () => {
    const unit = unitFor(spec({ tier: "user" }));
    const { host } = fakeHost({ fail: "enable --now" });
    await expect(installService(unit, host)).rejects.toThrow(/Command failed \(exit 3\)/);
  });
});

describe("uninstallService", () => {
  it("deactivates and removes an unprivileged unit", async () => {
    const unit = unitFor(spec({ tier: "user" }));
    const { host, files, ran } = fakeHost();
    await host.writeFile(unit.file, unit.contents);

    await uninstallService(unit, host);
    expect(commands(ran)).toEqual(commands(unit.deactivate));
    expect(files.has(unit.file)).toBe(false);
  });

  it("leaves the privileged file to the sudo command that owns it", async () => {
    const unit = unitFor(spec({ tier: "system" }));
    const { host, files, ran } = fakeHost();
    files.set(unit.file, unit.contents);

    await uninstallService(unit, host);
    expect(commands(ran)).toContain(`sudo rm -f ${unit.file}`);
    // Not deleted directly: an unprivileged rm would just fail.
    expect(files.has(unit.file)).toBe(true);
  });

  it("survives uninstalling something that was never active", async () => {
    const unit = unitFor(spec({ tier: "user" }));
    const { host, text } = fakeHost({ fail: "disable" });
    await expect(uninstallService(unit, host)).resolves.toBeUndefined();
    expect(text()).toContain("(ignored)");
  });
});

describe("serviceStatus", () => {
  it("reports every tier, so either one is found", async () => {
    const tiers: ServiceTier[] = ["user", "system"];
    const specs = tiers.map((tier) => spec({ tier }));
    const systemUnit = unitFor(specs[1]);
    const { host } = fakeHost({ existing: [systemUnit.file] });

    const report = await serviceStatus(specs, host);
    expect(report).toEqual([
      {
        tier: "user",
        id: `timeful-${HASH}.service`,
        file: `/home/ada/.config/systemd/user/timeful-${HASH}.service`,
        installed: false,
      },
      {
        tier: "system",
        id: `timeful-${HASH}.service`,
        file: `/etc/systemd/system/timeful-${HASH}.service`,
        installed: true,
        state: "running",
        report: "active (running)",
      },
    ]);
  });
});

describe("detectSystemd", () => {
  it("needs a user manager before offering systemctl --user", async () => {
    const { host } = fakeHost({ which: (bin) => bin === "systemctl" });
    expect(await detectSystemd(host, { XDG_RUNTIME_DIR: "/run/user/501" })).toEqual({
      systemctl: true,
      userManager: true,
    });
    expect(await detectSystemd(host, {})).toEqual({ systemctl: true, userManager: false });
  });

  it("reports no systemd at all when systemctl is missing", async () => {
    const { host } = fakeHost({ which: () => false });
    expect(await detectSystemd(host, { XDG_RUNTIME_DIR: "/run/user/501" })).toEqual({
      systemctl: false,
      userManager: false,
    });
  });
});

describe("controlFor", () => {
  const ref = (overrides: Partial<ServiceRef> = {}): ServiceRef => ({
    platform: "linux",
    tier: "user",
    id: `timeful-${HASH}.service`,
    file: `/home/ada/.config/systemd/user/timeful-${HASH}.service`,
    uid: 501,
    ...overrides,
  });

  it("drives systemctl --user for the user tier", () => {
    expect(commands(controlFor(ref(), "start"))).toEqual([
      `systemctl --user start timeful-${HASH}.service`,
    ]);
    expect(commands(controlFor(ref(), "stop"))).toEqual([
      `systemctl --user stop timeful-${HASH}.service`,
    ]);
    expect(commands(controlFor(ref(), "restart"))).toEqual([
      `systemctl --user restart timeful-${HASH}.service`,
    ]);
  });

  it("asks for sudo on the system tier, unless it is already root", () => {
    expect(commands(controlFor(ref({ tier: "system" }), "restart"))).toEqual([
      `sudo systemctl restart timeful-${HASH}.service`,
    ]);
    expect(commands(controlFor(ref({ tier: "system", uid: 0 }), "restart"))).toEqual([
      `systemctl restart timeful-${HASH}.service`,
    ]);
  });

  it("loads and unloads a LaunchAgent, because launchd has no restart", () => {
    const agent = ref({
      platform: "darwin",
      id: `app.timeful.${HASH}`,
      file: `/Users/ada/Library/LaunchAgents/app.timeful.${HASH}.plist`,
    });
    expect(commands(controlFor(agent, "start"))).toEqual([
      `launchctl bootstrap gui/501 /Users/ada/Library/LaunchAgents/app.timeful.${HASH}.plist`,
    ]);
    expect(commands(controlFor(agent, "stop"))).toEqual([
      `launchctl bootout gui/501/app.timeful.${HASH}`,
    ]);
    expect(commands(controlFor(agent, "restart"))).toEqual([
      `launchctl bootout gui/501/app.timeful.${HASH}`,
      `launchctl bootstrap gui/501 /Users/ada/Library/LaunchAgents/app.timeful.${HASH}.plist`,
    ]);
    // An agent that was not loaded is not a failed restart.
    expect(controlFor(agent, "restart")[0].tolerant).toBe(true);
  });

  it("runs and ends a scheduled task on Windows", () => {
    const task = ref({ platform: "win32", id: `Timeful-${HASH}`, file: "C:\\x.cmd" });
    expect(commands(controlFor(task, "start"))).toEqual([`schtasks /run /tn Timeful-${HASH}`]);
    expect(commands(controlFor(task, "stop"))).toEqual([`schtasks /end /tn Timeful-${HASH}`]);
    expect(commands(controlFor(task, "restart"))).toEqual([
      `schtasks /end /tn Timeful-${HASH}`,
      `schtasks /run /tn Timeful-${HASH}`,
    ]);
  });

  it("says so on a platform it cannot drive", () => {
    expect(() => controlFor(ref({ platform: "aix" }), "start")).toThrow(CliError);
  });
});

describe("probeFor / readRunState", () => {
  it("asks each platform the cheapest question that actually answers it", () => {
    // Not `is-active`: its one word calls a crash loop "activating", which is
    // how a unit that never started once used to read as running.
    expect(
      formatCommand(
        probeFor({ platform: "linux", tier: "user", id: "timeful-x.service", file: "/x" }),
      ),
    ).toBe("systemctl --user show -p ActiveState -p SubState -p NRestarts timeful-x.service");
    expect(
      formatCommand(
        probeFor({ platform: "linux", tier: "system", id: "timeful-x.service", file: "/x" }),
      ),
    ).toBe("systemctl show -p ActiveState -p SubState -p NRestarts timeful-x.service");
    expect(
      formatCommand(probeFor({ platform: "darwin", tier: "user", id: "app.timeful.x", file: "/x" })),
    ).toBe("launchctl list app.timeful.x");
  });

  const show = (active: string, sub = "", restarts?: number) =>
    readRunReport("linux", {
      code: 0,
      stdout: [
        `ActiveState=${active}`,
        `SubState=${sub}`,
        ...(restarts === undefined ? [] : [`NRestarts=${restarts}`]),
      ].join("\n"),
      stderr: "",
    });

  it("turns systemd's vocabulary into a state", () => {
    expect(show("active", "running").state).toBe("running");
    expect(show("inactive", "dead").state).toBe("stopped");
    expect(show("deactivating", "stop-sigterm").state).toBe("stopped");
    expect(show("failed", "failed").state).toBe("failed");
    expect(show("nonsense", "").state).toBe("unknown");
  });

  it("refuses to call a crash loop running", () => {
    // The bug: a unit failing at exec spends nearly all of its life waiting out
    // RestartSec, where is-active says "activating".
    expect(show("activating", "auto-restart", 7).state).toBe("failed");
    expect(show("activating", "auto-restart").state).toBe("failed");
    // A genuine start caught in the act is neither running nor failed.
    expect(show("activating", "start").state).toBe("starting");
    expect(show("reloading", "reload").state).toBe("starting");
  });

  it("counts the restarts behind the state, so a loop shows even mid-attempt", () => {
    expect(show("activating", "start", 12).restarts).toBe(12);
    expect(show("active", "running", 0).restarts).toBe(0);
    expect(show("active", "running").restarts).toBeUndefined();
    expect(describeRunState(show("activating", "auto-restart", 12))).toBe(
      "failed (12 automatic restarts)",
    );
    expect(describeRunState(show("activating", "auto-restart", 1))).toBe(
      "failed (1 automatic restart)",
    );
    // Nothing to add is nothing added.
    expect(describeRunState(show("active", "running", 0))).toBe("running");
    expect(describeRunState({ state: "stopped" })).toBe("stopped");
  });

  it("still reads the one word `is-active` prints, by hand or from an old unit", () => {
    const state = (stdout: string, code = 0) => readRunState("linux", { code, stdout, stderr: "" });
    expect(state("active\n")).toBe("running");
    expect(state("inactive\n", 3)).toBe("stopped");
    expect(state("failed\n", 3)).toBe("failed");
    expect(state("unknown\n", 4)).toBe("unknown");
    // Without a SubState there is no way to tell a loop from a start, and
    // "starting" is the honest half of the two — never "running".
    expect(state("activating\n")).toBe("starting");
  });

  it("treats a loaded LaunchAgent as a running one", () => {
    expect(readRunState("darwin", { code: 0, stdout: "{}", stderr: "" })).toBe("running");
    expect(readRunState("darwin", { code: 113, stdout: "", stderr: "" })).toBe("stopped");
  });

  it("reads the status line schtasks prints", () => {
    const state = (stdout: string) => readRunState("win32", { code: 0, stdout, stderr: "" });
    expect(state("TaskName: X\nStatus:  Running\n")).toBe("running");
    expect(state("TaskName: X\nStatus:  Ready\n")).toBe("stopped");
    expect(state("TaskName: X\n")).toBe("unknown");
  });
});

describe("controlService", () => {
  const unit = unitFor(spec({ tier: "user" }));

  it("says what it is about to run, then runs it", async () => {
    const { host, ran, text } = fakeHost();
    await controlService(refFor(unit), "restart", host);

    expect(commands(ran)).toEqual([`systemctl --user restart timeful-${HASH}.service`]);
    expect(text()).toContain(`systemctl --user restart timeful-${HASH}.service`);
    expect(text()).toContain(`Restarted timeful-${HASH}.service`);
  });

  it("reports a failure instead of claiming success", async () => {
    const { host } = fakeHost({ fail: "restart" });
    await expect(controlService(refFor(unit), "restart", host)).rejects.toThrow(
      /Command failed \(exit 3\)/,
    );
  });

  it("forgives the commands that are allowed to fail", async () => {
    const agent = unitFor(spec({ platform: "darwin", home: "/Users/ada" }));
    const { host, ran } = fakeHost({ fail: "bootout" });
    await expect(controlService(refFor(agent), "restart", host)).resolves.toBeUndefined();
    // The unload failed and the load still happened.
    expect(commands(ran)).toHaveLength(2);
  });

  it("only narrates when the host is pretending", async () => {
    const { host, ran, text } = fakeHost({ dryRun: true });
    await controlService(refFor(unit), "stop", host);

    expect(ran).toEqual([]);
    expect(text()).toContain(`would run: systemctl --user stop timeful-${HASH}.service`);
    expect(text()).toContain("was left alone");
  });
});
