/**
 * `timeful upgrade` — move an installed service onto the build that is running
 * this command.
 *
 * The verb exists because of one property of `npx`. By the time
 * `npx timeful@latest upgrade` reaches this file, npx has **already** fetched
 * and unpacked the new version: the process executing these lines *is* the new
 * Timeful. So upgrading never downloads anything and never overwrites anything
 * in place. It re-points the service unit at the bits already running and
 * restarts it.
 *
 * That matters because a service unit pins an absolute path
 * (`ExecStart=<node> <cli> serve`, and the plist and launcher equivalents), and
 * for an npx install that path is inside npm's `_npx` cache. Installing a
 * service from `npx timeful` and then running `npx timeful@latest` a year later
 * upgrades the copy in your terminal and leaves the service exactly where it
 * was. Re-pinning is the fix, and it is the whole job.
 *
 * What is never touched: `var/`, `timeful.config.json`, and anything else in
 * the webroot. There are no migrations — old documents are read as they stand
 * (ARCHITECTURE.md § Storage) — so there is nothing for an upgrade to convert.
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

/**
 * What the running CLI is, as far as upgrading is concerned.
 *
 * - `npx`   — the path is inside npm's `_npx` cache, so it belongs to this
 *             fetch and re-pinning the unit is exactly the right move.
 * - `stable`— a global install or a checkout. The path does not move, so a
 *             rewritten unit would exec the same file; taking a new version
 *             means replacing what lives at that path, which is npm's job and
 *             not ours.
 */
export type InstallKind = "npx" | "stable";

/**
 * npm unpacks an `npx <pkg>` into `<npm cache>/_npx/<hash>/node_modules/…`, and
 * `_npx` is the only part of that layout npm has kept stable across versions.
 * Matching a whole path *segment* rather than a substring keeps the heuristic
 * conservative: a global install under a directory that merely contains the
 * letters `_npx` is not misread, and the cost of guessing wrong is only which
 * of two accurate sentences gets printed.
 */
export function installKind(cliPath: string): InstallKind {
  const segments = cliPath.split(/[\\/]+/);
  return segments.includes("_npx") ? "npx" : "stable";
}

/**
 * The version of the package a CLI entry belongs to, from the `package.json`
 * beside it — which is where the build puts it (ARCHITECTURE.md § Packaging).
 * Null when there is none to read, which is the normal answer for a checkout.
 */
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

/**
 * Re-points every installed unit of one webroot and restarts it.
 *
 * `explicit` distinguishes a webroot the operator named from one `-A` swept
 * up: naming a serve-only directory deserves an explanation of how *that*
 * upgrades, while sweeping past one deserves a single line.
 */
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

    // Identical paths are only "nothing to do" if the bits behind that path are
    // also the ones running. They usually are — it is the same file — but the
    // check is cheap and the sentence it earns is worth more than the guess.
    if (pinned === cliPath && (await versionBeside(host, pinned)) === version) {
      host.log(`    already up to date (${version}). Nothing to do.`);
      // The one case the comparison above cannot see: the package at that path
      // was replaced under a running service, which still holds the old code.
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

/**
 * What to say before touching anything, when the running CLI did not come from
 * an npx cache.
 *
 * Re-pinning a unit that already execs a stable path changes nothing, so the
 * only way such an install takes a new version is for something to replace what
 * lives at that path. That something is `npm`, and running it on the operator's
 * behalf is not this command's business: a global install is a machine-wide
 * change, it may need a privilege we were not given, and the operator may be
 * pinned to a version on purpose. So the ritual is printed, never performed.
 *
 * The registry is asked only here, and only when a lookup was supplied — the
 * whole verb works offline, because the `@latest` form never needed the network
 * in the first place.
 */
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
    // Unreachable is not fatal. The re-pin and the restart below still work,
    // and an air-gapped machine is a supported way to run this.
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
