/**
 * Who this page is answering as, what they have marked, and how it is saved.
 * Per-page state, created by the component that renders the page and dying
 * with it; the chart's focus belongs to the view, hence `resetFocus`.
 */
import {
  computed,
  onBeforeUnmount,
  onMounted,
  reactive,
  ref,
  watch,
  type ComputedRef,
  type Ref,
} from "vue";
import { api, apiError, userPath } from "./api";
import { resolveEntryIdentity, type EntryRoute } from "./entry-identity";
import { toAvailabilitySets, toIsoArray, type AvailabilityType, type EventDoc } from "./event";
import type { RealtimeSession, SavePayload } from "./realtime";
import { createSaveTransport } from "./save-transport";
import { clearStorage, readStorage, STORAGE_KEYS, writeStorage } from "./storage";
import { createSyncEngine, type SyncBaseline, type SyncStatus } from "./sync";
import { adoptDisplayName, guestNameProblem, userKey, userKeyFromParam } from "./user-key";

export interface RealtimeWriter {
  save(payload: SavePayload): Promise<void> | null;
}

export interface ResponseSessionOptions {
  event: Ref<EventDoc>;
  /** The page's write session, when it holds one. */
  writer: Ref<RealtimeWriter | null>;
  /** Ask the page above for a fresh copy of the document. */
  onRefresh: () => void;
  /** Ask it to claim the write session for the identity already adopted. */
  onClaim: () => void;
  /** Counterpart of `onClaim`, not of `onIdentity(null)`: the identity is kept. */
  onRelease: () => void;
  /** Tell it who this page is now, so the socket can carry the name. */
  onIdentity: (session: RealtimeSession | null) => void;
  /** Drop the chart's pinned slot and hover; any identity change does. */
  resetFocus: () => void;
}

export interface ResponseSession {
  availability: Set<number>;
  ifNeeded: Set<number>;
  identity: Ref<RealtimeSession | null>;
  surrendered: Ref<boolean>;
  guestKey: ComputedRef<string | null>;
  guestName: ComputedRef<string | null>;
  editing: Ref<boolean>;
  identityOpen: Ref<boolean>;
  /** The person a landing greeted, while the welcome prompt is up. */
  welcome: ComputedRef<{
    key: string;
    displayName: string;
    matched: boolean;
    returning: boolean;
    /** The link's greeting decoration; never part of the identity. */
    prefix: string | null;
  } | null>;
  clearOpen: Ref<boolean>;
  deletingKey: Ref<string | null>;
  deleteError: Ref<string | null>;
  hasMarks: ComputedRef<boolean>;
  syncStatus: Ref<SyncStatus>;
  syncError: Ref<string | null>;
  /** The admin-only detail under a failed save; null for guests always. */
  syncErrorDetail: Ref<string | null>;
  /** The visitor's own unsaved edits, for `buildResponseIndex`. */
  override: ComputedRef<{
    key: string;
    displayName: string;
    availability: Set<number>;
    ifNeeded: Set<number>;
  } | null>;
  existingPeople: ComputedRef<{ key: string; displayName: string }[]>;
  retry(): void;
  onPaint(change: { type: "add" | "remove"; slots: number[] }): void;
  onFlip(change: { type: AvailabilityType; slots: number[] }): void;
  confirmIdentity(person: RealtimeSession): void;
  browseOnly(): void;
  confirmWelcome(): void;
  declineWelcome(): void;
  closeWelcome(): void;
  closeIdentity(): void;
  viewOnly(): void;
  applyEntry(entry: EntryRoute): void;
  clearMine(): Promise<void>;
  removeRespondent(key: string): Promise<void>;
  startEditing(): void;
  stopEditing(): void;
  leaveEditing(): void;
  changeName(): void;
}

