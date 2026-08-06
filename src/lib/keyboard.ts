/**
 * Publishes how much of the screen the on-screen keyboard covers as
 * `--keyboard-inset` on `<html>`. The page holds still — a keyboard covers
 * the page, it does not resize it — and fixed elements pad off the inset.
 * Two signals feed it: Chromium answers `env(keyboard-inset-height)` only
 * after opting into `navigator.virtualKeyboard.overlaysContent`; iOS Safari
 * implements neither and only speaks through `window.visualViewport`. iOS
 * also *pans* the page to reveal a focused field — the pan shows up as
 * `offsetTop` and must come out of the inset, or a fixed sheet lands a
 * keyboard's height too low.
 */

/** The measurements a keyboard inset is derived from. */
export interface ViewportMetrics {
  /** `visualViewport.height` — what is left of the window above the keyboard. */
  height: number;
  /** `visualViewport.offsetTop` — how far the platform panned the page up. */
  offsetTop: number;
  /** `visualViewport.scale`. Anything above 1 is a pinch, not a keyboard. */
  scale: number;
}

// Below this it is not a keyboard: a URL bar sliding away nets out near zero
// but not always to the pixel.
export const KEYBOARD_MIN_INSET = 24;

/** Pure and exported: a browser cannot be asked to raise a keyboard from a test. */
export function keyboardInset(
  innerHeight: number,
  viewport: ViewportMetrics | null | undefined,
): number {
  if (!viewport) return 0;
  // A pinch shrinks the visual viewport exactly the way a keyboard does; ignore it.
  if (viewport.scale > 1.01) return 0;
  const covered = innerHeight - viewport.height - viewport.offsetTop;
  return covered > KEYBOARD_MIN_INSET ? Math.round(covered) : 0;
}

/** What the CSS variable should read for a given inset. */
export function keyboardInsetValue(inset: number): string {
  return `${inset}px`;
}

/** Only ever one installation: there is one document to publish onto. */
let uninstall: (() => void) | null = null;

/** Called once from the client entry; idempotent, and a no-op under SSR. */
export function installKeyboardInset(): () => void {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return () => {};
  }
  if (uninstall) return uninstall;

  // A narrow local shape rather than a lib.dom that does not have it yet.
  const nav = navigator as Navigator & {
    virtualKeyboard?: { overlaysContent: boolean };
  };
  if (nav.virtualKeyboard) {
    // What makes `env(keyboard-inset-height)` non-zero.
    nav.virtualKeyboard.overlaysContent = true;
  }

  const root = document.documentElement;
  const viewport = window.visualViewport;
  let frame = 0;
  let published = 0;

  function apply(): void {
    frame = 0;
    const inset = keyboardInset(window.innerHeight, viewport);
    if (inset === published) return;
    published = inset;
    root.style.setProperty("--keyboard-inset", keyboardInsetValue(inset));
  }

  // Both events fire in bursts while the keyboard animates; one frame's worth
  // of them is one write.
  function schedule(): void {
    if (frame !== 0) return;
    frame = window.requestAnimationFrame(apply);
  }

  viewport?.addEventListener("resize", schedule);
  viewport?.addEventListener("scroll", schedule);
  schedule();

  uninstall = () => {
    uninstall = null;
    if (frame !== 0) window.cancelAnimationFrame(frame);
    viewport?.removeEventListener("resize", schedule);
    viewport?.removeEventListener("scroll", schedule);
    root.style.removeProperty("--keyboard-inset");
  };
  return uninstall;
}
