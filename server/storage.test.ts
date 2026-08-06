/**
 * The startup write probe. Errno branches use synthetic errors — a test
 * machine has no polite way to produce a real EROFS.
 */
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { explainWriteFailure, probeVarDirWritable } from "./storage.ts";

const savedVarDir = process.env.VAR_DIR;
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  if (savedVarDir === undefined) delete process.env.VAR_DIR;
  else process.env.VAR_DIR = savedVarDir;
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function tempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "timeful-probe-"));
  cleanups.push(async () => {
    // Un-freeze anything a test made read-only, or rm fails too.
    await fs.chmod(dir, 0o755).catch(() => {});
    await fs.rm(dir, { recursive: true, force: true });
  });
  return dir;
}

describe("explainWriteFailure", () => {
  const dir = "/srv/timeful/var";

  it("reads EROFS as the sandbox speaking, and points at the unit", () => {
    const text = explainWriteFailure(dir, { code: "EROFS" });
    expect(text).toContain("read-only file system (EROFS)");
    expect(text).toContain(dir);
    // The known producer of this errno: a hardened unit without the
    // write carve-out (or with a drop-in overriding it).
    expect(text).toContain(`ReadWritePaths=${dir}`);
    expect(text).toContain("npx timeful@latest upgrade");
    expect(text).toContain("/etc/systemd/system/timeful-*.service.d/");
  });

  it("reads EACCES and EPERM as ownership, and prints the chown/chmod pair", () => {
    for (const code of ["EACCES", "EPERM"]) {
      const text = explainWriteFailure(dir, { code });
      expect(text).toContain(code);
      expect(text).toContain(`sudo chown -R :timeful ${dir}`);
      expect(text).toContain(`sudo chmod -R g+rwX ${dir}`);
      expect(text).toContain("timeful service install");
    }
  });

  it("still names the directory and the errno it cannot explain", () => {
    expect(explainWriteFailure(dir, { code: "ENOSPC" })).toContain("ENOSPC");
    expect(explainWriteFailure(dir, { code: "ENOSPC" })).toContain(dir);
    expect(explainWriteFailure(dir, new Error("boom"))).toContain("boom");
  });
});

describe("probeVarDirWritable", () => {
  it("answers null for a writable directory, and leaves nothing behind", async () => {
    const dir = await tempDir();
    process.env.VAR_DIR = dir;
    expect(await probeVarDirWritable()).toBeNull();
    expect(await fs.readdir(dir)).toEqual([]);
  });

  it("creates a data directory that does not exist yet", async () => {
    const dir = path.join(await tempDir(), "var");
    process.env.VAR_DIR = dir;
    expect(await probeVarDirWritable()).toBeNull();
    expect((await fs.stat(dir)).isDirectory()).toBe(true);
  });

  // Root writes anywhere, so the permission failure cannot be staged for it.
  it.skipIf(process.getuid?.() === 0)(
    "diagnoses a directory this user may not write",
    async () => {
      const dir = await tempDir();
      await fs.chmod(dir, 0o555);
      process.env.VAR_DIR = dir;
      const text = await probeVarDirWritable();
      expect(text).toContain(dir);
      expect(text).toContain("sudo chown -R :timeful");
    },
  );
});
