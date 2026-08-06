/**
 * Showing one person's answer on the chart instead of everybody's — the
 * phone's stand-in for hovering a respondents-list row. Two cross-control
 * rules live here: entering the edit tab always drops the isolation, and an
 * eye pressed from the edit tab steps out of edit mode in the same gesture.
 */
import { onScopeDispose, ref, watch, type Ref } from "vue";

/**
 * How long a drawer stays up after an eye inside it is pressed — time to see
 * the glyph move. Deliberately not gated on `prefers-reduced-motion`: the
 * pause is not movement; the sheet's own travel respects it, in `Dialog`.
 */
export const ISOLATION_HOLD_MS = 500;

/** A drawer that will close itself shortly, and refuses to be closed until it does. */
export interface HoldThenClose {
  /**
   * True from hold start until it fires. While up the drawer takes no
   * dismissal (`Dialog`'s `locked`): a backdrop tap racing the coming close is
   * the one way this can glitch.
   */
  holding: Ref<boolean>;
  /** Start the hold, or restart it — a second press replaces the first. */
  begin(): void;
  /** Drop a pending hold without closing. */
  cancel(): void;
}

/**
 * Apply now, show for a beat, then close. The timer is owned by the creating
 * scope, so an unmount takes it along rather than closing a drawer that is gone.
 */
export function useHoldThenClose(
  close: () => void,
  delay: number = ISOLATION_HOLD_MS,
): HoldThenClose {
  const holding = ref(false);
  let timer: ReturnType<typeof setTimeout> | null = null;

  function cancel(): void {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    holding.value = false;
  }

  function begin(): void {
    if (timer !== null) clearTimeout(timer);
    holding.value = true;
    timer = setTimeout(() => {
      // Cleared before the callback, so the close's own cancel on its way
      // through finds nothing left to clear.
      timer = null;
      holding.value = false;
      close();
    }, delay);
  }

  onScopeDispose(cancel);

  return { holding, begin, cancel };
}

export interface Isolation {
  /** Whose answer is on the chart alone, by user key, or null for the group. */
  key: Ref<string | null>;
  /** Isolate this person, leaving the edit tab if that is where we are. */
  show(key: string): void;
  /** Back to the group's heatmap. */
  clear(): void;
  /** Isolate, or clear when this person is already the isolated one. */
  toggle(key: string): void;
}

/**
 * Whether this person's answer is on the chart as things stand: no isolation
 * means everybody's is. The eye glyph draws from this state; its label
 * describes the gesture.
 */
export function isOnChart(isolated: string | null | undefined, key: string): boolean {
  return isolated == null || isolated === key;
}

export function useIsolation(options: {
  /** Whether the page is on the "My availability" tab. */
  editing: Ref<boolean>;
  /** Steps out of that tab; the same function the view switch calls. */
  leaveEditing: () => void;
}): Isolation {
  const key = ref<string | null>(null);

  function clear(): void {
    key.value = null;
  }

  function show(next: string): void {
    // Set first: `leaveEditing` moves `editing`, and the watcher below would
    // otherwise undo this in the same tick.
    key.value = next;
    if (options.editing.value) options.leaveEditing();
  }

  function toggle(next: string): void {
    if (key.value === next) clear();
    else show(next);
  }

  // Only on the way *in*: leaving the edit tab is how `show` gets there.
  watch(options.editing, (on) => {
    if (on) clear();
  });

  return { key, show, clear, toggle };
}
