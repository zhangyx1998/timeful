/**
 * npx has already fetched the new version by the time this runs; units pin absolute paths
 * (often inside the _npx cache), so re-pinning + restart is the whole upgrade. The webroot
 * is never touched and there are no migrations (ARCHITECTURE.md § Storage).
 */
import path from "node:path";
import { pinnedCliPath } from "./discover.ts";
import {
  controlService,
  installService,
  refFor,
  type ServiceHost,
  type ServiceUnit,
  type VerifyOptions,
} from "./service.ts";
import { isNewerVersion, type RegistryLookup } from "../registry.ts";

/** `npx`: the path is inside the _npx cache, so re-pin; `stable`: the path does not move, replacing it is npm's job. */
export type InstallKind = "npx" | "stable";

/** `_npx` is the only path segment npm has kept stable; whole-segment matching keeps the heuristic conservative. */
export function installKind(cliPath: string): InstallKind {
  const segments = cliPath.split(/[\\/]+/);
  return segments.includes("_npx") ? "npx" : "stable";
}

/** Version from the package.json beside the CLI entry (ARCHITECTURE.md § Packaging); null for a checkout. */
export async function versionBeside(
  host: ServiceHost,
  cliPath: string,
): Promise<string | null> {
  const text = await host.readFile(path.join(path.dirname(cliPath), "package.json"));
  if (text === null) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    const version =
      typeof parsed === "object" && parsed !== null
        ? (parsed as { version?: unknown }).version
        : undefined;
    return typeof version === "string" && version ? version : null;
  } catch {
    return null;
  }
}

export interface UpgradeContext {
  host: ServiceHost;
  /** Absolute path of the CLI entry the running process is executing. */
  cliPath: string;
  /** The running version. */
  version: string;
  /** Asked before anything privileged runs; handed to `installService`. */
  confirmPrivileged?: () => Promise<boolean>;
  /** Pacing for the post-start watch; handed to `installService`. */
  verify?: VerifyOptions;
}

/** What happened to one webroot. Reported back so `-A` can summarise. */
export type UpgradeOutcome = "no-service" | "unchanged" | "upgraded";

/** Re-points every installed unit of one webroot; `explicit` earns a named webroot the long no-service explanation. */
export async function upgradeWebroot(
  webroot: string,
  units: readonly ServiceUnit[],
  context: UpgradeContext,
  { explicit = false }: { explicit?: boolean } = {},
): Promise<UpgradeOutcome> {
  const { host, cliPath, version } = context;
  host.log(webroot);

  if (units.length === 0) {
    if (!explicit) {
      host.log("  no Timeful service is installed here; nothing to re-point.");
      return "no-service";
    }
    host.log("  No Timeful service is installed for this webroot, so there is");
    host.log("  nothing to re-point. A copy you start by hand upgrades by being");
    host.log("  started again from the new version:");
    host.log();
    host.log(`    cd ${webroot} && npx timeful@latest`);
    host.log();
    host.log("  Run 'timeful service install' here if you would rather it came");
    host.log("  back on its own after a reboot.");
    return "no-service";
  }

  let outcome: UpgradeOutcome = "unchanged";
  for (const unit of units) {
    host.log(`  ${unit.spec.tier} tier: ${unit.id}`);

    const contents = await host.readFile(unit.file);
    const pinned = contents === null ? null : pinnedCliPath(unit.spec.platform, contents);

    if (pinned === null) {
      host.log("    the installed unit names no CLI path; rewriting it.");
    } else if (pinned === cliPath) {
      host.log(`    already execs ${cliPath}`);
    } else {
      host.log(`    was ${pinned}`);
      host.log(`    now ${cliPath}`);
    }

    // The same path does not guarantee the same bits; the version check is cheap.
    if (pinned === cliPath && (await versionBeside(host, pinned)) === version) {
      host.log(`    already up to date (${version}). Nothing to do.`);
      // A package replaced in place under a running service is invisible to the comparison.
      host.log("    (Replaced the install in place? Run 'timeful service restart'.)");
      continue;
    }

    await installService(unit, host, {
      confirmPrivileged: context.confirmPrivileged,
      verify: context.verify,
    });
    await controlService(refFor(unit), "restart", host);
    outcome = "upgraded";
  }
  return outcome;
}

/** The npm ritual is printed, never performed: replacing a stable install is npm's job, may need privileges, and may be pinned on purpose. The registry is asked only here, only when a lookup was supplied. */
export async function reportStableInstall(
  context: UpgradeContext,
  lookup?: () => Promise<RegistryLookup>,
): Promise<void> {
  const { host, cliPath, version } = context;
  host.log(`Running ${version} from ${cliPath},`);
  host.log("which is not an npx cache: re-pointing a unit at it changes nothing,");
  host.log("because it already points there.");
  host.log();

  if (!lookup) {
    host.log("Dry run: the npm registry was not contacted.");
    host.log();
    return;
  }

  const { latest, problem } = await lookup();
  if (latest === null) {
    // Unreachable is not fatal; air-gapped machines are supported.
    host.log(`${problem ?? "The npm registry could not be reached."} Continuing anyway.`);
    host.log();
    return;
  }

  if (!isNewerVersion(latest, version)) {
    host.log(`${latest} is the latest published version, so there is nothing newer to take.`);
    host.log();
    return;
  }

  host.log(`${latest} has been published. To take it:`);
  host.log();
  host.log("  npm i -g timeful@latest");
  host.log("  timeful service restart");
  host.log();
  host.log("Nothing below installs it for you.");
  host.log();
}
