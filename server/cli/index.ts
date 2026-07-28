/**
 * `npx timeful` — the packaged entry point.
 *
 * Bundled by rollup into `dist/cli.js`, which sits beside the `client/` and
 * `server/` asset trees it serves. The working directory is the operator's
 * **webroot**: `timeful.config.json` and `var/` are read from and written
 * there, and nothing else ever is.
 *
 * Three actions, and bare `timeful` picks between the first two by looking at
 * the directory:
 *
 *   timeful init      make this directory a webroot (the wizard)
 *   timeful serve     serve a webroot, and never anything else
 *   timeful service   install / control the background service for a webroot
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createStaticRenderer, serve } from "../app.ts";
import { resolveAssets } from "../paths.ts";
import { parseArgs, usage, type CliArgs, type ServiceAction } from "./args.ts";
import {
  CONFIG_FILE,
  configPath,
  envOverrides,
  isWebroot,
  mergeConfig,
  readConfigFile,
  serializeConfig,
  writeConfigFile,
  type ResolvedConfig,
} from "./config.ts";
import {
  discoverServices,
  scanPathsFor,
  webrootsOf,
  type DiscoveredService,
} from "./discover.ts";
import { CliError } from "./errors.ts";
import {
  availableTiers,
  controlService,
  detectSystemd,
  installService,
  nodeHost,
  probeRunState,
  refFor,
  serviceStatus,
  specFor,
  uninstallService,
  unitFor,
  type ControlVerb,
  type ServiceHost,
  type ServiceTier,
  type ServiceUnit,
} from "./service.ts";
import { confirm, isInteractive, say, select, stdio, type Tty } from "./tui.ts";
import { VERSION } from "./version.ts";
import { runWizard } from "./wizard.ts";

/** This file, as an absolute path: what a service unit has to exec. */
const CLI_PATH = fileURLToPath(import.meta.url);

async function main(argv: readonly string[]): Promise<void> {
  const args = parseArgs(argv);

  if (args.command === "help") {
    process.stdout.write(usage(VERSION));
    return;
  }
  if (args.command === "version") {
    process.stdout.write(`${VERSION}\n`);
    return;
  }

  const cwd = process.cwd();
  if (args.command === "service") return runService(args, cwd);
  if (args.command === "init") return runInit(args, cwd);
  if (args.command === "serve") return runServe(args, cwd);
  return runAuto(args, cwd);
}

// ---------------------------------------------------------------------------
// serve / init / auto
// ---------------------------------------------------------------------------

/** Bare `timeful`: serve a webroot, or offer to make this directory one. */
async function runAuto(args: CliArgs, cwd: string): Promise<void> {
  const file = await readConfigFile(cwd);
  if (file) {
    await start(mergeConfig({ cwd, file, env: envOverrides(), flags: args.overrides }), args);
    return;
  }

  // Not a webroot: initialize it, with or without questions.
  if (args.yes) {
    const config = mergeConfig({ cwd, env: envOverrides(), flags: args.overrides });
    await initialize(cwd, config, args);
    await start(config, args);
    return;
  }

  if (!process.stdin.isTTY) throw notAWebrootForSetup(cwd);
  await wizard(args, cwd);
}

/** `timeful init`: the wizard, explicitly, and only in a fresh directory. */
async function runInit(args: CliArgs, cwd: string): Promise<void> {
  if (await isWebroot(cwd))
    throw new CliError(
      [
        `${cwd} is already a Timeful webroot.`,
        "",
        `Edit ${CONFIG_FILE} to change its settings, or delete it to run the`,
        "wizard again. To start the server here, run 'timeful serve'.",
      ].join("\n"),
    );

  if (args.yes) {
    const config = mergeConfig({ cwd, env: envOverrides(), flags: args.overrides });
    await initialize(cwd, config, args);
    // Unlike bare `timeful --yes`, the explicit action does only what it says.
    console.log("Run 'timeful serve' in this directory to start the server.");
    return;
  }

  if (!process.stdin.isTTY) throw notAWebrootForSetup(cwd);
  await wizard(args, cwd);
}

