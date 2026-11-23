<script setup lang="ts">
/**
 * The server-rendered stand-in for `EventScheduler`: the group heatmap as
 * static markup — no listeners, no drag, no overlays. Deterministic from the
 * event document and the layout hint, so hydration re-renders it byte-equal;
 * the mounted scheduler replaces it wholesale (ARCHITECTURE.md § Routing / SSR).
 * Dimensions and cell styling mirror `AvailabilityGrid.vue` via `lib/grid.ts`.
 */
import { computed } from "vue";
import { GAP_HEIGHT, GAP_WIDTH, HEADER_HEIGHT } from "../../lib/grid";
import { buildPreview } from "../../lib/preview";
import type { EventDoc } from "../../lib/event";

const props = defineProps<{ event: EventDoc; compact: boolean }>();

const preview = computed(() => buildPreview(props.event, props.compact));
const model = computed(() => preview.value.model);
</script>

<template>
  <section class="preview" :class="{ compact, 'wide-gutter': preview.wideGutter }">
    <div class="bar" />

    <div class="layout">
      <div class="chart">
        <div class="viewport">
          <div class="sheet">
            <div class="gutter">
              <div class="gutter-head" :style="{ height: `${HEADER_HEIGHT}px` }" />
              <template v-for="(row, index) in model.rows" :key="`label-${index}`">
                <div
                  v-if="index === model.topRowCount && model.bottomRowCount > 0"
                  class="gutter-gap"
                  :style="{ height: `${GAP_HEIGHT}px` }"
                />
                <div
                  class="gutter-label"
                  :class="{ hour: row.isHourStart, first: index === 0 }"
                  :style="{ height: `${preview.rowHeight}px` }"
                >
                  <span v-if="row.isHourStart">{{ row.label }}</span>
                </div>
              </template>
            </div>

            <div class="track" :style="{ width: `${preview.trackWidth}px` }">
              <div class="header">
                <template
                  v-for="(column, index) in model.columns"
                  :key="`head-${column.dayIndex}`"
                >
                  <div
                    v-if="index > 0 && !column.isConsecutive"
                    class="col-gap"
                    :style="{ width: `${GAP_WIDTH}px` }"
                  />
                  <div class="head-cell" :style="{ width: `${preview.colWidth}px` }">
                    <span class="weekday">{{ column.weekday }}</span>
                    <span v-if="model.showDates" class="date">{{ column.dateLabel }}</span>
                  </div>
                </template>
              </div>

              <div class="body">
                <template
                  v-for="(column, colIndex) in model.columns"
                  :key="`col-${column.dayIndex}`"
                >
                  <div
                    v-if="colIndex > 0 && !column.isConsecutive"
                    class="col-gap"
                    :style="{ width: `${GAP_WIDTH}px` }"
                  />
                  <div class="col" :style="{ width: `${preview.colWidth}px` }">
                    <template v-for="(cell, rowIndex) in preview.cells[colIndex]" :key="rowIndex">
                      <div
                        v-if="rowIndex === model.topRowCount && model.bottomRowCount > 0"
                        class="block-gap"
                        :style="{ height: `${GAP_HEIGHT}px` }"
                      />
                      <div
                        class="cell"
                        :class="[
                          `is-${cell.kind}`,
                          {
                            hour: model.rows[rowIndex].isHourStart,
                            half: model.rows[rowIndex].isHalfHour,
                          },
                        ]"
                        :style="{
                          height: `${preview.rowHeight}px`,
                          '--heat': cell.heat,
                        }"
                      />
                    </template>
                  </div>
                </template>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div v-if="!compact" class="side" />
    </div>
  </section>
</template>

