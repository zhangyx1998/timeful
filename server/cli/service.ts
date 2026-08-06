/** Every command goes through ServiceHost.run — stubbed in tests, short-circuited by TIMEFUL_SERVICE_DRY_RUN. */
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { CliError } from "./errors.ts";
import {
  escapeXml,
  launchAgentsDir,
  PLATFORMS,
  platformNaming,
  SYSTEMD_SYSTEM_DIR,
  systemdUserDir,
  windowsLaunchersDir,
  type ServiceTier,
} from "./platforms.ts";

export type { ServiceTier };

export interface ServiceSpec {
  platform: NodeJS.Platform;
  tier: ServiceTier;
  /** The webroot: working directory of the service, home of the config. */
  webroot: string;
  /** Resolved data directory; the service's logs go beside it. */
  varDir: string;
  nodePath: string;
  cliPath: string;
  home: string;
  /** Login name; only printed (loginctl enable-linger), never used to decide. */
  user?: string;
  /** `XDG_CONFIG_HOME`, when set. */
  configHome?: string;
  /** `LOCALAPPDATA`, when set (Windows). */
  localAppData?: string;
  /** The invoking user's uid; launchd domains are per-uid. */
  uid?: number;
}

export interface ServiceCommand {
  command: string;
  args: string[];
  /** A non-zero exit is expected and reported, not fatal (stopping a stopped service). */
  tolerant?: boolean;
}

/** Explicit so a service can never fall into the wizard; older units exec no argument and still work. */
const SERVE_ARG = "serve";

export interface ServiceUnit {
  spec: ServiceSpec;
  /** Identifier shared by the file name and every command below. */
  id: string;
  file: string;
  /** Pre-install write location when the destination needs sudo. */
  staging?: string;
  contents: string;
  privileged: boolean;
  activate: ServiceCommand[];
  deactivate: ServiceCommand[];
  status: ServiceCommand[];
}

/** A short, stable identifier for a webroot. */
export function webrootHash(webroot: string): string {
  return crypto.createHash("sha256").update(path.resolve(webroot)).digest("hex").slice(0, 10);
}

export function serviceId(spec: ServiceSpec): string {
  const hash = webrootHash(spec.webroot);
  // Unknown platforms read as linux; unitFor refuses them before an id names a real unit.
  return `${(platformNaming(spec.platform) ?? PLATFORMS.linux).idPrefix}${hash}`;
}

/** Renders a command the way an operator would type it. */
export function formatCommand(cmd: ServiceCommand): string {
  return [cmd.command, ...cmd.args].map(quoteArg).join(" ");
}

function quoteArg(arg: string): string {
  return /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;
}

// ---------------------------------------------------------------------------
// unit generation
// ---------------------------------------------------------------------------

export function unitFor(spec: ServiceSpec): ServiceUnit {
  if (spec.platform === "darwin") return launchdUnit(spec);
  if (spec.platform === "win32") return schtasksUnit(spec);
  if (spec.platform === "linux")
    return spec.tier === "system" ? systemdSystemUnit(spec) : systemdUserUnit(spec);
  throw new CliError(
    `Installing a service is not supported on ${spec.platform}. Run 'timeful' from a process manager of your choice instead.`,
  );
}

export function availableTiers(platform: NodeJS.Platform): ServiceTier[] {
  const places = platformNaming(platform)?.places;
  return places ? (Object.keys(places) as ServiceTier[]) : ["user"];
}

function logFile(spec: ServiceSpec, stream: "out" | "err"): string {
  return path.join(spec.varDir, `timeful.${stream}.log`);
}

