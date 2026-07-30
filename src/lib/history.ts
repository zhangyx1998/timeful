/**
 * Taking back what you just did, and putting it back again.
 *
 * The chart has always had one way back: the arrow on the floating options,
 * which restored the rectangle a drag had just committed and nothing else. It
 * worked off `SlotSnapshot` — the record of what a set of slots held before
 * something happened to them — and that record is already everything an undo
 * stack needs. So this is not a second mechanism beside it. It is the same
 * record, kept rather than thrown away, and the arrow on the strip is now one
 * of its two front doors: the keyboard is the other.
 *
 * An entry is a pair of records over one set of slots: what they held before an
 * action and what they hold after it. Undo replays the first through
 * `revertOperations`, redo replays the second, and because both come out as the
 * chart's own `paint` and `flip` emits, an undo is applied by exactly the code
 * that applies a drag — including the autosave that follows it. Nothing here
 * talks to the server, and nothing here knows there is one.
 *
 * ### One gesture, one entry
 *
 * A gesture may commit many times. A handle dragged across six columns paints
 * on every step; a rectangle just drawn can be relabelled twice from the strip
 * before the hand leaves it. None of that is six or three things to undo — it is
 * one selection, and the way back from it is the state the gesture interrupted.
 * So commits carry the id of the gesture that made them, and a commit whose id
 * matches the one still open *amends* the entry on top of the stack instead of
 * pushing another. The chart's own record grows the same way and for the same
 * reason (`selectionStep` in `grid.ts`), which is what makes the amended entry
 * correct rather than merely convenient.
 *
 * An undo or a redo closes the open gesture. Whatever the chart does next is a
 * new one, and cannot reach back into an entry the cursor has already moved off.
 *
 * ### It lasts exactly as long as the edit session
 *
 * The stack is created empty when a name starts editing and emptied when that
 * stops being true — stepping back to the group view, going back to browsing,
 * switching to another person, or closing the page. Undo is about the marks you
 * are making now; offering to un-make somebody else's, or to re-apply yours over
 * theirs, would be a way to lose an answer rather than to recover one.
 */
import {
  computed,
  onBeforeUnmount,
  ref,
  shallowRef,
  watch,
  type ComputedRef,
  type Ref,
} from "vue";
import { revertOperations, snapshotSlotList, type RevertOp, type SlotSnapshot } from "./grid";

/** One action, as the two states of the slots it touched. */
export interface HistoryAction {
  /** The gesture that produced it; commits sharing an id are one action. */
  id: number;
  /** What those slots held before it. */
  before: SlotSnapshot;
  /** What they hold now. */
  after: SlotSnapshot;
}

/** A commit as the chart reports it: the record, and whose gesture it is. */
export interface HistoryCommit {
  id: number;
  before: SlotSnapshot;
}

/**
 * How far back it goes. Deep enough that nobody editing an afternoon reaches
 * the end of it, shallow enough that a page open all day cannot grow without
 * bound.
 */
export const HISTORY_DEPTH = 100;

export interface HistoryStack {
  /** Everything recorded, oldest first — undone entries included. */
  entries: ComputedRef<readonly HistoryAction[]>;
  /** How many of them are currently applied; the rest are the redo tail. */
  cursor: ComputedRef<number>;
  canUndo: ComputedRef<boolean>;
  canRedo: ComputedRef<boolean>;
  record(action: HistoryAction): void;
  /** The operations that take the last action back, or null if there is none. */
  undo(): RevertOp[] | null;
  /** The operations that put it back again, or null. */
  redo(): RevertOp[] | null;
  clear(): void;
}

export function createHistoryStack(depth: number = HISTORY_DEPTH): HistoryStack {
  const entries = shallowRef<HistoryAction[]>([]);
  const cursor = ref(0);
  /** The gesture still being committed, whose entry an amendment may replace. */
  let open: number | null = null;

  function record(action: HistoryAction): void {
    if (open === action.id && cursor.value > 0) {
      const amended = entries.value.slice(0, cursor.value);
      amended[amended.length - 1] = action;
      entries.value = amended;
      return;
    }
    // A new action after an undo is a new branch: what was undone is not coming
    // back, because there is now something else in the place it would return to.
    const kept = entries.value.slice(Math.max(0, cursor.value - depth + 1), cursor.value);
    entries.value = [...kept, action];
    cursor.value = entries.value.length;
    open = action.id;
  }

  function undo(): RevertOp[] | null {
    if (cursor.value <= 0) return null;
    const action = entries.value[cursor.value - 1];
    cursor.value -= 1;
    open = null;
    return revertOperations(action.before);
  }

  function redo(): RevertOp[] | null {
    if (cursor.value >= entries.value.length) return null;
    const action = entries.value[cursor.value];
    cursor.value += 1;
    open = null;
    return revertOperations(action.after);
  }

  function clear(): void {
    entries.value = [];
    cursor.value = 0;
    open = null;
  }

  return {
    entries: computed(() => entries.value),
    cursor: computed(() => cursor.value),
    canUndo: computed(() => cursor.value > 0),
    canRedo: computed(() => cursor.value < entries.value.length),
    record,
    undo,
    redo,
    clear,
  };
}

