<script setup lang="ts">
/**
 * What the chart is showing, while it is showing one person.
 *
 * The isolated view used to be self-evident: it only existed while a drawer
 * was open and collapsed to the row it was about, so the thing that set it was
 * still on screen saying so. Now that it outlives the drawer, a heatmap with
 * one person's answer on it looks exactly like a heatmap of a group where one
 * person answered — and there would be nothing anywhere to say otherwise, or
 * to undo it.
 *
 * So: one line over the chart, naming whose answer is on it, with the way out
 * at the end. Fixed to the viewport rather than to the chart, and centred,
 * because the desktop's chart is taller than the screen and a label pinned to
 * the bottom of it would be somewhere below the fold exactly when you are
 * reading the part you scrolled to. The offset clears the phone's identity bar,
 * which is the only thing that shares this corner.
 */
import IconEye from "../../assets/icons/eye.svg";
import IconClose from "../../assets/icons/close-sm.svg";

defineProps<{ name: string }>();
const emit = defineEmits<{ exit: [] }>();
</script>

<template>
  <div class="pill" role="status">
    <IconEye class="pill__glyph" aria-hidden="true" />
    <!-- One line, whatever the name: the pill floats over the chart, and one
         that grew a second line would cover the thing it is describing. -->
    <span class="pill__text" :title="name">{{ name }}’s availability</span>
    <button
      type="button"
      class="pill__exit"
      aria-label="Show everyone again"
      title="Show everyone again"
      @click="emit('exit')"
    >
      <IconClose aria-hidden="true" />
    </button>
  </div>
</template>

<style scoped>
.pill {
  position: fixed;
  bottom: 1.25rem;
  left: 50%;
  z-index: 20;
  display: flex;
  align-items: center;
  gap: 0.4rem;
  max-width: min(22rem, calc(100vw - 2rem));
  padding: 0.3rem 0.3rem 0.3rem 0.6rem;
  transform: translateX(-50%);
  font-size: 0.8125rem;
  color: var(--color-text);
  background: var(--color-raised);
  border: 1px solid var(--color-border-strong);
  border-radius: var(--radius-pill);
  box-shadow: var(--shadow-md);
}

.pill__glyph {
  flex: none;
  width: 0.95rem;
  height: 0.95rem;
  color: var(--color-accent);
}

.pill__text {
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

/* Divided from the label by a rule rather than by space: it is a second
   control on one chip, and the two must not read as one long button. */
.pill__exit {
  display: grid;
  flex: none;
  place-items: center;
  width: 1.5rem;
  height: 1.5rem;
  padding: 0;
  margin-left: 0.1rem;
  color: var(--color-text-muted);
  background: none;
  border: none;
  border-left: 1px solid var(--color-border);
  border-radius: 0 var(--radius-pill) var(--radius-pill) 0;
  cursor: pointer;
  transition: color var(--transition-fast), background var(--transition-fast);
}

.pill__exit svg {
  width: 0.7rem;
  height: 0.7rem;
}

.pill__exit:hover {
  color: var(--color-text);
  background: var(--color-subtle);
}

.pill__exit:focus-visible {
  outline: var(--focus-ring);
  outline-offset: calc(var(--focus-ring-offset) * -1);
}

/* The phone stacks two rows along this edge under the chart — the foot with the
   best-times filter, then the identity bar — and the pill has to clear both or
   it lands on top of a control. Isolation is a group-view thing and the group
   view always has that foot, so one offset covers every case it can appear in. */
@media (max-width: 820px) {
  .pill {
    bottom: calc(7.5rem + var(--safe-bottom));
  }
}

@media (pointer: coarse) {
  .pill {
    padding: 0.35rem 0.35rem 0.35rem 0.7rem;
  }

  .pill__exit {
    width: 2.1rem;
    height: 2.1rem;
  }
}

@media (prefers-reduced-motion: reduce) {
  .pill__exit {
    transition: none;
  }
}
</style>
