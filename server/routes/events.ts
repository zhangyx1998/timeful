import crypto from "node:crypto";
import { Router } from "express";
import type { NextFunction, Request, Response } from "express";
import { requireAdmin } from "../auth.ts";
import { asRecord, BadRequest, jsonRoute, param } from "../http.ts";
import { claimSlug, releaseSlug } from "../links.ts";
import { dropEventLog } from "../log.ts";
import {
  notifyEventChanged,
  notifyEventDeleted,
  notifyResponsesChanged,
} from "../push/deliver.ts";
import { broadcastEvent, broadcastGone, closeRoom } from "../realtime.ts";
import { slugProblem } from "../slugs.ts";
import {
  deleteEvent,
  isUuid,
  listEventIds,
  readEvent,
  readLinks,
  updateEvent,
  writeEvent,
} from "../storage.ts";
import { tarpitMiss } from "../tarpit.ts";
import type {
  EventResponse,
  EventSummary,
  EventType,
  LastEdit,
  StoredEvent,
} from "../types.ts";
// Runtime: what a link-holder may see is one rule, and the page the server
// renders has to apply exactly the same one the JSON route does.
import { publicEvent, publicResponse } from "../../src/lib/event.ts";
// Runtime, like the slug rules: the identity dialog has to reject exactly what
// this rejects, in the same words (src/lib/user-key.ts).
import { guestNameProblem, userKey, userKeyFromParam } from "../../src/lib/user-key.ts";
import { RESERVED_SUBPATHS } from "../../src/lib/slug-rules.ts";

/**
 * The global half: `/api/events` list and create, and nothing else.
 *
 * Anything addressed *to one event* lives on the event's own path instead
 * (`eventScopedRouter`), because the event's URL is the capability and hanging
 * its endpoints off `/api` only ever hid that.
 */
export const eventsRouter = Router();

/**
 * The event-scoped half, mounted at the site root rather than under `/api`.
 *
 * `/<slug>` is the page; `/<slug>/data`, `/<slug>/settings` and
 * `/<slug>/users/<userKey>` are what you can do to it. `users`, `ws`, `data`
 * and `settings` are therefore reserved *sub*-segments — slugs themselves are
 * still single segments and unaffected.
 */
export const eventScopedRouter = Router();

const MAX_NAME_LENGTH = 200;
const MAX_DATES = 366;
const MAX_SLOTS = 20000;

// ---------------------------------------------------------------------------
// validation
// ---------------------------------------------------------------------------

function requireName(value: unknown): string {
  const name = typeof value === "string" ? value.trim() : "";
  if (!name) throw new BadRequest("Event name is required");
  if (name.length > MAX_NAME_LENGTH)
    throw new BadRequest(`Event name must be at most ${MAX_NAME_LENGTH} characters`);
  return name;
}

function requireType(value: unknown): EventType {
  if (value !== "specific_dates" && value !== "dow")
    throw new BadRequest("type must be 'specific_dates' or 'dow'");
  return value;
}

function isoOrNull(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) return null;
  return new Date(ms).toISOString();
}

/** Validates an array of ISO date strings, returning sorted unique ISO values. */
function requireIsoArray(value: unknown, field: string, max: number): string[] {
  if (!Array.isArray(value))
    throw new BadRequest(`${field} must be an array of ISO date strings`);
  if (value.length > max)
    throw new BadRequest(`${field} may contain at most ${max} entries`);
  const seen = new Set<string>();
  for (const entry of value) {
    const iso = isoOrNull(entry);
    if (!iso) throw new BadRequest(`${field} must be an array of ISO date strings`);
    seen.add(iso);
  }
  return [...seen].sort();
}

/** Same as `requireIsoArray`, but the list may not be empty. */
function requireDates(value: unknown): string[] {
  const dates = requireIsoArray(value, "dates", MAX_DATES);
  if (dates.length === 0) throw new BadRequest("dates must contain at least one date");
  return dates;
}

