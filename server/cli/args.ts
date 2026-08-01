/**
 * Command line parsing for `timeful`.
 *
 * Deliberately hand-rolled: the whole surface is three actions, six service
 * verbs, four settings and a handful of switches, and a dependency-free CLI is
 * the point of the packaging (see the architecture reference, § Packaging &
 * CLI).
 */
import { readPort } from "./config.ts";
import { CliError } from "./errors.ts";

/**
 * `auto` is bare `timeful`: serve a webroot, or offer to make one. The other
 * two say which of those halves was meant, and never do the other.
 */
export type Command =
  | "auto"
  | "init"
  | "serve"
  | "service"
  | "upgrade"
  | "help"
  | "version";

export type ServiceAction =
  | "install"
  | "uninstall"
  | "start"
  | "stop"
  | "restart"
  | "status";

/** Settings from the command line, all optional; they override the config file. */
export interface Overrides {
  port?: number;
  host?: string;
  varDir?: string;
  /** Raw value; validated with the rest of the config so errors read alike. */
  trustedProxy?: string;
  /**
   * Realtime updates. There is no flag for this one — it comes from
   * `timeful.config.json` or from `TIMEFUL_REALTIME`, and rides the same
   * precedence chain as the rest.
   */
  realtime?: boolean;
}

export interface CliArgs {
  command: Command;
  /** Only set when `command` is "service"; absent means "list what is installed". */
  action?: ServiceAction;
  /**
   * A webroot given as a positional — to `timeful service <verb> <path>`, or
   * to `timeful upgrade <path>`. Both resolve it the same way.
   */
  target?: string;
  /** `-A` / `--all`: every installed webroot, not just one. */
  all: boolean;
  /** `--user` / `--system`: which service tier to act on. Unset means ask. */
  tier?: "user" | "system";
  /** `--yes`: take the defaults, do not prompt, do not install a service. */
  yes: boolean;
  /** `--dry-run`: print every file write and command instead of doing it. */
  dryRun: boolean;
  overrides: Overrides;
}

const COMMANDS: readonly string[] = ["init", "serve", "service", "upgrade"];

export const SERVICE_ACTIONS: readonly ServiceAction[] = [
  "install",
  "uninstall",
  "start",
  "stop",
  "restart",
  "status",
];

/** Verbs that can be pointed at every installed webroot at once. */
const ALL_ACTIONS: readonly ServiceAction[] = [
  "uninstall",
  "start",
  "stop",
  "restart",
  "status",
];

/**
 * The `Overrides` keys a flag fills with a raw string. `port` parses to a
 * number and `realtime` has no flag at all, so neither belongs here; deriving
 * the set rather than listing it keeps that true as `Overrides` grows.
 */
type StringOverride = {
  [K in keyof Overrides]-?: string extends Overrides[K] ? K : never;
}[keyof Overrides];

/** Flags that take a value, mapped to the `Overrides` key they fill. */
const VALUE_FLAGS: Record<string, StringOverride | "port"> = {
  "--port": "port",
  "--host": "host",
  "--var-dir": "varDir",
  "--trusted-proxy": "trustedProxy",
};

export function parseArgs(argv: readonly string[]): CliArgs {
  const args: CliArgs = {
    command: "auto",
    all: false,
    yes: false,
    dryRun: false,
    overrides: {},
  };
  const positionals: string[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === "--help" || arg === "-h") return { ...args, command: "help" };
    if (arg === "--version" || arg === "-v") return { ...args, command: "version" };
    if (arg === "--yes" || arg === "-y") {
      args.yes = true;
      continue;
    }
    if (arg === "--all" || arg === "-A") {
      args.all = true;
      continue;
    }
    if (arg === "--dry-run") {
      args.dryRun = true;
      continue;
    }
    if (arg === "--user" || arg === "--system") {
      args.tier = arg.slice(2) as "user" | "system";
      continue;
    }

    if (arg.startsWith("-") && arg !== "-") {
      const eq = arg.indexOf("=");
      const name = eq < 0 ? arg : arg.slice(0, eq);
      const key = VALUE_FLAGS[name];
      if (!key) throw new CliError(`Unknown option '${name}'. Try 'timeful --help'.`);

      let value: string;
      if (eq >= 0) {
        value = arg.slice(eq + 1);
      } else {
        const next = argv[i + 1];
        // A value that looks like a flag is far more likely to be a forgotten
        // argument than a host named "--port".
        if (next === undefined || next.startsWith("-"))
          throw new CliError(`${name} requires a value.`);
        value = next;
        i += 1;
      }
      if (value === "") throw new CliError(`${name} requires a value.`);

      if (key === "port") args.overrides.port = readPort(value, name);
      else args.overrides[key] = value;
      continue;
    }

    positionals.push(arg);
  }

  readPositionals(args, positionals);
  checkAll(args);
  return args;
}

