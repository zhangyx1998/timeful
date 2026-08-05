/**
 * Personalized event links: `?name=<display name>` on an event URL.
 *
 * The invite dialog is the producer and the event page's boot is the only
 * consumer. The query is a *suggestion* of who is opening the page, so it is
 * confirmed by a welcome prompt rather than acted on — with two exceptions
 * that need no asking: a device that already remembers the very same person
 * (nothing to confirm), and a name that breaks the guest-name rules (nothing
 * safe to greet with).
 *
 * The decision is pure and lives here so it can be tested without a DOM; the
 * two `window` helpers below it are the thin I/O around it. Validation and
 * normalization come from `user-key.ts` — the same rules the identity dialog
 * and the server enforce — never a second copy.
 */
import { adoptDisplayName, guestNameProblem, userKey } from "./user-key";

/** The one query parameter this app reads off an event URL. */
export const ENTRY_NAME_PARAM = "name";

/** One person already on the event: the key to match, the name to show. */
export interface KnownPerson {
  key: string;
  displayName: string;
}

export type EntryDecision =
  /** No usable name in the query: behave exactly as if there were none. */
  | { action: "none" }
  /**
   * The device already remembers this very person, so there is nothing to
   * confirm — the query is consumed silently and the visit proceeds as every
   * remembered visit does.
   */
  | { action: "skip" }
  /**
   * Greet the named person and ask. The display name is the event's own
   * spelling when the key matches somebody who already answered (`matched`),
   * so the greeting shows the name the group knows.
   */
  | { action: "welcome"; key: string; displayName: string; matched: boolean };

/**
 * What an arriving `?name=` means for this visit.
 *
 * `storedName` is the raw remembered name, if any; a remembered name that is
 * itself no longer legal (a legacy spelling with a dash) is no name at all
 * here, exactly as the boot path treats it. The query never *pre-empts* a
 * different remembered identity — it only wins the first move, by asking.
 */
export function resolveEntryIdentity(
  queryName: string | null,
  storedName: string | null,
  people: readonly KnownPerson[],
): EntryDecision {
  if (queryName === null || guestNameProblem(queryName) !== null) {
    return { action: "none" };
  }
  const key = userKey(queryName);
  if (
    storedName !== null &&
    guestNameProblem(storedName) === null &&
    userKey(storedName) === key
  ) {
    return { action: "skip" };
  }
  const known = people.find((person) => person.key === key);
  return {
    action: "welcome",
    key,
    displayName: adoptDisplayName(queryName, known?.displayName),
    matched: known !== undefined,
  };
}

/**
 * The link the invite dialog hands out: the canonical URL personalized for one
 * invitee, or — for a blank or unusable name — the canonical URL untouched. It
 * produces exactly what `resolveEntryIdentity` consumes, and the round-trip is
 * pinned by a test.
 */
export function inviteLink(base: string, name: string): string {
  const trimmed = name.trim();
  if (trimmed === "" || guestNameProblem(trimmed) !== null) return base;
  return `${base}?${ENTRY_NAME_PARAM}=${encodeURIComponent(trimmed)}`;
}

/** The raw `?name=` value on the address bar, or null. Browser only. */
export function readEntryName(): string | null {
  return new URLSearchParams(window.location.search).get(ENTRY_NAME_PARAM);
}

/**
 * Strips `name` from the address bar once the query has been consumed, so a
 * reload does not re-prompt and a URL copied afterwards does not carry one
 * person's name to the next. `replaceState`, not `pushState`: the personalized
 * address is not a place the back button should return to. Browser only.
 */
export function consumeEntryName(): void {
  const url = new URL(window.location.href);
  if (!url.searchParams.has(ENTRY_NAME_PARAM)) return;
  url.searchParams.delete(ENTRY_NAME_PARAM);
  window.history.replaceState(
    window.history.state,
    "",
    url.pathname + url.search + url.hash,
  );
}