/** `timeful serve`: a webroot is required, and the wizard is never offered. */
async function runServe(args: CliArgs, cwd: string): Promise<void> {
  const file = await readConfigFile(cwd);
  if (!file)
    throw new CliError(
      [
        `${cwd} is not a Timeful webroot: it has no ${CONFIG_FILE}.`,
        "",
        "Run 'timeful init' here to set one up, or 'timeful serve' from a",
        "directory that already is one.",
      ].join("\n"),
    );
  await start(mergeConfig({ cwd, file, env: envOverrides(), flags: args.overrides }), args);
}

function notAWebrootForSetup(cwd: string): CliError {
  // Nothing to read answers from. Say so and leave the directory alone —
  // hanging on a closed stdin is the one thing a scripted run must never do.
  return new CliError(
    [
      `${cwd} is not a Timeful webroot: it has no ${CONFIG_FILE}.`,
      "",
      "Setting one up needs answers, and stdin is not a terminal.",
      "Run 'timeful' from a terminal to use the setup wizard, or",
      "'timeful --yes' to initialize with the defaults and start.",
    ].join("\n"),
  );
}

async function wizard(args: CliArgs, cwd: string): Promise<void> {
  const result = await runWizard({
    cwd,
    input: process.stdin,
    output: process.stdout,
    defaults: args.overrides,
    commit: (config) => initialize(cwd, config, args),
  });
  if (!result) return;

  if (result.installService) await installFromWizard(result.config, cwd, args);
  if (result.startNow) {
    await start(result.config, args);
    return;
  }
  console.log("Run 'timeful' in this directory to start the server.");
}

/** Makes `cwd` a webroot: config file on disk, data directory created. */
async function initialize(cwd: string, config: ResolvedConfig, args: CliArgs): Promise<void> {
  if (args.dryRun) {
    console.log(`  would write ${configPath(cwd)}`);
    console.log(divider());
    console.log(serializeConfig(config).trimEnd());
    console.log(divider());
    console.log(`  would create ${config.varDir}`);
    return;
  }
  const file = await writeConfigFile(cwd, config);
  await fs.mkdir(config.varDir, { recursive: true });
  console.log(`Wrote ${file}`);
  console.log(`Created ${config.varDir}`);
}

async function start(config: ResolvedConfig, args: CliArgs): Promise<void> {
  if (args.dryRun) {
    console.log(`  would serve http://${config.host}:${config.port}`);
    console.log(`  would read and write ${config.varDir}`);
    console.log("Dry run: no server was started.");
    return;
  }

  // The storage layer reads VAR_DIR at call time; this is the one place the
  // resolved data directory has to be published to it.
  process.env.VAR_DIR = config.varDir;

  const assets = resolveAssets(import.meta.url);
  await assertBuilt(assets.templateFile);

  await serve({
    host: config.host,
    port: config.port,
    trustProxy: config.trustedProxy,
    realtime: config.realtime,
    renderer: createStaticRenderer(assets),
  });
  console.log(`Data directory: ${config.varDir}`);
}

async function assertBuilt(templateFile: string): Promise<void> {
  try {
    await fs.access(templateFile);
  } catch {
    throw new CliError(
      `The client build is missing (${templateFile}).\n` +
        "This install looks incomplete — reinstall the package, or run 'npm run build' if you are working from a checkout.",
    );
  }
}

// ---------------------------------------------------------------------------
// service
// ---------------------------------------------------------------------------

async function runService(args: CliArgs, cwd: string): Promise<void> {
  const host = nodeHost({ dryRun: args.dryRun });
  if (host.dryRun) console.log("Dry run: nothing below is written or executed.");

  const installed = await discover();

  // No verb at all is a question, not a command: what is installed here?
  if (!args.action) return listServices(installed, host);

  const targets = await resolveTargets(args, cwd, installed);
  if (args.action === "install") return installFor(targets[0], args, host);

  for (const [index, webroot] of targets.entries()) {
    if (index > 0) console.log();
    await runVerbOn(args.action, webroot, args, host);
  }
}

async function discover(): Promise<DiscoveredService[]> {
  return discoverServices({
    platform: process.platform,
    paths: scanPathsFor({ platform: process.platform, home: os.homedir() }),
  });
}

/**
 * Which webroots the verb applies to: `-A/--all`, an explicit path, this
 * directory, or — when none of those settle it — a question.
 */
