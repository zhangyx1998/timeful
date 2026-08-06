/**
 * Phone-vs-desktop layout and the chart's column count, off one measurement.
 * A `resize` listener, not a media query: there is no query for "how many columns".
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
