<script setup lang="ts">
// Chips saying what the group view is doing to itself (best times, isolation), with the
// way out: a filtered heatmap looks like an ordinary heatmap of a different event.
// One chip per mode; isolation keeps the lower slot so toggling best times does not move it.
import IconEye from "../../assets/icons/eye.svg";
import IconStar from "../../assets/icons/star.svg";
import IconClose from "../../assets/icons/close-sm.svg";

defineProps<{
  isolated: string | null;
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
/* No pointer events on the stack: the gaps between chips sit over tappable chart cells. */
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
  /* Specular inset edge; one declaration so the browser applies one box-shadow list. */
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

@media (prefers-reduced-transparency: reduce) {
  .pill {
    background: var(--color-glass-solid);
    -webkit-backdrop-filter: none;
    backdrop-filter: none;
  }
}

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

.pill__exit {
  --focus-ring-inset: calc(var(--focus-ring-offset) * -1);

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

/* The chip stays small; an invisible 44px box centred on the cross carries the tap target. */
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

/* Clears the phone's identity bar. */
@media (max-width: 820px) {
  .pills {
    bottom: calc(4.75rem + var(--safe-bottom));
  }
}
</style>