function requireDuration(value: unknown): number {
  const duration = Number(value);
  if (!Number.isFinite(duration) || duration <= 0 || duration > 24)
    throw new BadRequest("duration must be a number of hours between 0 and 24");
  return duration;
}

function requireTimeIncrement(value: unknown): number {
  const increment = Number(value);
  if (
    !Number.isInteger(increment) ||
    increment <= 0 ||
    increment > 240 ||
    1440 % increment !== 0
  )
    throw new BadRequest(
      "timeIncrement must be a whole number of minutes that divides a day",
    );
  return increment;
}

/**
 * The live-updates switch. Strict where `startOnMonday` coerces, on purpose:
 * this one decides whether a channel is served, and `Boolean("false")` being
 * true is not a mistake worth making about that.
 */
function requireRealtime(value: unknown): boolean {
  if (typeof value !== "boolean") throw new BadRequest("realtime must be true or false");
  return value;
}

/**
 * The key a `/<slug>/users/<userKey>` path segment addresses.
 *
 * Re-normalized rather than taken as given, so `Ada%20Lovelace` and
 * `ada-lovelace` are the same record and nobody can invent a second spelling
 * of one person by hand-writing a URL.
 */
function requireUserKey(raw: unknown): string {
  const key = userKeyFromParam(String(raw ?? ""));
  if (!key) throw new BadRequest("A guest key is required");
  return key;
}

/**
 * The name to show for a record, checked against the key it is being filed
 * under.
 *
 * The two must agree or the document stops meaning anything: display names are
 * what the page renders and keys are what it matches on, and a record whose
 * name does not normalize to its own key would appear twice or not at all.
 * That is also what stops a legacy display name containing a dash from being
 * written back — the grandfathered spelling is readable, not writable, and
 * saving under that key needs a legal name that maps to it.
 */
function requireDisplayName(value: unknown, key: string): string {
  if (typeof value !== "string") throw new BadRequest("A name is required");
  const problem = guestNameProblem(value);
  if (problem) throw new BadRequest(problem);
  const name = value.trim();
  if (userKey(name) !== key)
    throw new BadRequest("The name does not match the key in the path");
  return name;
}

// ---------------------------------------------------------------------------
// lookup helpers
// ---------------------------------------------------------------------------

/** Resolve an event by uuid or slug. Returns the event document or null. */
export async function resolveEvent(idOrSlug: string): Promise<StoredEvent | null> {
  if (isUuid(idOrSlug)) {
    const event = await readEvent(idOrSlug);
    if (event) return event;
  }
  const links = await readLinks();
  const id = links[idOrSlug];
  if (!id) return null;
  return readEvent(id);
}

function summarize(event: StoredEvent): EventSummary {
  return {
    id: event.id,
    slug: event.slug,
    name: event.name,
    type: event.type,
    responseCount: Object.keys(event.responses ?? {}).length,
    createdAt: event.createdAt,
    updatedAt: event.updatedAt,
  };
}

// ---------------------------------------------------------------------------
// route wrappers — the route table below says which misses are tarpitted
// ---------------------------------------------------------------------------

/** 404 for a public route whose event did not resolve — tarpitted. */
function eventMiss(req: Request, res: Response): Promise<void> {
  return tarpitMiss(req, res, () => {
    res.status(404).json({ error: "Event not found" });
  });
}

/** A handler that runs once `/:slug` has resolved to a stored event. */
type EventHandler = (
  req: Request,
  res: Response,
  event: StoredEvent,
) => Promise<void>;

/**
 * A public event route: mark it JSON, resolve `/:slug`, tarpit the miss.
 *
 * `jsonRoute` is the outermost layer on purpose, so `res.locals.jsonRoute` is
 * set synchronously on entry: a throw out of `resolveEvent` (a corrupt
 * `links.json`, say) must still answer JSON, not plain text — the error
 * middleware in app.ts reads that mark.
 */
