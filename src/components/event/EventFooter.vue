<script setup lang="ts">
/**
 * The foot of the event page: what this software is, and the quiet door out.
 *
 * One component, two mounts that are never on screen together — the last item
 * of the desktop sidebar, and the last content of the phone's settings drawer
 * (the sidebar renders only above 820px, the drawer only below it). Everything
 * in it is about the page rather than the event, which is why it sits after
 * everything the event is about.
 *
 * Top to bottom:
 *
 * 1. When live updates should be flowing and are not, it says so — see
 *    `realtimeDown`. Top-most because it is the only row that can matter.
 * 2. The name and version of the software, with the GitHub mark linking to
 *    where it lives. Muted: a colophon, not a promotion.
 * 3. The administrator sign-in, for the one visitor it concerns. It renders
 *    the same dialog it always has (`AdminLoginLink`) and disappears once
 *    signed in — the owner's tools live elsewhere.
 */
import AdminLoginLink from "./AdminLoginLink.vue";
import IconGitHub from "../../assets/icons/github.svg";
import { isAdmin } from "../../lib/admin";
import { VERSION } from "../../lib/version";

withDefaults(
  defineProps<{
    /**
     * Live updates were expected and the connection has stayed down. Only the
     * page can say so — it owns the socket and knows whether the event allows
     * realtime at all — so this arrives as a prop rather than being derived
     * here. False covers both "everything is fine" and "this event never had
     * live updates", neither of which is worth a row.
     */
    realtimeDown?: boolean;
  }>(),
  { realtimeDown: false },
);
</script>

<template>
  <footer class="footer">
    <!-- Honest and small: the page is not broken — saves and reloads still go
         over plain requests — but nothing new arrives on its own any more. -->
    <p v-if="realtimeDown" class="offline" role="status">
      Live updates are unavailable. The page still works — others' changes
      appear on reload.
    </p>

    <div class="colophon">
      <span class="version">Timeful v{{ VERSION }}</span>
      <a
        class="repo"
        href="https://github.com/zhangyx1998/timeful"
        target="_blank"
        rel="noopener noreferrer"
        aria-label="Timeful on GitHub"
        title="Timeful on GitHub"
      >
        <IconGitHub aria-hidden="true" />
      </a>
    </div>

    <AdminLoginLink v-if="!isAdmin" />
  </footer>
</template>

<style scoped>
.footer {
  display: flex;
  flex-direction: column;
  gap: 0.1rem;
  align-items: center;
}

/* The one row here that talks about a problem. Quiet-but-visible: the danger
   pair at small size, because the page is degraded rather than broken. */
.offline {
  align-self: stretch;
  margin-bottom: 0.4rem;
  padding: 0.45rem 0.6rem;
  font-size: 0.75rem;
  line-height: 1.45;
  text-align: center;
  color: var(--color-danger);
  background: var(--color-danger-soft);
  border-radius: var(--radius-md);
}

.colophon {
  display: inline-flex;
  gap: 0.15rem;
  align-items: center;
}

.version {
  font-size: 0.75rem;
  color: var(--color-text-muted);
}

/* An icon-sized link, padded out to something a finger can land on where
   there is no pointer to be precise with. */
.repo {
  display: inline-grid;
  place-items: center;
  width: 1.75rem;
  height: 1.75rem;
  color: var(--color-text-muted);
  border-radius: var(--radius-sm);
  transition: color var(--transition-fast);
}

.repo:hover {
  color: var(--color-text);
}

.repo svg {
  width: 0.95rem;
  height: 0.95rem;
}

@media (pointer: coarse) {
  .repo {
    width: var(--tap-min);
    height: var(--tap-min);
  }
}
</style>
