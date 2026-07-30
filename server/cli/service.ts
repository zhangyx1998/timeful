/**
 * Starting Timeful automatically, per platform.
 *
 * Two tiers:
 *  - **user** (every platform, the default): a launchd LaunchAgent, a systemd
 *    *user* unit, or a `schtasks` logon task. No sudo, runs as the invoking
 *    user, starts when that user logs in.
 *  - **system** (Linux + systemd only): a unit in /etc/systemd/system with
 *    `DynamicUser=yes` and the usual sandboxing, so the service runs as an
 *    ephemeral user that owns no account and reaches nothing it was not given.
 *    Needs sudo, starts at boot. See `systemdSystemUnit` for how a webroot
 *    inside a home directory is reached, and `systemTierProblem` for the one
 *    case that cannot be.
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
  /**
   * The invoking user's login name. Only used to print a command they can run
   * (`loginctl enable-linger <user>`), never to decide anything.
   */
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
 * The static group the hardened tier's data directory belongs to.
 *
 * A *group*, deliberately, and not a user: the service runs under
 * `DynamicUser=yes`, whose UID systemd allocates per start (by hashing the unit
 * name, so stable in practice but never promised). A file owned by last boot's
 * UID would be unreadable to this boot's. Group ownership is the part that
 * survives, so `var/` is chowned to this group, the group is handed to the
 * service with `SupplementaryGroups=`, and `UMask=0002` keeps everything the
 * service creates group-writable.
 *
 * One group per machine. Several webroots share it happily — each one's data
 * directory is still only reachable through that unit's own bind mount.
 */
export const SERVICE_GROUP = "timeful";

/**
 * The directories `ProtectHome=` covers, and therefore the ones a path has to
 * be reached through a bind mount to be usable at all.
 */
const PROTECTED_HOMES = ["/home", "/root", "/run/user"];

/** True when `child` is `parent` or sits underneath it. Posix paths only. */
function isUnder(child: string, parent: string): boolean {
  const rel = path.posix.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.posix.isAbsolute(rel));
}

/**
 * The home-ish roots for one spec: what `ProtectHome=` hides, plus the invoking
 * user's own home when it lives somewhere else entirely. The second is not a
 * systemd concern but a permissions one — a home directory anywhere is
 * typically 0700 or 0750, which no other account may traverse.
 */
function homeRoots(spec: ServiceSpec): string[] {
  const roots = [...PROTECTED_HOMES];
  const home = spec.home?.trim();
  if (home && home !== "/" && !roots.some((root) => isUnder(home, root))) roots.push(home);
  return roots;
}

/** True when `target` sits inside a home directory this unit would have to mount past. */
function underHome(spec: ServiceSpec, target: string): boolean {
  return Boolean(target) && homeRoots(spec).some((root) => isUnder(target, root));
}

/**
 * The hardened tier.
 *
 * `DynamicUser=yes` means systemd allocates a throwaway UID for each start, so
 * the service owns no account and no files outside the paths it is granted.
 * `ProtectSystem=strict` makes the entire filesystem read-only, and the two
 * bind mounts below are the only holes in it.
 *
 * ::: The home directory, and why `tmpfs` rather than `yes`
 * This unit used to say `ProtectHome=yes`, which covers /home, /root and
 * /run/user with an *inaccessible* mount. Nothing can be bound back through
 * one, so a webroot under /home could never be entered: systemd answered every
 * start with `status=200/CHDIR` and the unit crash-looped. The tier could not
 * have worked for any webroot in a home directory, which is where most of them
 * are.
 *
 * `ProtectHome=tmpfs` is the combination systemd documents for exactly this:
 * the three directories become empty tmpfs instances, and a path listed in
 * `BindPaths=` / `BindReadOnlyPaths=` is made visible through one, with systemd
 * creating the intermediate directories inside the tmpfs as root:755. So the
 * operator's real 0700 home is *shadowed* rather than traversed, and the
 * ephemeral UID walks a synthetic parent it is allowed to walk. No chmod on
 * anybody's home directory, and every other home stays as hidden as before.
 *
 * What the tmpfs does **not** bypass is the webroot's own permissions: the
 * bound directory keeps its real inode, so the webroot needs `o+x` and
 * `timeful.config.json` needs `o+r` (the 0755/0644 both are born with).
 * :::
 *
 * ::: The two mounts, and why not `ReadWritePaths=`
 * `BindReadOnlyPaths=<webroot>` and `BindPaths=<varDir>`, in that shape,
 * because a bind is the only directive that can make a path *appear* through
 * the tmpfs — `ReadWritePaths=` only changes whether an already-visible path is
 * writable, and naming a path the tmpfs has hidden is a start failure rather
 * than a mount. `BindPaths=` is read-write by default, which is what the data
 * directory wants, and systemd applies mount entries deepest-path-last, so the
 * writable data directory nested inside the read-only webroot survives both the
 * webroot's bind and `ProtectSystem=strict`. Order in the file is irrelevant.
 *
 * Read-write is therefore `varDir` alone, not the whole webroot as before:
 * tighter, and sufficient — `timeful.config.json` is only ever read, and the
 * unit logs to the journal rather than to the `timeful.*.log` files the
 * LaunchAgent writes, so nothing else in the webroot is written at runtime.
 * :::
 */
