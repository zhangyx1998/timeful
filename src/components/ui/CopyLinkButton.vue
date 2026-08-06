<script setup lang="ts">
// Copies a link; the tooltip is also the live region, so the verdict is announced.
// Failure is reported: on plain-http LAN deployments the copy genuinely can fail (src/lib/clipboard.ts).
import IconButton from "./IconButton.vue";
import IconCheckWide from "../../assets/icons/check-wide.svg";
import IconLink from "../../assets/icons/link.svg";
import { useCopyFeedback } from "../../lib/copy-feedback";

const props = withDefaults(
  defineProps<{
    url?: string;
    label?: string;
  }>(),
  { url: "", label: "Copy event link" },
);

const { copied, failed, copy: copyWith } = useCopyFeedback();

function copy(): Promise<void> {
  return copyWith(props.url || window.location.href);
}
</script>

<template>
  <span class="copy">
    <IconButton
      :label="copied ? 'Copied' : failed ? 'Copy failed' : props.label"
      @click="copy"
    >
      <IconCheckWide v-if="copied" class="icon icon--done" aria-hidden="true" />
      <IconLink v-else class="icon" :class="{ 'icon--failed': failed }" aria-hidden="true" />
    </IconButton>

    <span class="tip" :class="{ 'tip--on': copied || failed }" role="status">
      {{ copied ? "Copied" : failed ? "Couldn’t copy" : "" }}
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

.icon--failed {
  color: var(--color-danger);
}

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
</style>
