<script setup lang="ts">
// The opt-in bell. Renders nothing where push cannot work, except iOS pre-install,
// shown disabled with the actionable instruction (`pushBlock`). The permission prompt
// fires only from a press on the bell; a denied permission disables it quietly.
import { computed, onBeforeUnmount, onMounted, ref, useId, watch } from "vue";
import Spinner from "../ui/Spinner.vue";
import IconBell from "../../assets/icons/bell.svg";
import IconBellOff from "../../assets/icons/bell-off.svg";
import {
  disablePush,
  enablePush,
  pushBlock,
  pushEnabled,
  pushPermissionDenied,
  pushSupported,
  resyncPush,
  type PushBinding,
} from "../../lib/push";

const props = withDefaults(
  defineProps<{
    eventId: string;
    role: "owner" | "respondent";
    userKey?: string | null;
    label: string;
    variant?: "tool" | "setting";
  }>(),
  { userKey: null, variant: "tool" },
);

const binding = computed<PushBinding>(() => ({
  eventId: props.eventId,
  role: props.role,
  ...(props.userKey === null ? {} : { userKey: props.userKey }),
}));

// Refs, not constants: a disabled bell's claim must be re-readable after setup.
const supported = ref(pushSupported());
const block = ref(pushBlock());
const enabled = ref(supported.value && pushEnabled(binding.value));
const denied = ref(pushPermissionDenied());
const busy = ref(false);
const failed = ref(false);

/** Ties the install instruction to the bell it explains. */
const blockNoteId = useId();

// Strictly passive: must never call enablePush/resyncPush — the prompt fires only from a press.
function readState(): void {
  if (busy.value) return; // a toggle in flight owns these refs
  supported.value = pushSupported();
  block.value = pushBlock();
  denied.value = pushPermissionDenied();
  enabled.value = supported.value && pushEnabled(binding.value);
}

function onVisibility(): void {
  if (document.visibilityState === "visible") readState();
}

let permission: PermissionStatus | null = null;

onMounted(() => {
  // Heals a pruned/rotated subscription; never prompts — only runs where permission is granted.
  if (enabled.value) void resyncPush(binding.value);

  // The facts change elsewhere (home-screen install, site permission), so re-read on return.
  document.addEventListener("visibilitychange", onVisibility);

  // Throws or is absent in older Safari, so it can never be the only path.
  try {
    void navigator.permissions
      ?.query({ name: "notifications" })
      .then((status) => {
        permission = status;
        status.onchange = readState;
      })
      .catch(() => undefined);
  } catch {
    // visibilitychange above covers it.
  }
});

onBeforeUnmount(() => {
  document.removeEventListener("visibilitychange", onVisibility);
  if (permission) permission.onchange = null;
});

// A new identity re-files the subscription under the new key; the server upserts in place.
watch(
  () => props.userKey,
  () => {
    if (enabled.value) void resyncPush(binding.value);
  },
);

async function toggle(): Promise<void> {
  if (busy.value || denied.value || block.value !== null) return;
  busy.value = true;
  failed.value = false;
  try {
    if (enabled.value) {
      await disablePush(binding.value);
      enabled.value = false;
    } else {
      const result = await enablePush(binding.value);
      if (result === "on") enabled.value = true;
      else if (result === "denied") denied.value = true;
      else failed.value = true;
    }
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div v-if="supported || block" class="push" :class="`push--${variant}`">
    <button
      type="button"
      class="bell"
      :class="{ 'bell--on': enabled }"
      :aria-pressed="enabled"
      :disabled="busy || denied || block !== null"
      :aria-describedby="block ? blockNoteId : undefined"
      @click="toggle"
    >
      <span class="bell__glyph" aria-hidden="true">
        <Spinner v-if="busy" :size="15" label="" />
        <IconBell v-else-if="enabled" />
        <IconBellOff v-else />
      </span>
      <span class="bell__label">{{ label }}</span>
      <span v-if="variant === 'setting'" class="bell__state" aria-hidden="true">
        {{ enabled ? "On" : "Off" }}
      </span>
    </button>

    <p v-if="block" :id="blockNoteId" class="note">
      Add to Home Screen to get notifications.
    </p>

    <p v-else-if="denied" class="note">
      Notifications are blocked for this site in your browser settings.
    </p>
    <p v-else-if="failed" class="note note--error" role="alert">
      Could not turn notifications on. Try again in a moment.
    </p>
  </div>
</template>

<style scoped>
.push {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.bell {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  width: 100%;
  padding: 0.3rem 0.4rem;
  font-family: inherit;
  font-size: 0.8125rem;
  font-weight: 500;
  color: var(--color-text-muted);
  text-align: left;
  background: none;
  border: none;
  border-radius: var(--radius-md);
  cursor: pointer;
  transition: color var(--transition-fast), background var(--transition-fast);
}

.bell:hover:not(:disabled) {
  color: var(--color-text);
  background: var(--color-subtle);
}

.bell:disabled {
  cursor: not-allowed;
  opacity: var(--disabled-opacity);
}

.bell--on {
  color: var(--color-text);
}

.bell--on .bell__glyph {
  color: var(--color-accent);
}

.bell__glyph {
  display: grid;
  flex: none;
  place-items: center;
  width: 0.95rem;
  height: 0.95rem;
}

.bell__glyph svg {
  width: 100%;
  height: 100%;
}

.bell__label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.note {
  padding: 0 0.4rem;
  margin-top: 0.15rem;
  font-size: 0.71875rem;
  line-height: 1.35;
  color: var(--color-text-muted);
}

.note--error {
  color: var(--color-danger);
}

.push--setting .bell {
  gap: 0.6rem;
  min-height: var(--tap-min);
  padding: 0.2rem 0;
  font-size: 0.8125rem;
  font-weight: 600;
  color: var(--color-text);
}

.push--setting .bell:hover:not(:disabled) {
  background: none;
}

.push--setting .bell__glyph {
  width: 1.1rem;
  height: 1.1rem;
}

.push--setting .bell__label {
  flex: 1 1 auto;
}

.push--setting .bell__state {
  flex: none;
  font-size: 0.75rem;
  font-weight: 500;
  color: var(--color-text-muted);
}

.push--setting .bell--on .bell__state {
  color: var(--color-accent);
}

.push--setting .note {
  padding: 0;
}

@media (pointer: coarse) {
  .push--tool .bell {
    min-height: var(--tap-min);
  }
}
</style>
