/**
 * Finding the Timeful services installed on this machine.
 *
 * There is no registry file. The units themselves are the record: a service
 * knows its webroot because that is its working directory, so `timeful service`
 * reads the platform's unit directories back and parses the webroot out of what
 * it finds. Nothing to keep in sync, nothing to corrupt, and a unit written by
 * an older version — or edited by hand — is still found.
 *
 * The three parsers here mirror the three generators in service.ts. Change a
 * generator and change its parser, or an installed service becomes invisible to
 * the CLI that installed it.
 */
import fs from "node:fs/promises";
import path from "node:path";
import type { ServiceTier } from "./service.ts";

/** Where each platform keeps the units this CLI writes. Injectable for tests. */
export interface ScanPaths {
  /** macOS: `~/Library/LaunchAgents`. */
  launchAgents?: string;
  /** Linux user tier: `${XDG_CONFIG_HOME:-~/.config}/systemd/user`. */
  systemdUser?: string;
  /** Linux system tier: `/etc/systemd/system`. */
  systemdSystem?: string;
  /**
   * Windows: `%LOCALAPPDATA%\Timeful`. The `schtasks` logon task runs the
   * launcher script kept there, so the directory is the thing worth scanning —
   * a task without its launcher could not start anyway.
   */
  windowsLaunchers?: string;
}

export interface DiscoveredService {
  platform: NodeJS.Platform;
  tier: ServiceTier;
  /** Label, unit file name or task name — whatever the platform addresses. */
  id: string;
  file: string;
  /** The service's working directory, when the unit could be read and parsed. */
  webroot?: string;
  /** Why `webroot` is missing. Present only when something went wrong. */
  problem?: string;
}

export interface ScanOptions {
  platform: NodeJS.Platform;
  home: string;
  env?: NodeJS.ProcessEnv;
}

/** The real directories for `platform`, from the same inputs `specFor` uses. */
export function scanPathsFor({ platform, home, env = process.env }: ScanOptions): ScanPaths {
  if (platform === "darwin")
    return { launchAgents: path.join(home, "Library", "LaunchAgents") };
  if (platform === "linux")
    return {
      systemdUser: path.join(env.XDG_CONFIG_HOME || path.join(home, ".config"), "systemd", "user"),
      systemdSystem: "/etc/systemd/system",
    };
  if (platform === "win32")
    return {
      windowsLaunchers: path.join(
        env.LOCALAPPDATA || path.join(home, "AppData", "Local"),
        "Timeful",
      ),
    };
  return {};
}

interface Source {
  dir: string;
  tier: ServiceTier;
  /** Recognises a file we wrote, and yields the id it is addressed by. */
  idOf: (name: string) => string | null;
  /** Pulls the working directory out of the file's contents. */
  webrootOf: (contents: string) => string | null;
}

const HASH = "[0-9a-f]{6,}";

const PLIST = new RegExp(`^app\\.timeful\\.${HASH}\\.plist$`);
const UNIT = new RegExp(`^timeful-${HASH}\\.service$`);
const LAUNCHER = new RegExp(`^Timeful-${HASH}\\.cmd$`, "i");

const XML_UNESCAPES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&apos;": "'",
};

function fromPlist(contents: string): string | null {
  const match = /<key>WorkingDirectory<\/key>\s*<string>([\s\S]*?)<\/string>/.exec(contents);
  if (!match) return null;
  return match[1].replace(/&(amp|lt|gt|quot|apos);/g, (entity) => XML_UNESCAPES[entity] ?? entity);
}

function fromUnit(contents: string): string | null {
  return /^WorkingDirectory=(.+)$/m.exec(contents)?.[1].trim() ?? null;
}

function fromLauncher(contents: string): string | null {
  return /^cd \/d "(.+)"\s*$/m.exec(contents)?.[1] ?? null;
}

/**
 * The CLI entry an installed unit execs, read back out of the unit.
 *
 * A fourth parser mirroring the same three generators — `timeful upgrade` has
 * to be able to say what the unit runs *now* before it re-points it at what is
 * running the upgrade. Best effort by design: the generators do not quote the
 * two POSIX paths, so a node binary with a space in its path is unreadable
 * here. That is what the null is for, and re-pinning a unit whose old value
 * could not be read is still the right thing to do.
 */