function publicEventRoute(handler: EventHandler) {
  return jsonRoute(async (req: Request, res: Response): Promise<void> => {
    const event = await resolveEvent(param(req.params.slug));
    if (!event) {
      await eventMiss(req, res);
      return;
    }
    // For the error middleware: a failure past this point belongs to this
    // event, and the uuid is what tags its entry in the owner's log.
    res.locals.eventId = event.id;
    await handler(req, res, event);
  });
}

/**
 * An admin event route: the same resolution, but a miss answers immediately.
 *
 * Never tarpitted, for the reason no admin route ever is: the caller has
 * already authenticated, so a stale tab asking about a deleted event is a
 * mistake rather than a scan. `requireAdmin` stays a separate entry in the
 * route table, so an unauthenticated call on a known slug still answers 401
 * without revealing whether the event exists.
 */
function adminEventRoute(handler: EventHandler) {
  return jsonRoute(async (req: Request, res: Response): Promise<void> => {
    const event = await resolveEvent(param(req.params.slug));
    if (!event) {
      res.status(404).json({ error: "Event not found" });
      return;
    }
    res.locals.eventId = event.id;
    await handler(req, res, event);
  });
}

/**
 * A public route addressed to one guest record: `/:slug/users/:userKey`.
 *
 * The key validates BEFORE the slug resolves, and that order is load-bearing:
 * an illegal key is a fast 400 on the request's own merits. Resolve first and
 * an illegal key under an unknown slug turns into a tarpitted 404, while one
 * under a valid slug costs a links and event read before being refused.
 * Pinned by `user-key-order.test.ts`.
 */
function publicUserRoute(
  handler: (
    req: Request,
    res: Response,
    event: StoredEvent,
    key: string,
  ) => Promise<void>,
) {
  return jsonRoute(async (req: Request, res: Response): Promise<void> => {
    const key = requireUserKey(req.params.userKey);
    const event = await resolveEvent(param(req.params.slug));
    if (!event) {
      await eventMiss(req, res);
      return;
    }
    res.locals.eventId = event.id;
    await handler(req, res, event, key);
  });
}

// ---------------------------------------------------------------------------
// admin routes
// ---------------------------------------------------------------------------

// GET /api/events — admin
async function listEvents(_req: Request, res: Response): Promise<void> {
  const ids = await listEventIds();
  const events = (await Promise.all(ids.map((id) => readEvent(id))))
    .filter((event): event is StoredEvent => event !== null)
    .map(summarize)
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  res.json(events);
}

// POST /api/events — admin
async function createEvent(req: Request, res: Response): Promise<void> {
  const body = asRecord(req.body);
  const name = requireName(body.name);
  const type = requireType(body.type);
  const dates = requireDates(body.dates);
  const duration = requireDuration(body.duration);
  const timeIncrement = requireTimeIncrement(body.timeIncrement);
  const startOnMonday = Boolean(body.startOnMonday);
  // Written out even though it matches the default, so the file says what it
  // does; an older file that omits it still reads as on.
  const realtime = body.realtime === undefined ? true : requireRealtime(body.realtime);

  const explicitSlug =
    body.slug !== undefined && body.slug !== null && body.slug !== "";
  // No custom path means a capability URL: SLUG_LENGTH random base62 chars.
  const desired = explicitSlug ? String(body.slug).trim() : null;
  if (desired !== null) {
    const problem = slugProblem(desired);
    if (problem) throw new BadRequest(problem);
  }

  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  const slug = await claimSlug(desired, id);

  const event: StoredEvent = {
    id,
    slug,
    name,
    type,
    dates,
    duration,
    timeIncrement,
    startOnMonday,
    realtime,
    createdAt: now,
    updatedAt: now,
    responses: {},
  };

  try {
    await writeEvent(event);
  } catch (err) {
    await releaseSlug(slug, id);
    throw err;
  }

  res.status(201).json(event);
}