function launchdUnit(spec: ServiceSpec): ServiceUnit {
  const id = serviceId(spec);
  const file = path.join(launchAgentsDir(spec), `${id}${PLATFORMS.darwin.ext}`);
  const domain = `gui/${spec.uid ?? 0}`;
  const programArguments = [spec.nodePath, spec.cliPath, SERVE_ARG]
    .map((arg) => `      <string>${escapeXml(arg)}</string>`)
    .join("\n");

  const contents = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${escapeXml(id)}</string>
    <key>ProgramArguments</key>
    <array>
${programArguments}
    </array>
    <key>WorkingDirectory</key>
    <string>${escapeXml(spec.webroot)}</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ProcessType</key>
    <string>Background</string>
    <key>StandardOutPath</key>
    <string>${escapeXml(logFile(spec, "out"))}</string>
    <key>StandardErrorPath</key>
    <string>${escapeXml(logFile(spec, "err"))}</string>
  </dict>
</plist>
`;

  return {
    spec,
    id,
    file,
    contents,
    privileged: false,
    activate: [{ command: "launchctl", args: ["bootstrap", domain, file] }],
    deactivate: [{ command: "launchctl", args: ["bootout", `${domain}/${id}`] }],
    status: [{ command: "launchctl", args: ["print", `${domain}/${id}`] }],
  };
}

function systemdUserUnit(spec: ServiceSpec): ServiceUnit {
  const id = `${serviceId(spec)}${PLATFORMS.linux.ext}`;
  const file = path.join(systemdUserDir(spec), id);
  const contents = `[Unit]
Description=Timeful (${spec.webroot})
After=network.target

[Service]
Type=simple
WorkingDirectory=${spec.webroot}
ExecStart=${spec.nodePath} ${spec.cliPath} ${SERVE_ARG}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`;

  const user = (...args: string[]): ServiceCommand => ({
    command: "systemctl",
    args: ["--user", ...args],
  });

  return {
    spec,
    id,
    file,
    contents,
    privileged: false,
    activate: [user("daemon-reload"), user("enable", "--now", id)],
    deactivate: [user("disable", "--now", id)],
    status: [user("status", id)],
  };
}

/** A group, not a user: DynamicUser UIDs are per-start, so group ownership is what survives; one group per machine. */
export const SERVICE_GROUP = "timeful";

const PROTECTED_HOMES = ["/home", "/root", "/run/user"];

/** True when `child` is `parent` or sits underneath it. Posix paths only. */
function isUnder(child: string, parent: string): boolean {
  const rel = path.posix.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.posix.isAbsolute(rel));
}

/** PROTECTED_HOMES plus an out-of-place home, which is typically 0700/0750. */
function homeRoots(spec: ServiceSpec): string[] {
  const roots = [...PROTECTED_HOMES];
  const home = spec.home?.trim();
  if (home && home !== "/" && !roots.some((root) => isUnder(home, root))) roots.push(home);
  return roots;
}

// ProtectHome=off + ProtectSystem=strict + ReadWritePaths= is the only shape verified to write
// on real systemd 255; the documented tmpfs/BindPaths variants fail with EROFS. Do not re-derive
// from the manual — dry-run tests can never prove mount semantics.
function systemdSystemUnit(spec: ServiceSpec): ServiceUnit {
  const id = `${serviceId(spec)}${PLATFORMS.linux.ext}`;
  // posix on purpose: names a path on the unit's own machine, never backslashes.
  const file = path.posix.join(SYSTEMD_SYSTEM_DIR, id);
  const staging = path.join(os.tmpdir(), id);

  const contents = `[Unit]
Description=Timeful (${spec.webroot})
After=network.target

[Service]
Type=simple
DynamicUser=yes
SupplementaryGroups=${SERVICE_GROUP}
UMask=0002
WorkingDirectory=${spec.webroot}
ExecStart=${spec.nodePath} ${spec.cliPath} ${SERVE_ARG}
ProtectSystem=strict
ProtectHome=off
ReadWritePaths=${spec.varDir}
NoNewPrivileges=yes
PrivateTmp=yes
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
`;

  const sudo = (...args: string[]): ServiceCommand => ({ command: "sudo", args });

  return {
    spec,
    id,
    file,
    staging,
    contents,
    privileged: true,
    activate: [
      // Idempotent: an existing group is the normal case on the second webroot.
      sudo(
        "sh",
        "-c",
        `getent group ${SERVICE_GROUP} >/dev/null || groupadd --system ${SERVICE_GROUP}`,
      ),
      // systemd silently ignores a ReadWritePaths= path that does not exist at start.
      sudo("mkdir", "-p", spec.varDir),
      // Group ownership + setgid is what outlives the per-start dynamic UID.
      sudo("chown", "-R", `:${SERVICE_GROUP}`, spec.varDir),
      sudo("chmod", "-R", "g+rwX", spec.varDir),
      sudo("find", spec.varDir, "-type", "d", "-exec", "chmod", "g+s", "{}", "+"),
      sudo("install", "-m", "0644", staging, file),
      sudo("systemctl", "daemon-reload"),
      // Clears a latched failure from an older crash-looped unit; exit codes vary, hence tolerant.
      { ...sudo("systemctl", "reset-failed", id), tolerant: true },
      // `enable --now` would not bounce an already-running unit; restart does.
      sudo("systemctl", "enable", id),
      sudo("systemctl", "restart", id),
    ],
    deactivate: [
      sudo("systemctl", "disable", "--now", id),
      sudo("rm", "-f", file),
      sudo("systemctl", "daemon-reload"),
    ],
    status: [{ command: "systemctl", args: ["status", id] }],
  };
}

/** Ancestors of `target` inside a home, home itself down to target; containers above are root 0755. */
function homeAncestors(spec: ServiceSpec, target: string): string[] {
  const roots = homeRoots(spec);
  const containers = ["/home", "/run/user"];
  const chain: string[] = [];
  let dir = target;
  while (dir !== "/" && dir !== path.posix.dirname(dir)) {
    if (!roots.some((root) => isUnder(dir, root))) break;
    if (containers.includes(dir)) break;
    chain.unshift(dir);
    dir = path.posix.dirname(dir);
  }
  return chain;
}

/** Why this spec cannot be a system unit (home ancestor without o+x → 200/CHDIR crash loop), or null. */
export async function systemTierProblem(
  spec: ServiceSpec,
  host: ServiceHost,
  options: { installed?: boolean } = {},
): Promise<string | null> {
  if (spec.platform !== "linux" || spec.tier !== "system") return null;

  const suspects = new Set<string>();
  const targets = [
    spec.webroot,
    path.posix.dirname(spec.varDir),
    path.posix.dirname(spec.cliPath),
    path.posix.dirname(spec.nodePath),
  ];
  for (const target of targets)
    for (const dir of homeAncestors(spec, target)) suspects.add(dir);

  const blocked: string[] = [];
  for (const dir of [...suspects].sort()) {
    const mode = await host.mode(dir);
    if (mode !== null && (mode & 0o001) === 0)
      blocked.push(`  ${(mode & 0o7777).toString(8).padStart(4, "0")}  ${dir}`);
  }
  if (blocked.length === 0) return null;

  const who = spec.user || (spec.home ? path.posix.basename(spec.home) : "") || "<user>";
  const install = "  timeful service install";
  const linger = `  sudo loginctl enable-linger ${who}`;
  const column = Math.max(install.length, linger.length) + 2;
  const lines = [
    "The hardened system tier cannot reach this webroot.",
    "",
    "It would run as an ephemeral user (DynamicUser=yes) with no access beyond",
    "the 'timeful' group, and everything it uses — the webroot, the data",
    "directory, node, the CLI — sits behind directories that do not let another",
    "account pass through them:",
    "",
    ...blocked,
    "",
    "Traverse-only access is enough. o+x lets a process walk through a",
    "directory it names exactly, without listing or reading anything in it:",
    "",
    ...blocked.map((line) => `  chmod o+x ${line.trimStart().split(/\s+/)[1]}`),
    "",
    "Or run it as yourself instead. The user tier needs no sudo, and lingering",
    "is what makes it start at boot rather than at login:",
    "",
    `${install.padEnd(column)}# user tier, runs as you`,
    `${linger.padEnd(column)}# start at boot, survive logout`,
  ];

  if (options.installed) {
    lines.push(
      "",
      "A system unit is already installed for this webroot, and it cannot be",
      "working. Take it away before it fights the user service for the port:",
      "",
      "  timeful service uninstall --system",
    );
  }

  return lines.join("\n");
}

