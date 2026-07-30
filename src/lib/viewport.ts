/**
 * Which of the two event pages this is, and how much of the chart fits.
 *
 * One measurement decides both, which is why they are one composable: below
 * `COMPACT_MAX_WIDTH` the page is an app — viewport-locked, controls in drawers
 * — and above it a document, and the column count is derived from the same
 * width either way (`perViewFor`).
 *
 * A `resize` listener rather than a media query, because the second half of the
 * answer is a number rather than a boolean and there is no query for "how many
 * columns". Registered on mount and removed on unmount, so a component using
 * this leaves nothing behind.
 */
import { onBeforeUnmount, onMounted, ref, type Ref } from "vue";
import { COMPACT_MAX_WIDTH, DESKTOP_PER_VIEW, perViewFor } from "./grid";

export interface Viewport {
  /** The phone layout: a viewport-locked chart with its controls in drawers. */
  compact: Ref<boolean>;
  /** Day columns a viewport of the chart holds; the rest is scrolled to. */
  perView: Ref<number>;
}

export function useViewport(): Viewport {
  const compact = ref(false);
  const perView = ref(DESKTOP_PER_VIEW);

  function measure(): void {
    const width = window.innerWidth;
    compact.value = width <= COMPACT_MAX_WIDTH;
    perView.value = perViewFor(width, compact.value);
  }

  onMounted(() => {
    measure();
    window.addEventListener("resize", measure);
  });

  onBeforeUnmount(() => window.removeEventListener("resize", measure));

  return { compact, perView };
}
