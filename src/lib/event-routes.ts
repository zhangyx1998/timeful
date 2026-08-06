/**
 * The event page's URL shapes (ARCHITECTURE.md § Routing / SSR). Exactly three
 * canonical shapes serve — `/<slug>`, `/<slug>/view`, `/<slug>/edit/<userKey>`;
 * every other page-like path under a slug redirects to the event root (302 on
 * the server, router redirect in the SPA). Both guards use this one parser so
 * they cannot drift — hence the explicit `.ts` imports. Reserved API
 * sub-segments are never redirected. The slug stays the sole capability: a
 * user key in the path is never a secret.
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
 * Classifies a request path; null for anything that is not page territory
 * (unusable first segment, or a reserved API sub-segment). Whether the slug
 * resolves is the caller's question.
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
 * The edit view names the person: stored spelling, else `editorName`. SSR
 * passes no `editorName` and the client passes none until an identity is
 * confirmed, keeping the hydrated title byte-equal to the served one.
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
