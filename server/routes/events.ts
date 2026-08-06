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
// Runtime imports: one strip rule and one key rule, shared with the client.
import { publicEvent, publicResponse } from "../../src/lib/event.ts";
import { guestNameProblem, userKey, userKeyFromParam } from "../../src/lib/user-key.ts";
import { RESERVED_SUBPATHS } from "../../src/lib/slug-rules.ts";

/** The global half: `/api/events` list and create, and nothing else. */
export const eventsRouter = Router();

/** The event-scoped half, mounted at the site root; `users`, `ws`, `data`, `settings` are reserved sub-segments. */
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

/** Strict where `startOnMonday` coerces, on purpose: `Boolean("false")` is true. */
function requireRealtime(value: unknown): boolean {
  if (typeof value !== "boolean") throw new BadRequest("realtime must be true or false");
  return value;
}

/** Re-normalized so nobody can invent a second spelling of one person by hand-writing a URL. */
function requireUserKey(raw: unknown): string {
  const key = userKeyFromParam(String(raw ?? ""));
  if (!key) throw new BadRequest("A guest key is required");
  return key;
}

/** The name must normalize to the key it is filed under, or the record would appear twice or not at all. */
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

/** Mark JSON, resolve `/:slug`, tarpit the miss. `jsonRoute` outermost, on purpose: a throw out of `resolveEvent` must still answer JSON. */
function publicEventRoute(handler: EventHandler) {
  return jsonRoute(async (req: Request, res: Response): Promise<void> => {
    const event = await resolveEvent(param(req.params.slug));
    if (!event) {
      await eventMiss(req, res);
      return;
    }
    // For the error middleware: the uuid tags this event's log entry.
    res.locals.eventId = event.id;
    await handler(req, res, event);
  });
}

/**
 * Never tarpitted — the caller already authenticated. `requireAdmin` stays a
 * separate route-table entry so an unauthenticated call on a known slug
 * answers 401 without revealing whether the event exists.
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

/** The key validates BEFORE the slug resolves — load-bearing order, pinned by `user-key-order.test.ts`. */
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
  // Written out even though it matches the default; an older file that omits it reads as on.
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

  // Only when the slug actually changes: a plain PATCH must not take the links lock or consume a lease.
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
  // A PATCH that only touched `realtime`, or restated what was there, says nothing.
  const meaningful = (Object.keys(patch) as (keyof StoredEvent)[]).some(
    (field) =>
      field !== "realtime" &&
      JSON.stringify(patch[field]) !== JSON.stringify(existing[field]),
  );
  if (meaningful) notifyEventChanged(existing.id);
  // The snapshot includes a renamed slug; a watching page corrects its own address bar.
  broadcastEvent(updated);
  // Not `gone` — the event still exists and still answers over REST.
  if (!updated.realtime) closeRoom(updated.id);
  // Stripped even for the owner: the page feeds this back into the document it renders.
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
  dropEventLog(existing.id);
  notifyEventDeleted(existing);
  res.json({ ok: true });
}

// ---------------------------------------------------------------------------
// public routes
// ---------------------------------------------------------------------------

/** GET /<slug>/data — public: the whole event document (uuid or slug). */
async function getEventData(
  _req: Request,
  res: Response,
  event: StoredEvent,
): Promise<void> {
  res.json(publicEvent(event));
}

/** GET /<slug>/details — admin, the only route serving `lastEdit`; answers 401 rather than hiding the sub-path. */
async function getEventDetails(
  _req: Request,
  res: Response,
  event: StoredEvent,
): Promise<void> {
  const users = Object.entries(event.responses ?? {})
    .map(([key, response]) => ({
      key,
      displayName: response?.displayName || key,
      // Explicitly null: a pre-tracking record has no origin, and the panel must say so.
      lastEdit: response?.lastEdit ?? null,
    }))
    .sort((a, b) => a.displayName.localeCompare(b.displayName) || a.key.localeCompare(b.key));
  res.json({ users });
}

/** Removes under the file lock; `ok` false when the event vanished; a missing key is a successful no-op. */
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

/** Supplied by the caller: the PUT reads the request, a socket frame uses what the upgrade captured. A log note, not an identity. */
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
    // The same cap a session record puts on a user agent.
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

/** The only write path: the REST `PUT` and a realtime save share this one validator and zero-record rule. Throws `BadRequest`. */
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

  // Zero-record invariant (ARCHITECTURE.md § API): clearing the grid removes the guest; a no-op when they were never on the list.
  if (availability.length === 0 && ifNeeded.length === 0) {
    const { ok, removed, event } = await dropResponse(eventId, key);
    // A clear that cleared nothing is not a change the owner hears about.
    if (removed) notifyResponsesChanged(eventId, displayName);
    return { ok, response: null, event, changed: removed };
  }

  const now = new Date().toISOString();
  // Overwritten, never merged: a stale half would be worse than none.
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
  // In the one write path so both callers notify identically; scheduling only — delivery can neither block nor fail this request.
  if (updated) notifyResponsesChanged(eventId, displayName);
  return {
    ok: updated !== null,
    response: updated ? response : null,
    event: updated,
    changed: updated !== null,
  };
}

/** PUT /<slug>/users/<userKey> — public by contract (ARCHITECTURE.md § API): the URL is the auth boundary. */
async function putResponse(
  req: Request,
  res: Response,
  existing: StoredEvent,
  key: string,
): Promise<void> {
  const body = asRecord(req.body);
  const { ok, response, event, changed } = await writeResponse(existing.id, key, body, {
    // Trust-proxy-aware by construction (ARCHITECTURE.md § Trusted proxies).
    ip: req.ip ?? "",
    userAgent: userAgentOf(req.headers),
  });
  if (!ok) {
    await eventMiss(req, res);
    return;
  }
  // A room should only ever be woken for something that actually happened.
  if (changed && event) broadcastEvent(event);
  // Public route: the origin just stamped is not the guest's to read back.
  res.json({ ok: true, key, response: response && publicResponse(response) });
}

/** DELETE /<slug>/users/<userKey> — public: gating would only hide a door already open to link-holders. */
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
 * Reserved API sub-segments answer JSON here (tarpitted when the slug misses);
 * every other multi-segment path is page territory and falls through to SSR.
 * Registered last, so the real sub-paths always win.
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

// `/<slug>` itself belongs to the SSR handler in app.ts. The public* wrappers
// tarpit a miss; `adminEventRoute` (always behind `requireAdmin`) answers at once.
eventScopedRouter.get("/:slug/data", publicEventRoute(getEventData));
eventScopedRouter.get("/:slug/details", requireAdmin, adminEventRoute(getEventDetails));
eventScopedRouter.patch("/:slug/settings", requireAdmin, adminEventRoute(patchEvent));
eventScopedRouter.delete("/:slug/settings", requireAdmin, adminEventRoute(deleteEventRoute));
eventScopedRouter.put("/:slug/users/:userKey", publicUserRoute(putResponse));
eventScopedRouter.delete("/:slug/users/:userKey", publicUserRoute(deleteResponse));
// Not wrapped in `jsonRoute`: it decides for itself.
eventScopedRouter.all("/:slug/{*rest}", eventScopedCatchAll);
