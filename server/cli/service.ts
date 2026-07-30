/**
 * Starting Timeful automatically, per platform.
 *
 * Two tiers:
 *  - **user** (every platform, the default): a launchd LaunchAgent, a systemd
 *    *user* unit, or a `schtasks` logon task. No sudo, runs as the invoking
 *    user, starts when that user logs in.
 *  - **system** (Linux + systemd only): a unit in /etc/systemd/system with
 *    `DynamicUser=yes` and the usual sandboxing, so the service runs as an
 *    ephemeral user that owns nothing but the webroot. Needs sudo, starts at
 *    boot.
 *
 * Everything here is generated from a `ServiceSpec` by pure functions —
 * `unitFor` returns the file to write and the exact commands that would
 * activate, deactivate and query it. Only `installService`/`uninstallService`
 * touch the machine, and every command they run goes through `ServiceHost.run`,
 * which is stubbed in tests and short-circuited by TIMEFUL_SERVICE_DRY_RUN.
 */
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { CliError } from "./errors.ts";

export type ServiceTier = "user" | "system";

export interface ServiceSpec {
  platform: NodeJS.Platform;
  tier: ServiceTier;
  /** The webroot: working directory of the service, home of the config. */
  webroot: string;
  /** Resolved data directory; the service's logs go beside it. */
  varDir: string;
  /** The node binary to exec. */
  nodePath: string;
  /** Absolute path of the CLI entry to exec. */
  cliPath: string;
  /** The invoking user's home directory. */
  home: string;
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

/**
 * The argument the unit passes to the CLI. Explicit, so a service can never
 * fall into the wizard: `timeful serve` refuses a directory that is not a
 * webroot instead of asking a question nobody is there to answer.
 *
 * Units written before this existed exec the CLI with no argument at all. They
 * keep working — bare `timeful` in a webroot serves it — and uninstall and
 * status find them by path, not by content.
 */
const SERVE_ARG = "serve";

export interface ServiceUnit {
  spec: ServiceSpec;
  /** Identifier shared by the file name and every command below. */
  id: string;
  /** Where the generated file lives once installed. */
  file: string;
  /**
   * Where to write it before installing, when the destination needs sudo.
   * Undefined means write straight to `file`.
   */
  staging?: string;
  contents: string;
  /** True when activation needs elevated privileges. */
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
  if (spec.platform === "darwin") return `app.timeful.${hash}`;
  if (spec.platform === "win32") return `Timeful-${hash}`;
  return `timeful-${hash}`;
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

const XML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&apos;",
};

function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => XML_ESCAPES[c] ?? c);
}

/** The generated artifact and commands for `spec`. */
export function unitFor(spec: ServiceSpec): ServiceUnit {
  if (spec.platform === "darwin") return launchdUnit(spec);
  if (spec.platform === "win32") return schtasksUnit(spec);
  if (spec.platform === "linux")
    return spec.tier === "system" ? systemdSystemUnit(spec) : systemdUserUnit(spec);
  throw new CliError(
    `Installing a service is not supported on ${spec.platform}. Run 'timeful' from a process manager of your choice instead.`,
  );
}

/** The tiers `platform` can offer. */
export function availableTiers(platform: NodeJS.Platform): ServiceTier[] {
  return platform === "linux" ? ["user", "system"] : ["user"];
}

function logFile(spec: ServiceSpec, stream: "out" | "err"): string {
  return path.join(spec.varDir, `timeful.${stream}.log`);
}

