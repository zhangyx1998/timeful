import { describe, expect, it } from "vitest";
import {
  inviteLink,
  MAX_GREETING_PREFIX_LENGTH,
  normalizeGreetingPrefix,
  readEntryQuery,
  resolveEntryIdentity,
  type EntryRoute,
  type KnownPerson,
} from "./entry-identity";
import { MAX_GUEST_NAME_LENGTH } from "./user-key";

const nobody: KnownPerson[] = [];
const ada: KnownPerson = { key: "ada-lovelace", displayName: "Ada Lovelace" };

const root = (queryName: string | null = null): EntryRoute => ({
  kind: "root",
  queryName,
});
const edit = (key: string): EntryRoute => ({ kind: "edit", key });

describe("resolveEntryIdentity on the group view", () => {
  it("never prompts, whatever else is known", () => {
    expect(resolveEntryIdentity({ kind: "view" }, null, nobody)).toEqual({
      action: "view",
    });
    expect(resolveEntryIdentity({ kind: "view" }, "Grace Hopper", [ada])).toEqual({
      action: "view",
    });
  });
});

describe("resolveEntryIdentity on the root landing", () => {
  it("asks when it knows nothing", () => {
    expect(resolveEntryIdentity(root(), null, [ada])).toEqual({ action: "ask" });
  });

  it("welcomes the remembered name rather than entering silently", () => {
    expect(resolveEntryIdentity(root(), "Grace Hopper", nobody)).toEqual({
      action: "welcome",
      key: "grace-hopper",
      displayName: "Grace Hopper",
      matched: false,
      prefix: null,
    });
  });

  it("welcomes the query's name on a device that remembers nobody", () => {
    expect(resolveEntryIdentity(root(" Ada  Lovelace "), null, nobody)).toEqual({
      action: "welcome",
      key: "ada-lovelace",
      displayName: "Ada  Lovelace",
      matched: false,
      prefix: null,
    });
  });

  it("lets the query win the greeting over a different remembered name", () => {
    // Only the greeting: what the remembered identity becomes is settled by
    // what the visitor confirms, never here.
    expect(resolveEntryIdentity(root("Ada Lovelace"), "Grace Hopper", nobody)).toEqual({
      action: "welcome",
      key: "ada-lovelace",
      displayName: "Ada Lovelace",
      matched: false,
      prefix: null,
    });
  });

  it("treats an unusable query name exactly as no query", () => {
    // The same rules the identity dialog and the server enforce: empty,
    // over-long, or carrying a dash. None of them is a name to greet with.
    expect(resolveEntryIdentity(root(""), null, nobody)).toEqual({ action: "ask" });
    expect(resolveEntryIdentity(root("   "), null, nobody)).toEqual({ action: "ask" });
    expect(resolveEntryIdentity(root("Ada-Lovelace"), null, [ada])).toEqual({
      action: "ask",
    });
    expect(
      resolveEntryIdentity(root("a".repeat(MAX_GUEST_NAME_LENGTH + 1)), null, nobody),
    ).toEqual({ action: "ask" });
    // …which means a remembered name still gets its greeting.
    expect(resolveEntryIdentity(root("Ada-Lovelace"), "Grace Hopper", nobody)).toEqual({
      action: "welcome",
      key: "grace-hopper",
      displayName: "Grace Hopper",
      matched: false,
      prefix: null,
    });
  });

  it("ignores a remembered spelling that is no longer legal", () => {
    expect(resolveEntryIdentity(root(), "Ada-Lovelace", [ada])).toEqual({
      action: "ask",
    });
  });

  it("adopts the event's spelling when the key matches a respondent", () => {
    expect(resolveEntryIdentity(root("ada  LOVELACE"), null, [ada])).toEqual({
      action: "welcome",
      key: "ada-lovelace",
      displayName: "Ada Lovelace",
      matched: true,
      prefix: null,
    });
  });

  it("keeps the typed spelling over a legacy one that cannot be written back", () => {
    const legacy: KnownPerson = { key: "ada-lovelace", displayName: "Ada-Lovelace" };
    expect(resolveEntryIdentity(root("Ada Lovelace"), null, [legacy])).toEqual({
      action: "welcome",
      key: "ada-lovelace",
      displayName: "Ada Lovelace",
      matched: true,
      prefix: null,
    });
  });
});

