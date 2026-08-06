/** `timeful upgrade` through a stubbed ServiceHost — the whole verb is asserted without ever loading a service. */
import { describe, expect, it } from "vitest";
import {
  formatCommand,
  unitFor,
  type ServiceHost,
  type ServiceSpec,
  type ServiceUnit,
} from "./service.ts";
import { fakeHost, noWait } from "./fixtures.ts";
import { pinnedCliPath } from "./discover.ts";
import {
  installKind,
  reportStableInstall,
  upgradeWebroot,
  versionBeside,
  type UpgradeContext,
} from "./upgrade.ts";

const WEBROOT = "/srv/scheduling";
const OLD_CLI = "/home/ada/.npm/_npx/1a2b3c4d5e6f7a8b/node_modules/timeful/cli.js";
const NEW_CLI = "/home/ada/.npm/_npx/ffffffffffffffff/node_modules/timeful/cli.js";

function spec(overrides: Partial<ServiceSpec> = {}): ServiceSpec {
  return {
    platform: "linux",
    tier: "user",
    webroot: WEBROOT,
    varDir: `${WEBROOT}/var`,
    nodePath: "/usr/bin/node",
    cliPath: NEW_CLI,
    home: "/home/ada",
    uid: 501,
    ...overrides,
  };
}

/** The unit as it stands on disk before the upgrade: pinned at `cliPath`. */
function installedUnit(cliPath: string, overrides: Partial<ServiceSpec> = {}): ServiceUnit {
  return unitFor(spec({ ...overrides, cliPath }));
}

function context(host: ServiceHost, overrides: Partial<UpgradeContext> = {}): UpgradeContext {
  return { host, cliPath: NEW_CLI, version: "1.4.0", verify: noWait, ...overrides };
}

// ---------------------------------------------------------------------------

describe("installKind", () => {
  it("recognises an npx cache by its own directory, as a whole segment", () => {
    expect(installKind(OLD_CLI)).toBe("npx");
    expect(installKind("C:\\Users\\ada\\AppData\\npm-cache\\_npx\\ab\\node_modules\\timeful\\cli.js")).toBe(
      "npx",
    );
  });

  it("calls everything else stable, including a lookalike directory", () => {
    expect(installKind("/usr/local/lib/node_modules/timeful/cli.js")).toBe("stable");
    expect(installKind("/opt/my_npx-tools/timeful/cli.js")).toBe("stable");
    expect(installKind("/home/ada/timeful/server/cli/index.ts")).toBe("stable");
  });
});

describe("versionBeside", () => {
  it("reads the package.json the build writes beside the CLI", async () => {
    const { host } = fakeHost({
      seed: {
        "/opt/timeful/package.json": JSON.stringify({ name: "timeful", version: "1.4.0" }),
      },
    });
    expect(await versionBeside(host, "/opt/timeful/cli.js")).toBe("1.4.0");
  });

  it("answers null for anything it cannot read or make sense of", async () => {
    const { host } = fakeHost({
      seed: {
        "/opt/broken/package.json": "{ not json",
        "/opt/empty/package.json": "{}",
      },
    });
    expect(await versionBeside(host, "/opt/broken/cli.js")).toBeNull();
    expect(await versionBeside(host, "/opt/empty/cli.js")).toBeNull();
    expect(await versionBeside(host, "/opt/missing/cli.js")).toBeNull();
  });
});

describe("pinnedCliPath", () => {
  it("reads back what each generator wrote", () => {
    for (const platform of ["linux", "darwin", "win32"] as const) {
      const unit = installedUnit(OLD_CLI, { platform });
      expect(pinnedCliPath(platform, unit.contents)).toBe(OLD_CLI);
    }
  });

  it("reads a unit written before the serve argument existed", () => {
    const contents = "[Service]\nExecStart=/usr/bin/node /opt/timeful/cli.js\n";
    expect(pinnedCliPath("linux", contents)).toBe("/opt/timeful/cli.js");
  });

  it("answers null rather than guessing at something it does not recognise", () => {
    expect(pinnedCliPath("linux", "[Service]\nWorkingDirectory=/srv\n")).toBeNull();
    expect(pinnedCliPath("darwin", "<plist></plist>")).toBeNull();
    expect(pinnedCliPath("win32", "@echo off\r\n")).toBeNull();
  });
});

