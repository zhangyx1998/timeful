/**
 * Who an arriving visitor probably is. Inputs: the stateful URL
 * (`event-routes.ts`), the invite link's opaque query token (plain `?name=`
 * accepted for hand-typed links), and the name this device remembers.
 * Decisions: welcome (greet, one-tap confirm — nobody is entered silently),
 * ask, or view. Pure; validation comes from `user-key.ts`, never a second copy.
 */
import {
  adoptDisplayName,
  guestNameProblem,
  userKey,
  userKeyFromParam,
} from "./user-key";

/** The two query parameters this app reads off an event URL's landing. */
export const ENTRY_NAME_PARAM = "name";
export const ENTRY_PREFIX_PARAM = "prefix";

/** Longest greeting prefix carried, measured after trimming. */
export const MAX_GREETING_PREFIX_LENGTH = 20;

/**
 * The prefix is decoration only: it never enters the key, the stored name,
 * the respondents list or the title. Unusable ones are dropped silently —
 * a decoration is not worth blocking a link over.
 */
export function normalizeGreetingPrefix(raw: string | null | undefined): string | null {
  const prefix = raw?.trim() ?? "";
  if (!prefix || prefix.length > MAX_GREETING_PREFIX_LENGTH || prefix.includes("-"))
    return null;
  return prefix;
}

/** One person already on the event: the key to match, the name to show. */
export interface KnownPerson {
  key: string;
  displayName: string;
}

/** How the visitor arrived, as the entry decision needs it. */
export type EntryRoute =
  | { kind: "root"; queryName: string | null; queryPrefix?: string | null }
  | { kind: "view" }
  | { kind: "edit"; key: string };

export type EntryDecision =
  | { action: "view" }
  | { action: "ask" }
  /**
   * Greet the named person and ask for one tap. `displayName` is the event's
   * own spelling when the key `matched`; `prefix` decorates only a greeting of
   * the link's own name.
   */
  | {
      action: "welcome";
      key: string;
      displayName: string;
      matched: boolean;
      prefix: string | null;
    };

/** A stored spelling that is no longer legal counts as no name, as on boot. */
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
      // The link's name wins the greeting over the remembered one, but only
      // the greeting; the prefix belongs to the link's name alone.
      const fromQuery = usableName(entry.queryName);
      const candidate = fromQuery ?? stored;
      if (candidate === null) return { action: "ask" };
      return welcomeFor(
        candidate,
        people,
        fromQuery !== null ? normalizeGreetingPrefix(entry.queryPrefix) : null,
      );
    }
  }
}

/** The trimmed name, or null for anything the guest-name rules would refuse. */
function usableName(raw: string | null): string | null {
  if (raw === null || guestNameProblem(raw) !== null) return null;
  return raw.trim();
}

function welcomeFor(
  name: string,
  people: readonly KnownPerson[],
  prefix: string | null = null,
): EntryDecision {
  const key = userKey(name);
  const known = people.find((person) => person.key === key);
  return {
    action: "welcome",
    key,
    displayName: adoptDisplayName(name, known?.displayName),
    matched: known !== undefined,
    prefix,
  };
}

/**
 * `/edit/<key>` names its person by key, so the greeting works backwards: the
 * event's stored spelling, else the remembered name filing under this key,
 * else the key read as a name. An unpresentable key falls back to asking.
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
  const prefix = null; // decoration belongs to invite links, not edit paths
  if (known && guestNameProblem(known.displayName) === null)
    return { action: "welcome", key, displayName: known.displayName, matched, prefix };
  if (stored !== null && userKey(stored) === key)
    return { action: "welcome", key, displayName: stored, matched, prefix };
  const cleaned = key.replace(/-/g, " ");
  if (guestNameProblem(cleaned) === null)
    return { action: "welcome", key, displayName: cleaned, matched, prefix };
  return { action: "ask" };
}

/** UTF-8 → URL-safe base64 (`-`/`_` alphabet, padding stripped). */
function encodeBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** The inverse, or null for anything that is not such a token. */
function decodeBase64Url(token: string): string | null {
  if (!/^[A-Za-z0-9_-]+$/.test(token)) return null;
  const padded =
    token.replace(/-/g, "+").replace(/_/g, "/") +
    "=".repeat((4 - (token.length % 4)) % 4);
  try {
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    // `fatal`: mangled bytes are a null, not replacement characters greeted as a name.
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/** What a landing's query suggests: a name to greet, and its decoration. */
export interface EntryGreeting {
  name: string | null;
  prefix: string | null;
}

/**
 * Reads a landing's raw query string. The invite dialog's token form is one
 * bare base64url token encoding the inner `name=…&prefix=…` pair — visibly
 * opaque, and it survives chat apps that mangle nested percent-escapes. Plain
 * `?name=` is accepted; anything unusable reads as no query, never an error.
 */
export function readEntryQuery(search: string): EntryGreeting {
  const raw = search.startsWith("?") ? search.slice(1) : search;
  const none: EntryGreeting = { name: null, prefix: null };
  if (!raw) return none;
  let params: URLSearchParams;
  if (!raw.includes("=") && !raw.includes("&")) {
    const inner = decodeBase64Url(raw);
    if (inner === null) return none;
    params = new URLSearchParams(inner);
  } else {
    params = new URLSearchParams(raw);
  }
  return {
    name: params.get(ENTRY_NAME_PARAM),
    prefix: normalizeGreetingPrefix(params.get(ENTRY_PREFIX_PARAM)),
  };
}

/**
 * The invite dialog's link: `/<slug>?<token>`, or the canonical URL untouched
 * for a blank or unusable name. The round-trip with `readEntryQuery` is
 * pinned by tests.
 */
export function inviteLink(base: string, name: string, prefix = ""): string {
  const trimmed = name.trim();
  if (trimmed === "" || guestNameProblem(trimmed) !== null) return base;
  const inner = new URLSearchParams();
  inner.set(ENTRY_NAME_PARAM, trimmed);
  const decoration = normalizeGreetingPrefix(prefix);
  if (decoration) inner.set(ENTRY_PREFIX_PARAM, decoration);
  return `${base}?${encodeBase64Url(inner.toString())}`;
}
