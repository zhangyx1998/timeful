<script setup lang="ts">
// Who the page is answering as. A card beside the grid; at the 820px stack it
// becomes the bottom bar of the phone shell.
import PushToggle from "./PushToggle.vue";
import SyncIndicator from "./SyncIndicator.vue";
import Button from "../ui/Button.vue";
import IconButton from "../ui/IconButton.vue";
import IconPersonFilled from "../../assets/icons/person-filled.svg";
import IconPerson from "../../assets/icons/person.svg";
import IconSwitchUser from "../../assets/icons/switch-user.svg";
import IconTrash from "../../assets/icons/trash.svg";
import type { SyncStatus } from "../../lib/sync";

withDefaults(
  defineProps<{
    name: string | null;
    status: SyncStatus;
    error: string | null;
    /** The admin-only line under the error; guests never receive one. */
    errorDetail?: string | null;
    /** Phone only: the desktop's chart foot carries the labelled version. */
    canClear?: boolean;
    /** The confirm is open: the button stays armed under it. */
    clearing?: boolean;
    /** Card only; as a bar the row is spoken for and the settings drawer carries the toggle. */
    push?: { eventId: string; userKey: string } | null;
  }>(),
  { canClear: false, clearing: false, push: null, errorDetail: null },
);

const emit = defineEmits<{ change: []; pick: []; retry: []; clear: [] }>();
</script>

<template>
  <section class="identity" :class="{ 'identity--anon': !name }" aria-label="Your identity">
    <div class="inner">
      <template v-if="name">
        <p class="who">
          <span class="avatar" aria-hidden="true">
            <IconPersonFilled />
          </span>
          <span class="who__name" :title="name">{{ name }}</span>
        </p>

        <div class="trail">
          <SyncIndicator
            class="sync"
            :status="status"
            :error="error"
            :detail="errorDetail"
            @retry="emit('retry')"
          />

          <IconButton
            v-if="canClear"
            class="swap clear"
            :class="{ 'clear--armed': clearing }"
            size="xxs"
            label="Clear my response"
            @click="emit('clear')"
          >
            <IconTrash aria-hidden="true" />
          </IconButton>

          <IconButton class="swap" size="xxs" label="Switch person" @click="emit('change')">
            <IconSwitchUser aria-hidden="true" />
          </IconButton>
        </div>

        <PushToggle
          v-if="push"
          class="push-row"
          :event-id="push.eventId"
          role="respondent"
          :user-key="push.userKey"
          label="Notify me if the event changes"
        />
      </template>

      <template v-else>
        <div class="lead">
          <p class="who">
            <span class="avatar" aria-hidden="true">
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

.trail {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  min-width: 0;
}

/* max-width so the name's truncation has something to truncate against. */
.who {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  min-width: 0;
  max-width: 100%;
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
  min-width: 0;
  overflow: hidden;
  font-size: 0.9375rem;
  font-weight: 600;
  white-space: nowrap;
  text-overflow: ellipsis;
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
  --icon-button-glyph: 1.05rem;
}

.clear {
  --icon-button-glyph: 1rem;
  --icon-button-hover-color: var(--color-danger);
  --icon-button-hover-bg: var(--color-danger-soft);
}

.clear.clear--armed {
  color: var(--color-danger);
  background: var(--color-danger-soft);
}

/* Bleeds the card's padding so its hover pill lines up with the rows above. */
.push-row {
  align-self: stretch;
  margin: 0 -0.4rem -0.15rem;
}

/* The bar: last row of a viewport-filling shell, so no fixed positioning needed.
   --safe-* tokens are 0 unless the display takes something (home indicator, cutout). */
@media (max-width: 820px) {
  .identity {
    flex: none;
    /* Bleed past the shell's padding so the fill reaches the physical edges. */
    margin-right: calc((var(--page-pad) + var(--safe-right)) * -1);
    margin-left: calc((var(--page-pad) + var(--safe-left)) * -1);
    padding: 0.5rem calc(var(--page-pad) + var(--safe-right))
      calc(0.5rem + var(--safe-bottom)) calc(var(--page-pad) + var(--safe-left));
    border-width: 1px 0 0;
    border-radius: 0;
    box-shadow: 0 -2px 10px var(--shadow-color-md);
  }

  /* A dashed line across the whole screen reads as a broken edge, not an empty seat. */
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

  .who {
    flex: 1 1 auto;
    overflow: hidden;
  }

  .lead {
    flex: 1 1 auto;
    gap: 0.05rem;
  }

  .lead .who {
    flex: none;
  }

  .trail {
    flex: none;
    gap: 0.4rem;
  }

  .push-row {
    display: none;
  }

  .pick {
    flex: none;
  }
}

@media (max-height: 480px) and (max-width: 820px) {
  .identity {
    padding-top: 0.2rem;
    padding-bottom: calc(0.2rem + var(--safe-bottom));
  }
}
</style>