// ---------------------------------------------------------------------------

describe("upgradeWebroot", () => {
  it("rewrites the unit to exec the running CLI, then restarts the service", async () => {
    const old = installedUnit(OLD_CLI);
    const { host, files, ran, text } = fakeHost({ seed: { [old.file]: old.contents } });
    const next = installedUnit(NEW_CLI);

    expect(await upgradeWebroot(WEBROOT, [next], context(host))).toBe("upgraded");

    // The pinned path is the point of the whole verb.
    expect(files.get(next.file)).toContain(NEW_CLI);
    expect(files.get(next.file)).not.toContain(OLD_CLI);
    expect(text()).toContain(`was ${OLD_CLI}`);
    expect(text()).toContain(`now ${NEW_CLI}`);

    const commands = ran.map(formatCommand);
    expect(commands).toContain("systemctl --user daemon-reload");
    // Reinstalling does not bounce a running unit; the restart is what does.
    expect(commands).toContain(`systemctl --user restart ${next.id}`);
  });

  it("says so and does nothing when the unit already execs this build", async () => {
    const current = installedUnit(NEW_CLI);
    const { host, ran, text } = fakeHost({
      seed: {
        [current.file]: current.contents,
        [`${NEW_CLI.replace(/\/cli\.js$/, "")}/package.json`]: JSON.stringify({
          version: "1.4.0",
        }),
      },
    });

    expect(await upgradeWebroot(WEBROOT, [current], context(host))).toBe("unchanged");
    expect(text()).toContain("already up to date (1.4.0)");
    expect(text()).toContain("timeful service restart");
    expect(ran).toEqual([]);
  });

  it("upgrades anyway when the path matches but the build behind it does not", async () => {
    const current = installedUnit(NEW_CLI);
    const { host, ran, text } = fakeHost({
      seed: {
        [current.file]: current.contents,
        [`${NEW_CLI.replace(/\/cli\.js$/, "")}/package.json`]: JSON.stringify({
          version: "1.3.0",
        }),
      },
    });

    expect(await upgradeWebroot(WEBROOT, [current], context(host))).toBe("upgraded");
    expect(text()).toContain(`already execs ${NEW_CLI}`);
    expect(ran.map(formatCommand)).toContain(`systemctl --user restart ${current.id}`);
  });

  it("rewrites a unit whose old CLI path cannot be read out of it", async () => {
    const next = installedUnit(NEW_CLI);
    const { host, files, text } = fakeHost({ seed: { [next.file]: "[Service]\nType=simple\n" } });

    expect(await upgradeWebroot(WEBROOT, [next], context(host))).toBe("upgraded");
    expect(text()).toContain("names no CLI path");
    expect(files.get(next.file)).toContain(NEW_CLI);
  });

  it("prints every command and touches nothing under a dry run", async () => {
    const old = installedUnit(OLD_CLI);
    const { host, files, ran, text } = fakeHost({
      seed: { [old.file]: old.contents },
      dryRun: true,
    });
    const next = installedUnit(NEW_CLI);

    await upgradeWebroot(WEBROOT, [next], context(host));

    expect(text()).toContain("would write ");
    expect(text()).toContain(`would run: systemctl --user restart ${next.id}`);
    expect(ran).toEqual([]);
    // The installed unit is exactly as it was found.
    expect(files.get(old.file)).toBe(old.contents);
  });

  it("explains how a serve-only webroot upgrades, when it was named", async () => {
    const { host, ran, text } = fakeHost();

    expect(await upgradeWebroot(WEBROOT, [], context(host), { explicit: true })).toBe(
      "no-service",
    );
    expect(text()).toContain("No Timeful service is installed");
    expect(text()).toContain(`cd ${WEBROOT} && npx timeful@latest`);
    expect(text()).toContain("timeful service install");
    expect(ran).toEqual([]);
  });

  it("passes over a serve-only webroot in one line when it was swept up", async () => {
    const { host, text } = fakeHost();

    expect(await upgradeWebroot(WEBROOT, [], context(host), { explicit: false })).toBe(
      "no-service",
    );
    expect(text()).toContain("nothing to re-point");
    expect(text()).not.toContain("npx timeful@latest");
  });

  it("takes every installed tier of one webroot", async () => {
    const user = installedUnit(OLD_CLI, { tier: "user" });
    const system = installedUnit(OLD_CLI, { tier: "system" });
    const { host, ran } = fakeHost({
      seed: {
        [user.file]: user.contents,
        [system.file]: system.contents,
      },
    });

    await upgradeWebroot(
      WEBROOT,
      [installedUnit(NEW_CLI, { tier: "user" }), installedUnit(NEW_CLI, { tier: "system" })],
      context(host),
    );

    const commands = ran.map(formatCommand);
    expect(commands.some((cmd) => cmd.startsWith("systemctl --user restart"))).toBe(true);
    // The hardened tier keeps the escalation the other verbs already use.
    expect(commands.some((cmd) => cmd.startsWith("sudo systemctl restart"))).toBe(true);
  });

  // Re-pinning goes through unitFor, so a legacy unit comes back in the current shape — no hand-editing.
  it("regenerates a ProtectHome=yes legacy unit into the shape that works", async () => {
    const next = installedUnit(NEW_CLI, { tier: "system" });
    // Exactly what this CLI first wrote: an inaccessible /home, the whole
    // webroot writable, and no group to own anything.
    const legacy = `[Unit]
Description=Timeful (${WEBROOT})
After=network.target

[Service]
Type=simple
DynamicUser=yes
WorkingDirectory=${WEBROOT}
ExecStart=/usr/bin/node ${OLD_CLI} serve
ReadWritePaths=${WEBROOT}
ProtectSystem=strict
ProtectHome=yes
NoNewPrivileges=yes
PrivateTmp=yes
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
`;
    const { host, files, ran, text } = fakeHost({ seed: { [next.file]: legacy } });

    expect(await upgradeWebroot(WEBROOT, [next], context(host))).toBe("upgraded");
    expect(text()).toContain(`was ${OLD_CLI}`);

    const written = files.get(next.staging ?? next.file) ?? "";
    expect(written).toContain("ProtectHome=off");
    expect(written).not.toContain("ProtectHome=yes");
    expect(written).toContain("SupplementaryGroups=timeful");
    expect(written).toContain("UMask=0002");
    // The write grant is varDir, not the whole webroot as the legacy unit had.
    expect(written.match(/^ReadWritePaths=.*$/gm)).toEqual([`ReadWritePaths=${WEBROOT}/var`]);

    const commands = ran.map(formatCommand);
    expect(commands).toContain(
      "sudo sh -c 'getent group timeful >/dev/null || groupadd --system timeful'",
    );
    expect(commands).toContain(`sudo chown -R :timeful ${WEBROOT}/var`);
    // A unit that crash-looped itself into `failed` has to be unlatched, and
    // the running process has to be replaced rather than left alone.
    expect(commands).toContain(`sudo systemctl reset-failed ${next.id}`);
    expect(commands).toContain(`sudo systemctl restart ${next.id}`);
  });

  // The 0.0.2 generation: ProtectHome=tmpfs + BindPaths=, which systemd 255 surfaces read-only
  // (EROFS on save); upgrading must converge the unit on the shape that works.
  it("regenerates a 0.0.2 tmpfs unit whose data directory was read-only", async () => {
    const next = installedUnit(NEW_CLI, { tier: "system" });
    const erofs = `[Unit]
Description=Timeful (${WEBROOT})
After=network.target

[Service]
Type=simple
DynamicUser=yes
SupplementaryGroups=timeful
UMask=0002
WorkingDirectory=${WEBROOT}
ExecStart=/usr/bin/node ${OLD_CLI} serve
ProtectSystem=strict
ProtectHome=tmpfs
BindReadOnlyPaths=${WEBROOT}
BindPaths=${WEBROOT}/var
NoNewPrivileges=yes
PrivateTmp=yes
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
`;
    const { host, files, ran } = fakeHost({ seed: { [next.file]: erofs } });

    expect(await upgradeWebroot(WEBROOT, [next], context(host))).toBe("upgraded");

    const written = files.get(next.staging ?? next.file) ?? "";
    expect(written).toContain("ProtectHome=off");
    expect(written).not.toContain("ProtectHome=tmpfs");
    expect(written).not.toMatch(/^Bind/m);
    expect(written.match(/^ReadWritePaths=.*$/gm)).toEqual([`ReadWritePaths=${WEBROOT}/var`]);
    // Regenerating is not enough on its own; the running process is replaced.
    expect(ran.map(formatCommand)).toContain(`sudo systemctl restart ${next.id}`);
  });

  it("refuses to re-pin a hardened unit into a home it could never traverse", async () => {
    const next = installedUnit(NEW_CLI, {
      tier: "system",
      webroot: "/home/ada/timeful",
      varDir: "/home/ada/timeful",
    });
    const { host, files } = fakeHost({
      seed: { [next.file]: next.contents },
      modes: { "/home/ada": 0o700 },
    });

    await expect(upgradeWebroot("/home/ada/timeful", [next], context(host))).rejects.toThrow(
      /cannot reach this webroot/,
    );
    // The cure, not just the refusal — including how to stop the broken one.
    await expect(upgradeWebroot("/home/ada/timeful", [next], context(host))).rejects.toThrow(
      /timeful service uninstall --system/,
    );
    expect(files.get(next.file)).toBe(next.contents);
  });
});

