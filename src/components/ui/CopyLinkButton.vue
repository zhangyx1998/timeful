<script setup lang="ts">
/**
 * Copies a link. On the event page it sits beside the event's name, because
 * handing the link to someone else is the thing a host does most there and the
 * URL is the only way in (ARCHITECTURE.md § Security); the admin list uses the
 * same control per row.
 *
 * Feedback is the icon turning into a tick plus a brief tooltip; the tooltip
 * is also the live region, so the confirmation is announced rather than only
 * drawn. Nothing is claimed unless the copy actually succeeded.
 */
import { onBeforeUnmount, ref } from "vue";
import IconButton from "./IconButton.vue";
import IconCheckWide from "../../assets/icons/check-wide.svg";
import IconLink from "../../assets/icons/link.svg";
import { copyText } from "../../lib/clipboard";

const props = withDefaults(
  defineProps<{
    /** What to copy. Defaults to the page's own address. */
    url?: string;
    /** Accessible name and tooltip for the idle state. */
    label?: string;
  }>(),
  { url: "", label: "Copy event link" },
);

const copied = ref(false);
let timer: ReturnType<typeof setTimeout> | undefined;

async function copy(): Promise<void> {
  if (!(await copyText(props.url || window.location.href))) return;
  copied.value = true;
  clearTimeout(timer);
  timer = setTimeout(() => {
    copied.value = false;
  }, 1500);
}

onBeforeUnmount(() => clearTimeout(timer));
</script>

<template>
  <span class="copy">
    <IconButton :label="copied ? 'Copied' : props.label" @click="copy">
      <IconCheckWide v-if="copied" class="icon icon--done" aria-hidden="true" />
      <IconLink v-else class="icon" aria-hidden="true" />
    </IconButton>

    <span class="tip" :class="{ 'tip--on': copied }" role="status">
      {{ copied ? "Copied" : "" }}
    </span>
  </span>
</template>

<style scoped>
.copy {
  position: relative;
  display: inline-flex;
  flex: none;
}

.icon--done {
  color: var(--color-success);
}

/* Same bubble as the grid's slot tooltip: dark chip, small text, out of the
   way of the pointer. */
.tip {
  position: absolute;
  top: calc(100% - 0.4rem);
  left: 50%;
  z-index: 40;
  padding: 0.2rem 0.45rem;
  font-size: 0.75rem;
  line-height: 1.3;
  white-space: nowrap;
  color: var(--color-tooltip-text);
  background: var(--color-tooltip-bg);
  border-radius: var(--radius-sm);
  opacity: 0;
  transform: translateX(-50%);
  transition: opacity var(--transition-fast);
  pointer-events: none;
}

.tip--on {
  opacity: 1;
}

@media (prefers-reduced-motion: reduce) {
  .tip {
    transition: none;
  }
}
</style>
