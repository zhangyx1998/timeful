import { describe, expect, it } from "vitest";
import {
  ENTRY_NAME_PARAM,
  inviteLink,
  resolveEntryIdentity,
  type KnownPerson,
} from "./entry-identity";
import { MAX_GUEST_NAME_LENGTH } from "./user-key";

const nobody: KnownPerson[] = [];
const ada: KnownPerson = { key: "ada-lovelace", displayName: "Ada Lovelace" };

describe("resolveEntryIdentity", () => {
  it("does nothing without a query", () => {
    expect(resolveEntryIdentity(null, null, nobody)).toEqual({ action: "none" });
    expect(resolveEntryIdentity(null, "Grace Hopper", [ada])).toEqual({
      action: "none",
    });
  });

  it("treats an unusable query name exactly as no query", () => {
    // The same rules the identity dialog and the server enforce: empty,
    // over-long, or carrying a dash. None of them is a name to greet with.
    expect(resolveEntryIdentity("", null, nobody)).toEqual({ action: "none" });
    expect(resolveEntryIdentity("   ", null, nobody)).toEqual({ action: "none" });
    expect(resolveEntryIdentity("Ada-Lovelace", null, [ada])).toEqual({
      action: "none",
    });
    expect(
      resolveEntryIdentity("a".repeat(MAX_GUEST_NAME_LENGTH + 1), null, nobody),
    ).toEqual({ action: "none" });
  });

  it("welcomes a fresh name on a device that remembers nobody", () => {
    expect(resolveEntryIdentity(" Ada  Lovelace ", null, nobody)).toEqual({
      action: "welcome",
      key: "ada-lovelace",
      displayName: "Ada  Lovelace",
      matched: false,
    });
  });

  it("skips the prompt when the device already is that person", () => {
    // Matching is on keys, so spelling and spacing differences do not turn the
    // very same person into a question.
    expect(resolveEntryIdentity("Ada Lovelace", "Ada Lovelace", nobody)).toEqual({
      action: "skip",
    });
    expect(resolveEntryIdentity("ada  LOVELACE", "Ada Lovelace", [ada])).toEqual({
      action: "skip",
    });
  });

  it("welcomes the named person over a different remembered one", () => {
    // The query wins the first move by asking; whether the remembered identity
    // survives is decided by what the visitor confirms, not here.
    const decision = resolveEntryIdentity("Ada Lovelace", "Grace Hopper", nobody);
    expect(decision.action).toBe("welcome");
  });

  it("ignores a remembered name that is no longer legal", () => {
    // A legacy stored spelling with a dash cannot be anybody on this page, so
    // it cannot be the equal-key reason to skip — even though its key matches.
    const decision = resolveEntryIdentity("Ada Lovelace", "Ada-Lovelace", [ada]);
    expect(decision.action).toBe("welcome");
  });

  it("adopts the event's spelling when the key matches a respondent", () => {
    expect(resolveEntryIdentity("ada  LOVELACE", null, [ada])).toEqual({
      action: "welcome",
      key: "ada-lovelace",
      displayName: "Ada Lovelace",
      matched: true,
    });
  });

  it("keeps the typed spelling over a legacy one that cannot be written back", () => {
    const legacy: KnownPerson = { key: "ada-lovelace", displayName: "Ada-Lovelace" };
    expect(resolveEntryIdentity("Ada Lovelace", null, [legacy])).toEqual({
      action: "welcome",
      key: "ada-lovelace",
      displayName: "Ada Lovelace",
      matched: true,
    });
  });
});

describe("inviteLink", () => {
  const base = "https://timeful.example/happy-hour";

  it("appends the URL-encoded name to the canonical URL", () => {
    expect(inviteLink(base, "Ada Lovelace")).toBe(
      `${base}?name=Ada%20Lovelace`,
    );
  });

  it("trims before encoding", () => {
    expect(inviteLink(base, "  Ada Lovelace  ")).toBe(
      `${base}?name=Ada%20Lovelace`,
    );
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
    // the invite dialog generates, the welcome prompt greets that invitee.
    const url = new URL(inviteLink(base, "Ada Lovelace"));
    const arrived = url.searchParams.get(ENTRY_NAME_PARAM);
    expect(resolveEntryIdentity(arrived, null, nobody)).toEqual({
      action: "welcome",
      key: "ada-lovelace",
      displayName: "Ada Lovelace",
      matched: false,
    });
  });
});
