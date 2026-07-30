import { describe, expect, it } from "vitest";
import {
  adoptDisplayName,
  guestNameProblem,
  legacyUserKey,
  MAX_GUEST_NAME_LENGTH,
  userKey,
  userKeyFromParam,
} from "./user-key";

describe("userKey", () => {
  const table: Array<[string, string]> = [
    ["Ada Lovelace", "ada-lovelace"],
    ["  Ada   Lovelace ", "ada-lovelace"],
    ["ada  LOVELACE", "ada-lovelace"],
    ["ADA LOVELACE", "ada-lovelace"],
    ["Ada", "ada"],
    ["\tAda\nLovelace\r\n", "ada-lovelace"],
    // Non-breaking and thin spaces: whitespace to `trim()` and to `\s`, so
    // they collapse like any other run rather than surviving into the key.
    ["Ada Lovelace", "ada-lovelace"],
    [" Ada  Lovelace ", "ada-lovelace"],
    ["Ada Lovelace Byron", "ada-lovelace-byron"],
    ["ÉLODIE", "élodie"],
    ["山田 太郎", "山田-太郎"],
  ];

  for (const [raw, expected] of table) {
    it(`maps ${JSON.stringify(raw)} to ${expected}`, () => {
      expect(userKey(raw)).toBe(expected);
    });
  }

  it("is idempotent on its own output", () => {
    for (const [raw] of table) {
      const once = userKey(raw);
      expect(userKey(once)).toBe(once);
    }
  });

  it("is injective over names with no dash in them", () => {
    // The whole point of forbidding dashes: two legal names that differ by
    // anything but whitespace and case can never collide.
    expect(userKey("ada b")).not.toBe(userKey("adab"));
    expect(userKey("a b")).toBe(userKey("a  B"));
  });
});

describe("legacyUserKey", () => {
  it("reads a legacy dash as the space it stands in for", () => {
    expect(legacyUserKey("Ada-Lovelace")).toBe("ada-lovelace");
    expect(legacyUserKey("Ada Lovelace")).toBe("ada-lovelace");
    expect(legacyUserKey("ada--lovelace")).toBe("ada-lovelace");
    expect(legacyUserKey(" Ada - Lovelace ")).toBe("ada-lovelace");
  });

  it("agrees with userKey once the name is dash-free", () => {
    expect(legacyUserKey("Grace Hopper")).toBe(userKey("Grace Hopper"));
  });
});

describe("guestNameProblem", () => {
  it("accepts an ordinary name", () => {
    expect(guestNameProblem("Ada Lovelace")).toBeNull();
    expect(guestNameProblem("  Ada Lovelace  ")).toBeNull();
    expect(guestNameProblem("山田 太郎")).toBeNull();
  });

  it("requires something", () => {
    expect(guestNameProblem("")).toBe("A name is required");
    expect(guestNameProblem("   ")).toBe("A name is required");
  });

  it("caps the length after trimming", () => {
    expect(guestNameProblem("a".repeat(MAX_GUEST_NAME_LENGTH))).toBeNull();
    expect(guestNameProblem(` ${"a".repeat(MAX_GUEST_NAME_LENGTH)} `)).toBeNull();
    expect(guestNameProblem("a".repeat(MAX_GUEST_NAME_LENGTH + 1))).toBe(
      `A name must be at most ${MAX_GUEST_NAME_LENGTH} characters`,
    );
  });

  it("rejects a dash wherever it sits", () => {
    const problem = "A name may not contain a dash — use spaces instead";
    expect(guestNameProblem("Ada-Lovelace")).toBe(problem);
    expect(guestNameProblem("-Ada")).toBe(problem);
    expect(guestNameProblem("Ada -")).toBe(problem);
    expect(guestNameProblem("Jean-Luc Picard")).toBe(problem);
  });
});

describe("userKeyFromParam", () => {
  it("normalizes whatever spelling arrives in the path", () => {
    expect(userKeyFromParam("ada-lovelace")).toBe("ada-lovelace");
    expect(userKeyFromParam("Ada Lovelace")).toBe("ada-lovelace");
    expect(userKeyFromParam("  ADA   LOVELACE  ")).toBe("ada-lovelace");
  });

  it("rejects an empty or over-long segment", () => {
    expect(userKeyFromParam("")).toBeNull();
    expect(userKeyFromParam("   ")).toBeNull();
    expect(userKeyFromParam("a".repeat(MAX_GUEST_NAME_LENGTH + 1))).toBeNull();
  });
});

describe("adoptDisplayName", () => {
  it("keeps the spelling the event already carries", () => {
    // Two people who type the same name differently are one person, and the
    // group should keep seeing the name it knows rather than having it
    // rewritten by whoever answered most recently.
    expect(adoptDisplayName("ada  LOVELACE", "Ada Lovelace")).toBe("Ada Lovelace");
    expect(adoptDisplayName("  ADA LOVELACE  ", "Ada Lovelace")).toBe("Ada Lovelace");
  });

  it("takes the typed one when the event has nobody under that key", () => {
    expect(adoptDisplayName("  Ada   Lovelace ", undefined)).toBe("Ada   Lovelace");
    expect(adoptDisplayName("Ada Lovelace", "")).toBe("Ada Lovelace");
  });

  it("replaces a legacy spelling that could not be written back", () => {
    // A grandfathered name with a dash in it is readable but no longer legal,
    // so saving under that key needs the new spelling. The key is the same
    // either way, which is what makes the swap the same person's answer.
    expect(adoptDisplayName("Ada Lovelace", "Ada-Lovelace")).toBe("Ada Lovelace");
    expect(userKey("Ada-Lovelace")).toBe(userKey("Ada Lovelace"));
  });
});
