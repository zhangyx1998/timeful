/** JSON store rooted at `var/` (VAR_DIR): per-file write queue, atomic temp-file + rename writes. */
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { normalizeResponses } from "../src/lib/event.ts";
import { logError, stackHead } from "./log.ts";
import type {
  Credential,
  LinksMap,
  Mutator,
  PushStore,
  SessionsMap,
  StoredEvent,
  VapidKeyRecord,
} from "./types.ts";

export function varDir(): string {
  return process.env.VAR_DIR || path.join(process.cwd(), "var");
}

function resolve(relPath: string): string {
  return path.join(varDir(), relPath);
}

function errorCode(err: unknown): string | undefined {
  if (typeof err !== "object" || err === null || !("code" in err)) return undefined;
  return typeof err.code === "string" ? err.code : undefined;
}

// ---------------------------------------------------------------------------
// startup write probe
// ---------------------------------------------------------------------------

/** Split from `probeVarDirWritable` so both errno branches are testable with a synthetic error. */
export function explainWriteFailure(dir: string, err: unknown): string {
  const code = errorCode(err);
  if (code === "EROFS")
    return [
      `The data directory is on a read-only file system (EROFS):`,
      "",
      `  ${dir}`,
      "",
      "Reads work, so the server would come up looking healthy and then fail",
      "the first save. Under the hardened systemd service this means the unit",
      `is missing its 'ReadWritePaths=${dir}' line, or a drop-in overrides it.`,
      "Rerun 'npx timeful@latest upgrade' to regenerate the unit, and clear",
      "stale drop-ins under /etc/systemd/system/timeful-*.service.d/.",
    ].join("\n");
  if (code === "EACCES" || code === "EPERM")
    return [
      `This process is not allowed to write to the data directory (${code}):`,
      "",
      `  ${dir}`,
      "",
      "The directory's ownership or mode does not admit this user. For the",
      "hardened service, the data directory belongs to the 'timeful' group:",
      "",
      `  sudo chown -R :timeful ${dir}`,
      `  sudo chmod -R g+rwX ${dir}`,
      "",
      "or rerun 'timeful service install', which performs both.",
    ].join("\n");
  const reason = code ?? (err instanceof Error ? err.message : String(err));
  return `Could not write to the data directory ${dir} (${reason}).`;
}

/** Boot-time write probe: fail now with one diagnostic instead of 500ing on the first save. Null when writable. */
export async function probeVarDirWritable(): Promise<string | null> {
  const dir = varDir();
  const file = path.join(
    dir,
    `.write-probe.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`,
  );
  try {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(file, "write probe\n", "utf8");
    await fs.rm(file, { force: true });
    return null;
  } catch (err) {
    await fs.rm(file, { force: true }).catch(() => {});
    return explainWriteFailure(dir, err);
  }
}

// ---------------------------------------------------------------------------
// per-file write queue
// ---------------------------------------------------------------------------

const queues = new Map<string, Promise<unknown>>();

/** Runs `task` once `prev` has settled, however it settled. */
async function chain<T>(prev: Promise<unknown>, task: () => Promise<T>): Promise<T> {
  try {
    await prev;
  } catch {
    // A failed predecessor must not poison the queue for later tasks.
  }
  return task();
}

/** Run `task` exclusively with respect to other tasks for the same file. */
export function withFileLock<T>(relPath: string, task: () => Promise<T>): Promise<T> {
  const file = resolve(relPath);
  const prev = queues.get(file) ?? Promise.resolve();
  const run = chain(prev, task);
  const tail = run.then(
    () => {},
    () => {},
  );
  queues.set(file, tail);
  // Drop the entry once this task is the tail, so the map stays bounded.
  void tail.then(() => {
    if (queues.get(file) === tail) queues.delete(file);
  });
  return run;
}

// ---------------------------------------------------------------------------
// primitives
// ---------------------------------------------------------------------------

async function readRaw<T>(relPath: string, fallback: T): Promise<T> {
  try {
    const text = await fs.readFile(resolve(relPath), "utf8");
    return JSON.parse(text) as T;
  } catch (err) {
    if (errorCode(err) === "ENOENT") return fallback;
    throw err;
  }
}

function eventIdOf(relPath: string): string | undefined {
  const match = /^events\/(.+)\.json$/.exec(relPath);
  return match && isUuid(match[1]) ? match[1] : undefined;
}

async function writeRaw<T>(relPath: string, data: T): Promise<T> {
  const file = resolve(relPath);
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
    try {
      await fs.writeFile(tmp, JSON.stringify(data, null, 2) + "\n", "utf8");
      await fs.rename(tmp, file);
    } catch (err) {
      await fs.rm(tmp, { force: true }).catch(() => {});
      throw err;
    }
  } catch (err) {
    // The path here is the operator's own data directory — never a slug.
    logError(err instanceof Error ? err.message : "Storage write failed", {
      code: errorCode(err),
      path: relPath,
      stack: stackHead(err instanceof Error ? err.stack : undefined),
      eventId: eventIdOf(relPath),
    });
    throw err;
  }
  return data;
}

