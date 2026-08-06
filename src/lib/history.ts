/**
 * Undo/redo for the chart. An entry is a before/after `SlotSnapshot` pair over
 * one set of slots, replayed through `revertOperations` along the chart's own
 * paint/flip path — autosave included. Commits sharing a gesture id amend the
 * top entry (mirroring `selectionStep` in grid.ts); the stack lives exactly as
 * long as the edit session.
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
  before: SlotSnapshot;
  after: SlotSnapshot;
}

/** A commit as the chart reports it: the record, and whose gesture it is. */
export interface HistoryCommit {
  id: number;
  before: SlotSnapshot;
}

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
    // A new action after an undo drops the redo tail.
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

export type HistoryCommand = "undo" | "redo";

/** The parts of a keyboard event the shortcut is decided from. */
export interface ShortcutEvent {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

// One modifier per platform, not "whichever is held": on a Mac ctrl+Z is not
// undo anywhere, and alt combinations mean something else and are left alone.
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

// Fields keep their own undo; dialogs are modal over a chart the visitor
// cannot see, which must not be rearranged behind one.
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

export interface UndoHistoryOptions {
  /** The user key while the edit view is open, null otherwise; any change empties the stack. */
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
    // `after` is read here, once the parent has applied the change — the only
    // moment both halves of the pair are true.
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
    // Claimed either way: a cmd+Z with nothing left must not fall through to
    // the browser's own undo.
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
