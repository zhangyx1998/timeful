/** Hand-rolled TUI — the package declares no runtime dependencies. Raw-mode prompts on a TTY, line mode on a pipe (how the wizard is tested); callers check isInteractive rather than hang. */
import { emitKeypressEvents } from "node:readline";
import { createInterface } from "node:readline/promises";
import { CliError } from "./errors.ts";

/** The two streams a prompt needs, injectable so tests can script them. */
export interface Tty {
  input: NodeJS.ReadableStream & {
    isTTY?: boolean;
    setRawMode?: (mode: boolean) => void;
  };
  output: NodeJS.WritableStream & { columns?: number };
}

/** stdin closed (or Ctrl+D) with a question still on screen. */
export class InputEndedError extends CliError {
  constructor(message = "Input ended before the question was answered.") {
    super(message);
    this.name = "InputEndedError";
  }
}

/** Ctrl+C. 130 is the shell's convention for "killed by SIGINT". */
export class CancelledError extends CliError {
  constructor(message = "Cancelled.") {
    super(message, 130);
    this.name = "CancelledError";
  }
}

export function isInteractive(io: Tty): boolean {
  return Boolean(io.input.isTTY) && typeof io.input.setRawMode === "function";
}

export function stdio(): Tty {
  return { input: process.stdin, output: process.stdout };
}

// ---------------------------------------------------------------------------
// styling
// ---------------------------------------------------------------------------

const plain = (): boolean => Boolean(process.env.NO_COLOR);
const sgr = (code: string, text: string): string =>
  plain() ? text : `\x1b[${code}m${text}\x1b[0m`;
const bold = (text: string): string => sgr("1", text);
const dim = (text: string): string => sgr("2", text);

const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";

// ---------------------------------------------------------------------------
// line input
// ---------------------------------------------------------------------------

/** A closed input rejects instead of hanging; the interface is per question because raw-mode prompts take the stream over in between. */
export async function question(io: Tty, prompt: string): Promise<string> {
  if ((io.input as { readableEnded?: boolean }).readableEnded) throw new InputEndedError();
  const rl = createInterface({ input: io.input, output: io.output });
  try {
    return await new Promise<string>((resolve, reject) => {
      const onClose = () => reject(new InputEndedError());
      rl.once("close", onClose);
      rl.question(prompt).then(
        (answer) => {
          rl.off("close", onClose);
          resolve(answer);
        },
        (err: unknown) => {
          rl.off("close", onClose);
          reject(err);
        },
      );
    });
  } finally {
    rl.close();
  }
}

export interface TextRequest {
  message: string;
  /** Offered in brackets and taken when the answer is empty. */
  default?: string;
  /** Throws a `CliError` whose message is shown before the question repeats. */
  validate?: (value: string) => void;
}

/** A free-text answer. Always line mode: readline edits better than we can. */
export async function text(io: Tty, request: TextRequest): Promise<string> {
  const label =
    request.default === undefined
      ? `${request.message}: `
      : `${request.message} [${request.default}]: `;
  for (;;) {
    const raw = (await question(io, label)).trim();
    const value = raw === "" ? (request.default ?? "") : raw;
    try {
      request.validate?.(value);
      return value;
    } catch (err) {
      if (!(err instanceof CliError)) throw err;
      say(io, `  ${err.message}`);
    }
  }
}

export interface ConfirmRequest {
  message: string;
  default: boolean;
}

/** Yes or no. One keypress on a terminal, one line from a pipe. */
export async function confirm(io: Tty, request: ConfirmRequest): Promise<boolean> {
  const hint = request.default ? "Y/n" : "y/N";
  const prompt = `${request.message} (${hint}) `;

  if (isInteractive(io)) {
    io.output.write(prompt);
    const answer = await keySession<boolean>(io, (key) => {
      guardExit(key);
      if (key.name === "return" || key.name === "enter") return request.default;
      const char = (key.sequence ?? "").toLowerCase();
      if (char === "y") return true;
      if (char === "n") return false;
      return PENDING;
    });
    io.output.write(`${answer ? "yes" : "no"}\n`);
    return answer;
  }

  for (;;) {
    const answer = (await question(io, prompt)).trim().toLowerCase();
    if (answer === "") return request.default;
    if (answer === "y" || answer === "yes") return true;
    if (answer === "n" || answer === "no") return false;
    say(io, "  Please answer y or n.");
  }
}

