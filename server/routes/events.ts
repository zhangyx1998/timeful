import crypto from "node:crypto";
import { Router } from "express";
import type { Request, Response } from "express";
import { requireAdmin } from "../auth.ts";
import { asRecord, BadRequest, param } from "../http.ts";
import { consumeLease, isLeased } from "../leases.ts";
import { broadcastEvent, broadcastGone } from "../realtime.ts";
import { randomSlug, slugProblem } from "../slugs.ts";
import {
  deleteEvent,
  isUuid,
  listEventIds,
  readEvent,
  readLinks,
  updateEvent,
  updateLinks,
  writeEvent,
} from "../storage.ts";
import { tarpitMiss } from "../tarpit.ts";
import type { EventSummary, EventType, LinksMap, StoredEvent } from "../types.ts";

export const eventsRouter = Router();

const MAX_NAME_LENGTH = 200;
const MAX_GUEST_NAME_LENGTH = 100;
const MAX_DATES = 366;
const MAX_SLOTS = 20000;

// ---------------------------------------------------------------------------
// slugs
// ---------------------------------------------------------------------------

/** True when the slug is spoken for: a stored link, or a live lease. */
export function slugTaken(slug: string, links: LinksMap): boolean {
  return Boolean(links[slug]) || isLeased(slug);
}

/** A random capability slug that collides with neither links nor leases. */
function freeRandomSlug(links: LinksMap): string {
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const candidate = randomSlug();
    if (!slugTaken(candidate, links)) return candidate;
  }
  // 62^SLUG_LENGTH candidates: only a broken RNG gets here.
  throw new BadRequest("Could not allocate a free slug", 503);
}

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

