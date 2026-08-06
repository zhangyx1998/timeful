/**
 * Anti-scanning tarpit, misses only: a serial per-IP delay queue, 429 over the
 * cap. Hits must never be queued — guests sharing a NAT is the normal case.
 */
import type { Request, Response } from "express";
import { missDelayMs, missQueueCap } from "./config.ts";
import { logWarn, redactIp } from "./log.ts";

export interface TarpitOptions {
  /** Delay per queued miss, in ms. */
  delayMs?: number;
  /** Pending misses per IP before further ones are refused. */
  cap?: number;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
}

export interface Tarpit {
  /** True once the turn and delay elapse; false immediately at the pending cap (caller 429s). */
  enter(ip: string): Promise<boolean>;
  /** Misses currently queued for `ip`. */
  pending(ip: string): number;
  /** Number of IPs with a live queue (0 when everything has drained). */
  size(): number;
  /** Advisory `Retry-After`, in seconds. */
  retryAfterSeconds(): number;
  readonly delayMs: number;
  readonly cap: number;
}

interface QueueEntry {
  pending: number;
  /** Resolves when the last queued miss has finished waiting. */
  tail: Promise<void>;
}

const timerSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

export function createTarpit(options: TarpitOptions = {}): Tarpit {
  const delayMs = options.delayMs ?? missDelayMs();
  const cap = Math.max(1, options.cap ?? missQueueCap());
  const sleep = options.sleep ?? timerSleep;
  const queues = new Map<string, QueueEntry>();

  async function enter(ip: string): Promise<boolean> {
    const key = ip || "unknown";
    const existing = queues.get(key);
    if (existing && existing.pending >= cap) return false;

    const entry: QueueEntry = existing ?? { pending: 0, tail: Promise.resolve() };
    entry.pending += 1;
    if (!existing) queues.set(key, entry);

    // Our turn starts when the previous miss for this IP is done waiting.
    const turn = entry.tail.then(() => sleep(delayMs));
    entry.tail = turn.then(
      () => {},
      () => {},
    );

    try {
      await turn;
    } finally {
      entry.pending -= 1;
      // Drop the drained entry so the map stays bounded as scanners rotate addresses.
      if (entry.pending <= 0 && queues.get(key) === entry) queues.delete(key);
    }
    return true;
  }

  return {
    enter,
    pending: (ip: string) => queues.get(ip || "unknown")?.pending ?? 0,
    size: () => queues.size,
    retryAfterSeconds: () => Math.max(1, Math.ceil((cap * delayMs) / 1000)),
    delayMs,
    cap,
  };
}

/** The instance the HTTP layer uses. Configured by MISS_DELAY_MS / MISS_QUEUE_CAP. */
export const missTarpit: Tarpit = createTarpit();

// ---------------------------------------------------------------------------
// express glue
// ---------------------------------------------------------------------------

/** With `trust proxy` configured, already the rightmost untrusted X-Forwarded-For entry. */
export function clientIp(req: Request): string {
  return req.ip || req.socket.remoteAddress || "unknown";
}

function tooManyRequests(req: Request, res: Response): void {
  const ip = clientIp(req);
  // Address prefix only — never the path, whose first segment is a guessed slug.
  logWarn(
    `Tarpit refused a request from ${redactIp(ip)}: ${missTarpit.pending(ip)} misses already queued`,
  );
  res.status(429).set("Retry-After", String(missTarpit.retryAfterSeconds()));
  if (req.path.startsWith("/api")) {
    res.json({ error: "Too many requests" });
    return;
  }
  res.set("Content-Type", "text/plain; charset=utf-8").end("Too many requests");
}

/** Call only after resolution has actually failed — hits must never enter the queue. */
export async function tarpitMiss(
  req: Request,
  res: Response,
  send: () => void,
): Promise<void> {
  const allowed = await missTarpit.enter(clientIp(req));
  if (!allowed) {
    tooManyRequests(req, res);
    return;
  }
  // The client may have given up during the delay.
  if (res.writableEnded || res.destroyed) return;
  send();
}