function schtasksUnit(spec: ServiceSpec): ServiceUnit {
  const id = serviceId(spec);
  const file = path.join(windowsLaunchersDir(spec), `${id}${PLATFORMS.win32.ext}`);
  // schtasks has no working-directory option; the launcher cds into the webroot.
  const contents = `@echo off\r\ncd /d "${spec.webroot}"\r\n"${spec.nodePath}" "${spec.cliPath}" ${SERVE_ARG}\r\n`;

  return {
    spec,
    id,
    file,
    contents,
    privileged: false,
    activate: [
      { command: "schtasks", args: ["/create", "/tn", id, "/tr", `"${file}"`, "/sc", "onlogon", "/f"] },
    ],
    deactivate: [{ command: "schtasks", args: ["/delete", "/tn", id, "/f"] }],
    status: [{ command: "schtasks", args: ["/query", "/tn", id] }],
  };
}

// ---------------------------------------------------------------------------
// the machine
// ---------------------------------------------------------------------------

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Everything install/uninstall need from the outside world. */
export interface ServiceHost {
  /** True when nothing is actually done; the reporting says so. */
  readonly dryRun?: boolean;
  writeFile(file: string, contents: string): Promise<void>;
  /** Contents or null. Honoured in a dry run too — a read is not a change. */
  readFile(file: string): Promise<string | null>;
  removeFile(file: string): Promise<void>;
  exists(file: string): Promise<boolean>;
  /** Permission bits (`st_mode & 0o7777`) or null; honoured in a dry run like readFile. */
  mode(file: string): Promise<number | null>;
  run(cmd: ServiceCommand): Promise<RunResult>;
  /** Whether an executable is on PATH. */
  which(binary: string): Promise<boolean>;
  log(line?: string): void;
}