function systemdSystemUnit(spec: ServiceSpec): ServiceUnit {
  const id = `${serviceId(spec)}.service`;
  const file = path.posix.join("/etc/systemd/system", id);
  const staging = path.join(os.tmpdir(), id);

  // The package directory — cli.js beside the client/ and server/ asset trees.
  // Only load-bearing when the CLI lives under a home directory (an npx cache
  // does): everything else is left visible by ProtectSystem=strict, which makes
  // the filesystem read-only rather than invisible. Emitted only when it is
  // needed, so the unit says why every mount in it is there. An npx path moves
  // with each version, and `timeful upgrade` rewrites the unit each time, so a
  // bind can never outlive the package it points at.
  const cliDir = path.posix.dirname(spec.cliPath);
  const cliMount = underHome(spec, spec.cliPath)
    ? `BindReadOnlyPaths=${cliDir}\n`
    : "";

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
ProtectHome=tmpfs
BindReadOnlyPaths=${spec.webroot}
${cliMount}BindPaths=${spec.varDir}
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
      // BindPaths= fails to mount a source that is not there, and a webroot
      // initialized with --dry-run may not have one yet.
      sudo("mkdir", "-p", spec.varDir),
      // Group ownership is what outlives a dynamic UID; setgid on the
      // directories keeps it true for everything written from here on, and
      // UMask=0002 in the unit makes those files group-writable.
      sudo("chown", "-R", `:${SERVICE_GROUP}`, spec.varDir),
      sudo("chmod", "-R", "g+rwX", spec.varDir),
      sudo("find", spec.varDir, "-type", "d", "-exec", "chmod", "g+s", "{}", "+"),
      sudo("install", "-m", "0644", staging, file),
      sudo("systemctl", "daemon-reload"),
      // Installing over a unit that crash-looped itself into `failed` — the
      // shape this tier shipped with — would otherwise leave the failure
      // latched. Tolerant: a unit that never failed makes this a no-op, and
      // systemd versions differ on what they exit with for one it never saw.
      { ...sudo("systemctl", "reset-failed", id), tolerant: true },
      // `enable --now` does not bounce a unit that is already running, so it
      // would leave an old unit's process alive under the old settings. Enable
      // and restart say both halves out loud, and restart starts a stopped one.
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

/**
 * Why this spec cannot be a system unit, or null when it can.
 *
 * Almost everything a home directory used to break is now reachable through
 * the tmpfs and the binds above. The one thing left is the **node binary**:
 * making an arbitrary Node installation visible means knowing where that
 * installation ends, and nvm, fnm, asdf and volta each answer differently. The
 * bundled CLI is one self-contained directory and can be bound; a version
 * manager's tree cannot be delimited without guessing, and a wrong guess is
 * another crash loop rather than an error message.
 *
 * So this refuses, with the cure attached, rather than generating a unit that
 * would fail at the first start.
 */
export function systemTierProblem(
  spec: ServiceSpec,
  options: { installed?: boolean } = {},
): string | null {
  if (spec.platform !== "linux" || spec.tier !== "system") return null;
  if (!underHome(spec, spec.nodePath)) return null;

  const who = spec.user || (spec.home ? path.posix.basename(spec.home) : "") || "<user>";
  // Two commands, one comment column: the second line is the longer one only
  // for a very short login name, so pad whichever needs it.
  const install = "  timeful service install";
  const linger = `  sudo loginctl enable-linger ${who}`;
  const column = Math.max(install.length, linger.length) + 2;
  const lines = [
    "The hardened system tier cannot use this Node installation.",
    "",
    `  node   ${spec.nodePath}`,
    "",
    "A system service runs as an ephemeral user with ProtectHome=tmpfs, which",
    "replaces /home, /root and /run/user with empty directories. Timeful's own",
    "webroot and package are mounted back through that, but a Node installation",
    "in a home directory cannot be: where a version manager's tree begins and",
    "ends is its own business, and mounting the wrong part of it would replace",
    "this message with a crash loop.",
    "",
    "Run it as yourself instead. The user tier needs no sudo, and lingering is",
    "what makes it start at boot rather than at login:",
    "",
    `${install.padEnd(column)}# user tier, runs as you`,
    `${linger.padEnd(column)}# start at boot, survive logout`,
    "",
    "Or install Timeful under a system-wide Node — one outside a home",
    "directory — and run 'timeful service install --system' from that.",
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

/**
 * The invoking user's login name, for printing a command they can paste.
 * `os.userInfo()` throws when the uid has no passwd entry — a container, some
 * CI images — so the environment is the fallback and nothing depends on it.
 */
function loginName(env: NodeJS.ProcessEnv): string | undefined {
  try {
    return os.userInfo().username || undefined;
  } catch {
    return env.USER || env.LOGNAME || undefined;
  }
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
  // Before anything is printed: a unit that could never start is not something
  // to describe and then fail at, it is something to refuse with the cure.
  const problem = systemTierProblem(unit.spec, { installed: await host.exists(unit.file) });
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
    // Another webroot's unit may be using both, and neither is expensive to
    // leave behind: an empty group owns nothing, and the data is the point.
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

/**
 * The cheapest question the platform answers about a running service.
 *
 * Linux asks `show` rather than `is-active`, because `is-active` answers a
 * crash loop with the single word `activating` — indistinguishable from a
 * service that is genuinely coming up, and the reason this CLI once printed
 * "running" over a unit that had never started once. `SubState` is what tells
 * the two apart, and `NRestarts` is what says how long it has been going on.
 *
 * Keyed output rather than `--value`: reading values positionally would depend
 * on systemctl emitting properties in the order they were asked for, and
 * `Key=value` lines need no such promise.
 */
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

/** One `Key=value` line out of `systemctl show`. */
function property(stdout: string, key: string): string | undefined {
  return new RegExp(`^${key}=(.*)$`, "m").exec(stdout)?.[1].trim();
}

/**
 * Turns a probe's output into a state, and whatever else it happened to say.
 *
 * The systemd half is the interesting one. `activating` is **not** running: a
 * unit that fails at exec and is waiting out `RestartSec` before trying again
 * spends nearly all of its life there, and calling that "running" is how a
 * crash loop hid behind `timeful service status`. So:
 *
 * - `active`                       → running
 * - `activating` + `auto-restart`  → failed; systemd is counting down to
 *                                    another attempt, which only happens after
 *                                    one went wrong
 * - `activating` / `reloading`     → starting; a real start, caught in the act
 * - `failed`                       → failed
 * - `inactive` / `deactivating`    → stopped
 *
 * A bare word is still understood, so a probe run by hand — or by an older
 * unit of this CLI — reads the same way.
 */
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

/** Just the word, for callers that have nowhere to put the rest. */
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

/**
 * The state as a status line prints it. The restart count is the part that
 * makes a crash loop unmistakable even when the probe caught it mid-attempt.
 */
export function describeRunState(report: RunReport): string {
  if (!report.restarts) return report.state;
  const times = report.restarts === 1 ? "1 automatic restart" : `${report.restarts} automatic restarts`;
  return `${report.state} (${times})`;
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
