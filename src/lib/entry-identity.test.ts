import { describe, expect, it } from "vitest";
import {
  ENTRY_NAME_PARAM,
  inviteLink,
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
    });
  });

  it("welcomes the query's name on a device that remembers nobody", () => {
    expect(resolveEntryIdentity(root(" Ada  Lovelace "), null, nobody)).toEqual({
      action: "welcome",
      key: "ada-lovelace",
      displayName: "Ada  Lovelace",
      matched: false,
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
    });
  });

  it("keeps the typed spelling over a legacy one that cannot be written back", () => {
    const legacy: KnownPerson = { key: "ada-lovelace", displayName: "Ada-Lovelace" };
    expect(resolveEntryIdentity(root("Ada Lovelace"), null, [legacy])).toEqual({
      action: "welcome",
      key: "ada-lovelace",
      displayName: "Ada Lovelace",
      matched: true,
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
    });
  });

  it("re-normalizes whatever spelling of the key the URL carries", () => {
    expect(resolveEntryIdentity(edit("Ada Lovelace"), null, [ada])).toEqual({
      action: "welcome",
      key: "ada-lovelace",
      displayName: "Ada Lovelace",
      matched: true,
    });
  });

  it("greets a first-time invitee by the remembered name when it fits the key", () => {
    expect(resolveEntryIdentity(edit("grace-hopper"), "Grace Hopper", nobody)).toEqual({
      action: "welcome",
      key: "grace-hopper",
      displayName: "Grace Hopper",
      matched: false,
    });
  });

  it("greets an unknown key by reading its dashes as the spaces they were", () => {
    expect(resolveEntryIdentity(edit("grace-hopper"), null, nobody)).toEqual({
      action: "welcome",
      key: "grace-hopper",
      displayName: "grace hopper",
      matched: false,
    });
  });

  it("prefers a legal name over a stored legacy spelling for the same key", () => {
    const legacy: KnownPerson = { key: "ada-lovelace", displayName: "Ada-Lovelace" };
    expect(resolveEntryIdentity(edit("ada-lovelace"), null, [legacy])).toEqual({
      action: "welcome",
      key: "ada-lovelace",
      displayName: "ada lovelace",
      matched: true,
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

describe("inviteLink", () => {
  const base = "https://timeful.example/happy-hour";

  it("appends the URL-encoded name to the canonical URL", () => {
    expect(inviteLink(base, "Ada Lovelace")).toBe(`${base}?name=Ada%20Lovelace`);
  });

  it("trims before encoding", () => {
    expect(inviteLink(base, "  Ada Lovelace  ")).toBe(`${base}?name=Ada%20Lovelace`);
  });

  it("hands out the bare canonical URL for a blank name", () => {
    expect(inviteLink(base, "")).toBe(base);
    expect(inviteLink(base, "   ")).toBe(base);
  });

  it("refuses to personalize with an unusable name", () => {
    expect(inviteLink(base, "Ada-Lovelace")).toBe(base);
    expect(inviteLink(base, "a".repeat(MAX_GUEST_NAME_LENGTH + 1))).toBe(base);
  });

  it("round-trips through the entry decision to a welcome for that name", () => {
    // The producer and the consumer are two halves of one contract: whatever
    // the invite dialog generates, the root landing greets that invitee.
    const url = new URL(inviteLink(base, "Ada Lovelace"));
    const arrived = url.searchParams.get(ENTRY_NAME_PARAM);
    expect(resolveEntryIdentity(root(arrived), null, nobody)).toEqual({
      action: "welcome",
      key: "ada-lovelace",
      displayName: "Ada Lovelace",
      matched: false,
    });
  });
});
