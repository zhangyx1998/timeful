<script setup lang="ts">
// The foot of the event page: colophon plus the admin sign-in. Two mounts that are
// never on screen together — the desktop sidebar and the phone's settings drawer.
import AdminLoginLink from "./AdminLoginLink.vue";
import OfflineNotice from "./OfflineNotice.vue";
import IconGitHub from "../../assets/icons/github.svg";
import { isAdmin } from "../../lib/admin";
import { VERSION } from "../../lib/version";

withDefaults(
  defineProps<{
    realtimeDown?: boolean;
  }>(),
  { realtimeDown: false },
);
</script>

<template>
  <footer class="footer">
    <OfflineNotice v-if="realtimeDown" class="footer__offline" />

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

.footer__offline {
  margin-bottom: 0.4rem;
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
