/**
 * The per-platform facts service.ts and discover.ts must agree on.
 *
 * One side *writes* units — a launchd LaunchAgent, a systemd unit, a schtasks
 * launcher — and the other finds them again by scanning the platform's unit
 * directory and parsing the webroot back out of what it wrote. There is no
 * registry file tying the two together (see discover.ts), so the naming
 * scheme, the directories and the parsers live here, once, where neither side
 * can drift from the other.
 *
 * The parsers are deliberately **more lenient** than the generators: a shorter
 * hash, a re-cased extension, an `ExecStart` without `serve`, are all files an
 * older version of this CLI — or a hand — may have left behind, and every one
 * of them must keep being found or an installed service becomes invisible to
 * the CLI that installed it. Never tighten a parser here onto what today's
 * generator happens to emit; discover.test.ts carries fixtures for exactly
 * that regression.
 */
import path from "node:path";

export type ServiceTier = "user" | "system";

/** What the per-tier unit directories are built from; a slice of `ServiceSpec`. */
export interface PlaceInputs {
  /** The invoking user's home directory. */
  home: string;
  /** `XDG_CONFIG_HOME`, when set. */
  configHome?: string;
  /** `LOCALAPPDATA`, when set (Windows). */
  localAppData?: string;
}

// The directories, as named functions, so a generator can call the one it
// means without indexing through the table.

/** macOS user tier: `~/Library/LaunchAgents`. */
export const launchAgentsDir = (inputs: PlaceInputs): string =>
  path.join(inputs.home, "Library", "LaunchAgents");

/** Linux user tier: `${XDG_CONFIG_HOME:-~/.config}/systemd/user`. */
export const systemdUserDir = (inputs: PlaceInputs): string =>
  path.join(inputs.configHome || path.join(inputs.home, ".config"), "systemd", "user");

/**
 * Linux system tier. A posix constant, and a unit path under it is always
 * built with `path.posix.join`: it names a path on the machine the unit will
 * run on, not the one generating it, so a cross-generated unit must never
 * pick up another platform's separators.
 */
export const SYSTEMD_SYSTEM_DIR = "/etc/systemd/system";

/**
 * Windows: `%LOCALAPPDATA%\Timeful`. The `schtasks` logon task runs the
 * launcher script kept there, so the directory is the record worth scanning —
 * a task without its launcher could not start anyway.
 */
export const windowsLaunchersDir = (inputs: PlaceInputs): string =>
  path.join(inputs.localAppData || path.join(inputs.home, "AppData", "Local"), "Timeful");

// XML escaping: one map, inverted, so an entity the plist generator starts
// writing is an entity the parser puts back.

const XML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&apos;",
};

const XML_UNESCAPES: Record<string, string> = Object.fromEntries(
  Object.entries(XML_ESCAPES).map(([raw, escaped]) => [escaped, raw]),
);

export function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => XML_ESCAPES[c] ?? c);
}

export function unescapeXml(value: string): string {
  return value.replace(/&(amp|lt|gt|quot|apos);/g, (entity) => XML_UNESCAPES[entity] ?? entity);
}

// The parsers — lenient by design; see the module comment.

function fromPlist(contents: string): string | null {
  const match = /<key>WorkingDirectory<\/key>\s*<string>([\s\S]*?)<\/string>/.exec(contents);
  return match ? unescapeXml(match[1]) : null;
}

function fromUnit(contents: string): string | null {
  return /^WorkingDirectory=(.+)$/m.exec(contents)?.[1].trim() ?? null;
}

function fromLauncher(contents: string): string | null {
  return /^cd \/d "(.+)"\s*$/m.exec(contents)?.[1] ?? null;
}

function cliFromPlist(contents: string): string | null {
  const array = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(contents);
  if (!array) return null;
  const strings = [...array[1].matchAll(/<string>([\s\S]*?)<\/string>/g)].map((m) =>
    unescapeXml(m[1]),
  );
  // [node, cli, "serve"] — units written before `serve` existed have two.
  return strings[1] ?? null;
}

function cliFromUnit(contents: string): string | null {
  // The generators do not quote the two POSIX paths, so a node binary with a
  // space in its path is unreadable here; `ExecStart` with no `serve` is an
  // older unit and still parses.
  const exec = /^ExecStart=(.+)$/m.exec(contents)?.[1].trim();
  if (!exec) return null;
  const words = exec.split(/\s+/);
  if (words[words.length - 1] === "serve") words.pop();
  return words[1] ?? null;
}

function cliFromLauncher(contents: string): string | null {
  // The launcher quotes both paths, so this one is unambiguous.
  return /^"[^"]*"\s+"([^"]+)"/m.exec(contents)?.[1] ?? null;
}

/** A `ScanPaths` field (discover.ts): where discovery publishes a directory. */
export type ScanKey = "launchAgents" | "systemdUser" | "systemdSystem" | "windowsLaunchers";

export interface PlatformNaming {
  /** File-name prefix of every unit file this CLI writes. */
  idPrefix: string;
  /** The unit file's extension, dot included. */
  ext: string;
  /**
   * systemd addresses a unit by its file name, extension and all; a launchd
   * label and a schtasks task name drop it.
   */
  idIncludesExt: boolean;
  /** Windows compares file names case-insensitively, so the scanner must too. */
  ignoreCase?: boolean;
  /** One entry per tier the platform offers: where that tier's units live. */
  places: Partial<Record<ServiceTier, { scanKey: ScanKey; dir: (inputs: PlaceInputs) => string }>>;
  /** Pulls the service's working directory out of a unit's contents. */
  webrootOf(contents: string): string | null;
  /** Pulls the CLI entry a unit execs out of its contents. */
  cliPathOf(contents: string): string | null;
}

export const PLATFORMS: Record<"darwin" | "linux" | "win32", PlatformNaming> = {
  darwin: {
    idPrefix: "app.timeful.",
    ext: ".plist",
    idIncludesExt: false,
    places: { user: { scanKey: "launchAgents", dir: launchAgentsDir } },
    webrootOf: fromPlist,
    cliPathOf: cliFromPlist,
  },
  linux: {
    idPrefix: "timeful-",
    ext: ".service",
    idIncludesExt: true,
    places: {
      user: { scanKey: "systemdUser", dir: systemdUserDir },
      system: { scanKey: "systemdSystem", dir: () => SYSTEMD_SYSTEM_DIR },
    },
    webrootOf: fromUnit,
    cliPathOf: cliFromUnit,
  },
  win32: {
    idPrefix: "Timeful-",
    ext: ".cmd",
    idIncludesExt: false,
    ignoreCase: true,
    places: { user: { scanKey: "windowsLaunchers", dir: windowsLaunchersDir } },
    webrootOf: fromLauncher,
    cliPathOf: cliFromLauncher,
  },
};

/** The table entry for `platform`, or undefined when it has no service story. */
export function platformNaming(platform: NodeJS.Platform): PlatformNaming | undefined {
  return platform === "darwin" || platform === "linux" || platform === "win32"
    ? PLATFORMS[platform]
    : undefined;
}
