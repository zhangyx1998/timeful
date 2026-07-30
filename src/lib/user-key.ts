/**
 * What a guest's name is, and what it is *called* in the wire format.
 *
 * A response used to be filed under whatever the guest typed, which made
 * "Ada Lovelace", "ada lovelace" and "Ada  Lovelace" three different people on
 * the same event. The name is now two things instead of one:
 *
 * - the **display name** — exactly what they typed, and the only string ever
 *   shown to anybody;
 * - the **user key** — a normalized form of it, and the only string used to
 *   match, to file a response under, or to put in a URL.
 *
 * Pure rules, no crypto and no I/O, so **both halves import this one module**
 * — the same arrangement `slug-rules.ts` has, and for the same reason: the
 * server rejects with it before writing anything, the identity dialog rejects
 * with it as the guest types, and the wording of the two answers cannot drift.
 */

/**
 * Longest display name accepted, measured after trimming. Matches the limit
 * the response routes have always enforced.
 */
export const MAX_GUEST_NAME_LENGTH = 100;

/**
 * The key a display name files under: trim, casefold, then collapse each run
 * of whitespace to a single dash.
 *
 * ```
 * "  Ada   Lovelace "  ->  "ada-lovelace"
 * "ada  LOVELACE"      ->  "ada-lovelace"
 * ```
 *
 * The mapping is deliberately **injective** over legal names, which is what
 * makes a key safe to put in a URL and safe to match on: a dash in a key can
 * only ever have come from whitespace, because a dash in a raw name is
 * rejected (`guestNameProblem`). Without that rule "a-b" and "a b" would be
 * one key with two spellings and no way to tell which one was meant.
 */
export function userKey(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, "-");
}

/**
 * The key a **legacy** response name files under.
 *
 * Event files written before keys existed are keyed by the raw name, dashes
 * and all. Reading one treats those dashes as the spaces they stand in for, so
 * an old "Ada-Lovelace" and a new "Ada Lovelace" are recognised as the same
 * person rather than as two rows in the same list.
 */
export function legacyUserKey(raw: string): string {
  return userKey(raw.replace(/-/g, " "));
}

/**
 * Why this display name is not usable, or null when it is.
 *
 * The dash rule is the load-bearing one and the only new one: a name may not
 * contain `-`, because a dash is what a run of whitespace becomes and letting
 * both produce it would make two different names share one key.
 */
export function guestNameProblem(raw: string): string | null {
  const name = raw.trim();
  if (!name) return "A name is required";
  if (name.length > MAX_GUEST_NAME_LENGTH)
    return `A name must be at most ${MAX_GUEST_NAME_LENGTH} characters`;
  if (name.includes("-")) return "A name may not contain a dash — use spaces instead";
  return null;
}

/**
 * Which spelling to adopt: the one the event already carries, or the one just
 * typed.
 *
 * Two people who type the same name differently are one person — that is what
 * the key decides — and the group should keep seeing the spelling it already
 * knows rather than having it rewritten by whoever answered most recently. So
 * the stored one wins.
 *
 * The exception is a stored spelling that is no longer legal: a legacy name
 * with a dash in it is readable but cannot be written back, so the new one
 * replaces it. The key is the same either way, which is what makes the swap
 * safe — it is the same person's answer before and after.
 */
export function adoptDisplayName(typed: string, known: string | undefined): string {
  if (known && guestNameProblem(known) === null) return known;
  return typed.trim();
}

/**
 * The key for a path segment, or null when it is not one.
 *
 * A key arriving from a URL is not trusted to be the output of `userKey`: it
 * is re-normalized, so `/…/users/Ada%20Lovelace` and `/…/users/ada-lovelace`
 * address the same record and no caller can invent a second spelling of one
 * person. Empty and over-long segments are rejected outright.
 */
export function userKeyFromParam(raw: string): string | null {
  const key = userKey(raw);
  if (!key || key.length > MAX_GUEST_NAME_LENGTH) return null;
  return key;
}