// ---------------------------------------------------------------------------
// select
// ---------------------------------------------------------------------------

export interface SelectOption<T> {
  value: T;
  label: string;
  /** Shown dimmed after the label; never matched against in line mode. */
  hint?: string;
}

/** The "Other…" row: picking it switches to a free-text answer. */
export interface OtherOption<T> {
  label: string;
  /** Prompt for the text that replaces the list. */
  prompt: string;
  /** Turns the typed text into a value, or throws a `CliError` saying why not. */
  parse: (raw: string) => T;
  /** Pre-filled answer, offered as the default. */
  initial?: string;
}

export interface SelectRequest<T> {
  message: string;
  options: SelectOption<T>[];
  /** Index of the row the cursor starts on. Past the end means "Other…". */
  initial?: number;
  other?: OtherOption<T>;
}

export async function select<T>(io: Tty, request: SelectRequest<T>): Promise<T> {
  if (request.options.length === 0 && !request.other)
    throw new CliError("Nothing to choose from.");
  return isInteractive(io) ? selectByKeys(io, request) : selectByLine(io, request);
}

interface Row {
  label: string;
  hint?: string;
}

function rowsOf<T>(request: SelectRequest<T>): Row[] {
  const rows: Row[] = request.options.map((option) => ({
    label: option.label,
    hint: option.hint,
  }));
  if (request.other) rows.push({ label: request.other.label });
  return rows;
}

async function selectByKeys<T>(io: Tty, request: SelectRequest<T>): Promise<T> {
  const rows = rowsOf(request);
  const width = (io.output.columns ?? 80) - 4;
  let index = Math.min(Math.max(request.initial ?? 0, 0), rows.length - 1);
  let height = 0;

  const draw = () => {
    const lines = [request.message];
    rows.forEach((row, i) => {
      const label = clip(row.label, width);
      const head = i === index ? `> ${bold(label)}` : `  ${label}`;
      lines.push(`  ${head}${row.hint ? dim(` — ${clip(row.hint, width)}`) : ""}`);
    });
    lines.push(dim("  ↑/↓ to move, Enter to select, Ctrl+C to cancel"));
    height = frame(io, lines, height);
  };

  io.output.write(HIDE_CURSOR);
  try {
    draw();
    index = await keySession<number>(io, (key) => {
      guardExit(key);
      const name = key.name ?? "";
      const bare = !key.ctrl && !key.meta;
      if (name === "up" || (bare && name === "k") || (key.ctrl && name === "p")) {
        index = (index - 1 + rows.length) % rows.length;
        draw();
        return PENDING;
      }
      if (name === "down" || (bare && name === "j") || (key.ctrl && name === "n")) {
        index = (index + 1) % rows.length;
        draw();
        return PENDING;
      }
      if (bare && /^[1-9]$/.test(name) && Number(name) <= rows.length) {
        index = Number(name) - 1;
        draw();
        return PENDING;
      }
      if (name === "return" || name === "enter") return index;
      return PENDING;
    });
    erase(io, height);
    height = 0;
  } finally {
    io.output.write(SHOW_CURSOR);
  }

  const picked = request.options[index];
  if (picked) {
    say(io, `${request.message} ${bold(picked.label)}`);
    return picked.value;
  }
  // The "Other…" row: the list gives way to a text prompt.
  const other = request.other as OtherOption<T>;
  say(io, request.message);
  return askOther(io, other);
}

