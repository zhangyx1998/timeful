/**
 * How much of the screen the on-screen keyboard is covering, as a CSS variable.
 *
 * The page used to be resized to make room for it —
 * `interactive-widget=resizes-content` — which is the cheapest possible fix and
 * the wrong one here. The phone layout is `height: 100dvh` with the chart sized
 * off whatever the chrome leaves (see `EventPage`), so a keyboard inside the
 * layout viewport re-laid the entire app out: the chart lost half its height,
 * every column moved, and all of it snapped back when the field was dismissed.
 * A keyboard covers the page. It does not resize it.
 *
 * So the page holds still and the few things that must stay visible above the
 * keyboard pad themselves off an inset, exactly the way everything fixed to an
 * edge already pads off `--safe-*`. There is no single signal for that, so
 * there are two and the token takes the larger (`--overlay-bottom`,
 * `tokens.css`):
 *
 * - **Chromium** answers `env(keyboard-inset-height)`, but only after the page
 *   opts into `navigator.virtualKeyboard.overlaysContent`. That is the whole
 *   reason the opt-in is here rather than being implied by the meta tag.
 * - **iOS Safari** implements neither, and `window.visualViewport` is the only
 *   thing it will say. That measurement is what this module publishes as
 *   `--keyboard-inset`.
 *
 * The visualViewport reading is also what handles iOS's habit of *panning* the
 * page to bring a focused field into view: the pan shows up as `offsetTop`, and
 * a fixed element is still positioned against the layout viewport, so the pan
 * has to come out of the inset or a sheet lands a keyboard's height too low.
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

/**
 * Below this, it is not a keyboard.
 *
 * A URL bar sliding away moves `innerHeight` and `visualViewport.height`
 * together and nets out at zero, but not always to the pixel, and a sheet that
 * twitched two pixels every time the page was scrolled would be worse than one
 * that ignored a keyboard nobody can fit on a screen anyway.
 */
export const KEYBOARD_MIN_INSET = 24;

/**
 * The height the keyboard is covering, in CSS pixels, or 0 when there is none.
 *
 * Pure, and exported for that reason: this is the whole of the arithmetic, and
 * a browser cannot be asked to raise a keyboard on demand from a test.
 */
export function keyboardInset(
  innerHeight: number,
  viewport: ViewportMetrics | null | undefined,
): number {
  if (!viewport) return 0;
  // A pinch shrinks the visual viewport exactly the way a keyboard does, and
  // pinching to read a busy chart is a thing people do. Reading one as the
  // other would shove every sheet up the screen for as long as the zoom lasted.
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

/**
 * Opts into the Chromium API, starts measuring, and publishes
 * `--keyboard-inset` on `<html>`.
 *
 * Called once from the client entry. Returns the teardown, and calling it again
 * while it is already installed is the same installation rather than a second
 * one. Server-side there is no window, so it is a no-op that hands back a no-op.
 */
export function installKeyboardInset(): () => void {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return () => {};
  }
  if (uninstall) return uninstall;

  // A narrow local shape rather than a lib.dom that does not have it yet.
  // Type-only, so nothing survives type stripping.
  const nav = navigator as Navigator & {
    virtualKeyboard?: { overlaysContent: boolean };
  };
  if (nav.virtualKeyboard) {
    // What makes `env(keyboard-inset-height)` non-zero. The meta tag alone
    // stops the resize; this is what asks to be told about it instead.
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

  // Both events fire in bursts while the keyboard animates. One frame's worth
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
