/**
 * The toggle's sun/moon animation is pure CSS: the knob slides and the icons
 * cross-fade because a rule keyed off `html[data-theme="dark"]` (or the dark
 * media query) matches the knob. That rule has to survive the scoped-style
 * compiler, and once it did not: wrapping the `html` ancestor in `:global()`
 * makes the compiler drop everything after it and emit `html[data-theme=dark]
 * { transform: … }`, which styles the root element instead of the knob. The
 * switch then never moved and the icon was always a sun, while the palette
 * still flipped — so nothing else in the app looked wrong.
 *
 * Compiling the real SFC is the only way to catch that: the source looks
 * correct either way, and jsdom does not apply stylesheets.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compileStyle, parse } from "@vue/compiler-sfc";
import { describe, expect, it } from "vitest";

const SCOPE_ID = "data-v-test";

const component = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "ThemeToggle.vue",
);

/** The component's `<style scoped>` block, run through the SFC compiler. */
function compiledCss(): string {
  const { descriptor } = parse(fs.readFileSync(component, "utf8"));
  const style = descriptor.styles[0];
  if (!style?.scoped) throw new Error("ThemeToggle.vue must have a scoped style block");
  const result = compileStyle({
    source: style.content,
    filename: "ThemeToggle.vue",
    id: SCOPE_ID,
    scoped: true,
  });
  expect(result.errors).toHaveLength(0);
  return result.code;
}

/** Selectors of every emitted rule, with comments stripped and space collapsed. */
function selectors(css: string): string[] {
  return [...css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{[^{}]*\}/g)]
    .map((match) => match[1].replace(/\s+/g, " ").trim())
    .filter((selector) => selector !== "" && !selector.startsWith("@"));
}

describe("ThemeToggle scoped styles", () => {
  const css = compiledCss();
  const rules = selectors(css);

  it("moves the knob and swaps the icons under an explicit dark override", () => {
    const dark = rules.filter((rule) => rule.includes('[data-theme="dark"]'));
    expect(dark).toEqual([
      `html[data-theme="dark"] .knob[${SCOPE_ID}]`,
      `html[data-theme="dark"] .icon--sun[${SCOPE_ID}]`,
      `html[data-theme="dark"] .icon--moon[${SCOPE_ID}]`,
    ]);
  });

  it("does the same when the system is dark and nothing is overridden", () => {
    const system = rules.filter((rule) => rule.includes(':not([data-theme="light"])'));
    expect(system).toEqual([
      `html:not([data-theme="light"]) .knob[${SCOPE_ID}]`,
      `html:not([data-theme="light"]) .icon--sun[${SCOPE_ID}]`,
      `html:not([data-theme="light"]) .icon--moon[${SCOPE_ID}]`,
    ]);
  });

  it("never targets a bare ancestor, which would style <html> itself", () => {
    // This is the exact shape the `:global()` bug produced.
    for (const rule of rules) {
      expect(rule).not.toMatch(/^html[^ ]*$/);
    }
  });

  it("keeps every rule scoped to this component", () => {
    for (const rule of rules) {
      expect(rule).toContain(`[${SCOPE_ID}]`);
    }
  });

  it("takes its colors from tokens rather than literal hex", () => {
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });
});
