<script setup lang="ts">
import { computed } from "vue";
import { useSlotBaseColor } from "../../lib/colors";
import { heatmapColor } from "../../lib/grid";

const props = withDefaults(
  defineProps<{
    mode: "group" | "edit";
    max: number;
    total: number;
    /**
     * The phone's version of the same caption. It has to share one foot row
     * with two controls, so the counted scale collapses into a single ramp
     * labelled only at its ends — the shape is what carries the meaning, and
     * the numbers in between are already readable off the chart itself.
     */
    compact?: boolean;
  }>(),
  { compact: false },
);

/** Same theme-resolved base the grid paints with. */
const slotBase = useSlotBaseColor();

/** The right-hand end of the compact ramp: the busiest count on the chart. */
const topCount = computed(() => Math.max(props.max, 1));

/** A few steps of the same curve the grid paints with. */
const steps = computed(() => {
  const max = Math.max(props.max, 1);
  const counts = max <= 4
    ? Array.from({ length: max }, (_, i) => i + 1)
    : [1, Math.round(max / 3), Math.round((2 * max) / 3), max];
  const base = slotBase.value;
  return [...new Set(counts)].map((count) => ({
    count,
    color:
      heatmapColor(count, max, props.total, base) ??
      `rgb(${base.r}, ${base.g}, ${base.b})`,
  }));
});
</script>

<template>
  <div class="legend" :class="{ 'legend--compact': compact }">
    <template v-if="mode === 'edit'">
      <span class="item"><i class="swatch available" />Available</span>
      <span class="item"><i class="swatch if-needed" />If needed</span>
      <!-- The third key is the absence of the other two, which is the one
           thing a legend can afford to leave out when the row it shares is a
           phone's width. It keeps its place in assistive text. -->
      <span class="item" :class="{ hidden: compact }">
        <i class="swatch empty" />Unavailable
      </span>
    </template>
    <template v-else-if="compact">
      <span class="item ramp">
        0
        <i class="swatch empty" />
        <i
          v-for="step in steps"
          :key="step.count"
          class="swatch"
          :style="{ backgroundColor: step.color }"
        />
        {{ topCount }}
      </span>
      <!-- What the two numbers count. Dropped from the row for width, not from
           the caption: read aloud it still says what it says on a desktop. -->
      <span class="hidden">available</span>
    </template>
    <template v-else>
      <span class="item"><i class="swatch empty" />0</span>
      <span v-for="step in steps" :key="step.count" class="item">
        <i class="swatch" :style="{ backgroundColor: step.color }" />{{ step.count }}
      </span>
      <span class="item caption">available</span>
    </template>
  </div>
</template>

<style scoped>
.legend {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.75rem;
  color: var(--color-text-muted);
}

.item {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
}

/* Tighter type and smaller swatches: the same caption at the size a foot row
   shared with two controls can afford. */
.legend--compact {
  gap: 0.3rem;
  font-size: 0.6875rem;
}

.legend--compact .swatch {
  width: 0.7rem;
  height: 0.7rem;
}

/* The swatches run together into one strip so the scale reads as a ramp
   between its two labelled ends rather than as five separate keys. */
.ramp {
  gap: 0.2rem;
}

.ramp .swatch + .swatch {
  margin-left: -1px;
}

.hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}

.caption {
  margin-left: 0.1rem;
}

.swatch {
  width: 0.85rem;
  height: 0.85rem;
  border: 1px solid var(--color-border);
  border-radius: 2px;
}

.swatch.empty {
  background: var(--color-slot-empty);
}

.swatch.available {
  background: var(--color-slot-available);
}

.swatch.if-needed {
  background: var(--color-slot-if-needed);
}
</style>