describe("resolveEntryIdentity on an edit landing", () => {
  it("greets a respondent by the event's stored spelling", () => {
    expect(resolveEntryIdentity(edit("ada-lovelace"), null, [ada])).toEqual({
      action: "welcome",
      key: "ada-lovelace",
      displayName: "Ada Lovelace",
      matched: true,
      prefix: null,
    });
  });

  it("re-normalizes whatever spelling of the key the URL carries", () => {
    expect(resolveEntryIdentity(edit("Ada Lovelace"), null, [ada])).toEqual({
      action: "welcome",
      key: "ada-lovelace",
      displayName: "Ada Lovelace",
      matched: true,
      prefix: null,
    });
  });

  it("greets a first-time invitee by the remembered name when it fits the key", () => {
    expect(resolveEntryIdentity(edit("grace-hopper"), "Grace Hopper", nobody)).toEqual({
      action: "welcome",
      key: "grace-hopper",
      displayName: "Grace Hopper",
      matched: false,
      prefix: null,
    });
  });

  it("greets an unknown key by reading its dashes as the spaces they were", () => {
    expect(resolveEntryIdentity(edit("grace-hopper"), null, nobody)).toEqual({
      action: "welcome",
      key: "grace-hopper",
      displayName: "grace hopper",
      matched: false,
      prefix: null,
    });
  });

  it("prefers a legal name over a stored legacy spelling for the same key", () => {
    const legacy: KnownPerson = { key: "ada-lovelace", displayName: "Ada-Lovelace" };
    expect(resolveEntryIdentity(edit("ada-lovelace"), null, [legacy])).toEqual({
      action: "welcome",
      key: "ada-lovelace",
      displayName: "ada lovelace",
      matched: true,
      prefix: null,
    });
  });

  it("asks when the key cannot be presented as a name at all", () => {
    expect(resolveEntryIdentity(edit(""), null, nobody)).toEqual({ action: "ask" });
    expect(resolveEntryIdentity(edit("   "), null, nobody)).toEqual({ action: "ask" });
    expect(
      resolveEntryIdentity(edit("a".repeat(MAX_GUEST_NAME_LENGTH + 1)), null, nobody),
    ).toEqual({ action: "ask" });
  });
});

describe("the greeting prefix", () => {
  it("is decoration: dresses only a greeting sourced from the link itself", () => {
    expect(
      resolveEntryIdentity(
        { kind: "root", queryName: "Ada Lovelace", queryPrefix: "Prof." },
        null,
        [ada],
      ),
    ).toEqual({
      action: "welcome",
      key: "ada-lovelace", // the key of the bare name — never the prefix
      displayName: "Ada Lovelace",
      matched: true,
      prefix: "Prof.",
    });
    // A greeting that fell back to the remembered name is not the invitee's,
    // so the link's decoration does not transfer to it.
    const fallback = resolveEntryIdentity(
      { kind: "root", queryName: "Ada-Lovelace", queryPrefix: "Prof." },
      "Grace Hopper",
      nobody,
    );
    expect(fallback).toMatchObject({ action: "welcome", prefix: null });
  });

  it("is validated loosely and dropped rather than refused", () => {
    expect(normalizeGreetingPrefix("  Prof.  ")).toBe("Prof.");
    expect(normalizeGreetingPrefix("")).toBeNull();
    expect(normalizeGreetingPrefix("   ")).toBeNull();
    expect(normalizeGreetingPrefix(null)).toBeNull();
    expect(normalizeGreetingPrefix("Prof-Dr")).toBeNull(); // the dash rule
    expect(normalizeGreetingPrefix("a".repeat(MAX_GREETING_PREFIX_LENGTH + 1))).toBeNull();
    expect(normalizeGreetingPrefix("a".repeat(MAX_GREETING_PREFIX_LENGTH))).toBe(
      "a".repeat(MAX_GREETING_PREFIX_LENGTH),
    );
  });
});

