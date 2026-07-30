/**
 * The unit scanner, against fixture unit files in a temporary directory.
 *
 * The fixtures are written by hand rather than generated, so that a change to
 * a generator that the parser does not follow shows up here as a failure —
 * which is the whole risk of keeping the record in the units themselves.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { discoverServices, scanPathsFor, webrootsOf, type ScanPaths } from "./discover.ts";

let root: string;

beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "timeful-scan-")));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

/** Writes a fixture into `dir` under `root`, and returns its path. */
async function plant(dir: string, name: string, contents: string): Promise<string> {
  const file = path.join(root, dir, name);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, contents, "utf8");
  return file;
}

const paths = (dirs: Partial<Record<keyof ScanPaths, string>>): ScanPaths =>
  Object.fromEntries(
    Object.entries(dirs).map(([key, dir]) => [key, path.join(root, dir as string)]),
  );

const plist = (label: string, webroot: string, extra = ""): string =>
  `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${label}</string>
    <key>ProgramArguments</key>
    <array>
      <string>/usr/bin/node</string>
      <string>/opt/timeful/cli.js</string>${extra}
    </array>
    <key>WorkingDirectory</key>
    <string>${webroot}</string>
  </dict>
</plist>
`;

const unit = (webroot: string, exec = "/usr/bin/node /opt/timeful/cli.js serve"): string =>
  `[Unit]
Description=Timeful (${webroot})

[Service]
WorkingDirectory=${webroot}
ExecStart=${exec}
`;

describe("discoverServices: macOS", () => {
  it("reads the webroot out of every LaunchAgent it wrote", async () => {
    await plant("LaunchAgents", "app.timeful.abc123def4.plist", plist("app.timeful.abc123def4", "/srv/one"));
    await plant("LaunchAgents", "app.timeful.0011223344.plist", plist("app.timeful.0011223344", "/srv/two"));

    const found = await discoverServices({
      platform: "darwin",
      paths: paths({ launchAgents: "LaunchAgents" }),
    });

    expect(found).toHaveLength(2);
    expect(found.map((entry) => entry.webroot)).toEqual(["/srv/one", "/srv/two"]);
    expect(found[0].id).toBe("app.timeful.abc123def4");
    expect(found[0].tier).toBe("user");
    expect(found[0].file).toBe(path.join(root, "LaunchAgents", "app.timeful.abc123def4.plist"));
  });

  it("leaves everybody else's agents alone", async () => {
    await plant("LaunchAgents", "com.example.thing.plist", plist("com.example.thing", "/srv/no"));
    await plant("LaunchAgents", "notes.txt", "timeful");

    expect(
      await discoverServices({ platform: "darwin", paths: paths({ launchAgents: "LaunchAgents" }) }),
    ).toEqual([]);
  });

  it("puts the escaping back", async () => {
    await plant(
      "LaunchAgents",
      "app.timeful.aaaaaaaaaa.plist",
      plist("app.timeful.aaaaaaaaaa", "/srv/a&amp;b&lt;c&gt;"),
    );
    const [found] = await discoverServices({
      platform: "darwin",
      paths: paths({ launchAgents: "LaunchAgents" }),
    });
    expect(found.webroot).toBe("/srv/a&b<c>");
  });
});

describe("discoverServices: Linux", () => {
  it("scans both tiers and says which is which", async () => {
    await plant("user", "timeful-aaaaaaaaaa.service", unit("/srv/mine"));
    await plant("system", "timeful-bbbbbbbbbb.service", unit("/srv/theirs"));

    const found = await discoverServices({
      platform: "linux",
      paths: paths({ systemdUser: "user", systemdSystem: "system" }),
    });

    expect(found.map((entry) => [entry.tier, entry.webroot])).toEqual([
      ["user", "/srv/mine"],
      ["system", "/srv/theirs"],
    ]);
    expect(found[0].id).toBe("timeful-aaaaaaaaaa.service");
  });

  it("finds a unit with a shorter hash than today's generator writes", async () => {
    // The scanner is deliberately looser than webrootHash's 10 characters: a
    // unit an older version wrote must stay findable, or it can never be
    // uninstalled from here. Guards the parser against tightening onto the
    // generator now that both read the shared naming table.
    await plant("user", "timeful-abc123.service", unit("/srv/short"));
    const [found] = await discoverServices({
      platform: "linux",
      paths: paths({ systemdUser: "user" }),
    });
    expect(found.webroot).toBe("/srv/short");
    expect(found.id).toBe("timeful-abc123.service");
  });

  it("finds units written before the CLI passed 'serve'", async () => {
    await plant(
      "user",
      "timeful-aaaaaaaaaa.service",
      unit("/srv/old", "/usr/bin/node /opt/timeful/cli.js"),
    );
    const [found] = await discoverServices({
      platform: "linux",
      paths: paths({ systemdUser: "user" }),
    });
    expect(found.webroot).toBe("/srv/old");
  });
});

