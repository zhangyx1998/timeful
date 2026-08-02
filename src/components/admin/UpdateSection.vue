<script setup lang="ts">
/**
 * Is there a newer Timeful, and what is the ritual for taking it.
 *
 * The running version is always on screen; the registry is asked **only** when
 * the owner presses the button. Nothing here runs on mount, on an interval, or
 * on a tab switch — a self-hosted app that talks to npm without being asked is
 * not the app this one promises to be, and the check is the single outbound
 * call in the whole product (ARCHITECTURE.md § The update check).
 *
 * When there is something to take, the answer is one line to paste, because
 * the upgrade genuinely is one line: npx fetches the new version and the new
 * version re-points the service at itself.
 */
import { computed, ref } from "vue";
import { api, apiError } from "../../lib/api";
import { copyText } from "../../lib/clipboard";
import Button from "../ui/Button.vue";
import Card from "../ui/Card.vue";
import ErrorNote from "../ui/ErrorNote.vue";
import IconAlertTriangle from "../../assets/icons/alert-triangle.svg";
import IconCircleCheck from "../../assets/icons/circle-check.svg";
import IconRotateCw from "../../assets/icons/rotate-cw.svg";
import type { UpdateCheck } from "../../lib/api";

const emit = defineEmits<{ (e: "signed-out"): void }>();

const checking = ref(false);
const result = ref<UpdateCheck | null>(null);
const error = ref("");
const copied = ref(false);
let copyTimer: ReturnType<typeof setTimeout> | undefined;

/** A path only needs quoting when it has whitespace in it; most never do. */
function shellPath(value: string): string {
  return /\s/.test(value) ? `'${value.replace(/'/g, `'\\''`)}'` : value;
}

const command = computed(() =>
  result.value ? `cd ${shellPath(result.value.webroot)} && npx timeful@latest upgrade` : "",
);

async function check(): Promise<void> {
  error.value = "";
  checking.value = true;
  try {
    result.value = await api.get<UpdateCheck>("/api/update-check");
  } catch (err) {
    const { message, status } = apiError(err, "Could not check for updates");
    if (status === 401) {
      emit("signed-out");
      return;
    }
    result.value = null;
    error.value = message;
  } finally {
    checking.value = false;
  }
}

async function copy(): Promise<void> {
  if (!(await copyText(command.value))) return;
  copied.value = true;
  clearTimeout(copyTimer);
  copyTimer = setTimeout(() => {
    copied.value = false;
  }, 1500);
}
</script>

<template>
  <Card title="Software update">
    <template #actions>
      <Button variant="secondary" size="sm" :loading="checking" @click="check">
        {{ checking ? "Checking…" : "Check for updates" }}
      </Button>
    </template>

    <div class="update">
      <p class="running">
        <span class="running__label">Running</span>
        <code class="version">{{ result?.current ?? "—" }}</code>
        <span v-if="result?.development" class="note">development build</span>
      </p>

      <!-- The v-if is not redundant: the chain below hangs off it. -->
      <ErrorNote v-if="error" :message="error" />

      <template v-else-if="checking">
        <p class="state state--muted">Asking the npm registry…</p>
      </template>

      <template v-else-if="result">
        <p v-if="result.latest === null" class="state state--muted">
          <IconAlertTriangle class="state__icon" aria-hidden="true" />
          {{ result.problem || "The npm registry could not be reached." }}
        </p>

        <p v-else-if="!result.updateAvailable" class="state state--ok">
          <IconCircleCheck class="state__icon" aria-hidden="true" />
          <template v-if="result.development">
            The latest published version is {{ result.latest }}.
          </template>
          <template v-else>Up to date — {{ result.latest }} is the latest.</template>
        </p>

        <template v-else>
          <p class="state state--new">
            <IconRotateCw class="state__icon" aria-hidden="true" />
            {{ result.latest }} is available.
          </p>
          <p class="how">Run this on the server, in the webroot:</p>
          <div class="command">
            <code class="command__text">{{ command }}</code>
            <Button variant="secondary" size="sm" @click="copy">
              {{ copied ? "Copied" : "Copy" }}
            </Button>
          </div>
          <p class="note">
            It restarts the service. Your events, responses and settings are
            untouched.
          </p>
        </template>
      </template>

      <p v-else class="state state--muted">
        Nothing is checked until you ask: this is the only thing Timeful ever
        fetches from the internet.
      </p>
    </div>
  </Card>
</template>

<style scoped>
.update {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.running {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 0.5rem;
  margin: 0;
  font-size: 0.875rem;
}

.running__label {
  color: var(--color-text-muted);
}

.version {
  font-family: var(--font-mono);
  font-size: 0.875rem;
  color: var(--color-text);
}

.note {
  margin: 0;
  font-size: 0.8125rem;
  line-height: 1.5;
  color: var(--color-text-muted);
}

.state {
  display: flex;
  align-items: center;
  gap: 0.45rem;
  margin: 0;
  font-size: 0.875rem;
  line-height: 1.5;
}

.state__icon {
  flex: none;
  width: 1rem;
  height: 1rem;
}

.state--muted {
  color: var(--color-text-muted);
}

.state--ok {
  color: var(--color-success);
}

.state--new {
  color: var(--color-accent-text);
}

.how {
  margin: 0;
  font-size: 0.875rem;
  color: var(--color-text);
}

/* The command is the deliverable, so it gets its own surface — and it scrolls
   inside that surface rather than pushing the panel sideways on a phone. */
.command {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.5rem 0.6rem;
  background: var(--color-subtle);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
}

.command__text {
  flex: 1;
  min-width: 0;
  overflow-x: auto;
  font-family: var(--font-mono);
  font-size: 0.8125rem;
  line-height: 1.6;
  white-space: pre;
  color: var(--color-text);
}

/* Phones: the command and its button stack, so neither is squeezed to nothing
   and the button keeps its full tap target. */
@media (max-width: 30rem) {
  .command {
    flex-direction: column;
    align-items: stretch;
  }
}
</style>
