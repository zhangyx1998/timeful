<script setup lang="ts">
/**
 * The admin's window onto a server log buffer — one component, two sources:
 * the global stream (`/api/logs`, the panel's Logs tab) and one event's
 * (`/<uuid>/logs`, the Details dialog's "Server logs" tab).
 *
 * The transport is a **disposable** WebSocket: opened when this mounts, closed
 * when it unmounts, no reconnect loop — it is a viewing session, not sync. The
 * server replays the buffer in one frame and then streams live entries;
 * admin-only is the server's doing (the session cookie is verified before the
 * upgrade completes), this component just holds the receiving end.
 *
 * Newest entries land at the bottom, and the view sticks there — until the
 * admin scrolls up to read, which pauses the following; a "Jump to latest"
 * chip brings it back. That rule is what makes a live log readable at all.
 */
import { nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import type { LogEntry, LogStreamMessage } from "../../lib/logs";

const props = withDefaults(
  defineProps<{
    /** The stream's path — `/api/logs`, or `eventLogsPath(uuid)`. */
    path: string;
    /** What an empty buffer says. */
    emptyText?: string;
  }>(),
  { emptyText: "Nothing logged yet" },
);

const entries = ref<LogEntry[]>([]);
/** connecting -> open -> closed | gone; failed when it never opened. */
const state = ref<"connecting" | "open" | "closed" | "gone" | "failed">("connecting");
const stuck = ref(true);
const scroller = ref<HTMLElement | null>(null);

let socket: WebSocket | null = null;

function connect(): void {
  // Never during SSR, like every socket in this app — though this component
  // only ever mounts from a click, the guard costs one line.
  if (typeof window === "undefined") return;
  const scheme = window.location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${scheme}://${window.location.host}${props.path}`);
  socket = ws;
  ws.addEventListener("open", () => {
    if (socket === ws) state.value = "open";
  });
  ws.addEventListener("message", (event: MessageEvent) => {
    if (socket !== ws) return;
    let message: LogStreamMessage;
    try {
      message = JSON.parse(String(event.data)) as LogStreamMessage;
    } catch {
      return;
    }
    if (message.type === "replay") entries.value = message.entries;
    else if (message.type === "entry") entries.value.push(message.entry);
    else if (message.type === "gone") state.value = "gone";
    void followTail();
  });
  ws.addEventListener("close", () => {
    if (socket !== ws) return;
    // A refused upgrade never fired `open`; a served stream ended. No
    // reconnect either way — closing the panel and reopening it is the retry.
    if (state.value === "connecting") state.value = "failed";
    else if (state.value === "open") state.value = "closed";
  });
}

/** Keeps the view pinned to the newest line, unless the admin scrolled away. */
async function followTail(): Promise<void> {
  if (!stuck.value) return;
  await nextTick();
  const el = scroller.value;
  if (el) el.scrollTop = el.scrollHeight;
}

function onScroll(): void {
  const el = scroller.value;
  if (!el) return;
  // A little tolerance: subpixel scroll heights must not unstick the tail.
  stuck.value = el.scrollTop + el.clientHeight >= el.scrollHeight - 4;
}

function jumpToLatest(): void {
  stuck.value = true;
  void followTail();
}

const timeFormat =
  typeof Intl === "undefined"
    ? null
    : new Intl.DateTimeFormat(undefined, {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });

function formatAt(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return timeFormat ? timeFormat.format(date) : date.toLocaleString();
}

/** The structured fields, printed after the sentence in one quiet run. */
function extras(entry: LogEntry): string {
  const parts: string[] = [];
  if (entry.code && !entry.message.includes(entry.code)) parts.push(`[${entry.code}]`);
  if (entry.path && !entry.message.includes(entry.path)) parts.push(entry.path);
  if (entry.stack) parts.push(entry.stack);
  return parts.join(" ");
}

onMounted(connect);
onBeforeUnmount(() => {
  const ws = socket;
  socket = null;
  ws?.close();
});
</script>

<template>
  <div class="viewer">
    <div ref="scroller" class="lines" @scroll="onScroll">
      <p v-if="entries.length === 0" class="note">
        {{ state === "connecting" ? "Connecting…"
          : state === "failed" ? "Could not open the log stream."
          : emptyText }}
      </p>

      <template v-else>
        <div
          v-for="(entry, index) in entries"
          :key="index"
          class="line"
          :class="`line--${entry.level}`"
        >
          <span class="at">{{ formatAt(entry.at) }}</span>
          <span class="level">{{ entry.level }}</span>
          <span class="text">
            {{ entry.message
            }}<span v-if="extras(entry)" class="extras"> {{ extras(entry) }}</span>
          </span>
        </div>
      </template>

      <p v-if="state === 'gone'" class="note note--end">
        The event was deleted; the log ends here.
      </p>
      <p v-else-if="state === 'closed' && entries.length > 0" class="note note--end">
        The stream closed. Reopen this panel to reconnect.
      </p>
    </div>

    <!-- Reading pauses the following; this is the way back to now. -->
    <button v-if="!stuck" type="button" class="jump" @click="jumpToLatest">
      Jump to latest
    </button>
  </div>
</template>

<style scoped>
.viewer {
  position: relative;
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.lines {
  height: min(21rem, 55dvh);
  padding: 0.6rem 0.7rem;
  overflow-y: auto;
  overscroll-behavior: contain;
  font-family: var(--font-mono);
  font-size: 0.71875rem;
  line-height: 1.45;
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
}

.line {
  display: flex;
  gap: 0.5rem;
  align-items: baseline;
  padding: 0.05rem 0;
  color: var(--color-text-muted);
  user-select: text;
}

.at {
  flex: none;
  color: var(--color-text-muted);
}

/* The level word carries the tint; the message keeps reading weight so a
   column of errors is still a column of sentences, not a red wall. */
.level {
  flex: none;
  width: 2.9em;
  font-weight: 600;
  text-transform: uppercase;
}

.line--error .level {
  color: var(--color-danger);
}

.line--warn .level {
  color: var(--color-warning);
}

.line--info .level {
  color: var(--color-text-muted);
}

.line--error .text,
.line--warn .text {
  color: var(--color-text);
}

.text {
  min-width: 0;
  overflow-wrap: anywhere;
}

.extras {
  color: var(--color-text-muted);
}

.note {
  padding: 0.15rem 0;
  font-family: var(--font-sans);
  color: var(--color-text-muted);
}

.note--end {
  margin-top: 0.3rem;
  font-style: italic;
}

/* The way back to the tail, floated over the bottom of the pane. Glass would
   be overkill for a line of text; the surface colour and a border keep the
   log readable through its own corner. */
.jump {
  position: absolute;
  bottom: 0.6rem;
  left: 50%;
  padding: 0.25rem 0.7rem;
  font: inherit;
  font-size: 0.75rem;
  font-weight: 600;
  color: var(--color-accent);
  cursor: pointer;
  background: var(--color-surface);
  border: 1px solid var(--color-border-strong);
  border-radius: 999px;
  box-shadow: var(--shadow-sm);
  transform: translateX(-50%);
}

.jump:hover {
  background: var(--color-subtle);
}

/* Tap target on a phone; the pane is already narrow at 360px, and the chip
   keeps to its own width so no line of the log is permanently covered. */
@media (pointer: coarse) {
  .jump {
    min-height: var(--tap-min);
  }
}
</style>
