<script setup lang="ts">
/**
 * The landing's welcome prompt (`lib/entry-identity.ts`): the page believes it
 * knows who arrived — a personalized link named them, the device remembers
 * them, or the URL is their own edit path — and asks for one tap of
 * confirmation rather than acting on it. Continue means exactly what the
 * identity dialog's confirm means — snapped to the key, the event's spelling
 * adopted, load-then-overwrite — because the session runs it through the same
 * path.
 *
 * Its other two answers are quiet by design. "Not <name>?" is the wrong-person
 * hatch: it opens the generic dialog — blank, per its never-prefill contract,
 * and with its full mid-page semantics. "View only" declines the whole
 * question and goes to the group view; it is this prompt's version of the
 * generic dialog's browsing escape, without the purge. Closing (Escape, the
 * backdrop, the X) confirms and declines nothing — the page shows the group
 * and the remembered name survives to be asked about next time.
 */
import Button from "../ui/Button.vue";
import Dialog from "../ui/Dialog.vue";

/** Who the link named: greeted in the event's own spelling when matched. */
export interface WelcomePerson {
  key: string;
  displayName: string;
  matched: boolean;
}

defineProps<{
  person: WelcomePerson | null;
}>();

const emit = defineEmits<{
  confirm: [];
  decline: [];
  view: [];
  close: [];
}>();
</script>

<template>
  <Dialog :open="person !== null" title="Add your availability" @close="emit('close')">
    <div v-if="person" class="body">
      <p class="greeting">
        Hi <strong class="greeting__name">{{ person.displayName }}</strong> —
        ready to fill in your times?
      </p>

      <!-- The same one-line consequence the identity dialog spells out, in the
           event's own spelling: continuing edits the answer already filed. -->
      <p v-if="person.matched" class="hint hint--warn">
        <strong>{{ person.displayName }}</strong> already answered — continuing
        edits their times.
      </p>

      <div class="actions">
        <!-- Both hatches quiet on purpose: neither is a peer of Continue. The
             name is the only part that can be any length, so it is the only
             part that gives way. -->
        <Button variant="ghost" @click="emit('view')">View only</Button>
        <Button variant="ghost" @click="emit('decline')">
          <span class="not">Not <span class="not__name">{{ person.displayName }}</span>?</span>
        </Button>
        <Button variant="primary" autofocus @click="emit('confirm')">
          Continue
        </Button>
      </div>
    </div>
  </Dialog>
</template>

<style scoped>
.body {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.greeting {
  font-size: 0.9375rem;
  line-height: 1.5;
}

/* A name is one run with no guaranteed spaces; without this a long one walks
   out of the panel rather than wrapping. */
.greeting__name {
  overflow-wrap: anywhere;
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

.not {
  min-width: 0;
}

/* `bottom` rather than the baseline an overflow-hidden inline-block would
   otherwise offer, which sits at its margin edge and drops the name below the
   words beside it — the same cap the identity dialog's Continue label uses. */
.not__name {
  display: inline-block;
  max-width: 9rem;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  vertical-align: bottom;
}

/* Two buttons still stack rather than crowd on the narrowest panel. */
.actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 0.5rem;
  margin-top: 0.25rem;
}
</style>