export function pinnedCliPath(
  platform: NodeJS.Platform,
  contents: string,
): string | null {
  if (platform === "darwin") {
    const array = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(contents);
    if (!array) return null;
    const strings = [...array[1].matchAll(/<string>([\s\S]*?)<\/string>/g)].map((m) =>
      m[1].replace(/&(amp|lt|gt|quot|apos);/g, (entity) => XML_UNESCAPES[entity] ?? entity),
    );
    // [node, cli, "serve"] — units written before `serve` existed have two.
    return strings[1] ?? null;
  }

  if (platform === "win32") {
    // The launcher quotes both paths, so this one is unambiguous.
    return /^"[^"]*"\s+"([^"]+)"/m.exec(contents)?.[1] ?? null;
  }

  const exec = /^ExecStart=(.+)$/m.exec(contents)?.[1].trim();
  if (!exec) return null;
  const words = exec.split(/\s+/);
  if (words[words.length - 1] === "serve") words.pop();
  return words[1] ?? null;
}

function sourcesFor(platform: NodeJS.Platform, paths: ScanPaths): Source[] {
  const sources: Source[] = [];
  // A systemd unit is addressed by its file name, extension and all.
  const unitId = (file: string): string | null => (UNIT.test(file) ? file : null);

  if (platform === "darwin" && paths.launchAgents)
    sources.push({
      dir: paths.launchAgents,
      tier: "user",
      // The launchd label is the file name without the extension.
      idOf: (file) => (PLIST.test(file) ? file.replace(/\.plist$/, "") : null),
      webrootOf: fromPlist,
    });

  if (platform === "linux") {
    if (paths.systemdUser)
      sources.push({
        dir: paths.systemdUser,
        tier: "user",
        idOf: unitId,
        webrootOf: fromUnit,
      });
    if (paths.systemdSystem)
      sources.push({
        dir: paths.systemdSystem,
        tier: "system",
        idOf: unitId,
        webrootOf: fromUnit,
      });
  }

  if (platform === "win32" && paths.windowsLaunchers)
    sources.push({
      dir: paths.windowsLaunchers,
      tier: "user",
      idOf: (file) => (LAUNCHER.test(file) ? file.replace(/\.cmd$/i, "") : null),
      webrootOf: fromLauncher,
    });

  return sources;
}

/**
 * Every Timeful service installed for this platform, newest information first.
 *
 * A directory that does not exist, or that we may not read, contributes
 * nothing. A unit we cannot read or cannot parse is still reported — with a
 * `problem` instead of a webroot — because hiding it would make an installed
 * service impossible to uninstall from here.
 */
export async function discoverServices(options: {
  platform: NodeJS.Platform;
  paths: ScanPaths;
}): Promise<DiscoveredService[]> {
  const found: DiscoveredService[] = [];

  for (const source of sourcesFor(options.platform, options.paths)) {
    let names: string[];
    try {
      names = await fs.readdir(source.dir);
    } catch {
      continue;
    }

    for (const name of names.sort()) {
      const id = source.idOf(name);
      if (!id) continue;
      const file = path.join(source.dir, name);
      const entry: DiscoveredService = {
        platform: options.platform,
        tier: source.tier,
        id,
        file,
      };

      let contents: string;
      try {
        contents = await fs.readFile(file, "utf8");
      } catch (err) {
        entry.problem = `cannot be read (${err instanceof Error ? err.message : String(err)})`;
        found.push(entry);
        continue;
      }

      const webroot = source.webrootOf(contents);
      if (webroot) entry.webroot = webroot;
      else entry.problem = "no working directory in the unit";
      found.push(entry);
    }
  }

  return found.sort((a, b) => (a.webroot ?? a.file).localeCompare(b.webroot ?? b.file));
}

/** The distinct webroots among `services`, in the order they were found. */
export function webrootsOf(services: readonly DiscoveredService[]): string[] {
  const seen = new Set<string>();
  for (const service of services) if (service.webroot) seen.add(path.resolve(service.webroot));
  return [...seen];
}
