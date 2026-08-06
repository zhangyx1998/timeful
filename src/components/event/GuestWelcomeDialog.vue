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
 * Composed as a greeting, not a permissions check: the name is the hero,
 * "Welcome back" when the page has met this person before — their key is on
 * the event, or this device remembered them — and "Welcome" for a first-time
 * invitee; one line under it says what they are being welcomed to.
 *
 * The other two answers are quiet by design. "Not <name>?" is the
 * wrong-person hatch: it opens the generic dialog — blank, per its
 * never-prefill contract, and with its full semantics, "Just browsing"
 * included; that affordance deliberately does not exist here. "View only"
 * declines the whole question and goes to the group view, without the purge.
 * Closing (Escape, the backdrop, the X) confirms and declines nothing — the
 * page shows the group and the remembered name survives to be asked about
 * next time.
 */
import Button from "../ui/Button.vue";
import Dialog from "../ui/Dialog.vue";
import IconPerson from "../../assets/icons/person.svg";

/** Who the landing greets: named in the event's own spelling when matched. */
export interface WelcomePerson {
  key: string;
  displayName: string;
  /** The key already has an answer on the event. */
  matched: boolean;
  /** The page has met them: matched, or this device remembered the name. */
  returning: boolean;
  /**
   * The invite link's greeting decoration ("Prof.", "Dr."), or null. It
   * dresses the hero line and nothing else — never the identity, the stored
   * name, the consequence line, or the "Not <name>?" hatch, which all use the
   * bare name (`lib/entry-identity.ts`).
   */
  prefix: string | null;
}

defineProps<{
  person: WelcomePerson | null;
  /** What they are being welcomed to. */
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
      <!-- The plain person mark, not the admin shield: this is about who is
           answering. Decorative — the greeting says everything it would. -->
      <span class="badge" aria-hidden="true"><IconPerson class="badge__icon" /></span>

      <!-- One interpolation, because the compiler's whitespace condensing
           would eat a literal space between two of them. -->
      <p class="name">{{ person.prefix ? `${person.prefix} ${person.displayName}` : person.displayName }}</p>

      <p class="lead">
        Pick your times for <strong class="lead__event">{{ eventName }}</strong>.
      </p>

      <!-- The same one-line consequence the identity dialog spells out, in the
           event's own spelling: continuing edits the answer already filed. -->
      <p v-if="person.matched" class="hint hint--warn">
        <strong>{{ person.displayName }}</strong> already answered — continuing
        edits their times.
      </p>

      <Button variant="primary" block autofocus @click="emit('confirm')">
        Continue
      </Button>

      <!-- The two quiet ways out, side by side under the one obvious answer.
           The name is the only part that can be any length, so it is the only
           part that gives way. -->
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

/* A soft accent disc behind the mark: the one touch of colour the greeting
   takes, and from tokens, so it stays quiet in both themes. */
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

/* The hero. A name is one run with no guaranteed spaces; without the wrap rule
   a long one would walk out of the panel rather than breaking. */
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

/* The one obvious answer gets the room; a little air above it separates the
   decision from the greeting it answers. */
.body > .btn--primary {
  margin-top: 0.4rem;
}

/* Two quiet exits on one line while they fit, stacked when the name will not
   share a 360px row. */
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
</style>
