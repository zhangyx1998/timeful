<script setup lang="ts">
/**
 * Every device signed in as the owner.
 *
 * Signing a session out is destructive and irreversible from here — the one
 * marked "current" logs this browser out — so both the per-row action and the
 * sweep confirm in a dialog that says which it is about. The row action is an
 * icon: the table's own "Type" column already says what each row is.
 */
import { computed, onMounted, ref } from "vue";
import { api, apiError } from "../../lib/api";
import { formatDateTime } from "../../lib/dates";
import Button from "../ui/Button.vue";
import Card from "../ui/Card.vue";
import Dialog from "../ui/Dialog.vue";
import IconButton from "../ui/IconButton.vue";
import Spinner from "../ui/Spinner.vue";
import IconSignOut from "../../assets/icons/sign-out.svg";
import type { SessionInfo } from "../../lib/api";

const emit = defineEmits<{ (e: "signed-out"): void }>();

const sessions = ref<SessionInfo[]>([]);
const loading = ref(true);
const error = ref("");
const busyToken = ref("");
const purging = ref(false);

/** What the one confirm dialog is currently asking about. */
const confirming = ref<{ kind: "purge" } | { kind: "revoke"; session: SessionInfo } | null>(
  null,
);

const confirmTitle = computed(() => {
  if (confirming.value?.kind === "purge") return "Sign out every other device?";
  return confirming.value?.session.current
    ? "Sign out this device?"
    : "Sign out that device?";
});

async function load(): Promise<void> {
  error.value = "";
  loading.value = true;
  try {
    sessions.value = await api.get<SessionInfo[]>("/api/sessions");
  } catch (err) {
    const { message, status } = apiError(err, "Could not load sessions");
    if (status === 401) {
      emit("signed-out");
      return;
    }
    error.value = message;
  } finally {
    loading.value = false;
  }
}

/** Runs whichever action the open dialog was asking about. */
function confirmed(): void {
  const pending = confirming.value;
  if (!pending) return;
  void (pending.kind === "purge" ? purge() : revoke(pending.session));
}

async function revoke(session: SessionInfo): Promise<void> {
  error.value = "";
  confirming.value = null;
  busyToken.value = session.token;
  try {
    await api.del(`/api/sessions/${session.token}`);
    if (session.current) {
      emit("signed-out");
      return;
    }
    await load();
  } catch (err) {
    error.value = apiError(err, "Could not revoke the session").message;
  } finally {
    busyToken.value = "";
  }
}

async function purge(): Promise<void> {
  error.value = "";
  purging.value = true;
  try {
    await api.del("/api/sessions");
    confirming.value = null;
    await load();
  } catch (err) {
    error.value = apiError(err, "Could not sign out other sessions").message;
  } finally {
    purging.value = false;
  }
}

onMounted(load);
defineExpose({ load });
</script>

<template>
  <Card title="Sessions" flush>
    <template #actions>
      <Button
        variant="secondary"
        size="sm"
        :loading="purging"
        :disabled="sessions.length < 2"
        @click="confirming = { kind: 'purge' }"
      >
        Sign out others
      </Button>
    </template>

    <p v-if="error" class="error">{{ error }}</p>
    <p v-if="loading" class="empty">Loading…</p>

    <div v-else class="scroller">
      <table class="table">
        <thead>
          <tr>
            <th>Created</th>
            <th>Last seen</th>
            <th>Device</th>
            <th>Type</th>
            <th><span class="sr-only">Actions</span></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="session in sessions" :key="session.token">
            <td class="nowrap" data-label="Created">
              {{ formatDateTime(session.createdAt) }}
            </td>
            <td class="nowrap" data-label="Last seen">
              {{ formatDateTime(session.lastSeenAt) }}
            </td>
            <td class="device" data-label="Device" :title="session.userAgent">
              {{ session.userAgent || "Unknown" }}
            </td>
            <td class="nowrap" data-label="Type">
              {{ session.persistent ? "Persistent" : "Session" }}
              <span v-if="session.current" class="badge">current</span>
            </td>
            <td class="actions">
              <span v-if="busyToken === session.token" class="busy">
                <Spinner :size="16" label="Signing out" />
              </span>
              <IconButton
                v-else
                class="revoke"
                :label="session.current ? 'Sign out this device' : 'Sign out that device'"
                @click="confirming = { kind: 'revoke', session }"
              >
                <IconSignOut aria-hidden="true" />
              </IconButton>
            </td>
          </tr>
          <tr v-if="!sessions.length">
            <td class="empty" colspan="5">No sessions.</td>
          </tr>
        </tbody>
      </table>
    </div>

    <Dialog :open="confirming !== null" :title="confirmTitle" @close="confirming = null">
      <div class="confirm">
        <p class="confirm__text">
          <template v-if="confirming?.kind === 'purge'">
            Every signed-in device except this one is signed out. They will each
            need the password again.
          </template>
          <template v-else-if="confirming?.session.current">
            This browser is signed out and you will need the password again.
          </template>
          <template v-else>
            That device is signed out and needs the password again.
          </template>
        </p>
        <div class="confirm__actions">
          <Button variant="ghost" @click="confirming = null">Cancel</Button>
          <Button variant="danger" @click="confirmed">Sign out</Button>
        </div>
      </div>
    </Dialog>
  </Card>
