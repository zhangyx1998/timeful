/**
 * Atomic JSON file store rooted at `var/` (override with VAR_DIR).
 *
 * Every mutation goes through a per-file async queue so concurrent
 * read-modify-write cycles never interleave, and every write is done as
 * "write temp file + rename" so a reader never observes a partial file.
 */
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import type {
  Credential,
  LinksMap,
  Mutator,
  SessionsMap,
  StoredEvent,
} from "./types.ts";

export function varDir(): string {
  return process.env.VAR_DIR || path.join(process.cwd(), "var");
}

function resolve(relPath: string): string {
  return path.join(varDir(), relPath);
}

/** The `code` of a Node system error, when the value carries one. */
function errorCode(err: unknown): string | undefined {
  if (typeof err !== "object" || err === null || !("code" in err)) return undefined;
  return typeof err.code === "string" ? err.code : undefined;
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
  // Drop the entry once this task is the last one standing, so the map does
  // not grow without bound as events come and go.
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

async function writeRaw<T>(relPath: string, data: T): Promise<T> {
  const file = resolve(relPath);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  try {
    await fs.writeFile(tmp, JSON.stringify(data, null, 2) + "\n", "utf8");
    await fs.rename(tmp, file);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => {});
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

/**
 * Read-modify-write a JSON file under the file lock.
 * `mutator` receives the current value (or `fallback`) and returns the next
 * value; returning `undefined` leaves the file untouched.
 */
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

export function readEvent(id: string): Promise<StoredEvent | null> {
  if (!isUuid(id)) return Promise.resolve(null);
  return readJson<StoredEvent | null>(eventFile(id), null);
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
    if (!current) return undefined;
    return mutator(current);
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
