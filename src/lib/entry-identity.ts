/**
 * Who an arriving visitor probably is, and how sure the page may be about it.
 *
 * The event page's URL is stateful (`event-routes.ts`): `/<slug>` is the
 * landing that asks, `/<slug>/view` shows the group and asks nothing, and
 * `/<slug>/edit/<key>` is one person's edit view. Two more signals arrive with
 * a visit: the landing's query — a personalized invite link, produced by the
 * invite dialog as an opaque token (`inviteLink`/`readEntryQuery` below), with
 * plain `?name=` accepted for hand-typed links — and the name this device
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

/** The two query parameters this app reads off an event URL's landing. */
export const ENTRY_NAME_PARAM = "name";
export const ENTRY_PREFIX_PARAM = "prefix";

/** Longest greeting prefix carried, measured after trimming. */
export const MAX_GREETING_PREFIX_LENGTH = 20;

/**
 * The greeting prefix is **decoration only**: it rides an invite link and
 * shapes the welcome prompt's headline — "Welcome, Prof. Ada Lovelace" — and
 * nothing else. It never enters the user key, the stored display name, the
 * respondents list or the window title; identity remains a function of the
 * name alone, so "Prof. Ada" and "Ada" are one person. Validated loosely for
 * the same reason: an unusable prefix (blank, over-long, carrying a dash) is
 * silently dropped, never an error — a decoration is not worth blocking a
 * link over.
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
  /** Straight to the group view; nothing is asked. */
  | { action: "view" }
  /** Nothing usable to greet with: open the generic identity dialog. */
  | { action: "ask" }
  /**
   * Greet the named person and ask for one tap. The display name is the
   * event's own spelling when the key matches somebody who already answered
   * (`matched`), so the greeting shows the name the group knows. `prefix` is
   * the link's greeting decoration, carried only when the link's own name is
   * the one being greeted — it decorates that greeting and nothing after it.
   */
  | {
      action: "welcome";
      key: string;
      displayName: string;
      matched: boolean;
      prefix: string | null;
    };

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
      // is addressed to somebody — but never more than the greeting. The
      // prefix belongs to the link's name alone: a greeting that fell back to
      // the remembered name is not the invitee's, so it is not decorated.
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

// --- the wire form ---------------------------------------------------------

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
    // `fatal`, so mangled bytes are a null rather than replacement characters
    // greeted as somebody's name.
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
 * Reads a landing's raw query string (with or without the leading `?`).
 *
 * The invite dialog produces the **token form**: the whole query is one bare
 * URL-safe base64 token — no `=`, no `&` — encoding the UTF-8 bytes of the
 * inner `name=…&prefix=…` pair, so the link stays visibly opaque and survives
 * chat apps that mangle nested percent-escapes. The plain `?name=…` form is
 * still accepted for hand-typed links and old ones. Anything that decodes to
 * nothing usable — a mangled token, invalid UTF-8, junk parameters — reads as
 * no query at all, never as an error.
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
 * The link the invite dialog hands out: the canonical root URL personalized
 * for one invitee — `/<slug>?<token>` in the token form above — or, for a
 * blank or unusable name, the canonical URL untouched. An unusable prefix is
 * dropped silently rather than blocking the link: it is decoration. It
 * produces exactly what `readEntryQuery` + `resolveEntryIdentity` consume at
 * the root landing, and the round-trip is pinned by tests.
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