async function selectByLine<T>(io: Tty, request: SelectRequest<T>): Promise<T> {
  const rows = rowsOf(request);
  say(io, request.message);
  rows.forEach((row, i) => {
    say(io, `  ${i + 1}) ${row.label}${row.hint ? ` — ${row.hint}` : ""}`);
  });

  const initial = Math.min(Math.max(request.initial ?? 0, 0), rows.length - 1);
  const fallback = request.options[initial]?.label ?? request.other?.initial ?? "";

  for (;;) {
    const raw = (await question(io, `Choice [${fallback}]: `)).trim();
    const answer = raw === "" ? fallback : raw;

    if (/^\d+$/.test(answer)) {
      const index = Number(answer) - 1;
      const picked = request.options[index];
      if (picked) return picked.value;
      if (request.other && index === request.options.length) return askOther(io, request.other);
      say(io, `  Choose a number between 1 and ${rows.length}.`);
      continue;
    }

    const match = request.options.find(
      (option) => option.label.toLowerCase() === answer.toLowerCase(),
    );
    if (match) return match.value;

    if (!request.other) {
      say(io, `  '${answer}' is not one of the choices.`);
      continue;
    }
    try {
      // Anything unrecognised is taken as the "Other…" answer, typed directly.
      return request.other.parse(answer);
    } catch (err) {
      if (!(err instanceof CliError)) throw err;
      say(io, `  ${err.message}`);
    }
  }
}

async function askOther<T>(io: Tty, other: OtherOption<T>): Promise<T> {
  for (;;) {
    const raw = await text(io, { message: `  ${other.prompt}`, default: other.initial });
    try {
      return other.parse(raw);
    } catch (err) {
      if (!(err instanceof CliError)) throw err;
      say(io, `  ${err.message}`);
    }
  }
}

// ---------------------------------------------------------------------------
// drawing
// ---------------------------------------------------------------------------

export function say(io: Tty, line = ""): void {
  io.output.write(`${line}\n`);
}

/** Replaces the previous `height` lines; callers pre-clip, since a wrapped line breaks the cursor arithmetic. */
function frame(io: Tty, lines: string[], height: number): number {
  erase(io, height);
  io.output.write(`${lines.join("\n")}\n`);
  return lines.length;
}

function erase(io: Tty, height: number): void {
  if (height > 0) io.output.write(`\x1b[${height}A`);
  io.output.write("\x1b[0J");
}

/** Truncates on printable characters; callers style the result afterwards. */
function clip(text: string, width: number): string {
  if (width < 8 || text.length <= width) return text;
  return `${text.slice(0, width - 1)}…`;
}

// ---------------------------------------------------------------------------
// raw keypresses
// ---------------------------------------------------------------------------

export interface Key {
  name?: string;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
  sequence?: string;
}

const PENDING = Symbol("pending");

/** Ctrl+C and Ctrl+D mean the same things in a prompt as they do in a shell. */
function guardExit(key: Key): void {
  if (key.ctrl && key.name === "c") throw new CancelledError();
  if (key.ctrl && key.name === "d") throw new InputEndedError();
}

/** Raw mode is always restored, and the stream paused on the way out so the keypress decoder does not swallow input meant for the next readline interface. */
function keySession<T>(io: Tty, handle: (key: Key) => T | typeof PENDING): Promise<T> {
  const input = io.input;
  emitKeypressEvents(input as NodeJS.ReadableStream);
  input.setRawMode?.(true);
  (input as { resume?: () => void }).resume?.();

  return new Promise<T>((resolve, reject) => {
    const cleanup = () => {
      input.off("keypress", onKey);
      input.off("end", onEnd);
      input.off("close", onEnd);
      input.setRawMode?.(false);
      (input as { pause?: () => void }).pause?.();
    };
    const onKey = (_chunk: string, key: Key = {}) => {
      let outcome: T | typeof PENDING;
      try {
        outcome = handle(key);
      } catch (err) {
        cleanup();
        reject(err);
        return;
      }
      if (outcome !== PENDING) {
        cleanup();
        resolve(outcome);
      }
    };
    const onEnd = () => {
      cleanup();
      reject(new InputEndedError());
    };
    input.on("keypress", onKey);
    input.once("end", onEnd);
    input.once("close", onEnd);
  });
}