const run = (cmd: ServiceCommand): Promise<RunResult> =>
  new Promise((resolve) => {
    execFile(cmd.command, cmd.args, (err, stdout, stderr) => {
      const code =
        err && typeof err === "object" && "code" in err && typeof err.code === "number"
          ? err.code
          : err
            ? 1
            : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  });

export interface NodeHostOptions {
  log?: (line?: string) => void;
  /** `--dry-run`; TIMEFUL_SERVICE_DRY_RUN is an alias. */
  dryRun?: boolean;
}

/** The real host. A dry run prints every command instead of executing it and touches no file. */
export function nodeHost(options: NodeHostOptions = {}): ServiceHost {
  const log = options.log ?? console.log;
  const dryRun = options.dryRun || Boolean(process.env.TIMEFUL_SERVICE_DRY_RUN);
  return {
    dryRun,
    async writeFile(file, contents) {
      if (dryRun) return; // the caller reports it
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, contents, "utf8");
    },
    async readFile(file) {
      // Not gated on `dryRun`: a read is not a change.
      try {
        return await fs.readFile(file, "utf8");
      } catch {
        return null;
      }
    },
    async removeFile(file) {
      if (dryRun) return;
      await fs.rm(file, { force: true });
    },
    async exists(file) {
      try {
        await fs.access(file);
        return true;
      } catch {
        return false;
      }
    },
    async mode(file) {
      // Not gated on `dryRun`: a stat is not a change.
      try {
        return (await fs.stat(file)).mode & 0o7777;
      } catch {
        return null;
      }
    },
    async run(cmd) {
      if (dryRun) {
        log(`  would run: ${formatCommand(cmd)}`);
        return { code: 0, stdout: "", stderr: "" };
      }
      return run(cmd);
    },
    async which(binary) {
      const probe: ServiceCommand =
        process.platform === "win32"
          ? { command: "where", args: [binary] }
          : { command: "sh", args: ["-c", `command -v ${binary}`] };
      const result = await run(probe);
      return result.code === 0;
    },
    log,
  };
}

export interface SystemdSupport {
  systemctl: boolean;
  /** A per-user manager to talk to (`systemctl --user` needs one). */
  userManager: boolean;
}

export async function detectSystemd(
  host: ServiceHost,
  env: NodeJS.ProcessEnv = process.env,
): Promise<SystemdSupport> {
  const systemctl = await host.which("systemctl");
  return { systemctl, userManager: systemctl && Boolean(env.XDG_RUNTIME_DIR) };
}

// os.userInfo() throws when the uid has no passwd entry (containers, some CI images).
function loginName(env: NodeJS.ProcessEnv): string | undefined {
  try {
    return os.userInfo().username || undefined;
  } catch {
    return env.USER || env.LOGNAME || undefined;
  }
}

export function specFor(options: {
  webroot: string;
  varDir: string;
  cliPath: string;
  tier: ServiceTier;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
}): ServiceSpec {
  const env = options.env ?? process.env;
  return {
    platform: options.platform ?? process.platform,
    tier: options.tier,
    webroot: path.resolve(options.webroot),
    varDir: path.resolve(options.varDir),
    nodePath: process.execPath,
    cliPath: options.cliPath,
    home: os.homedir(),
    user: loginName(env),
    configHome: env.XDG_CONFIG_HOME,
    localAppData: env.LOCALAPPDATA,
    uid: process.getuid?.(),
  };
}

// ---------------------------------------------------------------------------
// install / uninstall / status
// ---------------------------------------------------------------------------

/** Prints the unit and the commands, so nothing privileged is a surprise. */
export function describeUnit(unit: ServiceUnit, host: ServiceHost): void {
  host.log();
  host.log(`Service file: ${unit.file}`);
  host.log("-".repeat(60));
  host.log(unit.contents.trimEnd());
  host.log("-".repeat(60));
  host.log();
  host.log("Commands to activate it:");
  for (const cmd of unit.activate) host.log(`  ${formatCommand(cmd)}`);
  host.log();
}

export interface InstallOptions {
  /** Asked before anything privileged runs; false prints the commands instead. */
  confirmPrivileged?: () => Promise<boolean>;
  /** Pacing for the post-start watch; tests hand in a sleep that does not. */
  verify?: VerifyOptions;
}

/** Writes the unit and activates it; false when the privileged half was skipped. */
export async function installService(
  unit: ServiceUnit,
  host: ServiceHost,
  options: InstallOptions = {},
): Promise<boolean> {
  // Refuse a unit that could never start, before describing it.
  const problem = await systemTierProblem(unit.spec, host, {
    installed: await host.exists(unit.file),
  });
  if (problem) throw new CliError(problem);

  describeUnit(unit, host);

  if (unit.privileged) {
    host.log("This tier runs the server as an ephemeral system user (DynamicUser=yes),");
    host.log(`with ${unit.spec.varDir} owned by the '${SERVICE_GROUP}' group.`);
    host.log(
      `The group is created if it is missing, and files under ${unit.spec.varDir} become`,
    );
    host.log(
      "group-owned and group-writable — that, rather than a per-boot UID, is what",
    );
    host.log("keeps the data readable across restarts. The rest of the webroot stays");
    host.log("yours, and read-only to the service; timeful.config.json has to stay");
    host.log("readable by others (mode 0644, which is what it is written as).");
    host.log();
    const hasSudo = await host.which("sudo");
    const consent = hasSudo && (await (options.confirmPrivileged?.() ?? Promise.resolve(true)));
    if (!consent) {
      await host.writeFile(unit.staging ?? unit.file, unit.contents);
      host.log(
        hasSudo
          ? "Skipped. The unit is staged; run the commands above to finish."
          : "sudo is not available. The unit is staged; run the commands above as root.",
      );
      printUndo(unit, host);
      return false;
    }
  }

  const target = unit.staging ?? unit.file;
  await host.writeFile(target, unit.contents);
  host.log(
    host.dryRun ? `  would write ${target} (contents above)` : `Wrote ${target}`,
  );

  for (const cmd of unit.activate) {
    const result = await host.run(cmd);
    if (result.code === 0 || cmd.tolerant) continue;
    throw new CliError(
      `Command failed (exit ${result.code}): ${formatCommand(cmd)}\n${result.stderr.trim()}`,
    );
  }

  // restart exiting 0 only proves the fork; system tier only, because reset-failed +
  // restart made the state and counters this install's own.
  if (unit.spec.platform === "linux" && unit.spec.tier === "system" && !host.dryRun) {
    const report = await watchAfterStart(refFor(unit), host, options.verify);
    if (report.state === "failed" || (report.restarts ?? 0) > 0) {
      throw new CliError(
        [
          `${unit.id} was installed, but the service is not staying up: ${describeRunState(report)}.`,
          "The unit file is in place and systemd keeps retrying it. To see why it dies:",
          "",
          `  journalctl -u ${unit.id} -e`,
          "",
          "If the journal shows EROFS (read-only file system) under the data",
          "directory, the unit's ReadWritePaths= line is missing or overridden —",
          `check for stale drop-ins in /etc/systemd/system/${unit.id}.d/`,
          "and rerun 'npx timeful@latest upgrade' to regenerate the unit.",
        ].join("\n"),
      );
    }
    host.log(
      report.state === "running"
        ? `Verified: ${unit.id} came up and stayed up.`
        : `Could not confirm ${unit.id} is running (state: ${report.state}). Check 'timeful service status'.`,
    );
  }

  host.log(
    host.dryRun
      ? `Dry run: ${unit.id} was not installed.`
      : `Installed and started ${unit.id}.`,
  );
  printUndo(unit, host);
  return true;
}

function printUndo(unit: ServiceUnit, host: ServiceHost): void {
  host.log();
  host.log("To undo:");
  host.log(`  timeful service uninstall${unit.spec.tier === "system" ? " --system" : ""}`);
  host.log("which runs:");
  for (const cmd of unit.deactivate) host.log(`  ${formatCommand(cmd)}`);
  if (!unit.privileged) host.log(`  rm ${unit.file}`);
  if (unit.spec.tier === "system") {
    // Another webroot's unit may still be using both.
    host.log();
    host.log(
      `The '${SERVICE_GROUP}' group and the contents of ${unit.spec.varDir} are left alone.`,
    );
  }
  host.log();
}

export async function uninstallService(unit: ServiceUnit, host: ServiceHost): Promise<void> {
  for (const cmd of unit.deactivate) {
    const result = await host.run(cmd);
    // Deactivating something that was never active is not a failure.
    if (result.code !== 0) host.log(`  (ignored) ${formatCommand(cmd)} exited ${result.code}`);
  }
  // A privileged unit is removed by its own `sudo rm` above.
  if (!unit.privileged) {
    if (host.dryRun) host.log(`  would remove ${unit.file}`);
    await host.removeFile(unit.file);
  }
  if (unit.staging) await host.removeFile(unit.staging);
  host.log(
    host.dryRun ? `  Dry run: ${unit.id} was left alone.` : `Removed ${unit.id} (${unit.file}).`,
  );
}

export interface ServiceStatus {
  tier: ServiceTier;
  id: string;
  file: string;
  installed: boolean;
  /** Running or not, when the unit exists and the platform will say. */
  state?: RunState;
  /** Automatic restarts behind that state, when the platform counted them. */
  restarts?: number;
  /** Output of the platform's status command, when the unit exists. */
  report?: string;
}

// ---------------------------------------------------------------------------
// start / stop / restart / is it running
// ---------------------------------------------------------------------------

export type ControlVerb = "start" | "stop" | "restart";

const PAST: Record<ControlVerb, string> = {
  start: "Started",
  stop: "Stopped",
  restart: "Restarted",
};

/** Deliberately less than a ServiceSpec: a scanned unit has file, id and tier even when its webroot is unreadable. */
export interface ServiceRef {
  platform: NodeJS.Platform;
  tier: ServiceTier;
  /** Label, unit file name, or task name — whatever the platform addresses. */
  id: string;
  /** The installed file; launchd needs it to load an agent back in. */
  file: string;
  /** The invoking user's uid; launchd domains are per-uid. */
  uid?: number;
}

export function refFor(unit: ServiceUnit): ServiceRef {
  return {
    platform: unit.spec.platform,
    tier: unit.spec.tier,
    id: unit.id,
    file: unit.file,
    uid: unit.spec.uid,
  };
}

const needsSudo = (ref: ServiceRef): boolean => ref.tier === "system" && ref.uid !== 0;

function systemctl(ref: ServiceRef, ...args: string[]): ServiceCommand {
  if (ref.tier === "system")
    return needsSudo(ref)
      ? { command: "sudo", args: ["systemctl", ...args] }
      : { command: "systemctl", args };
  return { command: "systemctl", args: ["--user", ...args] };
}

/** launchd has no restart: stop unloads, start loads, restart is both with the unload tolerant. */
export function controlFor(ref: ServiceRef, verb: ControlVerb): ServiceCommand[] {
  if (ref.platform === "darwin") {
    const domain = `gui/${ref.uid ?? 0}`;
    const start: ServiceCommand = {
      command: "launchctl",
      args: ["bootstrap", domain, ref.file],
    };
    const stop: ServiceCommand = {
      command: "launchctl",
      args: ["bootout", `${domain}/${ref.id}`],
    };
    if (verb === "start") return [start];
    if (verb === "stop") return [stop];
    return [{ ...stop, tolerant: true }, start];
  }

  if (ref.platform === "win32") {
    const start: ServiceCommand = { command: "schtasks", args: ["/run", "/tn", ref.id] };
    const stop: ServiceCommand = { command: "schtasks", args: ["/end", "/tn", ref.id] };
    if (verb === "start") return [start];
    if (verb === "stop") return [stop];
    return [{ ...stop, tolerant: true }, start];
  }

  if (ref.platform === "linux") return [systemctl(ref, verb, ref.id)];

  throw new CliError(
    `Controlling a service is not supported on ${ref.platform}. Use your own process manager.`,
  );
}

// `show`, not `is-active`: is-active calls a crash loop "activating"; keyed output
// avoids depending on systemctl's property order.
export function probeFor(ref: ServiceRef): ServiceCommand {
  if (ref.platform === "darwin") return { command: "launchctl", args: ["list", ref.id] };
  if (ref.platform === "win32")
    return { command: "schtasks", args: ["/query", "/tn", ref.id, "/fo", "list"] };
  if (ref.platform === "linux") {
    const args = ["show", "-p", "ActiveState", "-p", "SubState", "-p", "NRestarts", ref.id];
    return ref.tier === "system"
      ? { command: "systemctl", args }
      : { command: "systemctl", args: ["--user", ...args] };
  }
  throw new CliError(`Cannot check a service on ${ref.platform}.`);
}

export type RunState = "running" | "starting" | "stopped" | "failed" | "unknown";

/** What a probe found: the word, and the evidence worth printing beside it. */
export interface RunReport {
  state: RunState;
  /** Automatic restarts systemd has counted, when it was asked and answered. */
  restarts?: number;
}

function property(stdout: string, key: string): string | undefined {
  return new RegExp(`^${key}=(.*)$`, "m").exec(stdout)?.[1].trim();
}

// `activating` + `auto-restart` is a crash loop counting down RestartSec, not running.
export function readRunReport(platform: NodeJS.Platform, result: RunResult): RunReport {
  if (platform === "darwin") {
    // A loaded agent is a running one: the plist carries RunAtLoad + KeepAlive.
    return { state: result.code === 0 ? "running" : "stopped" };
  }

  if (platform === "linux") {
    const active = property(result.stdout, "ActiveState") ?? result.stdout.trim().split(/\s+/)[0] ?? "";
    const sub = property(result.stdout, "SubState") ?? "";
    const counted = Number(property(result.stdout, "NRestarts"));
    const restarts = Number.isInteger(counted) && counted >= 0 ? counted : undefined;

    const state: RunState =
      active === "active"
        ? "running"
        : active === "activating" || active === "reloading"
          ? sub === "auto-restart"
            ? "failed"
            : "starting"
          : active === "failed"
            ? "failed"
            : active === "inactive" || active === "deactivating"
              ? "stopped"
              : "unknown";
    return restarts === undefined ? { state } : { state, restarts };
  }

  if (platform === "win32") {
    const status = /^\s*Status:\s*(\S+)/im.exec(result.stdout)?.[1]?.toLowerCase();
    if (status === "running") return { state: "running" };
    if (status === "ready" || status === "disabled") return { state: "stopped" };
    return { state: result.code === 0 ? "unknown" : "stopped" };
  }

  return { state: "unknown" };
}

export function readRunState(platform: NodeJS.Platform, result: RunResult): RunState {
  return readRunReport(platform, result).state;
}

export async function probeRun(ref: ServiceRef, host: ServiceHost): Promise<RunReport> {
  // A dry run must not claim to know something it never asked about.
  if (host.dryRun) return { state: "unknown" };
  return readRunReport(ref.platform, await host.run(probeFor(ref)));
}

export async function probeRunState(ref: ServiceRef, host: ServiceHost): Promise<RunState> {
  return (await probeRun(ref, host)).state;
}

export function describeRunState(report: RunReport): string {
  if (!report.restarts) return report.state;
  const times = report.restarts === 1 ? "1 automatic restart" : `${report.restarts} automatic restarts`;
  return `${report.state} (${times})`;
}

/** How the post-start watch paces itself; injectable so tests never sleep. */
export interface VerifyOptions {
  /** How many probes to make, spaced `delayMs` apart. */
  attempts?: number;
  delayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

// The ~3s window is deliberately shorter than RestartSec=5, so a died unit is caught
// in auto-restart; a failed probe or any counted restart is the verdict.
export async function watchAfterStart(
  ref: ServiceRef,
  host: ServiceHost,
  options: VerifyOptions = {},
): Promise<RunReport> {
  const attempts = options.attempts ?? 4;
  const delayMs = options.delayMs ?? 1000;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let report: RunReport = { state: "unknown" };
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt > 0) await sleep(delayMs);
    report = await probeRun(ref, host);
    if (report.state === "failed" || (report.restarts ?? 0) > 0) return report;
  }
  return report;
}