function guestName(raw: unknown): string {
  const name = String(raw ?? "").trim();
  if (!name) throw new BadRequest("Guest name is required");
  if (name.length > MAX_GUEST_NAME_LENGTH)
    throw new BadRequest(
      `Guest name must be at most ${MAX_GUEST_NAME_LENGTH} characters`,
    );
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
// admin routes
// ---------------------------------------------------------------------------

// GET /api/events
eventsRouter.get("/events", requireAdmin, async (_req, res) => {
  const ids = await listEventIds();
  const events = (await Promise.all(ids.map((id) => readEvent(id))))
    .filter((event): event is StoredEvent => event !== null)
    .map(summarize)
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  res.json(events);
});

// POST /api/events
eventsRouter.post("/events", requireAdmin, async (req, res) => {
  const body = asRecord(req.body);
  const name = requireName(body.name);
  const type = requireType(body.type);
  const dates = requireDates(body.dates);
  const duration = requireDuration(body.duration);
  const timeIncrement = requireTimeIncrement(body.timeIncrement);
  const startOnMonday = Boolean(body.startOnMonday);

  const explicitSlug =
    body.slug !== undefined && body.slug !== null && body.slug !== "";
  // No custom path means a capability URL: SLUG_LENGTH random base62 chars.
  let slug = explicitSlug ? String(body.slug).trim() : "";
  if (explicitSlug) {
    const problem = slugProblem(slug);
    if (problem) throw new BadRequest(problem);
  }

  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  // Claim the slug under the links lock so two concurrent creates cannot
  // both win the same path.
  let conflict = false;
  await updateLinks((links) => {
    if (!explicitSlug) slug = freeRandomSlug(links);
    if (links[slug]) {
      conflict = true;
      return undefined;
    }
    // A live lease on this exact slug is this admin's own reservation:
    // creating the event consumes it.
    consumeLease(slug);
    links[slug] = id;
    return links;
  });
  if (conflict) throw new BadRequest("Slug is already taken", 409);

  const event: StoredEvent = {
    id,
    slug,
    name,
    type,
    dates,
    duration,
    timeIncrement,
    startOnMonday,
    createdAt: now,
    updatedAt: now,
    responses: {},
  };

  try {
    await writeEvent(event);
  } catch (err) {
    await updateLinks((links) => {
      if (links[slug] !== id) return undefined;
      delete links[slug];
      return links;
    });
    throw err;
  }

  res.status(201).json(event);
});

// PATCH /api/events/:id
eventsRouter.patch("/events/:id", requireAdmin, async (req, res) => {
  const id = param(req.params.id);
  const existing = await readEvent(id);
  if (!existing) {
    res.status(404).json({ error: "Event not found" });
    return;
  }
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

  let nextSlug = existing.slug;
  if (body.slug !== undefined) {
    nextSlug = String(body.slug ?? "").trim();
    const problem = slugProblem(nextSlug);
    if (problem) throw new BadRequest(problem);
  }

  if (nextSlug !== existing.slug) {
    let conflict = false;
    await updateLinks((links) => {
      if (links[nextSlug] && links[nextSlug] !== existing.id) {
        conflict = true;
        return undefined;
      }
      // A live lease on this exact slug is this admin's own reservation, and a
      // rename claims it the same way a create does. Blocking on it instead was
      // an asymmetry with no reason behind it: the edit form can now reserve a
      // fresh random link too, so the only lease a rename ever meets is the one
      // the form took a moment ago for this very rename.
      consumeLease(nextSlug);
      if (links[existing.slug] === existing.id) delete links[existing.slug];
      links[nextSlug] = existing.id;
      return links;
    });
    if (conflict) throw new BadRequest("Slug is already taken", 409);
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
  // Subscribers get the whole new document, the renamed slug included: a page
  // watching this event corrects its own address bar off the snapshot.
  broadcastEvent(updated);
  res.json(updated);
});

// DELETE /api/events/:id
eventsRouter.delete("/events/:id", requireAdmin, async (req, res) => {
  const id = param(req.params.id);
  const existing = await readEvent(id);
  if (!existing) {
    res.status(404).json({ error: "Event not found" });
    return;
  }
  await updateLinks((links) => {
    if (links[existing.slug] !== existing.id) return undefined;
    delete links[existing.slug];
    return links;
  });
  await deleteEvent(existing.id);
  // Only once it is actually gone from disk; the room is closed with it.
  broadcastGone(existing.id);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// public routes
// ---------------------------------------------------------------------------

/** 404 for a public route whose event did not resolve — tarpitted. */
function eventMiss(req: Request, res: Response): Promise<void> {
  return tarpitMiss(req, res, () => {
    res.status(404).json({ error: "Event not found" });
  });
}

// GET /api/events/:idOrSlug — public
eventsRouter.get("/events/:idOrSlug", async (req, res) => {
  const event = await resolveEvent(param(req.params.idOrSlug));
  if (!event) {
    await eventMiss(req, res);
    return;
  }
  res.json(event);
});

/**
 * Removes a guest's record from an event, under the event's file lock.
 * Resolves to false when the event vanished mid-request; a name that was not
 * there is a successful no-op.
 *
 * `event` is the document as it stands afterwards — unchanged when nothing was
 * removed — which is what the caller broadcasts to the event's subscribers.
 */
async function dropResponse(
  id: string,
  name: string,
): Promise<{ ok: boolean; removed: boolean; event: StoredEvent | null }> {
  let removed = false;
  const updated = await updateEvent(id, (current) => {
    if (!current.responses?.[name]) return undefined;
    removed = true;
    delete current.responses[name];
    current.updatedAt = new Date().toISOString();
    return current;
  });
  return { ok: updated !== null, removed, event: updated };
}

// PUT /api/events/:id/responses/:name — public guest autosave
eventsRouter.put("/events/:id/responses/:name", async (req, res) => {
  const name = guestName(req.params.name);
  const body = asRecord(req.body);
  const availability = requireIsoArray(
    body.availability ?? [],
    "availability",
    MAX_SLOTS,
  );
  const ifNeededRaw = requireIsoArray(body.ifNeeded ?? [], "ifNeeded", MAX_SLOTS);
  // availability and ifNeeded are mutually exclusive; availability wins.
  const available = new Set(availability);
  const ifNeeded = ifNeededRaw.filter((iso) => !available.has(iso));

  const existing = await resolveEvent(param(req.params.id));
  if (!existing) {
    await eventMiss(req, res);
    return;
  }

  // Zero-record invariant (ARCHITECTURE.md § API): an answer with nothing in
  // it is not an answer. Clearing the grid takes the guest off the event
  // instead of leaving a hollow record behind for the respondents list and the
  // heatmap to count. Autosave sends the whole state on every edit, so this is
  // the path a guest's "Clear" takes — and it has to be a no-op when they were
  // never on the list.
  if (availability.length === 0 && ifNeeded.length === 0) {
    const { ok, removed, event } = await dropResponse(existing.id, name);
    if (!ok) {
      await eventMiss(req, res);
      return;
    }
    // A clear that cleared nothing changed nothing, and a room should only
    // ever be woken for something that actually happened.
    if (removed && event) broadcastEvent(event);
    res.json({ ok: true, name, response: null });
    return;
  }

  const now = new Date().toISOString();
  const response = { availability, ifNeeded, updatedAt: now };
  const updated = await updateEvent(existing.id, (current) => {
    current.responses ??= {};
    current.responses[name] = response;
    current.updatedAt = now;
    return current;
  });
  if (!updated) {
    await eventMiss(req, res);
    return;
  }
  broadcastEvent(updated);
  res.json({ ok: true, name, response });
});

/**
 * DELETE /api/events/:id/responses/:name — public.
 *
 * Public by contract (ARCHITECTURE.md § API): a guest may clear their own
 * record, and the capability URL is the auth boundary — anyone who can read
 * the event can already answer it. The admin's per-respondent delete on the
 * event page uses this same endpoint.
 */
eventsRouter.delete("/events/:id/responses/:name", async (req, res) => {
  const name = guestName(req.params.name);
  const existing = await resolveEvent(param(req.params.id));
  if (!existing) {
    await eventMiss(req, res);
    return;
  }
  const { ok, removed, event } = await dropResponse(existing.id, name);
  if (!ok) {
    await eventMiss(req, res);
    return;
  }
  if (!removed) {
    res.status(404).json({ error: "Response not found" });
    return;
  }
  if (event) broadcastEvent(event);
  res.json({ ok: true });
});

/**
 * Anything else under `/api/events/:idOrSlug`, any method: a real event gets a
 * plain 404 (unknown subroute), an unresolvable one is a scan and is
 * tarpitted. Registered last so the routes above always win.
 */
async function eventCatchAll(req: Request, res: Response): Promise<void> {
  const event = await resolveEvent(param(req.params.idOrSlug));
  if (!event) {
    await eventMiss(req, res);
    return;
  }
  res.status(404).json({ error: "Not found" });
}

eventsRouter.all("/events/:idOrSlug", eventCatchAll);
eventsRouter.all("/events/:idOrSlug/{*rest}", eventCatchAll);
