/**
 * Web Push endpoints. The public key is global (ARCHITECTURE.md § API);
 * subscriptions are event-scoped. Owner subscribe needs the admin session;
 * respondent subscribe is public like answering. Unsubscribe needs no session:
 * the endpoint itself is a secret only the subscribing browser ever held.
 */
import { Router } from "express";
import type { Request, Response } from "express";
import { loadSession } from "../auth.ts";
import { asRecord, BadRequest, jsonRoute, param } from "../http.ts";
import { fromBase64Url, isP256Point, AUTH_SECRET_LENGTH } from "../push/crypto.ts";
import { ensureVapidKeys } from "../push/vapid.ts";
import {
  removeSubscription,
  saveSubscription,
} from "../push/subscriptions.ts";
import { tarpitMiss } from "../tarpit.ts";
import type { PushRole, PushSubscriptionKeys, StoredEvent } from "../types.ts";
// Runtime: a key claimed in a body is re-normalized exactly like a key in a path.
import { userKeyFromParam } from "../../src/lib/user-key.ts";
import { resolveEvent } from "./events.ts";

/** The global half: the public key, and nothing else. */
export const pushRouter = Router();

/** The event-scoped half, mounted at the root ahead of the event router. */
export const pushScopedRouter = Router();

// ---------------------------------------------------------------------------
// validation
// ---------------------------------------------------------------------------

/** Endpoint URLs a subscription may carry — never logged, so refused quietly. */
const MAX_ENDPOINT_LENGTH = 2048;

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/** HTTPS only (plain HTTP on loopback for dev/tests): the one client-chosen URL the server POSTs to, so strict. */
function requireEndpoint(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > MAX_ENDPOINT_LENGTH)
    throw new BadRequest("A push endpoint URL is required");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new BadRequest("The push endpoint must be a valid URL");
  }
  const loopback = LOOPBACK_HOSTS.has(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))
    throw new BadRequest("The push endpoint must be an https URL");
  return value;
}

/** The browser's per-subscription key pair, decoded to prove its shape. */
function requireSubscriptionKeys(value: unknown): PushSubscriptionKeys {
  const keys = asRecord(value);
  const p256dh = typeof keys.p256dh === "string" ? keys.p256dh : "";
  const auth = typeof keys.auth === "string" ? keys.auth : "";
  const point = fromBase64Url(p256dh);
  if (!point || !isP256Point(point))
    throw new BadRequest("keys.p256dh must be a base64url P-256 public key");
  const secret = fromBase64Url(auth);
  if (!secret || secret.length !== AUTH_SECRET_LENGTH)
    throw new BadRequest("keys.auth must be 16 base64url bytes");
  return { p256dh, auth };
}

function requireRole(value: unknown): PushRole {
  if (value !== "owner" && value !== "respondent")
    throw new BadRequest("role must be 'owner' or 'respondent'");
  return value;
}

// ---------------------------------------------------------------------------
// routes
// ---------------------------------------------------------------------------

// GET /api/push/public-key — public; minted on first ask, then the stored pair is the answer.
pushRouter.get("/push/public-key", async (_req: Request, res: Response) => {
  const record = await ensureVapidKeys();
  res.json({ key: record.publicKey });
});

/** The same resolve-or-tarpit shape the public event routes use. */
function pushEventRoute(
  handler: (req: Request, res: Response, event: StoredEvent) => Promise<void>,
) {
  return jsonRoute(async (req: Request, res: Response): Promise<void> => {
    const event = await resolveEvent(param(req.params.slug));
    if (!event) {
      await tarpitMiss(req, res, () => {
        res.status(404).json({ error: "Event not found" });
      });
      return;
    }
    await handler(req, res, event);
  });
}

// PUT /<slug>/push — subscribe this browser, in one role.
async function putSubscription(
  req: Request,
  res: Response,
  event: StoredEvent,
): Promise<void> {
  const body = asRecord(req.body);
  const role = requireRole(body.role);
  const endpoint = requireEndpoint(body.endpoint);
  const keys = requireSubscriptionKeys(body.keys);

  let userKey: string | undefined;
  if (role === "owner") {
    // Owner subscriptions sit behind the login wall like every owner tool.
    if (!(await loadSession(req))) {
      res.status(401).json({ error: "Not authenticated" });
      return;
    }
    if (body.userKey !== undefined)
      throw new BadRequest("An owner subscription does not carry a user key");
  } else {
    const key = userKeyFromParam(String(body.userKey ?? ""));
    if (!key) throw new BadRequest("A guest key is required");
    userKey = key;
  }

  const saved = await saveSubscription({
    eventId: event.id,
    role,
    ...(userKey === undefined ? {} : { userKey }),
    endpoint,
    keys,
    createdAt: new Date().toISOString(),
  });
  if (!saved) {
    // The per-event ceiling; 429 — the request was well-formed, there is simply no room.
    res.status(429).json({ error: "Too many subscriptions for this event" });
    return;
  }
  res.json({ ok: true });
}

// DELETE /<slug>/push — unsubscribe this browser, in one role. Idempotent.
async function deleteSubscription(
  req: Request,
  res: Response,
  event: StoredEvent,
): Promise<void> {
  const body = asRecord(req.body);
  const role = requireRole(body.role);
  const endpoint = requireEndpoint(body.endpoint);
  await removeSubscription(event.id, role, endpoint);
  res.json({ ok: true });
}

pushScopedRouter.put("/:slug/push", pushEventRoute(putSubscription));
pushScopedRouter.delete("/:slug/push", pushEventRoute(deleteSubscription));