export async function controlService(
  ref: ServiceRef,
  verb: ControlVerb,
  host: ServiceHost,
): Promise<void> {
  const commands = controlFor(ref, verb);
  // The dry-run host narrates each command itself.
  if (!host.dryRun) for (const cmd of commands) host.log(`  ${formatCommand(cmd)}`);
  for (const cmd of commands) {
    const result = await host.run(cmd);
    if (result.code === 0 || cmd.tolerant) continue;
    throw new CliError(
      `Command failed (exit ${result.code}): ${formatCommand(cmd)}\n${result.stderr.trim()}`,
    );
  }
  host.log(
    host.dryRun ? `  Dry run: ${ref.id} was left alone.` : `  ${PAST[verb]} ${ref.id}.`,
  );
}

/** Reports every tier this platform can install, so either one is found. */
export async function serviceStatus(
  specs: ServiceSpec[],
  host: ServiceHost,
): Promise<ServiceStatus[]> {
  const out: ServiceStatus[] = [];
  for (const spec of specs) {
    const unit = unitFor(spec);
    const installed = await host.exists(unit.file);
    const status: ServiceStatus = {
      tier: spec.tier,
      id: unit.id,
      file: unit.file,
      installed,
    };
    if (installed) {
      const run = await probeRun(refFor(unit), host);
      status.state = run.state;
      if (run.restarts) status.restarts = run.restarts;
      const result = await host.run(unit.status[0]);
      status.report = (result.stdout + result.stderr).trim();
    }
    out.push(status);
  }
  return out;
}
