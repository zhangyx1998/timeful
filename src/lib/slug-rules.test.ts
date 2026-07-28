import { describe, expect, it } from "vitest";
import { MAX_SLUG_LENGTH, RESERVED_SLUGS, slugProblem } from "./slug-rules";

describe("slugProblem", () => {
  it("accepts a path of letters, digits and hyphens", () => {
    expect(slugProblem("standup")).toBeNull();
    expect(slugProblem("sprint-planning-2")).toBeNull();
    expect(slugProblem("7")).toBeNull();
    // Generated capability slugs are mixed-case base62 and must stay legal.
    expect(slugProblem("aZ09kQ2mBn4X")).toBeNull();
  });

  it("rejects an empty path", () => {
    expect(slugProblem("")).toBe("Slug is required");
  });

  it("rejects anything with a slash — a slug is one path segment", () => {
    const message = "Slug may only contain letters, numbers and hyphens";
    expect(slugProblem("abc/def")).toBe(message);
    expect(slugProblem("api/")).toBe(message);
    expect(slugProblem("api/xxx")).toBe(message);
    expect(slugProblem("/leading")).toBe(message);
  });

  it("rejects the other characters a path might carry", () => {
    const message = "Slug may only contain letters, numbers and hyphens";
    expect(slugProblem("with space")).toBe(message);
    expect(slugProblem("dot.separated")).toBe(message);
    expect(slugProblem("under_score")).toBe(message);
    expect(slugProblem("percent%20")).toBe(message);
    expect(slugProblem("query?a=1")).toBe(message);
    expect(slugProblem("hash#frag")).toBe(message);
    expect(slugProblem("café")).toBe(message);
  });

  it("rejects a leading underscore or dot by name", () => {
    const message = "Slug may not start with '_' or '.'";
    expect(slugProblem("_hidden")).toBe(message);
    expect(slugProblem(".well-known")).toBe(message);
    // Ahead of the character rule, which would also have caught them but says
    // less about why.
    expect(slugProblem("_")).toBe(message);
  });

  it("rejects a path longer than the maximum", () => {
    expect(slugProblem("a".repeat(MAX_SLUG_LENGTH))).toBeNull();
    expect(slugProblem("a".repeat(MAX_SLUG_LENGTH + 1))).toBe(
      `Slug must be at most ${MAX_SLUG_LENGTH} characters`,
    );
    // Length is checked before the character rule, so an over-long illegal
    // path reports the length.
    expect(slugProblem(`${"a".repeat(MAX_SLUG_LENGTH)}/x`)).toBe(
      `Slug must be at most ${MAX_SLUG_LENGTH} characters`,
    );
  });

  it("rejects the paths the server owns, in any case", () => {
    expect(slugProblem("api")).toBe("'api' is a reserved slug");
    expect(slugProblem("API")).toBe("'API' is a reserved slug");
    expect(slugProblem("Assets")).toBe("'Assets' is a reserved slug");
    // Only the whole segment is reserved.
    expect(slugProblem("apiary")).toBeNull();
    expect(slugProblem("my-api")).toBeNull();
  });

  it("names every reserved path in the set", () => {
    for (const reserved of RESERVED_SLUGS) {
      expect(slugProblem(reserved)).toBe(`'${reserved}' is a reserved slug`);
    }
  });
});