// ---------------------------------------------------------------------------
// the keyboard
// ---------------------------------------------------------------------------

export type HistoryCommand = "undo" | "redo";

/** The parts of a keyboard event the shortcut is decided from. */
export interface ShortcutEvent {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

/**
 * Which of the two a keystroke is, if either.
 *
 * One modifier per platform rather than "whichever is held": on a Mac, ctrl+Z
 * is not undo in any application, and accepting it would mean accepting
 * cmd+ctrl+Z as well. Alt is never part of it, so a combination that means
 * something else somewhere is left alone.
 */
export function historyShortcut(event: ShortcutEvent, mac: boolean): HistoryCommand | null {
  if (event.altKey) return null;
  const modifier = mac
    ? event.metaKey && !event.ctrlKey
    : event.ctrlKey && !event.metaKey;
  if (!modifier) return null;
  if (event.key.toLowerCase() !== "z") return null;
  return event.shiftKey ? "redo" : "undo";
}

/** Whether this browser calls the modifier cmd. */
export function isMacPlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  const platform = `${navigator.platform ?? ""} ${navigator.userAgent ?? ""}`;
  return /mac|iphone|ipad|ipod/i.test(platform);
}

/**
 * Whether the keystroke belongs to something else on the page.
 *
 * A field is the obvious case — cmd+Z in the name box has to undo the typing —
 * and a dialog is the less obvious one: the identity prompt and the event form
 * are modal over the chart, so a chart the visitor cannot even see must not be
 * quietly rearranged behind one.
 */
export function shortcutBlocked(target: unknown): boolean {
  if (!target || typeof target !== "object") return false;
  const element = target as {
    tagName?: unknown;
    isContentEditable?: unknown;
    closest?: (selector: string) => unknown;
  };
  const tag = typeof element.tagName === "string" ? element.tagName.toUpperCase() : "";
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if (element.isContentEditable === true) return true;
  if (typeof element.closest !== "function") return false;
  return element.closest('[role="dialog"], [contenteditable="true"]') != null;
}

// ---------------------------------------------------------------------------
// the page's own copy of one
// ---------------------------------------------------------------------------

export interface UndoHistoryOptions {
  /**
   * Who is editing, as something that changes when that answer does: the user
   * key while the edit view is open, null otherwise. Any change empties the
   * stack, so leaving the view, browsing and switching person are one rule.
   */
  session: Ref<string | null> | ComputedRef<string | null>;
  /** Applies reverting operations along the chart's own emit path. */
  apply(operations: RevertOp[]): void;
  /** What the given slots hold at this moment. */
  read(slots: number[]): SlotSnapshot;
  /** Run before an undo or redo moves anything — the chart drops its selection. */
  beforeApply?(): void;
  depth?: number;
}

export interface UndoHistory {
  canUndo: ComputedRef<boolean>;
  canRedo: ComputedRef<boolean>;
  /** File a commit the chart has just made. */
  record(commit: HistoryCommit): void;
  /** Take back the last action. False when there was nothing to take back. */
  undo(): boolean;
  redo(): boolean;
  /** Ids for actions that do not come from a chart gesture, such as a clear. */
  nextId(): number;
  clear(): void;
}

export function useUndoHistory(options: UndoHistoryOptions): UndoHistory {
  const stack = createHistoryStack(options.depth);
  let sequence = 0;

  function record(commit: HistoryCommit): void {
    // The chart reports what the slots *were*; what they are is read here,
    // after the parent has applied the change, because that is the only place
    // both halves of the pair are true at the same time.
    const slots = snapshotSlotList(commit.before);
    stack.record({ id: commit.id, before: commit.before, after: options.read(slots) });
  }

  function run(operations: RevertOp[] | null): boolean {
    if (!operations) return false;
    options.beforeApply?.();
    options.apply(operations);
    return true;
  }

  watch(
    () => options.session.value,
    () => stack.clear(),
  );

  function onKeydown(event: KeyboardEvent) {
    if (options.session.value === null) return;
    if (event.defaultPrevented || shortcutBlocked(event.target)) return;
    const command = historyShortcut(event, isMacPlatform());
    if (!command) return;
    if (command === "undo") run(stack.undo());
    else run(stack.redo());
    // Claimed either way. A cmd+Z with nothing left to take back must not fall
    // through to the browser's own idea of undo on the page behind the chart.
    event.preventDefault();
  }

  if (typeof window !== "undefined") {
    window.addEventListener("keydown", onKeydown);
    onBeforeUnmount(() => window.removeEventListener("keydown", onKeydown));
  }

  return {
    canUndo: stack.canUndo,
    canRedo: stack.canRedo,
    record,
    undo: () => run(stack.undo()),
    redo: () => run(stack.redo()),
    nextId: () => {
      sequence -= 1;
      return sequence;
    },
    clear: stack.clear,
  };
}
