import { describe, expect, it } from "vitest";
import { randomSlug, SLUG_ALPHABET, SLUG_LENGTH, slugProblem } from "./slugs.ts";

describe("randomSlug", () => {
  it("is 12 base62 characters by default", () => {
    expect(SLUG_LENGTH).toBe(12);
    for (let i = 0; i < 200; i += 1) {
      expect(randomSlug()).toMatch(/^[0-9A-Za-z]{12}$/);
    }
  });

  it("honours an explicit length", () => {
    expect(randomSlug(1)).toHaveLength(1);
    expect(randomSlug(40)).toHaveLength(40);
    expect(randomSlug(40)).toMatch(/^[0-9A-Za-z]{40}$/);
  });

  it("does not repeat itself", () => {
    const seen = new Set(Array.from({ length: 5000 }, () => randomSlug()));
    expect(seen.size).toBe(5000);
  });

  it("draws every symbol about equally often (no modulo bias)", () => {
    const perSymbol = 400;
    const total = SLUG_ALPHABET.length * perSymbol; // 24800 characters
    const counts = new Map<string, number>();
    let drawn = "";
    while (drawn.length < total) drawn += randomSlug(64);

    for (const char of drawn.slice(0, total)) {
      counts.set(char, (counts.get(char) ?? 0) + 1);
    }

    // Every symbol must appear, and stay inside ~6 standard deviations
    // (sd ≈ 19.8 at this sample size) of the expected count.
    expect(counts.size).toBe(SLUG_ALPHABET.length);
    for (const symbol of SLUG_ALPHABET) {
      const count = counts.get(symbol) ?? 0;
      expect(count).toBeGreaterThan(perSymbol - 120);
      expect(count).toBeLessThan(perSymbol + 120);
    }
  });
});

describe("slugProblem", () => {
  it("accepts generated capability slugs", () => {
    for (let i = 0; i < 100; i += 1) {
      expect(slugProblem(randomSlug())).toBeNull();
    }
  });

  it("accepts sensible custom slugs", () => {
    expect(slugProblem("my-party")).toBeNull();
    expect(slugProblem("Team-Offsite-2026")).toBeNull();
    expect(slugProblem("a")).toBeNull();
  });

  it("rejects empty, overlong and structurally invalid slugs", () => {
    expect(slugProblem("")).toMatch(/required/);
    expect(slugProblem("x".repeat(81))).toMatch(/at most 80/);
    expect(slugProblem("-leading-hyphen")).toMatch(/may only contain/);
    expect(slugProblem("has space")).toMatch(/may only contain/);
    expect(slugProblem("has/slash")).toMatch(/may only contain/);
    expect(slugProblem("dotted.name")).toMatch(/may only contain/);
    expect(slugProblem("emoji-🎉")).toMatch(/may only contain/);
  });

  it("rejects the reserved prefixes and paths", () => {
    expect(slugProblem("_private")).toMatch(/may not start with/);
    expect(slugProblem(".hidden")).toMatch(/may not start with/);
    expect(slugProblem("api")).toMatch(/reserved/);
    // Express routing is case-insensitive, so /API is /api.
    expect(slugProblem("API")).toMatch(/reserved/);
    expect(slugProblem("assets")).toMatch(/reserved/);
    expect(slugProblem("Assets")).toMatch(/reserved/);
    // Not reserved: only the exact names are.
    expect(slugProblem("apiary")).toBeNull();
  });
});