function launchdUnit(spec: ServiceSpec): ServiceUnit {
  const id = serviceId(spec);
  const file = path.join(spec.home, "Library", "LaunchAgents", `${id}.plist`);
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

function systemdUserDir(spec: ServiceSpec): string {
  const configHome = spec.configHome || path.join(spec.home, ".config");
  return path.join(configHome, "systemd", "user");
}

function systemdUserUnit(spec: ServiceSpec): ServiceUnit {
  const id = `${serviceId(spec)}.service`;
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

/**
 * The hardened tier. `DynamicUser=yes` means systemd allocates a throwaway
 * UID for each start, so the service owns no account and no files outside the
 * paths it is granted: `ProtectSystem=strict` makes the entire filesystem
 * read-only except `ReadWritePaths`, which is exactly the webroot. Files the
 * service writes there therefore belong to that ephemeral user, not to the
 * operator — that is the trade for the isolation.
 */
function systemdSystemUnit(spec: ServiceSpec): ServiceUnit {
  const id = `${serviceId(spec)}.service`;
  const file = path.posix.join("/etc/systemd/system", id);
  const staging = path.join(os.tmpdir(), id);
  const contents = `[Unit]
Description=Timeful (${spec.webroot})
After=network.target

[Service]
Type=simple
DynamicUser=yes
WorkingDirectory=${spec.webroot}
ExecStart=${spec.nodePath} ${spec.cliPath} ${SERVE_ARG}
ReadWritePaths=${spec.webroot}
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

  const sudo = (...args: string[]): ServiceCommand => ({ command: "sudo", args });

  return {
    spec,
    id,
    file,
    staging,
    contents,
    privileged: true,
    activate: [
      sudo("install", "-m", "0644", staging, file),
      sudo("systemctl", "daemon-reload"),
      sudo("systemctl", "enable", "--now", id),
    ],
    deactivate: [
      sudo("systemctl", "disable", "--now", id),
      sudo("rm", "-f", file),
      sudo("systemctl", "daemon-reload"),
    ],
    status: [{ command: "systemctl", args: ["status", id] }],
  };
}

function schtasksUnit(spec: ServiceSpec): ServiceUnit {
  const id = serviceId(spec);
  const base = spec.localAppData || path.join(spec.home, "AppData", "Local");
  const file = path.join(base, "Timeful", `${id}.cmd`);
  // schtasks has no working-directory option, so the task runs a launcher that
  // changes into the webroot first.
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
  /**
   * The file's contents, or null when it cannot be read.
   *
   * Reading changes nothing, so unlike the writes this one is honoured in a
   * dry run too — `timeful upgrade --dry-run` has to be able to say which CLI
   * the installed unit currently execs.
   */
  readFile(file: string): Promise<string | null>;
  removeFile(file: string): Promise<void>;
  exists(file: string): Promise<boolean>;
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
  /** Where the running commentary goes. */
  log?: (line?: string) => void;
  /** `--dry-run`. The environment variable is an alias for the same thing. */
  dryRun?: boolean;
}

/**
 * The real host. In a dry run every command is printed instead of executed and
 * no file is touched — the gate that lets the install path be exercised without
 * ever loading a service into a developer's machine.
 *
 * `TIMEFUL_SERVICE_DRY_RUN` predates the `--dry-run` flag and still works;
 * either one turns the whole host into a narrator.
 */
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

/** What a Linux box can actually offer. */
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

/** A spec for the current process, in `webroot`. */
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
  /**
   * Asked before anything privileged runs. Returning false leaves the machine
   * untouched and the commands are printed for manual execution instead.
   */
  confirmPrivileged?: () => Promise<boolean>;
}

/**
 * Writes the unit and activates it. Returns false when the privileged half
 * was skipped (declined, or no sudo) — the file is still written to staging
 * and the commands are printed.
 */
export async function installService(
  unit: ServiceUnit,
  host: ServiceHost,
  options: InstallOptions = {},
): Promise<boolean> {
  describeUnit(unit, host);

  if (unit.privileged) {
    host.log("This tier runs the server as an ephemeral system user (DynamicUser=yes).");
    host.log(`Files under ${unit.spec.webroot} will be written by that user, not by you.`);
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
    if (result.code !== 0)
      throw new CliError(
        `Command failed (exit ${result.code}): ${formatCommand(cmd)}\n${result.stderr.trim()}`,
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
  host.log();
}

export async function uninstallService(unit: ServiceUnit, host: ServiceHost): Promise<void> {
  for (const cmd of unit.deactivate) {
    const result = await host.run(cmd);
    // Deactivating something that was never active is not a failure.
    if (result.code !== 0) host.log(`  (ignored) ${formatCommand(cmd)} exited ${result.code}`);
  }
  // A privileged unit is removed by its own `sudo rm` command above; only the
  // unprivileged file (and any staging copy) is ours to delete.
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

/**
 * The little that controlling an installed service needs to know about it.
 *
 * Deliberately less than a `ServiceSpec`: a unit found by scanning the
 * platform's unit directories has a file, an id and a tier, but its data
 * directory and node binary are only recoverable if its webroot could be read
 * back. Starting and stopping must work either way.
 */
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

/** True when the system tier's commands still need `sudo` in front of them. */
const needsSudo = (ref: ServiceRef): boolean => ref.tier === "system" && ref.uid !== 0;

function systemctl(ref: ServiceRef, ...args: string[]): ServiceCommand {
  if (ref.tier === "system")
    return needsSudo(ref)
      ? { command: "sudo", args: ["systemctl", ...args] }
      : { command: "systemctl", args };
  return { command: "systemctl", args: ["--user", ...args] };
}

/**
 * The commands that carry out `verb`, in order.
 *
 * launchd has no restart: an agent with `KeepAlive` comes back by itself, so
 * "stop" has to mean *unload* and "start" *load*, and a restart is the two in
 * sequence — the unload tolerating an agent that was not loaded to begin with.
 */
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

/** The cheapest question the platform answers about a running service. */
export function probeFor(ref: ServiceRef): ServiceCommand {
  if (ref.platform === "darwin") return { command: "launchctl", args: ["list", ref.id] };
  if (ref.platform === "win32")
    return { command: "schtasks", args: ["/query", "/tn", ref.id, "/fo", "list"] };
  if (ref.platform === "linux")
    return ref.tier === "system"
      ? { command: "systemctl", args: ["is-active", ref.id] }
      : { command: "systemctl", args: ["--user", "is-active", ref.id] };
  throw new CliError(`Cannot check a service on ${ref.platform}.`);
}

export type RunState = "running" | "stopped" | "failed" | "unknown";

/** Turns a probe's output into one of four words. */
export function readRunState(platform: NodeJS.Platform, result: RunResult): RunState {
  if (platform === "darwin") {
    // A loaded agent is a running one: the plist carries RunAtLoad + KeepAlive.
    return result.code === 0 ? "running" : "stopped";
  }
  if (platform === "linux") {
    const word = result.stdout.trim().split(/\s+/)[0] ?? "";
    if (word === "active" || word === "activating" || word === "reloading") return "running";
    if (word === "failed") return "failed";
    if (word === "inactive" || word === "deactivating") return "stopped";
    return "unknown";
  }
  if (platform === "win32") {
    const status = /^\s*Status:\s*(\S+)/im.exec(result.stdout)?.[1]?.toLowerCase();
    if (status === "running") return "running";
    if (status === "ready" || status === "disabled") return "stopped";
    return result.code === 0 ? "unknown" : "stopped";
  }
  return "unknown";
}

export async function probeRunState(ref: ServiceRef, host: ServiceHost): Promise<RunState> {
  // A dry run must not claim to know something it never asked about.
  if (host.dryRun) return "unknown";
  return readRunState(ref.platform, await host.run(probeFor(ref)));
}

/**
 * Runs a verb against an installed service. Every command is printed before it
 * runs, the same rule the install path follows.
 */
export async function controlService(
  ref: ServiceRef,
  verb: ControlVerb,
  host: ServiceHost,
): Promise<void> {
  const commands = controlFor(ref, verb);
  // A dry run narrates each command as it declines to run it; a real one says
  // what it is about to do before it does it.
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
      status.state = await probeRunState(refFor(unit), host);
      const result = await host.run(unit.status[0]);
      status.report = (result.stdout + result.stderr).trim();
    }
    out.push(status);
  }
  return out;
}
