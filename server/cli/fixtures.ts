/**
 * Shared test doubles for the CLI's tests.
 *
 * Not a `*.test.ts` file, so vitest never collects it as a suite; and the CLI
 * bundle is built from `server/cli/index.ts` alone, so nothing here can reach
 * `dist`.
 */
import { PassThrough, Writable } from "node:stream";
import { formatCommand, type ServiceCommand, type ServiceHost } from "./service.ts";
import type { Tty } from "./tui.ts";

export interface FakeHostOptions {
  /** Files already on disk before the test starts: path -> contents. */
  seed?: Record<string, string>;
  /**
   * Paths that exist without readable contents, on top of `seed`'s. A unit
   * file can be present on the machine without this host having its text —
   * `serviceStatus`'s installed check depends on exactly that.
   */
  existing?: string[];
  which?: (binary: string) => boolean;
  /** Fail (exit 3) every command whose formatted form contains this string. */
  fail?: string;
  /** Mirrors the real host: narrate, change nothing. */
  dryRun?: boolean;
}

/** A host that records everything instead of touching the machine. */
export function fakeHost(options: FakeHostOptions = {}) {
  const files = new Map(Object.entries(options.seed ?? {}));
  const ran: ServiceCommand[] = [];
  const lines: string[] = [];
  // Existence is tracked apart from contents, seeded from the union of both
  // options, so a seeded file exists and a bare `existing` path reads as null.
  const existing = new Set([...files.keys(), ...(options.existing ?? [])]);
  const host: ServiceHost = {
    dryRun: options.dryRun,
    async writeFile(file, contents) {
      if (options.dryRun) return;
      files.set(file, contents);
      existing.add(file);
    },
    async readFile(file) {
      // Reads are honoured in a dry run too, exactly as the real host does.
      return files.get(file) ?? null;
    },
    async removeFile(file) {
      if (options.dryRun) return;
      files.delete(file);
      existing.delete(file);
    },
    async exists(file) {
      return existing.has(file);
    },
    async run(cmd) {
      if (options.dryRun) {
        lines.push(`  would run: ${formatCommand(cmd)}`);
        return { code: 0, stdout: "", stderr: "" };
      }
      ran.push(cmd);
      const failed = options.fail && formatCommand(cmd).includes(options.fail);
      // The success stdout does double duty: `readRunReport` has no
      // `ActiveState=` line to find, so its first word becomes the state
      // ("running"), and the whole line becomes `status.report`.
      return { code: failed ? 3 : 0, stdout: failed ? "" : "active (running)", stderr: "" };
    },
    async which(binary) {
      return options.which ? options.which(binary) : true;
    },
    log(line = "") {
      lines.push(line);
    },
  };
  return { host, files, ran, text: () => lines.join("\n") };
}

/**
 * A scripted stdin that is a pipe, answering one prompt at a time, plus a
 * transcript of everything that was printed.
 *
 * Answers are fed reactively rather than all at once: readline hands over a
 * single line per `question()` and leaves the rest of an already-buffered
 * chunk sitting in its internal buffer, so a stdin written up front would
 * stall after the first answer. Waiting for each prompt is also what a person
 * does. A prompt is recognisable as the only output with no trailing newline.
 */
export function scripted(answers: string[], endWhenExhausted = false) {
  const queue = [...answers];
  const input = new PassThrough();
  const written: string[] = [];
  const output = new Writable({
    write(chunk, _encoding, callback) {
      const line = String(chunk);
      written.push(line);
      if (line.endsWith("\n")) return callback();
      const next = queue.shift();
      // Out of answers: either close the input (to exercise EOF) or leave the
      // prompt waiting, which fails the test rather than hiding a stray prompt.
      if (next === undefined) {
        if (endWhenExhausted) setImmediate(() => input.end());
        return callback();
      }
      setImmediate(() => input.write(`${next}\n`));
      callback();
    },
  });
  const io: Tty = { input, output };
  return { io, input, output, text: () => written.join("") };
}