async function resolveTargets(
  args: CliArgs,
  cwd: string,
  installed: DiscoveredService[],
): Promise<string[]> {
  if (args.all) {
    const webroots = webrootsOf(installed);
    if (webroots.length === 0)
      throw new CliError("No Timeful services are installed on this machine.");
    return webroots;
  }

  if (args.target) {
    const target = path.resolve(cwd, args.target);
    if (!(await isWebroot(target)))
      throw new CliError(
        `${target} is not a Timeful webroot: it has no ${CONFIG_FILE}.`,
      );
    return [target];
  }

  if (await isWebroot(cwd)) return [cwd];

  const candidates = webrootsOf(installed);
  if (candidates.length === 0)
    throw new CliError(
      [
        `${cwd} is not a Timeful webroot, and no Timeful services are installed.`,
        "",
        `Run 'timeful init' here first, or name a webroot:`,
        `  timeful service ${args.action} <path-to-webroot>`,
      ].join("\n"),
    );
  if (candidates.length === 1) {
    console.log(`Using the only installed webroot: ${candidates[0]}`);
    return candidates;
  }

  const io = stdio();
  if (!isInteractive(io))
    throw new CliError(
      [
        `${cwd} is not a Timeful webroot, and several are installed:`,
        ...candidates.map((webroot) => `  ${webroot}`),
        "",
        "Name the one you mean, or use -A/--all:",
        `  timeful service ${args.action} <path-to-webroot>`,
      ].join("\n"),
    );
  return [
    await select(io, {
      message: `Which webroot should 'timeful service ${args.action}' act on?`,
      options: candidates.map((webroot) => ({ value: webroot, label: webroot })),
    }),
  ];
}

/** `timeful service` with no verb: everything installed, on one screen. */
async function listServices(installed: DiscoveredService[], host: ServiceHost): Promise<void> {
  if (installed.length === 0) {
    console.log("No Timeful services are installed on this machine.");
    console.log("Install one with 'timeful service install' inside a webroot.");
    return;
  }

  console.log("Installed Timeful services:");
  for (const entry of installed) {
    const state = await probeRunState(
      { platform: entry.platform, tier: entry.tier, id: entry.id, file: entry.file, uid: process.getuid?.() },
      host,
    );
    const config = entry.webroot ? await tryReadConfig(entry.webroot) : null;
    const where = config ? `http://${config.host}:${config.port}` : "";
    console.log();
    console.log(`  ${entry.webroot ?? "(webroot unknown)"}`);
    console.log(`    ${entry.tier} tier, ${state}${where ? ` — ${where}` : ""}`);
    console.log(`    ${entry.file}`);
    if (entry.problem) console.log(`    ${entry.problem}`);
  }
  console.log();
  console.log("Manage one with: timeful service <verb> <path-to-webroot>");
}

/** The config of a webroot we only know by name; never fatal. */
async function tryReadConfig(webroot: string): Promise<ResolvedConfig | null> {
  try {
    const file = await readConfigFile(webroot);
    return file ? mergeConfig({ cwd: webroot, file }) : null;
  } catch {
    return null;
  }
}

async function loadWebroot(webroot: string, args: CliArgs): Promise<ResolvedConfig> {
  const file = await readConfigFile(webroot);
  if (!file)
    throw new CliError(
      `${webroot} is not a Timeful webroot: it has no ${CONFIG_FILE}.\n` +
        "Run 'timeful init' there first.",
    );
  return mergeConfig({ cwd: webroot, file, env: envOverrides(), flags: args.overrides });
}

/** Every tier this platform supports, so uninstall/status find either one. */
function unitsForAllTiers(webroot: string, config: ResolvedConfig): ServiceUnit[] {
  return availableTiers(process.platform).map((tier) =>
    unitFor(specFor({ webroot, varDir: config.varDir, cliPath: CLI_PATH, tier })),
  );
}

/** The units that actually exist on disk for `webroot`, narrowed by `--user`/`--system`. */
async function installedUnits(
  webroot: string,
  args: CliArgs,
  host: ServiceHost,
): Promise<ServiceUnit[]> {
  const config = await loadWebroot(webroot, args);
  const units = unitsForAllTiers(webroot, config).filter(
    (unit) => !args.tier || unit.spec.tier === args.tier,
  );
  const present: ServiceUnit[] = [];
  for (const unit of units) if (await host.exists(unit.file)) present.push(unit);
  return present;
}