// PATCH /<slug>/settings — admin. The segment may be the uuid or the slug.
async function patchEvent(
  req: Request,
  res: Response,
  existing: StoredEvent,
): Promise<void> {
  const body = asRecord(req.body);
  const patch: Partial<StoredEvent> = {};

  if (body.name !== undefined) patch.name = requireName(body.name);
  if (body.type !== undefined) patch.type = requireType(body.type);
  if (body.dates !== undefined) patch.dates = requireDates(body.dates);
  if (body.duration !== undefined) patch.duration = requireDuration(body.duration);
  if (body.timeIncrement !== undefined)
    patch.timeIncrement = requireTimeIncrement(body.timeIncrement);
  if (body.startOnMonday !== undefined)
    patch.startOnMonday = Boolean(body.startOnMonday);
  if (body.realtime !== undefined) patch.realtime = requireRealtime(body.realtime);

  let nextSlug = existing.slug;
  if (body.slug !== undefined) {
    nextSlug = String(body.slug ?? "").trim();
    const problem = slugProblem(nextSlug);
    if (problem) throw new BadRequest(problem);
  }

  // Only when the slug actually changes: a PATCH that merely flips a setting
  // must not take the links lock, rewrite links.json through the serialised
  // atomic write, or consume a lease on its own unchanged slug.
  if (nextSlug !== existing.slug) {
    await claimSlug(nextSlug, existing.id, existing.slug);
    patch.slug = nextSlug;
  }

  const updated = await updateEvent(existing.id, (current) => ({
    ...current,
    ...patch,
    updatedAt: new Date().toISOString(),
  }));
  if (!updated) {
    res.status(404).json({ error: "Event not found" });
    return;
  }
  // Respondents subscribed to hear when the plan itself moves: the name, the
  // days, the window, the slot size — or the URL, which invalidates the link
  // they saved. A PATCH that only touched `realtime`, or restated what was
  // already there, moved nothing and says nothing.
  const meaningful = (Object.keys(patch) as (keyof StoredEvent)[]).some(
    (field) =>
      field !== "realtime" &&
      JSON.stringify(patch[field]) !== JSON.stringify(existing[field]),
  );
  if (meaningful) notifyEventChanged(existing.id);
  // Subscribers get the whole new document, the renamed slug included: a page
  // watching this event corrects its own address bar off the snapshot. A no-op
  // when this same PATCH just switched live updates off.
  broadcastEvent(updated);
  // Switched off: hang up on whoever is still watching. Not `gone` — the event
  // is very much still there, and still answerable over REST. They will try to
  // reconnect, be refused, and give up.
  if (!updated.realtime) closeRoom(updated.id);
  // Stripped even though the caller is the owner: the page feeds this straight
  // back into the document it is rendering from, and there is exactly one way
  // to read an origin — the details route.
  res.json(publicEvent(updated));
}

// DELETE /<slug>/settings — admin. The segment may be the uuid or the slug.
async function deleteEventRoute(
  _req: Request,
  res: Response,
  existing: StoredEvent,
): Promise<void> {
  await releaseSlug(existing.slug, existing.id);
  await deleteEvent(existing.id);
  // Only once it is actually gone from disk; the room is closed with it.
  broadcastGone(existing.id);
  // And so is its log buffer: a log for a document that no longer exists is
  // not history, and any open log viewer is told the stream is over.
  dropEventLog(existing.id);
  // Told immediately — there is nothing left to coalesce with — and the
  // event's subscriptions are dropped once the notice has gone out.
  notifyEventDeleted(existing);
  res.json({ ok: true });
}

// ---------------------------------------------------------------------------
// public routes
// ---------------------------------------------------------------------------

/**
 * GET /<slug>/data — public: the whole event document.
 *
 * This is what the event page reads, and what a realtime snapshot is a copy
 * of. The segment may be the uuid or the slug.
 */
