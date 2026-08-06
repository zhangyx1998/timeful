/**
 * A guest's name is two things: the display name (exactly what they typed, the
 * only string ever shown) and the user key (its normalized form, the only
 * string used to match, file under, or put in a URL). Pure rules; both halves
 * import this one module so the two answers cannot drift.
 */

/** Longest display name accepted, measured after trimming. */
export const MAX_GUEST_NAME_LENGTH = 100;

/**
 * Trim, casefold, collapse each whitespace run to a dash. Deliberately
 * injective over legal names: a dash in a key can only have come from
 * whitespace, because a raw dash is rejected (`guestNameProblem`).
 */
export function userKey(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, "-");
}

/**
 * The key a legacy (pre-key, raw-name-keyed) response files under: its dashes
 * are read as the spaces they stood in for.
 */
export function legacyUserKey(raw: string): string {
  return userKey(raw.replace(/-/g, " "));
}

/**
 * Why this display name is not usable, or null when it is. The dash rule is
 * the load-bearing one: letting names carry `-` would give two different
 * names one key.
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
 * Which spelling to adopt: the stored one wins, so the group keeps the
 * spelling it knows — unless it is no longer legal (a legacy dash), in which
 * case the typed one replaces it. Same key either way.
 */
export function adoptDisplayName(typed: string, known: string | undefined): string {
  if (known && guestNameProblem(known) === null) return known;
  return typed.trim();
}

/**
 * The key for a path segment, or null when it is not one. Re-normalized rather
 * than trusted, so no caller can invent a second spelling of one person.
 */
export function userKeyFromParam(raw: string): string | null {
  const key = userKey(raw);
  if (!key || key.length > MAX_GUEST_NAME_LENGTH) return null;
  return key;
}