</template>

<style scoped>
.error {
  margin: 1rem;
  padding: 0.5rem 0.75rem;
  font-size: 0.875rem;
  color: var(--color-danger);
  background: var(--color-danger-soft);
  border-radius: var(--radius-md);
}

.empty {
  margin: 0;
  padding: 1.5rem 1.25rem;
  font-size: 0.875rem;
  color: var(--color-text-muted);
}

.scroller {
  overflow-x: auto;
}

.table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.875rem;
  text-align: left;
}

.table th {
  padding: 0.5rem 1.25rem;
  font-size: 0.75rem;
  font-weight: 500;
  letter-spacing: 0.03em;
  text-transform: uppercase;
  color: var(--color-text-muted);
  border-bottom: 1px solid var(--color-border);
}

.table td {
  padding: 0.5rem 1.25rem;
  color: var(--color-text);
  border-bottom: 1px solid var(--color-border);
}

.table tbody tr:last-child td {
  border-bottom: none;
}

.nowrap {
  white-space: nowrap;
}

.actions {
  text-align: right;
}

/* The spinner takes the button's box so the row does not resize mid-request. */
.busy,
.revoke {
  display: inline-grid;
  place-items: center;
  width: var(--tap-min);
  height: var(--tap-min);
}

.revoke:hover {
  color: var(--color-danger);
  background: var(--color-danger-soft);
}

.device {
  max-width: 16rem;
  overflow: hidden;
  color: var(--color-text-muted);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.badge {
  margin-left: 0.25rem;
  padding: 0.0625rem 0.375rem;
  font-size: 0.75rem;
  font-weight: 500;
  color: var(--color-accent-text);
  background: var(--color-accent-soft);
  border-radius: var(--radius-sm);
}

.confirm {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.confirm__text {
  font-size: 0.875rem;
  line-height: 1.5;
  color: var(--color-text-muted);
}

.confirm__actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 0.5rem;
}

.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}

/* Phones: the table stops being a table. Each session becomes a stacked block
   labelled by its column name, so nothing has to scroll sideways. */
@media (max-width: 46rem) {
  .table,
  .table tbody,
  .table tr,
  .table td {
    display: block;
    width: 100%;
  }

  .table thead {
    display: none;
  }

  .table tr {
    padding: 0.85rem 1.25rem;
    border-bottom: 1px solid var(--color-border);
  }

  .table tbody tr:last-child {
    border-bottom: none;
  }

  .table td {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0.5rem;
    padding: 0.15rem 0;
    border-bottom: none;
  }

  .table td[data-label]::before {
    content: attr(data-label);
    flex: none;
    min-width: 5.5rem;
    font-size: 0.75rem;
    color: var(--color-text-muted);
  }

  .device {
    max-width: none;
    overflow-wrap: anywhere;
    white-space: normal;
  }

  .nowrap {
    white-space: normal;
  }

  .actions {
    margin-top: 0.5rem;
    text-align: left;
  }
}
</style>