async function getEventData(
  _req: Request,
  res: Response,
  event: StoredEvent,
): Promise<void> {
  res.json(publicEvent(event));
}

/**
 * GET /<slug>/details — admin: where each answer was last written from.
 *
 * The login wall, and the only route that serves `lastEdit`. Everything else
 * about an event is public to whoever holds the link, so this route exists for
 * exactly the one field that is not — which is also why it answers `401`
 * rather than pretending the sub-path is unknown: an owner who is signed out
 * should be told to sign in, not told the event is missing.
 *
 * Not tarpitted, for the reason no admin route ever is: the caller has already
 * authenticated, so a stale tab asking about a deleted event is a mistake
 * rather than a scan.
 */
async function getEventDetails(
  _req: Request,
  res: Response,
  event: StoredEvent,
): Promise<void> {
  const users = Object.entries(event.responses ?? {})
    .map(([key, response]) => ({
      key,
      displayName: response?.displayName || key,
      // Explicitly null rather than absent: a record written before tracking
      // existed has no origin, and the panel has to say so rather than
      // rendering an empty row that looks like a failure to load.
      lastEdit: response?.lastEdit ?? null,
    }))
    .sort((a, b) => a.displayName.localeCompare(b.displayName) || a.key.localeCompare(b.key));
  res.json({ users });
}

/**
 * Removes a guest's record from an event, under the event's file lock.
 * Resolves to false when the event vanished mid-request; a key that was not
 * there is a successful no-op.
 *
 * `event` is the document as it stands afterwards — unchanged when nothing was
 * removed — which is what the caller broadcasts to the event's subscribers.
 */
async function dropResponse(
  id: string,
  key: string,
): Promise<{ ok: boolean; removed: boolean; event: StoredEvent | null }> {
  let removed = false;
  const updated = await updateEvent(id, (current) => {
    if (!current.responses?.[key]) return undefined;
    removed = true;
    delete current.responses[key];
    current.updatedAt = new Date().toISOString();
    return current;
  });
  return { ok: updated !== null, removed, event: updated };
}

/** What a save carries, however it arrived: a REST body or a socket frame. */
export interface ResponseInput {
  displayName?: unknown;
  availability?: unknown;
  ifNeeded?: unknown;
}

/**
 * Where a save came from, as the transport that carried it saw it.
 *
 * Supplied by the caller rather than derived here, because the two callers see
 * it differently: the `PUT` reads `req.ip` and the request's own headers, while
 * a write session has no request at all by the time a frame arrives and uses
 * what was captured when the socket was upgraded. Neither is trusted for
 * anything — it is a note in the owner's log, not an identity.
 */
export interface EditOrigin {
  ip: string;
  userAgent: string;
}

const MAX_USER_AGENT_LENGTH = 400;

/** The origin of one save, stamped with the instant it landed. */
function lastEditFrom(origin: EditOrigin | null, at: string): LastEdit | undefined {
  if (!origin) return undefined;
  return {
    ip: origin.ip,
    // The same cap a session record puts on a user agent: a header is whatever
    // the client felt like sending, and an event file is not a place to keep
    // several kilobytes of it.
    userAgent: origin.userAgent.slice(0, MAX_USER_AGENT_LENGTH),
    at,
  };
}

/** The header, as a plain string, however Node handed it over. */
export function userAgentOf(headers: { "user-agent"?: string | string[] }): string {
  const raw = headers["user-agent"];
  if (Array.isArray(raw)) return raw[0] ?? "";
  return raw ?? "";
}

export interface ResponseWrite {
  /** False when the event vanished between resolving it and writing. */
  ok: boolean;
  /** The record as stored, or null when the save cleared it away. */
  response: EventResponse | null;
  /** The document afterwards, for the caller to broadcast. */
  event: StoredEvent | null;
  /** Whether anything actually changed; a clear that cleared nothing did not. */
  changed: boolean;
}