describe("inviteLink and readEntryQuery — the wire form", () => {
  const base = "https://timeful.example/happy-hour";

  /** The query the producer put on a link, as the landing would read it. */
  function queryOf(link: string): string {
    return new URL(link).search;
  }

  it("produces one bare URL-safe token, visibly opaque", () => {
    const link = inviteLink(base, "Ada Lovelace");
    const token = queryOf(link).slice(1);
    expect(link.startsWith(`${base}?`)).toBe(true);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/); // no '=', '&', '%', padding
    expect(token).not.toContain("Ada");
  });

  it("hands out the bare canonical URL for a blank name", () => {
    expect(inviteLink(base, "")).toBe(base);
    expect(inviteLink(base, "   ")).toBe(base);
  });

  it("refuses to personalize with an unusable name", () => {
    expect(inviteLink(base, "Ada-Lovelace")).toBe(base);
    expect(inviteLink(base, "a".repeat(MAX_GUEST_NAME_LENGTH + 1))).toBe(base);
  });

  it("round-trips the name, trimmed, through the token", () => {
    expect(readEntryQuery(queryOf(inviteLink(base, "  Ada Lovelace  ")))).toEqual({
      name: "Ada Lovelace",
      prefix: null,
    });
  });

  it("round-trips the prefix, and omits it when blank or unusable", () => {
    expect(readEntryQuery(queryOf(inviteLink(base, "Ada Lovelace", "Prof.")))).toEqual({
      name: "Ada Lovelace",
      prefix: "Prof.",
    });
    for (const dropped of ["", "  ", "Prof-Dr", "a".repeat(21)]) {
      expect(readEntryQuery(queryOf(inviteLink(base, "Ada Lovelace", dropped)))).toEqual(
        { name: "Ada Lovelace", prefix: null },
      );
    }
  });

  it("survives UTF-8 far beyond ASCII", () => {
    for (const name of ["山田 太郎", "Ada 🚀 Lovelace", "Élodie Ström"]) {
      expect(readEntryQuery(queryOf(inviteLink(base, name))).name).toBe(name);
    }
  });

  it("still consumes the plain ?name= form", () => {
    expect(readEntryQuery("?name=Ada%20Lovelace")).toEqual({
      name: "Ada Lovelace",
      prefix: null,
    });
    expect(readEntryQuery("name=Ada%20Lovelace&prefix=Dr.")).toEqual({
      name: "Ada Lovelace",
      prefix: "Dr.",
    });
  });

  it("reads anything undecodable as no query at all", () => {
    expect(readEntryQuery("")).toEqual({ name: null, prefix: null });
    expect(readEntryQuery("?")).toEqual({ name: null, prefix: null });
    // Not base64url at all, or valid base64 of bytes that are not UTF-8 or
    // not the inner query: silence, never an error.
    expect(readEntryQuery("?not~a~token").name).toBeNull();
    expect(readEntryQuery("?_w").name).toBeNull(); // 0xFF: invalid UTF-8
    expect(readEntryQuery("?aGVsbG8").name).toBeNull(); // "hello": no params
    expect(readEntryQuery("?x").name).toBeNull(); // impossible base64 length
  });

  it("round-trips through the entry decision to the prefixed welcome", () => {
    // The producer and the consumer are two halves of one contract: whatever
    // the invite dialog generates, the root landing greets that invitee —
    // decorated, but filed under the bare name's key.
    const greeting = readEntryQuery(queryOf(inviteLink(base, "ada  LOVELACE", "Dr.")));
    expect(
      resolveEntryIdentity(
        { kind: "root", queryName: greeting.name, queryPrefix: greeting.prefix },
        null,
        [ada],
      ),
    ).toEqual({
      action: "welcome",
      key: "ada-lovelace",
      displayName: "Ada Lovelace",
      matched: true,
      prefix: "Dr.",
    });
  });

  it("treats a token carrying an unusable name as absent at the decision", () => {
    // has-dash by hand-crafted token: the name survives the wire but fails
    // the guest-name rules, so the landing behaves as if there were no query.
    expect(readEntryQuery("?bmFtZT1BZGEtTG92ZWxhY2U").name).toBe("Ada-Lovelace");
    expect(
      resolveEntryIdentity(root("Ada-Lovelace"), null, nobody),
    ).toEqual({ action: "ask" });
  });
});
