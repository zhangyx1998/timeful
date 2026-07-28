<script setup lang="ts">
/**
 * Who the page is answering as, in its own container above the respondents
 * list.
 *
 * The second state is why it exists. With nobody adopted — a first visit, or
 * after "Just browsing" — the page said nothing at all about it, so browsing
 * looked exactly like being someone, right up until a drag on the grid did
 * nothing. It now says plainly that there is no name, and offers the way out.
 *
 * The save status lives here too: it is a statement about the name above it,
 * and belongs where that name is.
 *
 * Two shapes, one markup
 * ----------------------
 * Beside the grid (wide) it is a card: name, then status, then the way out,
 * stacked. Under the grid there is no "beside" — the column falls below a very
 * tall chart, which is exactly where a phone stops scrolling — so at the same
 * breakpoint the layout stacks (820px) the card leaves the flow and becomes a
 * bar pinned to the bottom of the viewport: who you are and whether you are
 * saved stay on screen while you paint. The row reads name at the left, status
 * and the way out at the right end.
 */
import SyncIndicator from "./SyncIndicator.vue";
import Button from "../ui/Button.vue";
import IconPersonFilled from "../../assets/icons/person-filled.svg";
import IconPerson from "../../assets/icons/person.svg";
import IconSwitchUser from "../../assets/icons/switch-user.svg";
import type { SyncStatus } from "../../lib/sync";

defineProps<{
  /** The adopted name, or null when the visitor is only browsing. */
  name: string | null;
  status: SyncStatus;
  error: string | null;
}>();

const emit = defineEmits<{ change: []; pick: []; retry: [] }>();
</script>

<template>
  <section class="identity" :class="{ 'identity--anon': !name }" aria-label="Your identity">
    <div class="inner">
      <template v-if="name">
        <p class="who">
          <span class="avatar" aria-hidden="true">
            <IconPersonFilled />
          </span>
          <span class="who__name">{{ name }}</span>
        </p>

        <!-- Where the name is, so is what is happening to it, and the way out
             of it. As a bar these trail the name at the row's right end. -->
        <div class="trail">
          <SyncIndicator
            class="sync"
            :status="status"
            :error="error"
            @retry="emit('retry')"
          />

          <!-- A glyph rather than the words it replaces: on a phone this rides
               the end of a row the name is already competing for, and two
               figures trading places says "someone else" in a fraction of the
               width. The label lives on the button for anyone who needs it —
               as its accessible name, and as its tooltip. -->
          <button
            type="button"
            class="swap"
            aria-label="Switch person"
            title="Switch person"
            @click="emit('change')"
          >
            <IconSwitchUser aria-hidden="true" />
          </button>
        </div>
      </template>

      <template v-else>
        <div class="lead">
          <p class="who">
            <span class="avatar" aria-hidden="true">
              <!-- Dashed: the empty seat, same vocabulary as the sync
                   indicator's resting state. -->
              <IconPerson stroke-dasharray="3 2.6" />
            </span>
            <span class="who__name who__name--anon">Just browsing</span>
          </p>

          <p class="note">Nothing is being saved as you.</p>
        </div>

        <Button class="pick" variant="secondary" size="sm" @click="emit('pick')">
          Pick a name
        </Button>
      </template>
    </div>
  </section>
</template>

<style scoped>
.identity {
  padding: 0.7rem 0.85rem;
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-sm);
}

/* Dashed like the empty seat it is. */
.identity--anon {
  border-style: dashed;
}

.inner,
.lead {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 0.35rem;
  min-width: 0;
}

/* Status and the way out are both statements about the name above them, and
   now that the second is a glyph they fit on one line of the card together. */
.trail {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  min-width: 0;
}

.who {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  min-width: 0;
}

.avatar {
  display: grid;
  flex: none;
  place-items: center;
  width: 1.05rem;
  height: 1.05rem;
  color: var(--color-accent);
}

.identity--anon .avatar {
  color: var(--color-text-muted);
}

.avatar svg {
  width: 100%;
  height: 100%;
}

.who__name {
  font-size: 0.9375rem;
  font-weight: 600;
  overflow-wrap: anywhere;
}

.who__name--anon {
  font-weight: 500;
  color: var(--color-text-muted);
}

.note {
  font-size: 0.75rem;
  line-height: 1.4;
  color: var(--color-text-muted);
}

.sync {
  font-size: 0.75rem;
}

.swap {
  display: inline-grid;
  flex: none;
  place-items: center;
  width: 1.75rem;
  height: 1.75rem;
  padding: 0;
  color: var(--color-text-muted);
  background: none;
  border: none;
  border-radius: var(--radius-md);
  cursor: pointer;
  transition: color var(--transition-fast), background var(--transition-fast);
}

.swap:hover {
  color: var(--color-text);
  background: var(--color-subtle);
}

.swap:focus-visible {
  outline: var(--focus-ring);
  outline-offset: calc(var(--focus-ring-offset) * -1);
}

.swap svg {
  width: 1.05rem;
  height: 1.05rem;
}

/* What a finger can hit grows to the floor; what it draws does not. */
@media (pointer: coarse) {
  .swap {
    width: var(--tap-min);
    height: var(--tap-min);
  }
}

@media (prefers-reduced-motion: reduce) {
  .swap {
    transition: none;
  }
}

/* --- the bar, under the grid --------------------------------------------
   Same breakpoint as the scheduler's layout stack: the moment the identity
   stops sitting beside the grid it becomes the bottom edge of the phone
   layout — the last row of a shell that already fills the viewport, so it
   needs no fixed positioning of its own to stay on screen while you paint. It
   bleeds to both edges by cancelling the shell's own padding.

   The `--safe-*` tokens are 0 unless the display actually takes something —
   a home indicator under this row, a camera cutout beside it in landscape —
   so where they do not apply this costs nothing, and where they do the row
   clears them instead of hiding under them. */
@media (max-width: 820px) {
  .identity {
    flex: none;
    /* Out past the shell's own padding, insets and all, so the fill reaches the
       physical edges; the contents are padded back inside them. */
    margin-right: calc((var(--page-pad) + var(--safe-right)) * -1);
    margin-left: calc((var(--page-pad) + var(--safe-left)) * -1);
    padding: 0.5rem calc(var(--page-pad) + var(--safe-right))
      calc(0.5rem + var(--safe-bottom)) calc(var(--page-pad) + var(--safe-left));
    border-width: 1px 0 0;
    border-radius: 0;
    box-shadow: 0 -2px 10px var(--shadow-color-md);
  }

  /* A dashed line across the whole screen reads as a broken edge rather than
     as an empty seat; the words carry that state here. */
  .identity--anon {
    border-style: solid;
  }

  .inner {
    flex-direction: row;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    max-width: var(--page-max);
    margin: 0 auto;
  }

  /* The name takes the row and gives way first: it is the one thing here that
     can be arbitrarily long. */
  .who {
    flex: 1 1 auto;
    overflow: hidden;
  }

  .who__name {
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }

  .lead {
    flex: 1 1 auto;
    gap: 0.05rem;
  }

  .lead .who {
    flex: none;
  }

  /* Status and the switch ride the right end of the name's own row. */
  .trail {
    flex: 0 1 auto;
    gap: 0.4rem;
  }

  .pick {
    flex: none;
  }
}

/* Sideways: the row is already as short as its own controls allow, so only the
   padding around them goes. The home-indicator inset stays whatever it is. */
@media (max-height: 480px) and (max-width: 820px) {
  .identity {
    padding-top: 0.2rem;
    padding-bottom: calc(0.2rem + var(--safe-bottom));
  }
}
</style>