/**
 * Validates and applies one guest's answer. **The only write path there is.**
 *
 * Both the REST `PUT` and a `save` frame on a named write session come through
 * here, which is what makes "validated exactly like the REST PUT" a fact about
 * the code rather than a promise about it: there is one validator, one
 * zero-record rule and one place the document is touched. Throws `BadRequest`
 * on anything malformed — the callers differ only in what they do with that.
 */
export async function writeResponse(
  eventId: string,
  key: string,
  input: ResponseInput,
  origin: EditOrigin | null = null,
): Promise<ResponseWrite> {
  const displayName = requireDisplayName(input.displayName, key);
  const availability = requireIsoArray(
    input.availability ?? [],
    "availability",
    MAX_SLOTS,
  );
  const ifNeededRaw = requireIsoArray(input.ifNeeded ?? [], "ifNeeded", MAX_SLOTS);
  // availability and ifNeeded are mutually exclusive; availability wins.
  const available = new Set(availability);
  const ifNeeded = ifNeededRaw.filter((iso) => !available.has(iso));

  // Zero-record invariant (ARCHITECTURE.md § API): an answer with nothing in
  // it is not an answer. Clearing the grid takes the guest off the event
  // instead of leaving a hollow record behind for the respondents list and the
  // heatmap to count. Autosave sends the whole state on every edit, so this is
  // the path a guest's "Clear" takes — and it has to be a no-op when they were
  // never on the list.
  if (availability.length === 0 && ifNeeded.length === 0) {
    const { ok, removed, event } = await dropResponse(eventId, key);
    // Clearing an answer is a change the owner asked to hear about; a clear
    // that cleared nothing is not. Fire-and-forget, like the broadcast.
    if (removed) notifyResponsesChanged(eventId, displayName);
    return { ok, response: null, event, changed: removed };
  }

  const now = new Date().toISOString();
  // Overwritten on every write, never merged with what was there: the field
  // says where this answer was last edited from, and a stale half of it would
  // be a worse answer than none.
  const lastEdit = lastEditFrom(origin, now);
  const response: EventResponse = {
    displayName,
    availability,
    ifNeeded,
    updatedAt: now,
    ...(lastEdit ? { lastEdit } : {}),
  };
  const updated = await updateEvent(eventId, (current) => {
    current.responses ??= {};
    current.responses[key] = response;
    current.updatedAt = now;
    return current;
  });
  // In here rather than in the routes, for the same reason the validator is:
  // this is the only write path, so the REST PUT and a realtime save frame
  // trigger the owner's notification identically. Scheduling only — delivery
  // is coalesced and queued in push/deliver.ts and can neither block nor fail
  // this request.
  if (updated) notifyResponsesChanged(eventId, displayName);
  return {
    ok: updated !== null,
    response: updated ? response : null,
    event: updated,
    changed: updated !== null,
  };
}

/**
 * PUT /<slug>/users/<userKey> — public guest autosave.
 *
 * Public by contract (ARCHITECTURE.md § API): the capability URL is the auth
 * boundary, so anyone who can read the event can already answer it.
 */
async function putResponse(
  req: Request,
  res: Response,
  existing: StoredEvent,
  key: string,
): Promise<void> {
  const body = asRecord(req.body);
  const { ok, response, event, changed } = await writeResponse(existing.id, key, body, {
    // Trust-proxy-aware by construction: `req.ip` is the rightmost forwarded
    // entry no trusted peer vouched for (ARCHITECTURE.md § Trusted proxies).
    ip: req.ip ?? "",
    userAgent: userAgentOf(req.headers),
  });
  if (!ok) {
    await eventMiss(req, res);
    return;
  }
  // A room should only ever be woken for something that actually happened.
  if (changed && event) broadcastEvent(event);
  // The record goes back to the guest who just wrote it, and this route is
  // public: the origin it was just stamped with is not theirs to read back.
  res.json({ ok: true, key, response: response && publicResponse(response) });
}

