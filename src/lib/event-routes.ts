/**
 * The event page's URL shapes, and the window title each one carries.
 *
 * An event's path is stateful (ARCHITECTURE.md § Routing / SSR): `/<slug>` is
 * the landing that asks who is answering, `/<slug>/view` is the group chart,
 * and `/<slug>/edit/<userKey>` is the edit view as that person. Those three
 * exact shapes are **canonical** and the only page URLs that serve; every
 * other page-like path under a slug — junk sub-paths, `/edit` with no key,
 * trailing-slash forms, the bare `/<slug>/` — classifies as non-canonical and
 * is sent back to the event root, by a 302 on the server and by a router
 * redirect in the SPA. **Both guards use this one parser** — the server to
 * serve, redirect or miss, the client router so an in-SPA navigation cannot
 * land where a full load could not — so the two cannot drift; that is why
 * every import here carries an explicit `.ts` extension (docs § Conventions).
 *
 * The one carve-out is the reserved API sub-segments (`RESERVED_SUBPATHS`):
 * those paths are not pages at all, keep their exact API semantics, and are
 * never redirected. The slug stays the sole capability: a user key in the
 * path is an address *within* an event already proven reachable, never a
 * secret and never a way to find one.
 */
import { RESERVED_SUBPATHS } from "./slug-rules.ts";
import { userKeyFromParam } from "./user-key.ts";

/** Which of the event page's three canonical shapes a path is. */
export type EventSubpage =
  | { kind: "root" }
  | { kind: "view" }
  | { kind: "edit"; key: string };

/** What a page-like path under a slug amounts to. */
export type EventPagePath =
  /** One of the three canonical shapes: serve it. */
  | { slug: string; canonical: true; sub: EventSubpage }
  /** Page territory, but not a canonical URL: redirect to `/<slug>`. */
  | { slug: string; canonical: false };

/**
 * Classifies a request path, or returns null for a path that is not page
 * territory at all — an unusable first segment (empty, a `.` as in a file
 * name, a malformed escape), or a reserved API sub-segment, which belongs to
 * the event-scoped API router whatever else the path says.
 *
 * Whether the slug *resolves* is the caller's question: for the server a null
 * here or a failed lookup is the tarpitted miss it always was, and a
 * non-canonical shape only redirects once the slug has proven to be an event.
 */
export function parseEventPath(pathname: string): EventPagePath | null {
  if (!pathname.startsWith("/")) return null;
  const raw = pathname.slice(1).split("/");
  let slug: string;
  try {
    slug = decodeURIComponent(raw[0] ?? "");
  } catch {
    return null; // malformed percent-encoding in the slug
  }
  if (!slug || slug.includes("/") || slug.includes(".")) return null;
  if (raw.length >= 2 && RESERVED_SUBPATHS.has(raw[1] ?? "")) return null;

  let rest: string[];
  try {
    rest = raw.slice(1).map((segment) => decodeURIComponent(segment));
  } catch {
    // A malformed escape below the slug is junk under a real address.
    return { slug, canonical: false };
  }
  if (rest.length === 0) return { slug, canonical: true, sub: { kind: "root" } };
  if (rest.length === 1 && rest[0] === "view")
    return { slug, canonical: true, sub: { kind: "view" } };
  if (rest.length === 2 && rest[0] === "edit" && rest[1])
    return { slug, canonical: true, sub: { kind: "edit", key: rest[1] } };
  return { slug, canonical: false };
}

/** The slice of the event document a title needs. */
export interface TitledEvent {
  name: string;
  responses?: Record<string, { displayName?: string } | undefined> | null;
}

/**
 * The window title for one shape of the page.
 *
 * The root and the group view are about the event, so they say the event —
 * exactly what they always said. The edit view is about one person's answer,
 * so it names the person: the respondent's stored spelling when the key is on
 * the event, else `editorName` — the client passes the identity it has just
 * confirmed, which is how a first-time invitee's key gets a name before their
 * answer exists. With neither, it falls back to the event alone; SSR passes no
 * `editorName`, and the client passes none until an identity for that key is
 * confirmed, which is what keeps the hydrated title byte-equal to the served
 * one on first paint.
 */
export function eventPageTitle(
  event: TitledEvent,
  sub: EventSubpage,
  editorName?: string,
): string {
  if (sub.kind === "edit") {
    const key = userKeyFromParam(sub.key);
    const name = (key ? event.responses?.[key]?.displayName : undefined) || editorName;
    if (name) return `${name}’s availability for ${event.name} · Timeful`;
  }
  return `${event.name} · Timeful`;
}
