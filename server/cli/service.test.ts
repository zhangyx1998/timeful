import { describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";
import { CliError } from "./errors.ts";
import { fakeHost, noWait } from "./fixtures.ts";
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
  watchAfterStart,
  webrootHash,
  type RunResult,
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
ProtectHome=off
ReadWritePaths=/srv/timeful/var
NoNewPrivileges=yes
PrivateTmp=yes
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
`);
  });

  it("emits the one shape that has survived a real boot: off + strict + ReadWritePaths", () => {
    // The empirical ladder (systemd 255, production): ProtectHome=yes was a
    // mount nothing can be bound through (200/CHDIR); ProtectHome=tmpfs +
    // BindPaths surfaced a *read-only* data directory (EROFS on every save),
    // and adding ReadWritePaths on top of the bind changed nothing. Only
    // ProtectHome=off with a plain ReadWritePaths carve-out writes.
    expect(unit.contents).toContain("ProtectHome=off");
    expect(unit.contents).not.toContain("ProtectHome=yes");
    expect(unit.contents).not.toContain("ProtectHome=tmpfs");
    expect(unit.contents).not.toMatch(/^BindPaths=/m);
    expect(unit.contents).not.toMatch(/^BindReadOnlyPaths=/m);
  });

  it("grants write access to the data directory and nowhere else", () => {
    // ProtectSystem=strict makes the whole filesystem read-only; the single
    // ReadWritePaths line is the carve-out, and it names varDir, never the
    // webroot around it.
    expect(unit.contents).toContain("ProtectSystem=strict");
    expect(unit.contents.match(/^ReadWritePaths=.*$/gm)).toEqual([
      `ReadWritePaths=${WEBROOT}/var`,
    ]);
  });

  it("collapses cleanly when the data directory is the webroot itself", () => {
    // The default layout since varDir began defaulting to "./": one path,
    // one write grant, and no read-only directive fighting it.
    const merged = unitFor(spec({ tier: "system", varDir: WEBROOT }));
    expect(merged.contents.match(/^ReadWritePaths=.*$/gm)).toEqual([
      `ReadWritePaths=${WEBROOT}`,
    ]);
    expect(merged.contents).not.toMatch(/^BindPaths=|^BindReadOnlyPaths=|^ReadOnlyPaths=/m);
  });

  it("keeps the data durable across a UID it does not choose", () => {
    // DynamicUser reallocates the UID, so group ownership is the part that
    // lasts: the group is handed to the service and the umask keeps what it
    // writes group-writable.
    expect(unit.contents).toContain("DynamicUser=yes");
    expect(unit.contents).toContain("SupplementaryGroups=timeful");
    expect(unit.contents).toContain("UMask=0002");
  });

  it("needs no mounts for a webroot or an npx cache in a home directory", () => {
    // With ProtectHome=off nothing is hidden, so nothing has to be bound
    // back: the home-dir webroot and the npx-cache CLI are reached by plain
    // permissions, which systemTierProblem checks at install time instead.
    const npx = unitFor(
      spec({
        tier: "system",
        webroot: "/home/ada/timeful",
        varDir: "/home/ada/timeful/var",
        cliPath: "/home/ada/.npm/_npx/abc123/node_modules/timeful/cli.js",
      }),
    );
    expect(npx.contents).not.toMatch(/^Bind/m);
    expect(npx.contents).toContain("ReadWritePaths=/home/ada/timeful/var");
    expect(npx.contents).toContain("WorkingDirectory=/home/ada/timeful");
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
    // mkdir first: systemd silently ignores a ReadWritePaths= path that does
    // not exist at start, so the carve-out depends on the directory existing.
    expect(activate.findIndex((cmd) => cmd.includes("mkdir -p"))).toBeLessThan(
      activate.findIndex((cmd) => cmd.includes("chown")),
    );
  });
});

describe("systemTierProblem", () => {
  // A webroot in a traversable home: the ordinary deployed layout.
  const homeSpec = (overrides: Partial<ServiceSpec> = {}) =>
    spec({
      tier: "system",
      webroot: "/home/ada/timeful",
      varDir: "/home/ada/timeful",
      cliPath: "/home/ada/.npm/_npx/abc/node_modules/timeful/cli.js",
      user: "ada",
      ...overrides,
    });

  it("has nothing to say about a home directory another account can walk", async () => {
    // ProtectHome=off means reaching the webroot is plain DAC: a home with
    // o+x (0755, or traverse-only 0711) is not a problem.
    const { host } = fakeHost({ modes: { "/home/ada": 0o755, "/home/ada/timeful": 0o755 } });
    expect(await systemTierProblem(homeSpec(), host)).toBeNull();
    const stingy = fakeHost({ modes: { "/home/ada": 0o711 } });
    expect(await systemTierProblem(homeSpec(), stingy.host)).toBeNull();
  });

  it("refuses a home the ephemeral user cannot pass through, with the one-bit cure", async () => {
    const { host } = fakeHost({ modes: { "/home/ada": 0o700 } });
    const problem = await systemTierProblem(homeSpec(), host);
    expect(problem).toContain("cannot reach this webroot");
    // What was found, and exactly what to run about it.
    expect(problem).toContain("0700  /home/ada");
    expect(problem).toContain("chmod o+x /home/ada");
    // A refusal without the alternative is just a refusal.
    expect(problem).toContain("timeful service install");
    expect(problem).toContain("sudo loginctl enable-linger ada");
  });

  it("no longer refuses a version-manager node just for living in a home", async () => {
    // With no tmpfs there is nothing to delimit: nvm's tree is reached by
    // ordinary permissions like everything else, so only an untraversable
    // ancestor is a problem.
    const nvm = spec({
      tier: "system",
      nodePath: "/home/ada/.nvm/versions/node/v22.18.0/bin/node",
      user: "ada",
    });
    const open = fakeHost({ modes: { "/home/ada": 0o755, "/home/ada/.nvm": 0o755 } });
    expect(await systemTierProblem(nvm, open.host)).toBeNull();
    const closed = fakeHost({ modes: { "/home/ada/.nvm": 0o700 } });
    expect(await systemTierProblem(nvm, closed.host)).toContain("chmod o+x /home/ada/.nvm");
  });

  it("exempts the data directory itself, which the timeful group unlocks instead", async () => {
    // Activation chowns varDir to the service's own group; o+x on it is not
    // required. Its *ancestors* still are.
    const layout = homeSpec({ varDir: "/home/ada/timeful/var" });
    const { host } = fakeHost({
      modes: { "/home/ada": 0o755, "/home/ada/timeful": 0o755, "/home/ada/timeful/var": 0o770 },
    });
    expect(await systemTierProblem(layout, host)).toBeNull();
  });

  it("lets an unstattable directory through rather than guessing", async () => {
    // The check is a courtesy; the post-start watch is the backstop. A mode
    // it cannot read is not evidence of anything.
    const { host } = fakeHost();
    expect(await systemTierProblem(homeSpec(), host)).toBeNull();
  });

  it("adds the uninstall when a broken unit is already sitting there", async () => {
    const { host } = fakeHost({ modes: { "/home/ada": 0o700 } });
    expect(await systemTierProblem(homeSpec(), host, { installed: true })).toContain(
      "timeful service uninstall --system",
    );
    expect(await systemTierProblem(homeSpec(), host, { installed: false })).not.toContain(
      "timeful service uninstall --system",
    );
  });

  it("says nothing about the tiers and platforms it does not govern", async () => {
    const { host } = fakeHost({ modes: { "/home/ada": 0o700 } });
    expect(await systemTierProblem(homeSpec({ tier: "user" }), host)).toBeNull();
    expect(await systemTierProblem(homeSpec({ platform: "darwin" }), host)).toBeNull();
    // A directory that merely starts with the same letters is not a home.
    const lookalike = spec({ tier: "system", nodePath: "/homebrew/bin/node" });
    const brew = fakeHost({ modes: { "/homebrew": 0o700 } });
    expect(await systemTierProblem(lookalike, brew.host)).toBeNull();
  });

  it("covers /root and an unusual home just as it covers /home", async () => {
    const root = spec({ tier: "system", nodePath: "/root/node/bin/node" });
    const rootHost = fakeHost({ modes: { "/root": 0o700 } });
    expect(await systemTierProblem(root, rootHost.host)).toContain("chmod o+x /root");
    // ProtectHome never covered /export/home, but DAC applies wherever the
    // invoking user's home actually is.
    const odd = spec({
      tier: "system",
      home: "/export/home/ada",
      nodePath: "/export/home/ada/.local/bin/node",
    });
    const oddHost = fakeHost({ modes: { "/export/home/ada": 0o750 } });
    expect(await systemTierProblem(odd, oddHost.host)).toContain("chmod o+x /export/home/ada");
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
    await installService(unit, host, { confirmPrivileged: async () => true, verify: noWait });
    expect(text()).toContain("DynamicUser=yes");
    expect(text()).toContain("ProtectHome=off");
    expect(text()).toContain(`ReadWritePaths=${WEBROOT}/var`);
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
    await installService(unit, host, { confirmPrivileged: async () => true, verify: noWait });
    expect(text()).toContain("The 'timeful' group and the contents of");
  });

  it("refuses a hardened install that could only crash-loop", async () => {
    const unit = unitFor(
      spec({ tier: "system", webroot: "/home/ada/timeful", varDir: "/home/ada/timeful" }),
    );
    const { host, files, ran, text } = fakeHost({ modes: { "/home/ada": 0o700 } });

    await expect(
      installService(unit, host, { confirmPrivileged: async () => true, verify: noWait }),
    ).rejects.toThrow(/cannot reach this webroot/);
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
    expect(
      await installService(unit, host, { confirmPrivileged: async () => true, verify: noWait }),
    ).toBe(true);
    expect(commands(ran).slice(0, unit.activate.length)).toEqual(commands(unit.activate));
  });

  it("suggests '--system' in the undo line for the hardened tier", async () => {
    const unit = unitFor(spec({ tier: "system" }));
    const { host, text } = fakeHost();
    await installService(unit, host, { confirmPrivileged: async () => true, verify: noWait });
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

describe("installService: the post-start watch", () => {
  const unit = unitFor(spec({ tier: "system" }));
  const PROBE = `systemctl show -p ActiveState -p SubState -p NRestarts timeful-${HASH}.service`;

  /** The stock host, with the probe scripted to answer `stdout`. */
  const probing = (stdout: string) => {
    const fake = fakeHost();
    let probes = 0;
    const host = {
      ...fake.host,
      run: async (cmd: ServiceCommand): Promise<RunResult> => {
        if (!cmd.args.includes("show")) return fake.host.run(cmd);
        probes += 1;
        return { code: 0, stdout, stderr: "" };
      },
    };
    return { ...fake, host, probes: () => probes };
  };

  it("verifies the hardened service came up and stayed up", async () => {
    const { host, ran, text } = fakeHost();
    expect(
      await installService(unit, host, { confirmPrivileged: async () => true, verify: noWait }),
    ).toBe(true);
    // The watch rides the same unprivileged probe the status verb uses, and
    // keeps looking across the whole window rather than trusting one answer.
    expect(commands(ran).filter((cmd) => cmd === PROBE)).toHaveLength(4);
    expect(text()).toContain(`Verified: timeful-${HASH}.service came up and stayed up.`);
    expect(text()).toContain("Installed and started");
  });

  it("reports a crash loop loudly instead of claiming success", async () => {
    // activating + auto-restart is systemd counting down to another attempt
    // after one died — the exact state a broken sandbox leaves a unit in.
    const scripted = probing("ActiveState=activating\nSubState=auto-restart\nNRestarts=3");
    await expect(
      installService(unit, scripted.host, {
        confirmPrivileged: async () => true,
        verify: noWait,
      }),
    ).rejects.toThrow(/not staying up/);
    expect(scripted.text()).not.toContain("Installed and started");
  });

  it("points a failed watch at journalctl, and names the EROFS trap", async () => {
    const scripted = probing("ActiveState=failed\nSubState=failed");
    const failure = await installService(unit, scripted.host, {
      confirmPrivileged: async () => true,
      verify: noWait,
    }).catch((err: unknown) => (err instanceof Error ? err.message : String(err)));
    expect(failure).toContain(`journalctl -u timeful-${HASH}.service -e`);
    expect(failure).toContain("EROFS");
    expect(failure).toContain(`/etc/systemd/system/timeful-${HASH}.service.d/`);
  });

  it("stops probing the moment the verdict is in", async () => {
    const scripted = probing("ActiveState=activating\nSubState=auto-restart");
    await expect(
      installService(unit, scripted.host, {
        confirmPrivileged: async () => true,
        verify: noWait,
      }),
    ).rejects.toThrow();
    expect(scripted.probes()).toBe(1);
  });

  it("treats a counted restart as not staying up, even mid-green", async () => {
    // active(running) with NRestarts>0 means it died and came back inside the
    // window: reset-failed ran just before restart, so the count is ours.
    const scripted = probing("ActiveState=active\nSubState=running\nNRestarts=2");
    await expect(
      installService(unit, scripted.host, {
        confirmPrivileged: async () => true,
        verify: noWait,
      }),
    ).rejects.toThrow(/not staying up/);
  });

  it("does not watch the user tier or a dry run", async () => {
    const user = unitFor(spec({ tier: "user" }));
    const { host, ran } = fakeHost();
    await installService(user, host, { verify: noWait });
    expect(commands(ran).some((cmd) => cmd.includes("show -p ActiveState"))).toBe(false);

    const dry = fakeHost({ dryRun: true });
    await installService(unit, { ...dry.host, dryRun: true }, { verify: noWait });
    expect(dry.text()).not.toContain("show -p ActiveState");
    expect(dry.text()).toContain(`Dry run: timeful-${HASH}.service was not installed.`);
  });

  it("paces itself with the injected sleep, once per gap between probes", async () => {
    const scripted = probing("ActiveState=active\nSubState=running");
    const sleeps: number[] = [];
    const report = await watchAfterStart(refFor(unit), scripted.host, {
      attempts: 3,
      delayMs: 250,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    expect(report.state).toBe("running");
    expect(sleeps).toEqual([250, 250]);
    expect(scripted.probes()).toBe(3);
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