<style scoped>
/* Layout boxes mirror EventScheduler.vue; chart chrome mirrors AvailabilityGrid.vue. */
.preview {
  --head: 42px;
  --gutter: 3.5rem;

  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

/* Space the scheduler's view switch will occupy — its 2.25rem minimum plus
   its border — so the chart does not jump at mount. */
/* Mirrors the live grid's wide gutter for "10:30 am" labels. */
.preview.wide-gutter {
  --gutter: 3.75rem;
}

.bar {
  height: 2.375rem;
  margin: 0.75rem 0 1.75rem;
}

@media (max-width: 640px) {
  .bar {
    margin: 0.35rem 0 1.25rem;
  }
}

.layout {
  display: flex;
  align-items: flex-start;
  gap: 1rem;
}

.chart {
  flex: 1 1 auto;
  min-width: 0;
}

.side {
  flex: 0 0 14rem;
  max-width: 14rem;
}

/* No scrolling: the static chart clips where the live one would scroll to. */
.viewport {
  position: relative;
  overflow: hidden;
}

.sheet {
  display: flex;
  align-items: stretch;
  width: max-content;
  min-width: 100%;
}

.gutter {
  flex: none;
  width: var(--gutter);
  text-align: right;
  background: var(--color-bg);
}

.gutter-label {
  position: relative;
  font-size: 0.6875rem;
  line-height: 1;
  color: var(--color-text-muted);
}

.gutter-label.hour span {
  position: absolute;
  top: 0;
  right: 0.4rem;
  transform: translateY(-50%);
  white-space: nowrap;
}

.gutter-label.hour.first span {
  transform: none;
}

.track {
  position: relative;
  flex: none;
}

.header {
  display: flex;
  height: var(--head);
  align-items: flex-end;
  padding-bottom: 0.35rem;
  background: var(--color-bg);
}

.head-cell {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.05rem;
  overflow: hidden;
  white-space: nowrap;
}

.weekday {
  font-size: 0.75rem;
  font-weight: 600;
  color: var(--color-text-muted);
  text-transform: uppercase;
  letter-spacing: 0.03em;
}

.date {
  font-size: 0.8125rem;
  font-weight: 600;
  color: var(--color-text);
}

.body {
  position: relative;
  display: flex;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  overflow: hidden;
}

.col {
  display: flex;
  flex-direction: column;
  border-right: 1px solid var(--color-border);
}

.col:last-child {
  border-right: none;
}

.col-gap,
.block-gap {
  flex: none;
  background: var(--color-bg);
}

.block-gap {
  border-top: 1px solid var(--color-border);
  border-bottom: 1px solid var(--color-border);
}

.cell {
  position: relative;
  background-color: var(--color-slot-empty);
}

.cell.hour {
  border-top: 1px solid var(--color-border);
}

.cell.half {
  border-top: 1px dashed var(--color-border);
}

.cell.is-disabled {
  background-color: var(--color-slot-disabled);
  background-image: repeating-linear-gradient(
    45deg,
    transparent,
    transparent 4px,
    var(--color-border) 4px,
    var(--color-border) 5px
  );
}

.cell.is-if_needed {
  background-color: var(--color-slot-if-needed);
}

/* Same pixels as the live grid's rgba(): color-mix with transparent keeps the
   token's channels at the computed alpha, so the tone re-resolves per theme. */
.cell.is-heat {
  background-color: color-mix(in srgb, var(--color-slot-available) var(--heat), transparent);
}

@media (max-width: 820px) {
  .preview {
    --gutter: 2.75rem;

    gap: 0.5rem;
  }

  .preview.wide-gutter {
    --gutter: 3.25rem;
  }

  .preview.compact {
    flex: 1 1 auto;
    min-height: 0;
  }

  /* The bar holds the drawer handles at their 44px tap floor on a phone. */
  .bar {
    height: 44px;
    margin: 0;
  }

  .compact .layout {
    flex: 1 1 auto;
    flex-direction: column;
    gap: 0.5rem;
    min-height: 0;
  }

  .compact .chart {
    flex: 1 1 auto;
    width: 100%;
    min-height: 0;
    overflow: hidden;
  }

  .gutter-label {
    font-size: 0.625rem;
  }

  .weekday,
  .date {
    font-size: 0.6875rem;
  }
}
</style>
