/**
 * Anti-scanning tarpit, scoped to MISSES only.
 *
 * A request whose event/slug resolution failed — or a failed auth attempt —
 * joins a serial per-IP queue: it waits `delayMs` before its 4xx, and the next
 * queued miss for that IP only starts waiting once this one is done. Enumerating
 * slugs therefore costs an attacker 100ms per guess per IP, while everyone who
 * hits a real event (or is an authed admin) is never touched. Guests sharing a
 * NAT is the normal case for group scheduling, so hits must never be queued.
 *
 * When an IP already has `cap` misses pending, further misses are refused
 * immediately with a 429 instead of growing the queue.
 */
import type { Request, Response } from "express";
import { missDelayMs, missQueueCap } from "./config.ts";

export interface TarpitOptions {
  /** Delay per queued miss, in ms. */
  delayMs?: number;
  /** Pending misses per IP before further ones are refused. */
  cap?: number;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
}

export interface Tarpit {
  /**
   * Joins the queue for `ip`. Resolves true once the caller's turn has come
   * and the delay has elapsed; resolves false immediately when the IP is at
   * its pending cap (caller should 429).
   */
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
      // Nothing left waiting: drop the entry so the map cannot grow without
      // bound as scanners rotate through addresses.
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

/**
 * The client address. With `trust proxy` configured this is already the
 * rightmost untrusted entry of `X-Forwarded-For`.
 */
export function clientIp(req: Request): string {
  return req.ip || req.socket.remoteAddress || "unknown";
}

function tooManyRequests(req: Request, res: Response): void {
  res.status(429).set("Retry-After", String(missTarpit.retryAfterSeconds()));
  if (req.path.startsWith("/api")) {
    res.json({ error: "Too many requests" });
    return;
  }
  res.set("Content-Type", "text/plain; charset=utf-8").end("Too many requests");
}

/**
 * Delays `send` by the caller's turn in its IP's miss queue, or answers 429
 * when that IP is already at the cap. Call this only after resolution has
 * actually failed — hits must never enter the queue.
 */
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
