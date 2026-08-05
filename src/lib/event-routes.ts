/**
 * The event page's URL shapes, and the window title each one carries.
 *
 * An event's path is stateful (ARCHITECTURE.md § Routing / SSR): `/<slug>` is
 * the landing that asks who is answering, `/<slug>/view` is the group chart,
 * and `/<slug>/edit/<userKey>` is the edit view as that person. **Both halves
 * use this one module at runtime** — the server to recognise the shapes and
 * write the SSR `<title>`, the client to derive the same title after
 * hydration — so the two cannot disagree on first paint. That is why every
 * import here carries an explicit `.ts` extension (docs § Conventions).
 *
 * The slug stays the sole capability: a user key in the path is an address
 * *within* an event already proven reachable, never a secret and never a way
 * to find one.
 */
import { userKeyFromParam } from "./user-key.ts";

/** Which of the event page's three shapes a path is. */
export type EventSubpage =
  | { kind: "root" }
  | { kind: "view" }
  | { kind: "edit"; key: string };

/**
 * Parses a request path into an event page shape, or null for a path that is
 * not one — which for the server means the miss handling it always had.
 *
 * The slug rules are unchanged: one segment, no `.` (a file extension is a
 * static asset, not a page), decoded before lookup. The edit key is a single
 * further segment, passed through decoded but otherwise untouched — whether it
 * names a respondent is the page's question, not the router's.
 */
export function parseEventPath(
  pathname: string,
): { slug: string; sub: EventSubpage } | null {
  if (!pathname.startsWith("/")) return null;
  let segments: string[];
  try {
    segments = pathname
      .slice(1)
      .split("/")
      .map((segment) => decodeURIComponent(segment));
  } catch {
    return null; // malformed percent-encoding
  }
  const [slug, second, third] = segments;
  if (!slug || slug.includes("/") || slug.includes(".")) return null;
  if (segments.length === 1) return { slug, sub: { kind: "root" } };
  if (segments.length === 2 && second === "view") return { slug, sub: { kind: "view" } };
  if (segments.length === 3 && second === "edit" && third)
    return { slug, sub: { kind: "edit", key: third } };
  return null;
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
