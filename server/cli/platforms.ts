/**
 * The per-platform facts service.ts and discover.ts must agree on. Parsers are deliberately
 * more lenient than generators — units an older version left behind must stay findable;
 * never tighten a parser onto today's output (discover.test.ts carries the fixtures).
 */
import path from "node:path";

export type ServiceTier = "user" | "system";

/** What the per-tier unit directories are built from; a slice of `ServiceSpec`. */
export interface PlaceInputs {
  home: string;
  /** `XDG_CONFIG_HOME`, when set. */
  configHome?: string;
  /** `LOCALAPPDATA`, when set (Windows). */
  localAppData?: string;
}

/** macOS user tier: `~/Library/LaunchAgents`. */
export const launchAgentsDir = (inputs: PlaceInputs): string =>
  path.join(inputs.home, "Library", "LaunchAgents");

/** Linux user tier: `${XDG_CONFIG_HOME:-~/.config}/systemd/user`. */
export const systemdUserDir = (inputs: PlaceInputs): string =>
  path.join(inputs.configHome || path.join(inputs.home, ".config"), "systemd", "user");

/** Linux system tier. Paths under it always use `path.posix.join`: they name the target machine, not the generator's. */
export const SYSTEMD_SYSTEM_DIR = "/etc/systemd/system";

/** Windows: `%LOCALAPPDATA%\Timeful` — the schtasks task runs the launcher kept there. */
export const windowsLaunchersDir = (inputs: PlaceInputs): string =>
  path.join(inputs.localAppData || path.join(inputs.home, "AppData", "Local"), "Timeful");

// One map, inverted, so the plist generator and parser can never disagree.
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
  // Paths are unquoted, so a node path with a space is unreadable; ExecStart without serve is an older unit.
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
  /** systemd addresses a unit by file name with extension; launchd labels and schtasks names drop it. */
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
