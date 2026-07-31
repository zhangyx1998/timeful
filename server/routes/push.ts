/**
 * Web Push endpoints: the global public key, and each event's subscriptions.
 *
 * `GET /api/push/public-key` is global because the VAPID pair is global —
 * one server, one signing identity, whatever event a browser subscribes from —
 * which is exactly the `/api` rule (ARCHITECTURE.md § API): global state lives
 * under `/api`, event state lives on the event's path. It is public because a
 * public key is public by definition and a respondent subscribing from an
 * event page has no session to show.
 *
 * `PUT`/`DELETE /<slug>/push` are event-scoped because a subscription is a
 * fact about one event: who to tell, and about what. Subscribing as the
 * **owner** requires the admin session on top of the URL; subscribing as a
 * **respondent** is public by the same contract as answering — the capability
 * URL is the boundary, and a subscription only ever causes notifications to
 * the browser that minted the keys in it. Unsubscribing needs no session in
 * either role: the endpoint being removed is itself a secret only the
 * subscribing browser ever held, so naming it is proof enough.
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
// Runtime, the same import the response routes make: a key claimed in a body
// is re-normalized exactly like a key in a path, so no caller can invent a
// second spelling of one person.
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

/**
 * The push service URL, as the browser handed it out. HTTPS only — a browser
 * never mints anything else — with plain HTTP allowed on loopback so that
 * development and the delivery tests do not need a certificate authority.
 * This is the one URL in the application the server will POST to that a
 * client chose, so the check is strict rather than polite.
 */
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

// GET /api/push/public-key — public. Minting on first ask is what "generated
// on first use" means; from then on the stored pair is the answer, because a
// subscription is bound to the key it was created against.
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
    // The owner's subscription is behind the login wall like every owner
    // tool: the capability URL says you may answer, not that you are the one
    // to be told when answers change.
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
    // The per-event ceiling (see subscriptions.ts). 429 rather than 400: the
    // request was well-formed, there is simply no room left.
    res.status(429).json({ error: "Too many subscriptions for this event" });
    return;
  }
  res.json({ ok: true });
}

// DELETE /<slug>/push — unsubscribe this browser, in one role. Idempotent:
// a subscription that was already pruned server-side is still a success.
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