async function installFor(webroot: string, args: CliArgs, host: ServiceHost): Promise<void> {
  const config = await loadWebroot(webroot, args);
  const tier = await chooseTier(args, host);
  const unit = unitFor(
    specFor({ webroot, varDir: config.varDir, cliPath: CLI_PATH, tier }),
  );
  await installService(unit, host, {
    confirmPrivileged: () => confirmOnTty("Run these commands with sudo now?"),
  });
}

async function runVerbOn(
  action: Exclude<ServiceAction, "install">,
  webroot: string,
  args: CliArgs,
  host: ServiceHost,
): Promise<void> {
  if (action === "status") return statusFor(webroot, args, host);

  const units = await installedUnits(webroot, args, host);
  console.log(webroot);
  if (units.length === 0) {
    console.log(`  no Timeful service is installed${args.tier ? ` in the ${args.tier} tier` : ""}.`);
    return;
  }

  for (const unit of units) {
    console.log(`  ${unit.spec.tier} tier: ${unit.id}`);
    if (action === "uninstall") await uninstallService(unit, host);
    else await controlService(refFor(unit), action as ControlVerb, host);
  }
}

async function statusFor(webroot: string, args: CliArgs, host: ServiceHost): Promise<void> {
  const config = await loadWebroot(webroot, args);
  console.log(webroot);
  console.log(`  configured to serve http://${config.host}:${config.port} from ${config.varDir}`);

  const specs = unitsForAllTiers(webroot, config).map((unit) => unit.spec);
  for (const entry of await serviceStatus(specs, host)) {
    console.log(
      `  ${entry.tier} tier: ${entry.installed ? `installed, ${entry.state}` : "not installed"}`,
    );
    console.log(`    ${entry.id}`);
    console.log(`    ${entry.file}`);
    if (entry.report) console.log(indent(entry.report, 4));
  }
}

/**
 * Which tier to install. Explicit flags win; otherwise the user tier, except
 * that an interactive Linux box with systemd is offered the hardened one.
 */
async function chooseTier(args: CliArgs, host: ServiceHost): Promise<ServiceTier> {
  if (args.tier) {
    if (!availableTiers(process.platform).includes(args.tier))
      throw new CliError(`The ${args.tier} tier is not available on ${process.platform}.`);
    return args.tier;
  }
  const io = stdio();
  if (process.platform !== "linux" || args.yes || !isInteractive(io)) return "user";

  const systemd = await detectSystemd(host);
  if (!systemd.systemctl) return "user";

  return select<ServiceTier>(io, {
    message: "How should Timeful run in the background?",
    options: [
      {
        value: "user",
        label: "user service",
        hint: `no sudo, starts when you log in, runs as you${
          systemd.userManager ? "" : " (no systemd user manager here: this may not work)"
        }`,
      },
      {
        value: "system",
        label: "hardened system service",
        hint: "needs sudo, starts at boot, runs as an isolated ephemeral user",
      },
    ],
  });
}

async function confirmOnTty(question: string): Promise<boolean> {
  const io: Tty = stdio();
  if (!isInteractive(io)) return false;
  say(io);
  return confirm(io, { message: question, default: false });
}

/** Installs the service the wizard was told to install. */
async function installFromWizard(
  config: ResolvedConfig,
  cwd: string,
  args: CliArgs,
): Promise<void> {
  const host = nodeHost({ dryRun: args.dryRun });
  const tier = await chooseTier({ ...args, tier: args.tier }, host);
  const unit = unitFor(specFor({ webroot: cwd, varDir: config.varDir, cliPath: CLI_PATH, tier }));
  await installService(unit, host, {
    confirmPrivileged: () => confirmOnTty("Run these commands with sudo now?"),
  });
}

const divider = (): string => "-".repeat(60);

const indent = (text: string, width = 4): string =>
  text
    .split("\n")
    .map((line) => `${" ".repeat(width)}${line}`)
    .join("\n");

// ---------------------------------------------------------------------------

try {
  await main(process.argv.slice(2));
} catch (err) {
  if (err instanceof CliError) {
    console.error(err.message);
    process.exit(err.code);
  }
  console.error(err);
  process.exit(1);
}
