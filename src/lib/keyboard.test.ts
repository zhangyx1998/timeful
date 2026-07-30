/**
 * The keyboard inset, as arithmetic.
 *
 * No browser can be asked to raise a keyboard from a test, which is exactly why
 * the measurement is a pure function taking the three numbers `visualViewport`
 * reports rather than reading them itself. What is asserted here is the reading
 * of those numbers on each platform that produces them, written down as the
 * cases they actually occur in.
 */
import { describe, expect, it } from "vitest";
import { KEYBOARD_MIN_INSET, keyboardInset, keyboardInsetValue } from "./keyboard";

/** A 390x844 phone, the way `visualViewport` describes it. */
const phone = (over: Partial<{ height: number; offsetTop: number; scale: number }> = {}) => ({
  height: 844,
  offsetTop: 0,
  scale: 1,
  ...over,
});

describe("keyboardInset", () => {
  it("is zero with no keyboard", () => {
    expect(keyboardInset(844, phone())).toBe(0);
  });

  it("is zero where there is no visualViewport at all", () => {
    // Everything downstream reads the token, which stays 0px, so a browser that
    // reports nothing behaves exactly as it did before any of this existed.
    expect(keyboardInset(844, null)).toBe(0);
    expect(keyboardInset(844, undefined)).toBe(0);
  });

  it("measures what a keyboard is covering", () => {
    // Android/Chromium with `overlays-content`: the layout viewport is
    // unchanged and only the visual one shrinks.
    expect(keyboardInset(844, phone({ height: 508 }))).toBe(336);
  });

  it("takes the page's own pan out of it", () => {
    // iOS Safari scrolls the page up to bring a focused field into view. A
    // fixed element is still placed against the layout viewport, so the pan is
    // not room the sheet has gained — it has to come out of the inset, or the
    // sheet lands that far below the keys.
    expect(keyboardInset(844, phone({ height: 508, offsetTop: 120 }))).toBe(216);
  });

  it("ignores a pinch, which shrinks the viewport the same way", () => {
    // Zooming into a busy chart is a thing people do, and this app deliberately
    // does not take pinch-to-zoom away.
    expect(keyboardInset(844, phone({ height: 400, scale: 2 }))).toBe(0);
  });

  it("ignores a viewport that is a few pixels out", () => {
    // A URL bar sliding away moves both numbers together, but not always to the
    // pixel. A sheet that twitched on every scroll would be worse than one that
    // ignored a keyboard nobody could type on.
    expect(keyboardInset(844, phone({ height: 844 - KEYBOARD_MIN_INSET }))).toBe(0);
    expect(keyboardInset(844, phone({ height: 844 - KEYBOARD_MIN_INSET - 1 }))).toBe(
      KEYBOARD_MIN_INSET + 1,
    );
  });

  it("never goes negative", () => {
    // A visual viewport taller than the layout one happens mid-rotation.
    expect(keyboardInset(844, phone({ height: 900 }))).toBe(0);
  });

  it("rounds to whole pixels", () => {
    expect(keyboardInset(844, phone({ height: 507.4 }))).toBe(337);
    expect(keyboardInsetValue(337)).toBe("337px");
    expect(keyboardInsetValue(0)).toBe("0px");
  });
});
