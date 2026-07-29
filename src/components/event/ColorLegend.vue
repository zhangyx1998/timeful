<script setup lang="ts">
import { computed } from "vue";
import { useSlotBaseColor } from "../../lib/colors";
import { heatmapColor } from "../../lib/grid";

/**
 * What the chart's colours mean, under the chart.
 *
 * Desktop only. A phone's foot row is a row of the fixed pane rather than
 * something the page scrolls past, and every pixel it spends is a pixel of
 * chart — so the caption is not shrunk there, it is dropped, and the height
 * goes to the grid. What a filled cell means is legible from the chart itself
 * once the cells are the size a phone gives them.
 */
const props = defineProps<{
  mode: "group" | "edit";
  max: number;
  total: number;
}>();

/** Same theme-resolved base the grid paints with. */
const slotBase = useSlotBaseColor();

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
  <div class="legend">
    <template v-if="mode === 'edit'">
      <span class="item"><i class="swatch available" />Available</span>
      <span class="item"><i class="swatch if-needed" />If needed</span>
      <span class="item"><i class="swatch empty" />Unavailable</span>
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
