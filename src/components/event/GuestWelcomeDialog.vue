<script setup lang="ts">
// The landing's welcome prompt (`lib/entry-identity.ts`): one tap of confirmation, run
// through the identity dialog's confirm path. "Not <name>?" opens the generic dialog blank;
// "View only" declines without the purge; closing decides nothing and keeps the remembered name.
import Button from "../ui/Button.vue";
import Dialog from "../ui/Dialog.vue";
import IconPerson from "../../assets/icons/person.svg";

export interface WelcomePerson {
  key: string;
  displayName: string;
  /** The key already has an answer on the event. */
  matched: boolean;
  /** The page has met them: matched, or this device remembered the name. */
  returning: boolean;
  /** Invite-link greeting decoration; dresses the hero line only, never the identity (`lib/entry-identity.ts`). */
  prefix: string | null;
}

defineProps<{
  person: WelcomePerson | null;
  eventName: string;
}>();

const emit = defineEmits<{
  confirm: [];
  decline: [];
  view: [];
  close: [];
}>();
</script>

<template>
  <Dialog
    :open="person !== null"
    :title="person?.returning ? 'Welcome back' : 'Welcome'"
    @close="emit('close')"
  >
    <div v-if="person" class="body">
      <span class="badge" aria-hidden="true"><IconPerson class="badge__icon" /></span>

      <!-- One interpolation: the compiler's whitespace condensing would eat a literal space between two. -->
      <p class="name">{{ person.prefix ? `${person.prefix} ${person.displayName}` : person.displayName }}</p>

      <p class="lead">
        Pick your times for <strong class="lead__event">{{ eventName }}</strong>.
      </p>

      <p v-if="person.matched" class="hint hint--warn">
        <strong>{{ person.displayName }}</strong> already answered — continuing
        edits their times.
      </p>

      <Button variant="primary" block autofocus @click="emit('confirm')">
        Continue
      </Button>

      <div class="quiet">
        <Button variant="ghost" size="sm" @click="emit('decline')">
          <span class="not">Not <span class="not__name">{{ person.displayName }}</span>?</span>
        </Button>
        <Button variant="ghost" size="sm" @click="emit('view')">View only</Button>
      </div>
    </div>
  </Dialog>
</template>

<style scoped>
.body {
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
  align-items: center;
  padding-top: 0.35rem;
  text-align: center;
}

.badge {
  display: grid;
  flex: none;
  place-items: center;
  width: 3rem;
  height: 3rem;
  color: var(--color-accent);
  background: var(--color-accent-soft);
  border-radius: 50%;
}

.badge__icon {
  width: 1.5rem;
  height: 1.5rem;
}

/* overflow-wrap: a spaceless name must break rather than walk out of the panel. */
.name {
  max-width: 100%;
  font-size: 1.375rem;
  font-weight: 650;
  line-height: 1.25;
  letter-spacing: -0.01em;
  overflow-wrap: anywhere;
  color: var(--color-text);
}

.lead {
  font-size: 0.875rem;
  line-height: 1.5;
  overflow-wrap: anywhere;
  color: var(--color-text-muted);
}

.lead__event {
  font-weight: 600;
  color: var(--color-text);
}

.hint {
  font-size: 0.8125rem;
  line-height: 1.4;
}

.hint--warn {
  padding: 0.5rem 0.6rem;
  color: var(--color-warning);
  background: var(--color-warning-soft);
  border-radius: var(--radius-md);
}

.body > .btn--primary {
  margin-top: 0.4rem;
}

.quiet {
  display: flex;
  flex-wrap: wrap;
  gap: 0 0.25rem;
  align-items: center;
  justify-content: center;
  max-width: 100%;
}

.not {
  min-width: 0;
}

/* bottom: an overflow-hidden inline-block's baseline sits at its margin edge, dropping the name. */
.not__name {
  display: inline-block;
  max-width: 9rem;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  vertical-align: bottom;
}
</style>