describe("discoverServices: Windows", () => {
  it("reads the webroot out of the launcher script", async () => {
    await plant(
      "Timeful",
      "Timeful-aaaaaaaaaa.cmd",
      `@echo off\r\ncd /d "C:\\srv\\timeful"\r\n"node.exe" "cli.js" serve\r\n`,
    );
    const [found] = await discoverServices({
      platform: "win32",
      paths: paths({ windowsLaunchers: "Timeful" }),
    });
    expect(found.webroot).toBe("C:\\srv\\timeful");
    expect(found.id).toBe("Timeful-aaaaaaaaaa");
  });

  it("keeps matching a launcher whose extension was re-cased", async () => {
    // Windows file names compare case-insensitively, so `.CMD` is the same
    // launcher; the scanner has to stay case-insensitive too.
    await plant(
      "Timeful",
      "Timeful-bbbbbbbbbb.CMD",
      `@echo off\r\ncd /d "C:\\srv\\other"\r\n"node.exe" "cli.js" serve\r\n`,
    );
    const [found] = await discoverServices({
      platform: "win32",
      paths: paths({ windowsLaunchers: "Timeful" }),
    });
    expect(found.webroot).toBe("C:\\srv\\other");
    expect(found.id).toBe("Timeful-bbbbbbbbbb");
  });
});

describe("discoverServices: what can go wrong", () => {
  it("says nothing at all when the directories do not exist", async () => {
    await expect(
      discoverServices({
        platform: "linux",
        paths: { systemdUser: path.join(root, "nope"), systemdSystem: "/nowhere/at/all" },
      }),
    ).resolves.toEqual([]);
  });

  it("reports a unit it cannot make sense of instead of dropping it", async () => {
    const file = await plant("user", "timeful-aaaaaaaaaa.service", "[Service]\nExecStart=/bin/true\n");
    const [found] = await discoverServices({
      platform: "linux",
      paths: paths({ systemdUser: "user" }),
    });

    // Hiding it would make an installed service impossible to uninstall.
    expect(found.file).toBe(file);
    expect(found.webroot).toBeUndefined();
    expect(found.problem).toMatch(/no working directory/);
  });

  it("reports a unit it cannot read", async () => {
    const file = await plant("user", "timeful-aaaaaaaaaa.service", unit("/srv/x"));
    await fs.chmod(file, 0o000);
    const [found] = await discoverServices({
      platform: "linux",
      paths: paths({ systemdUser: "user" }),
    });
    await fs.chmod(file, 0o644);

    // Running as root reads it anyway; then there is nothing to report.
    if (found.problem) {
      expect(found.problem).toMatch(/cannot be read/);
      expect(found.webroot).toBeUndefined();
    } else {
      expect(found.webroot).toBe("/srv/x");
    }
  });
});

describe("webrootsOf", () => {
  it("keeps one entry per directory, however it was spelled", () => {
    expect(
      webrootsOf([
        { platform: "linux", tier: "user", id: "a", file: "/a", webroot: "/srv/one" },
        { platform: "linux", tier: "system", id: "b", file: "/b", webroot: "/srv/one/" },
        { platform: "linux", tier: "user", id: "c", file: "/c" },
        { platform: "linux", tier: "user", id: "d", file: "/d", webroot: "/srv/two" },
      ]),
    ).toEqual(["/srv/one", "/srv/two"]);
  });
});

describe("scanPathsFor", () => {
  it("looks where each platform keeps them", () => {
    expect(scanPathsFor({ platform: "darwin", home: "/Users/ada", env: {} })).toEqual({
      launchAgents: "/Users/ada/Library/LaunchAgents",
    });
    expect(scanPathsFor({ platform: "linux", home: "/home/ada", env: {} })).toEqual({
      systemdUser: "/home/ada/.config/systemd/user",
      systemdSystem: "/etc/systemd/system",
    });
    expect(scanPathsFor({ platform: "aix", home: "/home/ada", env: {} })).toEqual({});
  });

  it("honours XDG_CONFIG_HOME and LOCALAPPDATA, as the installer does", () => {
    expect(
      scanPathsFor({ platform: "linux", home: "/home/ada", env: { XDG_CONFIG_HOME: "/cfg" } })
        .systemdUser,
    ).toBe("/cfg/systemd/user");
    expect(
      scanPathsFor({ platform: "win32", home: "C:\\ada", env: { LOCALAPPDATA: "D:\\local" } })
        .windowsLaunchers,
    ).toBe(path.join("D:\\local", "Timeful"));
  });
});
