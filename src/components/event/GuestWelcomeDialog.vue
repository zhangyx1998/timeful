<script setup lang="ts">
/**
 * The welcome prompt behind a personalized link (`?name=`, see
 * `lib/entry-identity.ts`). It greets the person the link named and asks for
 * one thing only: confirmation. Continue means exactly what the identity
 * dialog's confirm means — snapped to the key, the event's spelling adopted,
 * load-then-overwrite — because the session runs it through the same path.
 *
 * Two choices, deliberately. "Just browsing" belongs to the generic dialog:
 * this prompt is a yes-or-not-me question about one named person, and the way
 * to every other answer is "Not <name>?", which opens that dialog — blank, per
 * its never-prefill contract. Closing (Escape, the backdrop, the X) declines
 * nothing and confirms nothing; the page falls back to whatever it would have
 * been without the query.
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
  close: [];
}>();
</script>

<template>
  <Dialog :open="person !== null" title="Add your availability" @close="emit('close')">
    <div v-if="person" class="body">
      <p class="greeting">
        Hi <strong class="greeting__name">{{ person.displayName }}</strong> —
        this link was made for you.
      </p>

      <!-- The same one-line consequence the identity dialog spells out, in the
           event's own spelling: continuing edits the answer already filed. -->
      <p v-if="person.matched" class="hint hint--warn">
        <strong>{{ person.displayName }}</strong> already answered — continuing
        edits their times.
      </p>

      <div class="actions">
        <!-- Quiet on purpose: the wrong-person escape hatch, not a peer of
             Continue. The name is the only part that can be any length, so it
             is the only part that gives way. -->
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