// ---------------------------------------------------------------------------

describe("reportStableInstall", () => {
  const stable = "/usr/local/lib/node_modules/timeful/cli.js";

  it("prints the ritual rather than running npm, when something newer exists", async () => {
    const { host, ran, text } = fakeHost();
    await reportStableInstall(context(host, { cliPath: stable }), async () => ({
      latest: "1.5.0",
    }));

    expect(text()).toContain("1.5.0 has been published");
    expect(text()).toContain("npm i -g timeful@latest");
    expect(text()).toContain("timeful service restart");
    expect(text()).toContain("Nothing below installs it for you.");
    // The verb never runs a package manager on the operator's behalf.
    expect(ran).toEqual([]);
  });

  it("says there is nothing newer when the running version is the latest", async () => {
    const { host, text } = fakeHost();
    await reportStableInstall(context(host, { cliPath: stable }), async () => ({
      latest: "1.4.0",
    }));
    expect(text()).toContain("is the latest published version");
    expect(text()).not.toContain("npm i -g");
  });

  it("carries on when the registry cannot be reached", async () => {
    const { host, text } = fakeHost();
    await reportStableInstall(context(host, { cliPath: stable }), async () => ({
      latest: null,
      problem: "The npm registry could not be reached.",
    }));

    expect(text()).toContain("could not be reached");
    expect(text()).toContain("Continuing anyway");
  });

  it("does not contact the registry at all when there is no lookup to make", async () => {
    const { host, text } = fakeHost();
    await reportStableInstall(context(host, { cliPath: stable }));
    expect(text()).toContain("the npm registry was not contacted");
  });
});