/** The action, then whatever that action takes. */
function readPositionals(args: CliArgs, positionals: string[]): void {
  const [command, ...rest] = positionals;
  if (command === undefined) return;
  if (!COMMANDS.includes(command))
    throw new CliError(
      `Unknown command '${command}'. Expected ${COMMANDS.join(", ")}. Try 'timeful --help'.`,
    );
  args.command = command as Command;

  // `upgrade` takes the same positional the service verbs do — a webroot — and
  // no verb of its own: it does exactly one thing.
  if (args.command === "upgrade") {
    const [target, ...extra] = rest;
    if (target !== undefined) args.target = target;
    if (extra.length > 0)
      throw new CliError(`Unexpected argument '${extra[0]}'. Try 'timeful --help'.`);
    return;
  }

  if (args.command !== "service") {
    if (rest.length > 0)
      throw new CliError(
        `'timeful ${command}' takes no arguments, got '${rest[0]}'. Try 'timeful --help'.`,
      );
    return;
  }

  const [action, target, ...extra] = rest;
  if (action !== undefined) {
    if (!SERVICE_ACTIONS.includes(action as ServiceAction))
      throw new CliError(
        `Unknown service action '${action}'. Expected ${SERVICE_ACTIONS.join(", ")}.`,
      );
    args.action = action as ServiceAction;
  }
  if (target !== undefined) args.target = target;
  if (extra.length > 0)
    throw new CliError(`Unexpected argument '${extra[0]}'. Try 'timeful --help'.`);
}

function checkAll(args: CliArgs): void {
  if (!args.all) return;
  if (args.command !== "service" && args.command !== "upgrade")
    throw new CliError("-A/--all only means something for 'timeful service' and 'timeful upgrade'.");
  if (args.target)
    throw new CliError(`Pass a webroot or -A/--all, not both ('${args.target}').`);
  if (args.command === "upgrade") return;
  if (args.action && !ALL_ACTIONS.includes(args.action))
    throw new CliError(
      `'timeful service ${args.action}' works on one webroot; -A/--all is not allowed.` +
        (args.action === "install"
          ? "\nInstall it from inside the webroot, or name the webroot as an argument."
          : ""),
    );
}

export function usage(version: string): string {
  return `timeful ${version} — self-hosted group availability scheduling

Usage:
  timeful [options]                 serve this directory, or offer to set it up
  timeful init [options]            set this directory up as a webroot
  timeful serve [options]           serve this directory (it must be a webroot)
  timeful service [verb] [webroot]  manage background services
  timeful upgrade [webroot | -A]    point an installed service at this build
  timeful --help | --version

Upgrading is one command, run from the webroot:

  npx timeful@latest upgrade

npx has already fetched the new version by the time that runs, so 'upgrade'
does not download anything. It rewrites the service unit to exec the build
that is running it and restarts the service. Your data is never touched.

Service verbs (the webroot defaults to this directory, and -A/--all means
every installed one; with no verb at all, installed services are listed):
  install     write and activate a startup service for a webroot
  uninstall   deactivate and remove it
  start       start it now
  stop        stop it
  restart     stop and start it
  status      report where it is installed and whether it is running

Service tiers (--user is the default; --system is Linux + systemd only):
  --user      no sudo, starts at login, runs as you
  --system    hardened unit, needs sudo, starts at boot, runs as an
              isolated ephemeral user that can read this webroot and
              write only its data directory

Options:
  --port <n>              port to listen on (default 3000)
  --host <addr>           interface to bind (default 127.0.0.1)
  --var-dir <path>        data directory (default ./, the webroot itself)
  --trusted-proxy <list>  peers allowed to send X-Forwarded-For:
                          'loopback' (default), 'none', or IPs/CIDRs
  -A, --all               act on every installed webroot (service verbs,
                          and upgrade)
  -y, --yes               accept every default, do not prompt
      --dry-run           print every file write and command instead of
                          performing it, then exit 0
  -h, --help              show this help
  -v, --version           show the version

Settings are read from timeful.config.json in the current directory; the
options above and the PORT, HOST and VAR_DIR environment variables override it.

Live updates are configured per event, in the event's own settings. The
config key "realtime" and TIMEFUL_REALTIME=0 are a server-wide kill switch
above that: off means no event gets them, whatever its own setting says.
Either way the pages keep working on the REST API alone.
`;
}