/** Read a JSON file, returning `fallback` when it does not exist. */
export function readJson<T>(relPath: string, fallback: T): Promise<T> {
  return readRaw(relPath, fallback);
}

/** Atomically write a JSON file (queued per file). */
export function writeJson<T>(relPath: string, data: T): Promise<T> {
  return withFileLock(relPath, () => writeRaw(relPath, data));
}

/** Atomically delete a JSON file (queued per file). No-op when missing. */
export function deleteJson(relPath: string): Promise<void> {
  return withFileLock(relPath, () => fs.rm(resolve(relPath), { force: true }));
}

/** Read-modify-write under the file lock; a mutator returning `undefined` leaves the file untouched. */
export function updateJson<T>(
  relPath: string,
  fallback: T,
  mutator: Mutator<T>,
): Promise<T> {
  return withFileLock(relPath, async () => {
    const current = await readRaw(relPath, fallback);
    const next = await mutator(current);
    if (next === undefined) return current;
    await writeRaw(relPath, next);
    return next;
  });
}

// ---------------------------------------------------------------------------
// typed accessors for the four store shapes
// ---------------------------------------------------------------------------

export const CREDENTIAL_FILE = "credential.json";
export const SESSIONS_FILE = "sessions.json";
export const LINKS_FILE = "links.json";

const eventFile = (id: string): string => path.posix.join("events", `${id}.json`);

export const readCredential = (): Promise<Credential | null> =>
  readJson<Credential | null>(CREDENTIAL_FILE, null);

export const writeCredential = (cred: Credential): Promise<Credential> =>
  writeJson(CREDENTIAL_FILE, cred);

export const readSessions = (): Promise<SessionsMap> =>
  readJson<SessionsMap>(SESSIONS_FILE, {});

export const updateSessions = (mutator: Mutator<SessionsMap>): Promise<SessionsMap> =>
  updateJson<SessionsMap>(SESSIONS_FILE, {}, mutator);

export const readLinks = (): Promise<LinksMap> => readJson<LinksMap>(LINKS_FILE, {});

export const updateLinks = (mutator: Mutator<LinksMap>): Promise<LinksMap> =>
  updateJson<LinksMap>(LINKS_FILE, {}, mutator);

export const PUSH_FILE = "push.json";
export const VAPID_FILE = "vapid.json";

// Fresh fallback objects per call: `readJson` hands the fallback itself back.
export const readPushStore = (): Promise<PushStore> =>
  readJson<PushStore>(PUSH_FILE, { subscriptions: [] });

export const updatePushStore = (mutator: Mutator<PushStore>): Promise<PushStore> =>
  updateJson<PushStore>(PUSH_FILE, { subscriptions: [] }, mutator);

export const readVapidKeys = (): Promise<VapidKeyRecord | null> =>
  readJson<VapidKeyRecord | null>(VAPID_FILE, null);

export const updateVapidKeys = (
  mutator: Mutator<VapidKeyRecord | null>,
): Promise<VapidKeyRecord | null> =>
  updateJson<VapidKeyRecord | null>(VAPID_FILE, null, mutator);

/** Migrates pre-guest-key event files on every read; persisted by the next ordinary write. */
function migrate(event: StoredEvent | null): StoredEvent | null {
  if (!event) return null;
  const { responses, changed } = normalizeResponses(event.responses, (message) =>
    console.warn(message),
  );
  if (!changed) return event;
  return { ...event, responses };
}

export async function readEvent(id: string): Promise<StoredEvent | null> {
  if (!isUuid(id)) return null;
  return migrate(await readJson<StoredEvent | null>(eventFile(id), null));
}

export function writeEvent(event: StoredEvent): Promise<StoredEvent> {
  return writeJson(eventFile(event.id), event);
}

/** Mutate an existing event. Resolves to null when the event does not exist. */
export function updateEvent(
  id: string,
  mutator: Mutator<StoredEvent>,
): Promise<StoredEvent | null> {
  if (!isUuid(id)) return Promise.resolve(null);
  return updateJson<StoredEvent | null>(eventFile(id), null, async (current) => {
    // Migrated before the mutator sees it: a write never mixes keyed records into a legacy document.
    const migrated = migrate(current);
    if (!migrated) return undefined;
    return mutator(migrated);
  });
}

export function deleteEvent(id: string): Promise<void> {
  if (!isUuid(id)) return Promise.resolve();
  return deleteJson(eventFile(id));
}

export async function listEventIds(): Promise<string[]> {
  try {
    const entries = await fs.readdir(resolve("events"));
    return entries
      .filter((name) => name.endsWith(".json"))
      .map((name) => name.slice(0, -".json".length))
      .filter(isUuid);
  } catch (err) {
    if (errorCode(err) === "ENOENT") return [];
    throw err;
  }
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}
