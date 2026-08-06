/**
 * Who this page is answering as, what they have marked, and how it is saved.
 *
 * One concern, and the event page's largest: adopting a name, loading that
 * name's stored answer, painting on it, autosaving every change over whichever
 * pipe is open, clearing it, and handing the identity back when somebody else
 * takes the write session. It lived inside `EventScheduler`, which also owns a
 * chart, two drawers, a sidebar and a phone layout; pulled out here it can be
 * read start to finish without any of that in the way.
 *
 * It is deliberately not a component and deliberately not a store. It is the
 * state of one open page, so it is created by the component that renders that
 * page and dies with it.
 *
 * What it does *not* own is the chart: the pinned slot and the hover highlight
 * belong to the view, and every change of identity drops them, so the caller
 * passes a `resetFocus` rather than this reaching into a grid it knows nothing
 * about.
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

/**
 * The half of the realtime handle this needs: one method that either takes a
 * save or says it cannot.
 */
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
  /**
   * Ask it to give the write session back. The identity is kept — this is the
   * counterpart of `onClaim`, not of `onIdentity(null)` — so entering the edit
   * tab again can ask for the same session by the same name.
   */
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
  /**
   * Whether the open identity dialog is a *landing* — the page's first
   * question, whose quiet way out is "View only" — rather than a question the
   * visitor asked for mid-page, whose way out stays "Just browsing".
   */
  identityLanding: Ref<boolean>;
  /** The person a landing greeted, while the welcome prompt is up. */
  welcome: ComputedRef<{ key: string; displayName: string; matched: boolean } | null>;
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
  /** Everyone who has answered, as the identity dialog needs them. */
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

  /**
   * Who this page is answering as: the key it files under and the name it
   * shows.
   *
   * One ref for both halves rather than two, because they are one fact and the
   * two must never disagree — a key without its spelling cannot render a row,
   * and a spelling without its key cannot match one.
   */
  const identity = ref<RealtimeSession | null>(null);

  /**
   * True while somebody *else* holds this identity's write session.
   *
   * The page still knows who it is — the name is remembered, and "My
   * availability" can ask for the session back — but it is not the one writing
   * as that person, so nothing it is holding locally has any authority. It
   * shows the document instead.
   */
  const surrendered = ref(false);
  const guestKey = computed(() => identity.value?.key ?? null);
  const guestName = computed(() => identity.value?.displayName ?? null);
  const editing = ref(false);
  const identityOpen = ref(false);
  const clearOpen = ref(false);
  /** Set when the guest paints; blocks a background refresh clobbering edits. */
  const dirtySinceConfirm = ref(false);
  let awaitingIdentityRefresh: string | null = null;

  /**
   * The visitor's own unsaved edits, layered over the group's answers so a drag
   * shows up in the heatmap before it has been saved.
   *
   * Null once the session has been surrendered, which is the whole of what
   * makes a replaced page honest: it has no unsaved edits to show, and the
   * marks under that key belong to whoever holds the session now. Without this
   * the page would keep painting its own last state over the top of theirs.
   */
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

  /**
   * Everyone who has already answered, as the identity dialog needs them: the
   * key to match on, the name to offer. Ordered by the name, which is read.
   */
  const existingPeople = computed(() =>
    Object.entries(options.event.value.responses ?? {})
      .map(([key, response]) => ({ key, displayName: response?.displayName || key }))
      .sort((a, b) => a.displayName.localeCompare(b.displayName)),
  );

  /**
   * Announces the identity upwards so the realtime connection can carry it.
   *
   * A watcher rather than a call in each of the three places an identity is
   * taken up or given up: it fires after the synchronous work of the switch —
   * including `engine.flush()`, which has to reach the server as the person
   * being stepped out of — so reconnecting cannot get ahead of the autosave it
   * follows.
   */
  watch(identity, (session) => options.onIdentity(session));

  // --- autosave -------------------------------------------------------------

  /**
   * Whose answer the queued payload is. Not `identity`: switching person while
   * an edit is still queued must not post that edit under the person being
   * switched *to*. It is set where the payload is built and left alone
   * thereafter, so a flush during the switch still lands under the person who
   * made the edit.
   */
  let savingAs: RealtimeSession | null = null;

  /**
   * One save, over whichever pipe is open — the write session when this page
   * holds one, the REST `PUT` otherwise and whenever the socket lets it down.
   * The rule lives in `save-transport.ts`; this only says who is saving.
   *
   * The sync engine above it is untouched by any of it: coalescing, the era
   * counter, the baselines and the retry all work off one `save` promise, and
   * this is that promise however it was kept.
   */
  const saveResponse = createSaveTransport({
    overSocket: (payload) => options.writer.value?.save(payload) ?? null,
    overRest: (payload) => {
      const session = savingAs;
      if (!session) return Promise.resolve();
      // `keepalive`, because this same PUT is what the flush on
      // `pagehide`/`visibilitychange` dispatches: the browser must not cancel
      // it with the document. Harmless on every ordinary save — it only caps
      // the body, and `request` falls back to a plain fetch over the cap.
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

  /** Move a set of slots into one of the two marks, or out of both. */
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

  /**
   * The flush on the way out of the page itself.
   *
   * The Vue unmount hook below covers a component torn down inside a living
   * document; it never runs when the document goes — a closed tab, a
   * navigation, Safari backgrounded mid-edit — which is exactly when a mark
   * made inside the debounce window would otherwise be lost while the
   * indicator's last word was "Saving…". `pagehide` covers desktop unload and
   * the bfcache; `visibilitychange → hidden` is the only signal mobile honours
   * reliably. Neither fires for anything inside the page — a drawer, a view
   * switch — so these cannot double up on `stopEditing`'s flush-then-release,
   * and a flush with nothing queued is a no-op anyway. The REST leg of the
   * flushed save survives the document via `keepalive` (see `overRest` above).
   */
  function flushOnHide(): void {
    engine.flush();
  }
  function onVisibility(): void {
    if (document.visibilityState === "hidden") engine.flush();
  }

  // Registered in `onMounted`, so SSR never sees them, and removed on unmount
  // or a remounted scheduler would leak a listener flushing a dead engine.
  onMounted(() => {
    window.addEventListener("pagehide", flushOnHide);
    document.addEventListener("visibilitychange", onVisibility);
  });

  onBeforeUnmount(() => {
    window.removeEventListener("pagehide", flushOnHide);
    document.removeEventListener("visibilitychange", onVisibility);
    engine.flush();
    engine.dispose();
  });

  // --- identity -------------------------------------------------------------

  /**
   * Adopts a name's stored answer, and tells the autosave engine which of its
   * two resting states that leaves it in.
   *
   * The distinction is the whole point of the two quiet indicator states: a
   * name that came back with marks is already saved on the server ("Up to
   * date"), while a name nobody has answered under yet has nothing behind it at
   * all ("No selection"). The zero-record invariant (ARCHITECTURE.md § API)
   * makes the two the same question — a stored response always has at least one
   * mark, so an empty grid after loading means there is no response.
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
    // Whatever the person being stepped out of had queued goes to the server
    // before the grid is re-seeded under someone else; `loadResponseFor` drops
    // the queue, and an unsaved edit is not this new person's to carry.
    engine.flush();
    identity.value = person;
    // A fresh claim, whatever the last one ended as.
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

  /**
   * "Just browsing": the visitor declined to be anyone, so the page must stop
   * treating them as someone. Dropping the name is what actually stops the
   * autosave — `queueSave` is a no-op without one — and the marks go with it,
   * since they belong to the name that was just given up. Anything already
   * typed under that name is flushed first rather than lost.
   *
   * The stored name goes too. It exists for one job — skipping the dialog for a
   * visitor who already said who they are — and someone who just declined to be
   * anyone has withdrawn exactly that. Leaving it behind meant the next refresh
   * silently put them back under the name they had stepped out of. The response
   * on the server is untouched; they can pick the name again and edit it.
   */
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

  /**
   * The name the landing greets, while the welcome prompt is up. Always a name
   * that passed `guestNameProblem`; null once the prompt has been answered or
   * dismissed.
   */
  const pendingName = ref<string | null>(null);

  /** See `ResponseSession.identityLanding`. */
  const identityLanding = ref(false);

  /**
   * Who the welcome prompt greets. Derived rather than stored, so a snapshot
   * arriving while the prompt is up keeps the greeting on the event's own
   * spelling and the already-answered line honest.
   */
  const welcome = computed(() => {
    const raw = pendingName.value;
    if (raw === null) return null;
    const person = adopt(raw);
    return {
      ...person,
      matched: options.event.value.responses?.[person.key] !== undefined,
    };
  });

  /** The welcome prompt's Continue: the identity dialog's confirm, exactly. */
  function confirmWelcome() {
    const person = welcome.value;
    if (!person) return;
    pendingName.value = null;
    confirmIdentity({ key: person.key, displayName: person.displayName });
  }

  /**
   * "Not <name>?": the greeting was wrong, so ask properly. The generic dialog
   * opens blank per its own contract — the declined name is not this visitor's
   * and must not be offered back to them as a prefill — and keeps its full
   * mid-page semantics, "Just browsing" included. Declining costs nothing yet:
   * the remembered name stays stored until the visitor confirms somebody else
   * or browses.
   */
  function declineWelcome() {
    pendingName.value = null;
    identityLanding.value = false;
    identityOpen.value = true;
  }

  /**
   * The two prompts' quiet exits. Dismissing (Escape, the backdrop, the X)
   * answers nothing: no identity is adopted and the remembered name is not
   * touched — the next landing simply asks again. "View only" is the same
   * answer made explicitly; either way the page shows the group, and the view
   * above navigates accordingly.
   */
  function closeWelcome() {
    pendingName.value = null;
  }

  function closeIdentity() {
    identityOpen.value = false;
  }

  function viewOnly() {
    pendingName.value = null;
    identityOpen.value = false;
  }

  /**
   * Takes an arrival — the mount, or any later route change — and puts the
   * page in the state that URL means (§ Guest UX): the group view asks
   * nothing, an edit path for the person this page already is resumes their
   * editing, and any other landing asks — by name where one is known, blank
   * where none is. Idempotent, because the route watcher above fires for
   * navigations this session itself asked for.
   */
  function applyEntry(entry: EntryRoute) {
    const stored = readStorage(STORAGE_KEYS.guestName)?.trim() ?? "";
    // A name stored before dashes were illegal cannot be saved under, so it is
    // not a name this page can be. Dropping it asks once, and the key the
    // guest retypes lands on the very record the old spelling pointed at.
    const storedUsable = stored !== "" && guestNameProblem(stored) === null;
    if (stored && !storedUsable) clearStorage(STORAGE_KEYS.guestName);

    // The person this page already is needs no confirming twice: reaching
    // their own edit URL — a tab switch, a back button — just resumes.
    if (
      entry.kind === "edit" &&
      identity.value !== null &&
      userKeyFromParam(entry.key) === identity.value.key
    ) {
      pendingName.value = null;
      identityOpen.value = false;
      if (!editing.value) startEditing();
      return;
    }

    const decision = resolveEntryIdentity(
      entry,
      storedUsable ? stored : null,
      existingPeople.value,
    );
    // Whatever this arrival asks, it is not the edit session the page was in.
    if (editing.value) stopEditing();
    switch (decision.action) {
      case "view":
        pendingName.value = null;
        identityOpen.value = false;
        return;
      case "welcome":
        identityOpen.value = false;
        pendingName.value = decision.displayName;
        return;
      case "ask":
        pendingName.value = null;
        identityLanding.value = true;
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

  /** Nothing to clear means no button: the confirm would have no work to do. */
  const hasMarks = computed(() => availability.size > 0 || ifNeeded.size > 0);

  /**
   * Wipes the guest's own answer. The empty state goes out through the normal
   * autosave path — the server turns an empty PUT into a delete (zero-record
   * invariant, ARCHITECTURE.md § API), so the guest leaves the respondents list
   * instead of staying on it with nothing marked. Flushed rather than debounced
   * so the indicator confirms the wipe straight away.
   */
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
    // Drop the stale copy of the response the page is still holding, so coming
    // back through the switch-person button cannot reload what was just
    // deleted. Only once the save actually landed — after a failure the retry
    // still needs the old view, and the error has to stay on screen to be
    // retried from.
    if (syncStatus.value !== "saved") return;
    options.onRefresh();
    // "Saved" would be the wrong thing to leave behind: what the server holds
    // is now nothing at all, which is exactly the state a name with no answer
    // is in. The grid is empty, the name is off the respondents list, and the
    // indicator says so rather than claiming an answer is stored.
    engine.reset("empty");
  }

  // --- removing a response --------------------------------------------------

  /**
   * Anyone holding the link may remove a response — the endpoint is public and
   * the URL is the trust boundary (ARCHITECTURE.md § API/§ Security). The panel
   * confirms first; this only runs the delete and reports what came back.
   */
  const deletingKey = ref<string | null>(null);
  const deleteError = ref<string | null>(null);

  async function removeRespondent(key: string) {
    if (deletingKey.value) return;
    deletingKey.value = key;
    deleteError.value = null;
    try {
      await api.del(userPath(options.event.value.id, key));
      // Their own answer is held locally as well; drop it so the override
      // cannot put the row straight back.
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
      // Coming back after a takeover: the grid has been showing the document,
      // so re-seed from it before letting anyone paint on it again.
      if (surrendered.value) {
        surrendered.value = false;
        loadResponseFor(identity.value.key);
      }
      editing.value = true;
      options.resetFocus();
      // The session may have been refused, or taken away, since this identity
      // was adopted. Asking again here is what makes "My availability" the
      // place a takeover is offered from.
      options.onClaim();
      return;
    }
    // Nobody yet. A remembered name gets the one-tap welcome — the same
    // confirmation a landing gives it — and anyone else is asked properly.
    const stored = readStorage(STORAGE_KEYS.guestName)?.trim() ?? "";
    if (stored && guestNameProblem(stored) === null) {
      pendingName.value = stored;
      return;
    }
    identityLanding.value = false;
    identityOpen.value = true;
  }

  /**
   * Leaving the edit tab ends the editing session, not just the view.
   *
   * A page reading the group's chart is not editing anybody, and holding the
   * write session anyway kept its presence dots pulsing and its key locked
   * against every other device — which then had to be "taken over" from an
   * editor that no longer existed. So the session goes with the tab, in order:
   * the flush first, and the release only once it settles, because a mark made
   * a moment before the switch must reach the server before the socket that
   * would carry it is given up. A save that settles into the error state stays
   * parked for `retry()` exactly as before — the release does not lose it, it
   * only means the retry goes over the REST fallback.
   *
   * Checked again at the far end because the switch can be reversed within the
   * debounce: re-entering the edit tab has already asked for the session back
   * (`startEditing` → `onClaim`), and releasing it then would take away what
   * was just claimed.
   *
   * `leaveEditing` below deliberately does not release: it is the path for a
   * session that was refused or taken away, where there is nothing left to
   * give back.
   */
  function stopEditing() {
    editing.value = false;
    engine.flush();
    void engine.settled().then(() => {
      if (!editing.value) options.onRelease();
    });
  }

  /**
   * Somebody else took this key's write session. Step back to the group view:
   * the page is no longer the one editing as this person, and leaving the grid
   * live would invite marks that have nowhere to go. The identity itself is
   * kept, so "My availability" can ask for the session back.
   */
  function leaveEditing() {
    engine.flush();
    editing.value = false;
    options.resetFocus();
    surrendered.value = true;
  }

  function changeName() {
    // Asked for mid-page: the dialog keeps "Just browsing", not "View only".
    identityLanding.value = false;
    identityOpen.value = true;
  }

  /**
   * The identity for a typed name, snapped to the spelling already on the
   * event.
   *
   * Two people who type the same name differently are one person — that is what
   * the key decides — and the group should keep seeing the spelling it already
   * knows rather than having it rewritten by whoever answered last. A stored
   * spelling that is itself no longer legal (a legacy name with a dash in it) is
   * the exception: it cannot be written back, so the new one replaces it.
   */
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

  // No identity boot here: the arrival is a property of the URL, so the view
  // that owns the route calls `applyEntry` on mount and on every route change
  // (§ Guest UX). Nobody is entered silently on a landing any more — a
  // remembered name gets the one-tap welcome instead.

  return {
    availability,
    ifNeeded,
    identity,
    surrendered,
    guestKey,
    guestName,
    editing,
    identityOpen,
    identityLanding,
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
