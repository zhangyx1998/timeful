import { describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";
import { CliError } from "./errors.ts";
import { fakeHost } from "./fixtures.ts";
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
  systemTierProblem,
  uninstallService,
  unitFor,
  webrootHash,
  type ServiceCommand,
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
SupplementaryGroups=timeful
UMask=0002
WorkingDirectory=/srv/timeful
ExecStart=/usr/bin/node /usr/lib/node_modules/timeful/cli.js serve
ProtectSystem=strict
ProtectHome=tmpfs
BindReadOnlyPaths=/srv/timeful
BindPaths=/srv/timeful/var
NoNewPrivileges=yes
PrivateTmp=yes
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
`);
  });

  it("never covers a home directory with something nothing can be bound through", () => {
    // ProtectHome=yes is the bug this tier shipped with: an inaccessible mount
    // over /home that no BindPaths can reach past, so a webroot in a home
    // directory answered every start with 200/CHDIR.
    expect(unit.contents).toContain("ProtectHome=tmpfs");
    expect(unit.contents).not.toContain("ProtectHome=yes");
  });

  it("grants write access to the data directory and nowhere else", () => {
    // ProtectSystem=strict makes everything read-only and the tmpfs makes a
    // home directory empty, so both paths are named as mounts: the webroot
    // read-only, and the one directory the server writes read-write.
    expect(unit.contents).toContain(`BindReadOnlyPaths=${WEBROOT}`);
    expect(unit.contents).toContain(`BindPaths=${WEBROOT}/var`);
    expect(unit.contents.match(/^BindPaths=.*$/gm)).toHaveLength(1);
    // The whole webroot is no longer writable; only var/ is.
    expect(unit.contents).not.toContain(`BindPaths=${WEBROOT}\n`);
    expect(unit.contents).not.toMatch(/^ReadWritePaths=/m);
  });

  it("keeps the data durable across a UID it does not choose", () => {
    // DynamicUser reallocates the UID, so group ownership is the part that
    // lasts: the group is handed to the service and the umask keeps what it
    // writes group-writable.
    expect(unit.contents).toContain("DynamicUser=yes");
    expect(unit.contents).toContain("SupplementaryGroups=timeful");
    expect(unit.contents).toContain("UMask=0002");
  });

  it("mounts an npx-cache CLI back through the tmpfs", () => {
    const npx = unitFor(
      spec({
        tier: "system",
        webroot: "/home/ada/timeful",
        varDir: "/home/ada/timeful/var",
        cliPath: "/home/ada/.npm/_npx/abc123/node_modules/timeful/cli.js",
      }),
    );
    // The package directory, not the file: cli.js is served beside client/.
    expect(npx.contents).toContain(
      "BindReadOnlyPaths=/home/ada/.npm/_npx/abc123/node_modules/timeful",
    );
    expect(npx.contents).toContain("BindReadOnlyPaths=/home/ada/timeful");
    expect(npx.contents).toContain("BindPaths=/home/ada/timeful/var");
  });

  it("leaves a CLI outside a home directory to ProtectSystem, which only hides nothing", () => {
    // Read-only is not invisible, so there is no mount to add and the unit
    // says so by not carrying one.
    expect(unit.contents.match(/^BindReadOnlyPaths=.*$/gm)).toHaveLength(1);
  });

  it("starts at boot rather than at login", () => {
    expect(unit.contents).toContain("WantedBy=multi-user.target");
  });

  it("drives systemctl with sudo, after making the data directory the group's", () => {
    expect(commands(unit.activate)).toEqual([
      "sudo sh -c 'getent group timeful >/dev/null || groupadd --system timeful'",
      `sudo mkdir -p ${WEBROOT}/var`,
      `sudo chown -R :timeful ${WEBROOT}/var`,
      `sudo chmod -R g+rwX ${WEBROOT}/var`,
      `sudo find ${WEBROOT}/var -type d -exec chmod g+s '{}' +`,
      `sudo install -m 0644 ${unit.staging} /etc/systemd/system/timeful-${HASH}.service`,
      "sudo systemctl daemon-reload",
      `sudo systemctl reset-failed timeful-${HASH}.service`,
      `sudo systemctl enable timeful-${HASH}.service`,
      `sudo systemctl restart timeful-${HASH}.service`,
    ]);
    expect(commands(unit.deactivate)).toEqual([
      `sudo systemctl disable --now timeful-${HASH}.service`,
      `sudo rm -f /etc/systemd/system/timeful-${HASH}.service`,
      "sudo systemctl daemon-reload",
    ]);
    // Reading status needs no privileges.
    expect(commands(unit.status)).toEqual([`systemctl status timeful-${HASH}.service`]);
  });

  it("replaces a running unit rather than leaving the old process up", () => {
    // `enable --now` is a no-op against a unit that is already running, which
    // is exactly the migration case: the User=/DynamicUser= change would never
    // reach the live process. reset-failed unlatches one that crash-looped.
    const activate = commands(unit.activate);
    expect(activate).not.toContain(`sudo systemctl enable --now timeful-${HASH}.service`);
    expect(activate.indexOf("sudo systemctl daemon-reload")).toBeLessThan(
      activate.indexOf(`sudo systemctl restart timeful-${HASH}.service`),
    );
    // A unit systemd has never seen is not a failed install.
    expect(unit.activate.find((cmd) => cmd.args.includes("reset-failed"))?.tolerant).toBe(true);
  });

  it("creates the group before it chowns anything to it", () => {
    const activate = commands(unit.activate);
    expect(activate[0]).toContain("groupadd --system timeful");
    expect(activate.findIndex((cmd) => cmd.includes("chown"))).toBeGreaterThan(0);
    // mkdir first: BindPaths= cannot mount a source that is not there.
    expect(activate.findIndex((cmd) => cmd.includes("mkdir -p"))).toBeLessThan(
      activate.findIndex((cmd) => cmd.includes("chown")),
    );
  });
});

describe("systemTierProblem", () => {
  it("has nothing to say about a webroot in a home directory any more", () => {
    // The whole point of ProtectHome=tmpfs plus the binds: this used to be the
    // crash-loop case, and it is now the ordinary one.
    expect(
      systemTierProblem(
        spec({
          tier: "system",
          webroot: "/home/ada/timeful",
          varDir: "/home/ada/timeful/var",
          cliPath: "/home/ada/.npm/_npx/abc/node_modules/timeful/cli.js",
        }),
      ),
    ).toBeNull();
  });

  it("refuses a Node installation inside a home directory, with the cure", () => {
    const problem = systemTierProblem(
      spec({
        tier: "system",
        nodePath: "/home/ada/.nvm/versions/node/v22.18.0/bin/node",
        user: "ada",
      }),
    );
    expect(problem).toContain("cannot use this Node installation");
    expect(problem).toContain("/home/ada/.nvm/versions/node/v22.18.0/bin/node");
    // A refusal without the alternative is just a refusal.
    expect(problem).toContain("timeful service install");
    expect(problem).toContain("sudo loginctl enable-linger ada");
  });

  it("adds the uninstall when a broken unit is already sitting there", () => {
    const broken = spec({ tier: "system", nodePath: "/home/ada/.nvm/bin/node", user: "ada" });
    expect(systemTierProblem(broken, { installed: true })).toContain(
      "timeful service uninstall --system",
    );
    expect(systemTierProblem(broken, { installed: false })).not.toContain(
      "timeful service uninstall --system",
    );
  });

  it("says nothing about the tiers and platforms it does not govern", () => {
    const home = { nodePath: "/home/ada/.nvm/bin/node" };
    expect(systemTierProblem(spec({ tier: "user", ...home }))).toBeNull();
    expect(systemTierProblem(spec({ platform: "darwin", tier: "system", ...home }))).toBeNull();
    // /root and /run/user are covered by ProtectHome just as /home is.
    expect(systemTierProblem(spec({ tier: "system", nodePath: "/root/node/bin/node" }))).not.toBeNull();
    // A directory that merely starts with the same letters is not a home.
    expect(systemTierProblem(spec({ tier: "system", nodePath: "/homebrew/bin/node" }))).toBeNull();
  });

  it("follows the invoking user's home when it is somewhere unusual", () => {
    // ProtectHome does not cover /export/home, but a 0700 home is untraversable
    // by another account wherever it lives.
    const odd = spec({
      tier: "system",
      home: "/export/home/ada",
      nodePath: "/export/home/ada/.local/bin/node",
    });
    expect(systemTierProblem(odd)).not.toBeNull();
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
    expect(text()).toContain("ProtectHome=tmpfs");
    expect(text()).toContain("sudo systemctl restart");
    expect(text()).toContain("groupadd --system timeful");
    expect(text()).toContain("ephemeral system user");
    // The warning explains the group and the chown, which is what an operator
    // actually has to live with.
    expect(text()).toContain("owned by the 'timeful' group");
    expect(text()).toContain("group-owned and group-writable");
    expect(text()).toContain("timeful.config.json has to stay");
  });

  it("says the group and the data outlive an uninstall", async () => {
    const unit = unitFor(spec({ tier: "system" }));
    const { host, text } = fakeHost();
    await installService(unit, host, { confirmPrivileged: async () => true });
    expect(text()).toContain("The 'timeful' group and the contents of");
  });

  it("refuses a hardened install that could only crash-loop", async () => {
    const unit = unitFor(spec({ tier: "system", nodePath: "/home/ada/.nvm/bin/node" }));
    const { host, files, ran, text } = fakeHost();

    await expect(
      installService(unit, host, { confirmPrivileged: async () => true }),
    ).rejects.toThrow(/cannot use this Node installation/);
    // Refused before anything is printed, written or run: a unit that can
    // never start is not worth describing.
    expect(text()).toBe("");
    expect(files.size).toBe(0);
    expect(ran).toEqual([]);
  });

  it("forgives an activation command that is allowed to fail", async () => {
    const unit = unitFor(spec({ tier: "system" }));
    const { host, ran } = fakeHost({ fail: "reset-failed" });
    // A unit systemd has never seen has no failure to reset.
    expect(await installService(unit, host, { confirmPrivileged: async () => true })).toBe(true);
    expect(commands(ran)).toEqual(commands(unit.activate));
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
