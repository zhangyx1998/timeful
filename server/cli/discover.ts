/** No registry file: the units themselves are the record, the webroot parsed back out of each one's working directory. Naming and parsers live in platforms.ts. */
import fs from "node:fs/promises";
import path from "node:path";
import {
  PLATFORMS,
  platformNaming,
  type PlatformNaming,
  type ServiceTier,
} from "./platforms.ts";

/** Where each platform keeps the units this CLI writes. Injectable for tests. */
export interface ScanPaths {
  /** macOS: `~/Library/LaunchAgents`. */
  launchAgents?: string;
  /** Linux user tier: `${XDG_CONFIG_HOME:-~/.config}/systemd/user`. */
  systemdUser?: string;
  /** Linux system tier: `/etc/systemd/system`. */
  systemdSystem?: string;
  /** Windows: `%LOCALAPPDATA%\Timeful` — the schtasks task runs the launcher kept there. */
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
  const naming = platformNaming(platform);
  if (!naming) return {};
  const inputs = { home, configHome: env.XDG_CONFIG_HOME, localAppData: env.LOCALAPPDATA };
  const paths: ScanPaths = {};
  for (const place of Object.values(naming.places))
    if (place) paths[place.scanKey] = place.dir(inputs);
  return paths;
}

interface Source {
  dir: string;
  tier: ServiceTier;
  /** Recognises a file we wrote, and yields the id it is addressed by. */
  idOf: (name: string) => string | null;
  /** Pulls the working directory out of the file's contents. */
  webrootOf: (contents: string) => string | null;
}

// Looser than today's 10-char webrootHash on purpose: older units must stay findable.
const HASH = "[0-9a-f]{6,}";

const escapeRe = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Regex-escaped: `app.timeful.`'s dots must match dots, or other vendors' plists match too.
const fileNameOf = (naming: PlatformNaming): RegExp =>
  new RegExp(
    `^${escapeRe(naming.idPrefix)}${HASH}${escapeRe(naming.ext)}$`,
    naming.ignoreCase ? "i" : "",
  );

/** The CLI entry an installed unit execs; best effort — re-pinning a unit that reads null is still right. */
export function pinnedCliPath(platform: NodeJS.Platform, contents: string): string | null {
  // Unknown platforms read as systemd units, as they always have.
  return (platformNaming(platform) ?? PLATFORMS.linux).cliPathOf(contents);
}

function sourcesFor(platform: NodeJS.Platform, paths: ScanPaths): Source[] {
  const naming = platformNaming(platform);
  if (!naming) return [];

  const pattern = fileNameOf(naming);
  const ext = new RegExp(`${escapeRe(naming.ext)}$`, naming.ignoreCase ? "i" : "");
  const idOf = (file: string): string | null =>
    pattern.test(file) ? (naming.idIncludesExt ? file : file.replace(ext, "")) : null;

  const sources: Source[] = [];
  for (const [tier, place] of Object.entries(naming.places)) {
    const dir = place && paths[place.scanKey];
    if (dir)
      sources.push({ dir, tier: tier as ServiceTier, idOf, webrootOf: naming.webrootOf });
  }
  return sources;
}

/** An unreadable directory contributes nothing; an unparseable unit is still reported with a `problem`, or it could never be uninstalled from here. */
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
