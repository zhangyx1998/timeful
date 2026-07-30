/**
 * First-run wizard: turns an empty directory into a Timeful webroot.
 *
 * Built on the prompts in tui.ts — no prompt library, no color library, nothing
 * that would add a runtime dependency to a package whose whole point is that
 * `npx timeful` pulls one thing. Streams are injected so the flow can be driven
 * by a scripted stdin in tests, which is also what a piped stdin gets: the
 * numbered line prompts rather than the arrow-key list.
 */
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
  /**
   * Command-line settings, used as the offered defaults: `timeful --port 8080`
   * in a fresh directory should not then propose 3000.
   */
  defaults?: Overrides;
  /**
   * Persists the answers (write the config file, create the data directory)
   * before the last two questions are asked, so "start now?" is only offered
   * once the directory really is a webroot. Injectable for tests.
   */
  commit: (config: ResolvedConfig) => Promise<void>;
}

export interface WizardResult {
  config: ResolvedConfig;
  startNow: boolean;
  installService: boolean;
}

/**
 * Runs the wizard. Resolves to null when the user declines to initialize the
 * directory — that is a normal outcome, not an error.
 */
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

    // The built-in defaults, resolved once, so the questions need not restate
    // them. `varDirRaw`, not `varDir`: the wizard proposes "./var", not an
    // absolute path. The command-line values stay raw on purpose — a typo in
    // `--trusted-proxy` is prefilled below for fixing, never thrown over.
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
    // A stdin that closes mid-wizard is an error, not a hang — and the
    // directory is left exactly as it was found.
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

/**
 * The answer is stored as typed, so the config file keeps the operator's
 * wording; it is validated here, while they are still around to fix it.
 */
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
