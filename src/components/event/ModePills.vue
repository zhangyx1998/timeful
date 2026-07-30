<script setup lang="ts">
/**
 * What the chart is doing to itself, floating over the chart it is doing it to.
 *
 * The group view has two modes that change what the colours mean without
 * changing anything you can see a control for: **best times**, which throws
 * away every slot that is not one of the fullest, and **isolation**, which
 * throws away everybody but one person. Both leave a heatmap that looks like a
 * perfectly ordinary heatmap of a different event — a chart with two cells lit
 * is exactly what "hardly anybody is free" looks like — so each needs something
 * on screen saying it is on, and a way out that is where you are already
 * looking.
 *
 * **One chip per mode, stacked, not merged.** A merged chip would have to fit
 * two labels and two crosses into 360px minus the chart's margins, with one of
 * the labels being somebody's name — so either the name is cut to nothing or
 * the chip wraps, and a wrapped chip is a stack that has lost its edges. Two
 * chips are also two independent facts with two independent ways out, which is
 * what they are. Isolation keeps the lower slot so that turning best times on
 * or off does not move the chip you were about to press.
 *
 * Fixed to the viewport rather than to the chart, and centred, because the
 * desktop's chart is taller than the screen and a label pinned to the bottom of
 * it would be below the fold exactly when you are reading the part you scrolled
 * to. The offset clears the phone's identity bar, which is the only thing that
 * shares this corner.
 *
 * The material is the glass in `tokens.css`: what a chip covers is the thing it
 * is describing, so it is translucent and blurred rather than opaque — and it
 * falls back to a solid surface where `backdrop-filter` is missing or where
 * less transparency has been asked for.
 */
import IconEye from "../../assets/icons/eye.svg";
import IconStar from "../../assets/icons/star.svg";
import IconClose from "../../assets/icons/close-sm.svg";

defineProps<{
  /** The name whose answer is on the chart alone, or null for the group's. */
  isolated: string | null;
  /** Whether the chart is showing only the fullest slots. */
  bestTimes: boolean;
}>();

const emit = defineEmits<{ "exit-isolation": []; "exit-best-times": [] }>();
</script>

<template>
  <div v-if="isolated !== null || bestTimes" class="pills" role="status">
    <div v-if="bestTimes" class="pill">
      <IconStar class="pill__glyph" aria-hidden="true" />
      <span class="pill__text">Best times only</span>
      <button
        type="button"
        class="pill__exit"
        aria-label="Show every time again"
        title="Show every time again"
        @click="emit('exit-best-times')"
      >
        <IconClose aria-hidden="true" />
      </button>
    </div>

    <div v-if="isolated !== null" class="pill">
      <IconEye class="pill__glyph" aria-hidden="true" />
      <!-- One line, whatever the name: the chip floats over the chart, and one
           that grew a second line would cover the thing it is describing. -->
      <span class="pill__text" :title="isolated">{{ isolated }}’s availability</span>
      <button
        type="button"
        class="pill__exit"
        aria-label="Show everyone again"
        title="Show everyone again"
        @click="emit('exit-isolation')"
      >
        <IconClose aria-hidden="true" />
      </button>
    </div>
  </div>
</template>

<style scoped>
/* The stack takes no pointer events of its own: the gaps between chips are over
   the chart, and a chart cell under one of them still has to be tappable. */
.pills {
  position: fixed;
  bottom: 1.25rem;
  left: 50%;
  z-index: 20;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.3rem;
  max-width: min(24rem, calc(100vw - 1.5rem));
  transform: translateX(-50%);
  pointer-events: none;
}

.pill {
  display: flex;
  align-items: center;
  gap: 0.3rem;
  max-width: 100%;
  padding: 0.15rem 0.15rem 0.15rem 0.5rem;
  pointer-events: auto;
  font-size: 0.75rem;
  line-height: 1.4;
  color: var(--color-text);
  /* The floor, and what a browser with no backdrop-filter keeps. */
  background: var(--color-glass-solid);
  border: 1px solid var(--color-glass-border);
  border-radius: var(--radius-pill);
  /* The specular edge: a hairline of light along the top inside, which is what
     makes the chip read as a pane with a thickness rather than a painted
     rectangle. Kept in the same declaration as the drop shadow so a browser
     applies one box-shadow list rather than two. */
  box-shadow: inset 0 1px 0 var(--color-glass-highlight), var(--shadow-glass);
}

/* The glass proper, only where there is something to see through it. */
@supports ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) {
  .pill {
    background: var(--color-glass);
    -webkit-backdrop-filter: var(--blur-glass);
    backdrop-filter: var(--blur-glass);
  }
}

/* Asked for plainly: the same chip, opaque. */
@media (prefers-reduced-transparency: reduce) {
  .pill {
    background: var(--color-glass-solid);
    -webkit-backdrop-filter: none;
    backdrop-filter: none;
  }
}

/* A stronger edge for anyone who needs one; the fill is already at token
   contrast, so what is worth strengthening is the outline. */
@media (prefers-contrast: more) {
  .pill {
    background: var(--color-glass-solid);
    -webkit-backdrop-filter: none;
    backdrop-filter: none;
    border-color: var(--color-border-strong);
  }
}

.pill__glyph {
  flex: none;
  width: 0.85rem;
  height: 0.85rem;
  color: var(--color-accent);
}

.pill__text {
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

/* Divided from the label by a rule rather than by space: it is a second control
   on one chip, and the two must not read as one long button. */
.pill__exit {
  position: relative;
  display: grid;
  flex: none;
  place-items: center;
  width: 1.35rem;
  height: 1.35rem;
  padding: 0;
  color: var(--color-text-muted);
  background: none;
  border: none;
  border-left: 1px solid var(--color-glass-border);
  border-radius: 0 var(--radius-pill) var(--radius-pill) 0;
  cursor: pointer;
  transition: color var(--transition-fast), background var(--transition-fast);
}

.pill__exit svg {
  width: 0.65rem;
  height: 0.65rem;
}

.pill__exit:hover {
  color: var(--color-text);
  background: var(--color-subtle);
}

.pill__exit:focus-visible {
  outline: var(--focus-ring);
  outline-offset: calc(var(--focus-ring-offset) * -1);
}

/* The chip stays small under a finger — it is covering the chart, and a chip
   sized for a thumb covers a lot of it — so the target grows instead of the
   button: an invisible 44px box centred on the cross. */
@media (pointer: coarse) {
  .pill {
    padding: 0.2rem 0.2rem 0.2rem 0.6rem;
  }

  .pill__exit {
    width: 1.6rem;
    height: 1.6rem;
  }

  .pill__exit::after {
    content: "";
    position: absolute;
    top: 50%;
    left: 50%;
    width: var(--tap-min);
    height: var(--tap-min);
    transform: translate(-50%, -50%);
  }
}

/* The phone stacks the identity bar along this edge under the chart, and the
   stack has to clear it or the lowest chip lands on top of a control. */
@media (max-width: 820px) {
  .pills {
    bottom: calc(4.75rem + var(--safe-bottom));
  }
}

@media (prefers-reduced-motion: reduce) {
  .pill__exit {
    transition: none;
  }
}
</style>
