/** Shared test doubles. Not `*.test.ts`, so vitest never collects it; the bundle is built from index.ts alone, so nothing here reaches dist. */
import { PassThrough, Writable } from "node:stream";
import {
  formatCommand,
  type ServiceCommand,
  type ServiceHost,
  type VerifyOptions,
} from "./service.ts";
import type { Tty } from "./tui.ts";

/** Post-start watch pacing that never sleeps. */
export const noWait: VerifyOptions = { sleep: async () => {} };

export interface FakeHostOptions {
  /** Files already on disk before the test starts: path -> contents. */
  seed?: Record<string, string>;
  /** Paths that exist without readable contents, on top of `seed`'s. */
  existing?: string[];
  /** Permission bits by path; unlisted paths stat as null, which the traversal check lets through. */
  modes?: Record<string, number>;
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
  // A seeded file exists; a bare `existing` path reads as null.
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
    async mode(file) {
      // Like reads, honoured in a dry run: a stat is not a change.
      return options.modes?.[file] ?? null;
    },
    async run(cmd) {
      if (options.dryRun) {
        lines.push(`  would run: ${formatCommand(cmd)}`);
        return { code: 0, stdout: "", stderr: "" };
      }
      ran.push(cmd);
      const failed = options.fail && formatCommand(cmd).includes(options.fail);
      // readRunReport takes the first word as the state; the whole line becomes status.report.
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

/** A scripted piped stdin, one answer per prompt — a stdin written up front stalls in readline's buffer after the first line. A prompt is the only output with no trailing newline. */
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
      // Out of answers: close the input to exercise EOF, or leave the prompt waiting to fail the test.
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
