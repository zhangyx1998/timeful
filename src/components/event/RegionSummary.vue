<script setup lang="ts">
// Who is free across the drawn region, floated over the chart. `regionDigest` gives each
// person the worst thing they said anywhere inside it; a one-cell region is the plain slot reading.
import { computed, nextTick, onMounted, ref, watch } from "vue";
import {
  placeOverlay,
  regionDigest,
  toneFor,
  STANCE_LABELS,
  type OverlayField,
  type ResponseIndex,
} from "../../lib/grid";
import IconCheck from "../../assets/icons/check.svg";
import IconHourglass from "../../assets/icons/hourglass.svg";
import IconClose from "../../assets/icons/close-sm.svg";

const props = defineProps<{
  slotIds: number[];
  responseIndex: ResponseIndex;
  label: string;
  /** Region centre; clearance is the region's half-height, so the card lands clear of the whole rectangle. */
  anchor: { x: number; y: number; clearance: number };
  field: OverlayField;
}>();

const emit = defineEmits<{
  dismiss: [];
}>();

/** Eight chips keep the card under about a third of the chart on the narrowest phone. */
const SUMMARY_CAP = 8;
/** Clearance from the chart's own edges. */
const SUMMARY_GAP = 8;

/** Exposed: the chart asks this element `contains()` to tell a press on the card from one outside it. */
const element = ref<HTMLElement | null>(null);
// Content-sized, so it is rendered once unplaced and invisible, measured, then shown.
const size = ref<{ width: number; height: number } | null>(null);

function measure() {
  const root = element.value;
  if (root) size.value = { width: root.offsetWidth, height: root.offsetHeight };
}

onMounted(measure);

// Re-measure on content change; the old size is kept until the new one is read,
// so the card does not blink out under a drag.
watch(
  () => props.slotIds,
  () => void nextTick(measure),
);

const digest = computed(() => regionDigest(props.slotIds, props.responseIndex, { cap: SUMMARY_CAP }));

const whole = computed(() => props.slotIds.length > 1);

const tone = computed(() => toneFor(digest.value.free, digest.value.total));

// Above by preference: a finger covers what it has just touched.
const placement = computed(() => {
  const box = size.value;
  if (!box) return { left: props.anchor.x, top: props.anchor.y };
  return placeOverlay(box, props.field, {
    x: props.anchor.x,
    y: props.anchor.y,
    clearance: props.anchor.clearance,
    gap: SUMMARY_GAP,
    above: true,
  });
});

const placed = computed(() => size.value !== null);

defineExpose({ element });
</script>

<template>
  <div
    ref="element"
    class="digest"
    :class="{ 'digest--placed': placed }"
    role="group"
    :aria-label="whole ? `Who is free throughout ${label}` : `Who is free at ${label}`"
    :style="{ left: `${placement.left}px`, top: `${placement.top}px` }"
  >
    <div class="digest__head">
      <span class="digest__when" :title="label">{{ label }}</span>
      <button type="button" class="digest__close" aria-label="Dismiss" @click="emit('dismiss')">
        <IconClose width="14" height="14" aria-hidden="true" />
      </button>
    </div>

    <p v-if="digest.total === 0" class="digest__none">No answers yet.</p>

    <template v-else>
      <p class="digest__count" :class="`digest__count--${tone}`">
        {{ digest.free }} of {{ digest.total }} free{{ whole ? " throughout" : "" }}
      </p>

      <ul class="digest__people">
        <li
          v-for="person in digest.people"
          :key="person.key"
          class="who"
          :class="`who--${person.stance}`"
          :title="person.label"
        >
          <!-- The glyph carries the stance for the accessibility tree; it is not decoration. -->
          <span class="who__mark" role="img" :aria-label="STANCE_LABELS[person.stance]">
            <IconCheck v-if="person.stance === 'available'" />
            <IconHourglass v-else-if="person.stance === 'if_needed'" />
            <IconClose v-else stroke-width="2.2" />
          </span>
          <span class="who__name">{{ person.label }}</span>
        </li>
        <li v-if="digest.hidden > 0 && digest.people.length > 0" class="who who--more">
          +{{ digest.hidden }} more
        </li>
      </ul>
    </template>
  </div>
</template>

<style scoped>
/* Unplaced until measured: the first frame is laid out where the tap was and hidden. */
.digest {
  position: absolute;
  z-index: 18;
  width: max-content;
  max-width: min(15rem, 100%);
  transform: translateX(-50%);
  padding: 0.4rem 0.5rem 0.5rem;
  background: var(--color-raised);
  border: 1px solid var(--color-border-strong);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-md);
  visibility: hidden;
}

.digest--placed {
  visibility: visible;
}

.digest__head {
  display: flex;
  align-items: flex-start;
  gap: 0.25rem;
}

/* One line: the card is placed against a measured box, so the heading must not grow by wrapping. */
.digest__when {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  font-size: 0.75rem;
  font-weight: 600;
  line-height: 1.3;
  white-space: nowrap;
  text-overflow: ellipsis;
  color: var(--color-text);
}

.digest__close {
  --focus-ring-inset: calc(var(--focus-ring-offset) * -1);

  display: grid;
  flex: none;
  place-items: center;
  width: 1.35rem;
  height: 1.35rem;
  margin: -0.15rem -0.2rem 0 0;
  padding: 0;
  color: var(--color-text-muted);
  background: none;
  border: none;
  border-radius: var(--radius-sm);
  cursor: pointer;
}

.digest__close svg {
  width: 0.7rem;
  height: 0.7rem;
}

.digest__count {
  margin-top: 0.1rem;
  font-size: 0.6875rem;
  font-weight: 500;
}

.digest__count--all {
  color: var(--color-success);
}

.digest__count--some {
  color: var(--color-warning);
}

.digest__count--none {
  color: var(--color-danger);
}

.digest__none {
  margin-top: 0.15rem;
  font-size: 0.6875rem;
  color: var(--color-text-muted);
}

.digest__people {
  display: flex;
  flex-wrap: wrap;
  gap: 0.15rem 0.3rem;
  margin: 0.3rem 0 0;
  padding: 0;
  list-style: none;
}

.who {
  display: inline-flex;
  align-items: center;
  gap: 0.2rem;
  min-width: 0;
  max-width: 100%;
  font-size: 0.75rem;
  line-height: 1.35;
  white-space: nowrap;
  color: var(--color-text);
}

.who__mark {
  display: grid;
  flex: none;
  place-items: center;
  width: 0.75rem;
  height: 0.75rem;
}

.who__mark svg {
  width: 100%;
  height: 100%;
}

.who__name {
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.who--available .who__mark {
  color: var(--color-accent-text);
}

.who--if_needed .who__mark {
  color: var(--color-if-needed-text);
}

.who--unavailable .who__mark {
  color: var(--color-danger);
}

.who--unavailable .who__name {
  color: var(--color-text-muted);
  text-decoration: line-through;
}

.who--more {
  flex: none;
  color: var(--color-text-muted);
  font-size: 0.6875rem;
}

@media (pointer: coarse) {
  .digest__close {
    width: 2.1rem;
    height: 2.1rem;
    margin: -0.35rem -0.35rem 0 0;
  }
}
</style>