/**
 * DELETE /<slug>/users/<userKey> — public.
 *
 * The admin's per-respondent delete on the event page uses this same endpoint;
 * gating it would only hide a door already open to everyone holding the link.
 */
async function deleteResponse(
  req: Request,
  res: Response,
  existing: StoredEvent,
  key: string,
): Promise<void> {
  const { ok, removed, event } = await dropResponse(existing.id, key);
  if (!ok) {
    await eventMiss(req, res);
    return;
  }
  if (!removed) {
    res.status(404).json({ error: "Response not found" });
    return;
  }
  if (event) broadcastEvent(event);
  // The name as the event knew it — the deleter typed nothing.
  notifyResponsesChanged(
    existing.id,
    existing.responses?.[key]?.displayName ?? key,
  );
  res.json({ ok: true });
}

/**
 * Anything else under `/<slug>/…`, any method.
 *
 * Only the reserved **API** sub-segments are this router's to answer: those
 * callers are API clients and get JSON — an unresolvable first segment is a
 * scan and is [tarpitted](../tarpit.ts) first, while a *resolvable* one has
 * proven it holds the capability URL and gets its 404 at once. That includes
 * a reserved segment with extra path on it (`/<slug>/data/x`): it stays an
 * API miss, deliberately, rather than becoming a page.
 *
 * Every other multi-segment path is **page territory** and falls through to
 * the SSR handler behind this router, which serves the canonical shapes,
 * 302-redirects everything else under a resolving slug to the event root, and
 * tarpits unknown slugs exactly as the bare `/<slug>` always was
 * (`event-routes.ts` owns the classification).
 *
 * Registered last, so the real sub-paths always win. A plain `GET /<slug>/ws`
 * or `GET /<slug>/users/<key>` lands here too: those are WebSocket upgrades,
 * they never reach Express, and a non-upgrade request for them is not a route.
 */
async function eventScopedCatchAll(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  if (!RESERVED_SUBPATHS.has(req.path.split("/")[2] ?? "")) {
    next();
    return;
  }
  res.locals.jsonRoute = true;
  const event = await resolveEvent(param(req.params.slug));
  if (!event) {
    await tarpitMiss(req, res, () => {
      res.status(404).json({ error: "Event not found" });
    });
    return;
  }
  res.status(404).json({ error: "Not found" });
}

// ---------------------------------------------------------------------------
// the route table
// ---------------------------------------------------------------------------

// Global: the list and the create, admin-only, and nothing event-scoped.
eventsRouter.get("/events", requireAdmin, listEvents);
eventsRouter.post("/events", requireAdmin, createEvent);

// Event-scoped, mounted at the root. `/<slug>` itself is the page and is not
// here: it belongs to the SSR handler in app.ts. The wrapper names say who a
// miss answers to: `publicEventRoute`/`publicUserRoute` tarpit it,
// `adminEventRoute` (always behind `requireAdmin`) answers at once.
eventScopedRouter.get("/:slug/data", publicEventRoute(getEventData));
eventScopedRouter.get("/:slug/details", requireAdmin, adminEventRoute(getEventDetails));
eventScopedRouter.patch("/:slug/settings", requireAdmin, adminEventRoute(patchEvent));
eventScopedRouter.delete("/:slug/settings", requireAdmin, adminEventRoute(deleteEventRoute));
eventScopedRouter.put("/:slug/users/:userKey", publicUserRoute(putResponse));
eventScopedRouter.delete("/:slug/users/:userKey", publicUserRoute(deleteResponse));
// Not wrapped in `jsonRoute`: it decides for itself, because most of what
// reaches it is a browser rather than an API client.
eventScopedRouter.all("/:slug/{*rest}", eventScopedCatchAll);
