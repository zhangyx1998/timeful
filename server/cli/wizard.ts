/** First-run wizard, on tui.ts's dependency-free prompts; streams are injected so tests drive it over a piped stdin. */
import type { Overrides } from "./args.ts";
import {
  CONFIG_FILE,
  mergeConfig,
  parseTrustedProxyChoice,
  type ResolvedConfig,
} from "./config.ts";
import { CliError } from "./errors.ts";
import { confirm, InputEndedError, say, select, text, type Tty } from "./tui.ts";

export interface WizardOptions {
  cwd: string;
  input: Tty["input"];
  output: Tty["output"];
  /** Command-line settings, used as the offered defaults. */
  defaults?: Overrides;
  /** Persists the answers before the last two questions, so "start now?" is only offered on a real webroot. */
  commit: (config: ResolvedConfig) => Promise<void>;
}

export interface WizardResult {
  config: ResolvedConfig;
  startNow: boolean;
  installService: boolean;
}

/** Null when the user declines — a normal outcome, not an error. */
export async function runWizard(options: WizardOptions): Promise<WizardResult | null> {
  const { cwd, defaults = {}, commit } = options;
  const io: Tty = { input: options.input, output: options.output };

  try {
    say(io);
    say(io, `This directory is not a Timeful webroot: no ${CONFIG_FILE} in ${cwd}`);
    say(io, "Answer a few questions and it will be. Press Enter to take a default.");
    say(io);

    if (!(await confirm(io, { message: "Initialize a Timeful webroot here?", default: true }))) {
      say(io, "Nothing was written.");
      return null;
    }
    say(io);

    // varDirRaw, not varDir: propose "./", not an absolute path. Command-line values
    // stay raw so a typo is prefilled for fixing, never thrown over.
    const fallback = mergeConfig({ cwd });

    const port = await askPort(io, defaults.port ?? fallback.port);
    const host = await text(io, {
      message: "Bind address",
      default: defaults.host ?? fallback.host,
    });
    const varDir = await text(io, {
      message: "Data directory",
      default: defaults.varDir ?? fallback.varDirRaw,
    });
    const trustedProxy = await askTrustedProxy(io, defaults.trustedProxy ?? "loopback");

    const config = mergeConfig({ cwd, file: { port, host, varDir, trustedProxy } });
    await commit(config);
    say(io);

    const startNow = await confirm(io, { message: "Start the server now?", default: true });
    const installService = await confirm(io, {
      message: "Install as a system service so Timeful starts automatically?",
      default: false,
    });
    return { config, startNow, installService };
  } catch (err) {
    // A stdin that closes mid-wizard errors instead of hanging; the directory is left as found.
    if (err instanceof InputEndedError)
      throw new CliError("Input ended before the wizard finished; nothing was written.");
    throw err;
  }
}

// ---------------------------------------------------------------------------
// questions
// ---------------------------------------------------------------------------

async function askPort(io: Tty, fallback: number): Promise<number> {
  const answer = await text(io, {
    message: "Port",
    default: String(fallback),
    validate: (raw) => {
      const port = Number(raw);
      if (!Number.isInteger(port) || port < 1 || port > 65535)
        throw new CliError(`'${raw}' is not a port number (1-65535).`);
    },
  });
  return Number(answer);
}

const TRUSTED_PROXY_CHOICES = [
  {
    value: "loopback",
    label: "loopback",
    hint: "trust 127.0.0.1 and ::1 — a reverse proxy on this machine",
  },
  { value: "none", label: "none", hint: "ignore X-Forwarded-* entirely" },
];

/** Stored as typed so the config keeps the operator's wording; validated now, while they can fix it. */
async function askTrustedProxy(io: Tty, fallback: string): Promise<string> {
  const index = TRUSTED_PROXY_CHOICES.findIndex(
    (choice) => choice.value === fallback.trim().toLowerCase(),
  );
  const other = index < 0;
  return select(io, {
    message: "Trusted proxy — who may speak for a client's address?",
    options: TRUSTED_PROXY_CHOICES,
    initial: other ? TRUSTED_PROXY_CHOICES.length : index,
    other: {
      label: "specific addresses",
      prompt: "IPs or CIDR ranges, comma separated",
      initial: other ? fallback : undefined,
      parse: (raw) => {
        parseTrustedProxyChoice(raw);
        return raw;
      },
    },
  });
}
