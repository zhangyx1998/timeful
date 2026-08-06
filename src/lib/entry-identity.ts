/**
 * Who an arriving visitor probably is, and how sure the page may be about it.
 *
 * The event page's URL is stateful (`event-routes.ts`): `/<slug>` is the
 * landing that asks, `/<slug>/view` shows the group and asks nothing, and
 * `/<slug>/edit/<key>` is one person's edit view. Two more signals arrive with
 * a visit: a `?name=` query on the landing (a personalized invite link — the
 * invite dialog is the producer, `inviteLink` below), and the name this device
 * remembers in localStorage. This module decides what those add up to:
 *
 * - **welcome** — greet one named person and ask for a single tap of
 *   confirmation. Nobody is ever entered silently on a landing; the query
 *   outranks a different remembered name for who gets greeted, but only ever
 *   wins the first move — declining costs the remembered identity nothing.
 * - **ask** — nothing usable to greet with: the generic identity dialog.
 * - **view** — the group view was asked for by URL; no prompt at all.
 *
 * The decision is pure and tested without a DOM. Validation and normalization
 * come from `user-key.ts` — the same rules the identity dialog and the server
 * enforce — never a second copy.
 */
import {
  adoptDisplayName,
  guestNameProblem,
  userKey,
  userKeyFromParam,
} from "./user-key";

/** The one query parameter this app reads off an event URL. */
export const ENTRY_NAME_PARAM = "name";

/** One person already on the event: the key to match, the name to show. */
export interface KnownPerson {
  key: string;
  displayName: string;
}

/** How the visitor arrived, as the entry decision needs it. */
export type EntryRoute =
  | { kind: "root"; queryName: string | null }
  | { kind: "view" }
  | { kind: "edit"; key: string };

export type EntryDecision =
  /** Straight to the group view; nothing is asked. */
  | { action: "view" }
  /** Nothing usable to greet with: open the generic identity dialog. */
  | { action: "ask" }
  /**
   * Greet the named person and ask for one tap. The display name is the
   * event's own spelling when the key matches somebody who already answered
   * (`matched`), so the greeting shows the name the group knows.
   */
  | { action: "welcome"; key: string; displayName: string; matched: boolean };

/**
 * What this arrival means. `storedName` is the raw remembered name, if any; a
 * remembered spelling that is itself no longer legal (a legacy one with a
 * dash) is no name at all here, exactly as the boot path treats it.
 */
export function resolveEntryIdentity(
  entry: EntryRoute,
  storedName: string | null,
  people: readonly KnownPerson[],
): EntryDecision {
  const stored = usableName(storedName);
  switch (entry.kind) {
    case "view":
      return { action: "view" };
    case "edit":
      return editDecision(entry.key, stored, people);
    case "root": {
      // The link's name wins the greeting over the remembered one — an invite
      // is addressed to somebody — but never more than the greeting.
      const candidate = usableName(entry.queryName) ?? stored;
      if (candidate === null) return { action: "ask" };
      return welcomeFor(candidate, people);
    }
  }
}

/** The trimmed name, or null for anything the guest-name rules would refuse. */
function usableName(raw: string | null): string | null {
  if (raw === null || guestNameProblem(raw) !== null) return null;
  return raw.trim();
}

function welcomeFor(name: string, people: readonly KnownPerson[]): EntryDecision {
  const key = userKey(name);
  const known = people.find((person) => person.key === key);
  return {
    action: "welcome",
    key,
    displayName: adoptDisplayName(name, known?.displayName),
    matched: known !== undefined,
  };
}

/**
 * A landing on `/edit/<key>` names its person by key, so the greeting works
 * backwards from one: the respondent's stored spelling where the key is on the
 * event, else the remembered name when it files under this very key, else the
 * key itself read as a name (its dashes are the spaces `userKey` collapsed —
 * lowercased, but honestly so). A key that cannot be presented as a legal name
 * at all falls back to asking.
 */
function editDecision(
  rawKey: string,
  stored: string | null,
  people: readonly KnownPerson[],
): EntryDecision {
  const key = userKeyFromParam(rawKey);
  if (key === null) return { action: "ask" };
  const known = people.find((person) => person.key === key);
  const matched = known !== undefined;
  if (known && guestNameProblem(known.displayName) === null)
    return { action: "welcome", key, displayName: known.displayName, matched };
  if (stored !== null && userKey(stored) === key)
    return { action: "welcome", key, displayName: stored, matched };
  const cleaned = key.replace(/-/g, " ");
  if (guestNameProblem(cleaned) === null)
    return { action: "welcome", key, displayName: cleaned, matched };
  return { action: "ask" };
}

/**
 * The link the invite dialog hands out: the canonical root URL personalized
 * for one invitee, or — for a blank or unusable name — the canonical URL
 * untouched. It produces exactly what `resolveEntryIdentity` consumes at the
 * root landing, and the round-trip is pinned by a test.
 */
export function inviteLink(base: string, name: string): string {
  const trimmed = name.trim();
  if (trimmed === "" || guestNameProblem(trimmed) !== null) return base;
  return `${base}?${ENTRY_NAME_PARAM}=${encodeURIComponent(trimmed)}`;
}
