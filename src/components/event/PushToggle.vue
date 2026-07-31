<script setup lang="ts">
/**
 * The opt-in bell: one browser asking to be told about one event, in one
 * role. The owner's copy lives with the admin tools ("about responses"); a
 * named respondent's lives with their identity ("about the event").
 *
 * Three rules, all about consent:
 *
 * - it renders **nothing** where push cannot work — an insecure context, a
 *   browser without the API, iOS before install-to-home-screen. A control
 *   that only ever explains why it is disabled is chrome, not a control;
 * - the permission prompt fires only from a press on this bell, never on
 *   load (`lib/push.ts` is written so that is the only call site);
 * - a **denied** permission is shown quietly as a disabled bell with one line
 *   of explanation, because the browser will not ask again and pretending
 *   the toggle still works would be a lie.
 *
 * Two shapes for its two homes: `tool` is a row in the admin tools' column,
 * `setting` is a label-and-checkbox row like the settings drawer's own.
 */
import { computed, onMounted, ref, watch } from "vue";
import Spinner from "../ui/Spinner.vue";
import IconBell from "../../assets/icons/bell.svg";
import IconBellOff from "../../assets/icons/bell-off.svg";
import {
  disablePush,
  enablePush,
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
    /** The adopted identity; respondent bells only. */
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

const supported = pushSupported();
const enabled = ref(supported && pushEnabled(binding.value));
const denied = ref(pushPermissionDenied());
const busy = ref(false);
const failed = ref(false);

onMounted(() => {
  // Heal a subscription the server pruned or the push service rotated. Never
  // prompts: it only runs where permission is already granted.
  if (enabled.value) void resyncPush(binding.value);
});

// Answering as somebody else re-files the respondent subscription under the
// new key — same browser, same endpoint, so the server upserts in place.
watch(
  () => props.userKey,
  () => {
    if (enabled.value) void resyncPush(binding.value);
  },
);

async function toggle(): Promise<void> {
  if (busy.value || denied.value) return;
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
  <div v-if="supported" class="push" :class="`push--${variant}`">
    <button
      type="button"
      class="bell"
      :class="{ 'bell--on': enabled }"
      :aria-pressed="enabled"
      :disabled="busy || denied"
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

    <!-- The browser will not ask again; only its own site settings can. Said
         once, quietly, under the bell it explains. -->
    <p v-if="denied" class="note">
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
  cursor: default;
  opacity: 0.55;
}

/* The state is the glyph's colour as much as its shape: an accent bell is
   ringing, a muted struck-through one is not. */
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

/* --- the settings-drawer shape --------------------------------------------
   A full row, label leading and state trailing, at the drawer's own tap
   floor: it sits among rows built exactly like this. */
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

/* In the tools column the rows meet the tap floor on coarse pointers, the way
   the link row beside them does. */
@media (pointer: coarse) {
  .push--tool .bell {
    min-height: var(--tap-min);
  }
}
</style>