export function useResponseSession(options: ResponseSessionOptions): ResponseSession {
  const availability = reactive(new Set<number>());
  const ifNeeded = reactive(new Set<number>());

  /** One ref for both halves, so the key and its spelling can never disagree. */
  const identity = ref<RealtimeSession | null>(null);

  /** True while somebody *else* holds this identity's write session. */
  const surrendered = ref(false);
  const guestKey = computed(() => identity.value?.key ?? null);
  const guestName = computed(() => identity.value?.displayName ?? null);
  const editing = ref(false);
  const identityOpen = ref(false);
  const clearOpen = ref(false);
  /** Set when the guest paints; blocks a background refresh clobbering edits. */
  const dirtySinceConfirm = ref(false);
  let awaitingIdentityRefresh: string | null = null;

  // Null once surrendered: the marks under this key belong to whoever holds
  // the session now, so the replaced page must not paint over them.
  const override = computed(() =>
    identity.value && !surrendered.value
      ? {
          key: identity.value.key,
          displayName: identity.value.displayName,
          availability: availability as Set<number>,
          ifNeeded: ifNeeded as Set<number>,
        }
      : null,
  );

  const existingPeople = computed(() =>
    Object.entries(options.event.value.responses ?? {})
      .map(([key, response]) => ({ key, displayName: response?.displayName || key }))
      .sort((a, b) => a.displayName.localeCompare(b.displayName)),
  );

  // A watcher, so it fires after the switch's synchronous work — including the
  // engine.flush() that must reach the server as the person being stepped out of.
  watch(identity, (session) => options.onIdentity(session));

  // --- autosave -------------------------------------------------------------

  // Snapshotted where the payload is built: switching person while an edit is
  // queued must not post that edit under the person being switched to.
  let savingAs: RealtimeSession | null = null;

  const saveResponse = createSaveTransport({
    overSocket: (payload) => options.writer.value?.save(payload) ?? null,
    overRest: (payload) => {
      const session = savingAs;
      if (!session) return Promise.resolve();
      // keepalive: this same PUT is the pagehide/visibilitychange flush and
      // must survive the document.
      return api.put(
        userPath(options.event.value.id, session.key),
        {
          displayName: session.displayName,
          ...payload,
        },
        { keepalive: true },
      );
    },
  });

  const engine = createSyncEngine({
    save: async (payload) => {
      if (!savingAs) return;
      await saveResponse(payload);
    },
  });

  const syncStatus = engine.status;
  const syncError = engine.error;
  const syncErrorDetail = engine.errorDetail;

  function queueSave() {
    if (!identity.value) return;
    savingAs = identity.value;
    engine.schedule({
      availability: toIsoArray(availability),
      ifNeeded: toIsoArray(ifNeeded),
    });
  }

  function mark(slots: number[], as: AvailabilityType | null) {
    for (const slot of slots) {
      if (as === "available") {
        availability.add(slot);
        ifNeeded.delete(slot);
      } else if (as === "if_needed") {
        ifNeeded.add(slot);
        availability.delete(slot);
      } else {
        availability.delete(slot);
        ifNeeded.delete(slot);
      }
    }
    dirtySinceConfirm.value = true;
    queueSave();
  }

  /** Every drag paints an available time; the menu that follows may refine it. */
  function onPaint(change: { type: "add" | "remove"; slots: number[] }) {
    mark(change.slots, change.type === "add" ? "available" : null);
  }

  function onFlip(change: { type: AvailabilityType; slots: number[] }) {
    mark(change.slots, change.type);
  }

  // The unmount hook never runs when the document goes: `pagehide` covers
  // desktop unload and the bfcache; `visibilitychange → hidden` is the only
  // signal mobile honours reliably.
  function flushOnHide(): void {
    engine.flush();
  }
  function onVisibility(): void {
    if (document.visibilityState === "hidden") engine.flush();
  }

  // Stale instances re-resolve on cross-tab writes and bfcache restores, so a
  // purged name cannot be resurrected (ARCHITECTURE.md § Guest UX).
  function reresolveEntry(): void {
    if (identity.value === null) applyEntry(currentEntry);
  }
  function onStorage(event: StorageEvent): void {
    // `key === null` is `clear()`.
    if (event.key !== null && event.key !== STORAGE_KEYS.guestName) return;
    reresolveEntry();
  }
  function onPageShow(event: PageTransitionEvent): void {
    if (event.persisted) reresolveEntry();
  }

  // Registered in `onMounted` so SSR never sees them.
  onMounted(() => {
    window.addEventListener("pagehide", flushOnHide);
    window.addEventListener("pageshow", onPageShow);
    window.addEventListener("storage", onStorage);
    document.addEventListener("visibilitychange", onVisibility);
  });

  onBeforeUnmount(() => {
    window.removeEventListener("pagehide", flushOnHide);
    window.removeEventListener("pageshow", onPageShow);
    window.removeEventListener("storage", onStorage);
    document.removeEventListener("visibilitychange", onVisibility);
    engine.flush();
    engine.dispose();
  });

  // --- identity -------------------------------------------------------------

  /**
   * Zero-record invariant (ARCHITECTURE.md § API): a stored response always
   * has at least one mark, so an empty grid after loading means no response.
   */
  function loadResponseFor(key: string) {
    const sets = toAvailabilitySets(options.event.value.responses?.[key]);
    availability.clear();
    for (const slot of sets.availability) availability.add(slot);
    ifNeeded.clear();
    for (const slot of sets.ifNeeded) ifNeeded.add(slot);
    const baseline: SyncBaseline =
      availability.size > 0 || ifNeeded.size > 0 ? "current" : "empty";
    engine.reset(baseline);
  }

  function confirmIdentity(person: RealtimeSession) {
    // Flush the outgoing person's queue before the grid is re-seeded under
    // someone else.
    engine.flush();
    identity.value = person;
    surrendered.value = false;
    writeStorage(STORAGE_KEYS.guestName, person.displayName);
    identityOpen.value = false;
    dirtySinceConfirm.value = false;
    loadResponseFor(person.key);
    editing.value = true;
    options.resetFocus();
    // Pull the freshest copy: someone may have answered since this page loaded.
    awaitingIdentityRefresh = person.key;
    options.onRefresh();
  }

  // Dropping the name is what stops the autosave; the stored name goes too, or
  // the next refresh would silently re-adopt it. The server response is untouched.
  function browseOnly() {
    engine.flush();
    clearStorage(STORAGE_KEYS.guestName);
    identityOpen.value = false;
    awaitingIdentityRefresh = null;
    identity.value = null;
    surrendered.value = false;
    availability.clear();
    ifNeeded.clear();
    engine.reset("empty");
    editing.value = false;
    dirtySinceConfirm.value = false;
    options.resetFocus();
  }

  // --- landing --------------------------------------------------------------

  /** Set while the welcome prompt is up; always a name that passed `guestNameProblem`. */
  const pendingGreeting = ref<{ name: string; prefix: string | null } | null>(null);

  /** The last arrival applied, for re-resolution when storage shifts under it. */
  let currentEntry: EntryRoute = { kind: "view" };

  // Derived rather than stored, so a snapshot arriving mid-prompt keeps the
  // greeting on the event's own spelling.
  const welcome = computed(() => {
    const greeting = pendingGreeting.value;
    if (greeting === null) return null;
    const person = adopt(greeting.name);
    const matched = options.event.value.responses?.[person.key] !== undefined;
    const stored = readStorage(STORAGE_KEYS.guestName)?.trim() ?? "";
    return {
      ...person,
      matched,
      returning: matched || (stored !== "" && userKey(stored) === person.key),
      prefix: greeting.prefix,
    };
  });

  function confirmWelcome() {
    const person = welcome.value;
    if (!person) return;
    pendingGreeting.value = null;
    confirmIdentity({ key: person.key, displayName: person.displayName });
  }

  // The dialog opens blank: the declined name is not this visitor's and must
  // not be offered back as a prefill.
  function declineWelcome() {
    pendingGreeting.value = null;
    identityOpen.value = true;
  }

  function closeWelcome() {
    pendingGreeting.value = null;
  }

  function closeIdentity() {
    identityOpen.value = false;
  }

  function viewOnly() {
    pendingGreeting.value = null;
    identityOpen.value = false;
  }

  /** Puts the page in the state the arrival URL means (§ Guest UX). Idempotent. */
  function applyEntry(entry: EntryRoute) {
    currentEntry = entry;
    const stored = readStorage(STORAGE_KEYS.guestName)?.trim() ?? "";
    // A stored name that is no longer legal cannot be saved under; drop it and
    // ask once — the retyped key lands on the record the old spelling pointed at.
    const storedUsable = stored !== "" && guestNameProblem(stored) === null;
    if (stored && !storedUsable) clearStorage(STORAGE_KEYS.guestName);

    // Reaching your own edit URL — a tab switch, a back button — just resumes.
    if (
      entry.kind === "edit" &&
      identity.value !== null &&
      userKeyFromParam(entry.key) === identity.value.key
    ) {
      pendingGreeting.value = null;
      identityOpen.value = false;
      if (!editing.value) startEditing();
      return;
    }

    const decision = resolveEntryIdentity(
      entry,
      storedUsable ? stored : null,
      existingPeople.value,
    );
    if (editing.value) stopEditing();
    switch (decision.action) {
      case "view":
        pendingGreeting.value = null;
        identityOpen.value = false;
        return;
      case "welcome":
        identityOpen.value = false;
        pendingGreeting.value = { name: decision.displayName, prefix: decision.prefix };
        return;
      case "ask":
        pendingGreeting.value = null;
        identityOpen.value = true;
        return;
    }
  }

  // A refresh triggered by confirming identity re-seeds the grid, unless the
  // guest has already started editing.
  watch(
    () => options.event.value,
    () => {
      const key = awaitingIdentityRefresh;
      awaitingIdentityRefresh = null;
      if (!key || dirtySinceConfirm.value || engine.pending.value) return;
      loadResponseFor(key);
    },
  );

  // --- clearing your own answer ---------------------------------------------

  const hasMarks = computed(() => availability.size > 0 || ifNeeded.size > 0);

  // The empty state goes out through the normal autosave path; the server
  // turns an empty PUT into a delete (zero-record invariant, ARCHITECTURE.md § API).
  async function clearMine() {
    clearOpen.value = false;
    if (!identity.value) return;
    availability.clear();
    ifNeeded.clear();
    options.resetFocus();
    dirtySinceConfirm.value = true;
    queueSave();
    engine.flush();
    await engine.settled();
    // Only once the save landed: a failed save still needs the old view and
    // the on-screen error to retry from.
    if (syncStatus.value !== "saved") return;
    options.onRefresh();
    // The server now holds nothing, which is the state a name with no answer is in.
    engine.reset("empty");
  }

  // --- removing a response --------------------------------------------------

  // Public endpoint; the URL is the trust boundary (ARCHITECTURE.md § API/§ Security).
  const deletingKey = ref<string | null>(null);
  const deleteError = ref<string | null>(null);

  async function removeRespondent(key: string) {
    if (deletingKey.value) return;
    deletingKey.value = key;
    deleteError.value = null;
    try {
      await api.del(userPath(options.event.value.id, key));
      // Drop the local copy too, so the override cannot put the row straight back.
      if (guestKey.value === key) {
        availability.clear();
        ifNeeded.clear();
        engine.reset("empty");
      }
      options.onRefresh();
    } catch (err) {
      deleteError.value = apiError(err, "Could not remove that response").message;
    } finally {
      deletingKey.value = null;
    }
  }

  // --- the two views --------------------------------------------------------

  function startEditing() {
    if (identity.value) {
      // After a takeover the grid showed the document; re-seed before painting.
      if (surrendered.value) {
        surrendered.value = false;
        loadResponseFor(identity.value.key);
      }
      editing.value = true;
      options.resetFocus();
      // Ask again: the session may have been refused or taken away since.
      options.onClaim();
      return;
    }
    const stored = readStorage(STORAGE_KEYS.guestName)?.trim() ?? "";
    if (stored && guestNameProblem(stored) === null) {
      pendingGreeting.value = { name: stored, prefix: null };
      return;
    }
    identityOpen.value = true;
  }

  /**
   * Leaving the edit tab releases the write session: flush first, release only
   * once settled, and only if the switch was not reversed within the debounce.
   */
  function stopEditing() {
    editing.value = false;
    engine.flush();
    void engine.settled().then(() => {
      if (!editing.value) options.onRelease();
    });
  }

  /** Session taken away: back to the group view; identity kept so it can be reclaimed. */
  function leaveEditing() {
    engine.flush();
    editing.value = false;
    options.resetFocus();
    surrendered.value = true;
  }

  function changeName() {
    identityOpen.value = true;
  }

  // Snaps a typed name to the spelling already on the event; an illegal stored
  // spelling (legacy dash) is replaced instead.
  function adopt(displayName: string): RealtimeSession {
    const key = userKey(displayName);
    return {
      key,
      displayName: adoptDisplayName(
        displayName,
        options.event.value.responses?.[key]?.displayName,
      ),
    };
  }

  // No identity boot here: the view that owns the route calls `applyEntry` on
  // mount and on every route change (§ Guest UX).

  return {
    availability,
    ifNeeded,
    identity,
    surrendered,
    guestKey,
    guestName,
    editing,
    identityOpen,
    welcome,
    clearOpen,
    deletingKey,
    deleteError,
    hasMarks,
    syncStatus,
    syncError,
    syncErrorDetail,
    override,
    existingPeople,
    retry: () => engine.retry(),
    onPaint,
    onFlip,
    confirmIdentity,
    browseOnly,
    confirmWelcome,
    declineWelcome,
    closeWelcome,
    closeIdentity,
    viewOnly,
    applyEntry,
    clearMine,
    removeRespondent,
    startEditing,
    stopEditing,
    leaveEditing,
    changeName,
  };
}
