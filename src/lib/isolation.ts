/**
 * Showing one person's answer on the chart instead of everybody's.
 *
 * A heatmap is a sum, and a sum cannot say who is behind it. That is the one
 * question about the chart its colours can never answer, so there is an eye on
 * every row of the respondents list that puts that row's owner on the chart
 * alone.
 *
 * It began as a phone-only trick tied to the drawer it was switched on from,
 * and lived exactly as long as the drawer did: turning it on collapsed the
 * sheet to the row it was about, and closing the sheet put the group back.
 * That made it a thing you could set up but barely look at. It is now a view of
 * the chart rather than a mode of the drawer — it survives the drawer closing,
 * it is offered on the desktop too, and a pill over the chart says whose answer
 * is on screen and takes it away again.
 *
 * Which leaves exactly two rules worth stating in one place, because both are
 * about a *different* control moving this one:
 *
 * - **Writing your own answer is not a view of anybody else's.** Entering the
 *   edit tab drops the isolation, always. The grid there paints what you have
 *   marked, so a filter over the group's answers has nothing to filter and
 *   nowhere to show.
 * - **An eye pressed from the edit tab means "show me that instead".** The
 *   alternative — refusing, or isolating something invisible behind the mode
 *   you are still in — is a button that does nothing you can see. So it steps
 *   out of edit mode and isolates in the same gesture.
 */
import { onScopeDispose, ref, watch, type Ref } from "vue";

/**
 * How long a drawer stays up after an eye inside it is pressed.
 *
 * Comprehension time rather than decoration: the tap has already landed, the
 * chart behind the sheet has already changed, and this is the beat in which the
 * eye is seen to move before the sheet that holds it goes away. Half a second
 * is long enough to read a glyph flipping and short enough that nobody waits
 * for it. It is deliberately **not** gated on `prefers-reduced-motion` — what
 * that setting asks for is less movement, and the pause is the opposite of
 * movement; the sheet's own travel is what respects it, in `Dialog`.
 */
export const ISOLATION_HOLD_MS = 500;

/** A drawer that will close itself shortly, and refuses to be closed until it does. */
export interface HoldThenClose {
  /**
   * True from the moment the hold starts until it fires. While it is up the
   * drawer takes no dismissal from anybody — see `Dialog`'s `locked` — because
   * a backdrop tap racing the close that is already coming is the one way this
   * can be made to glitch.
   */
  holding: Ref<boolean>;
  /**
   * Start the hold, or restart it. A second press inside the window replaces
   * the first rather than queueing behind it, so however many times the eyes
   * are tapped the drawer goes down once, showing whatever the last tap asked
   * for.
   */
  begin(): void;
  /** Drop a pending hold without closing. */
  cancel(): void;
}

/**
 * Apply now, show for a beat, then get out of the way.
 *
 * A phone's respondents list is a sheet over the chart it filters, so an eye
 * pressed there changes something nobody can see. Closing the drawer on the tap
 * hides the toggle before it has visibly moved and reads as the sheet having
 * been dismissed by accident; leaving it open means the visitor has to know to
 * close it. Neither is what was asked for, which was "show me this person".
 *
 * The timer is owned by the scope that created it, so a component unmounting —
 * or a layout that stops being a phone — takes it with it rather than closing a
 * drawer that is no longer there.
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
      // Cleared before the callback, so a `close` that cancels this on its way
      // through — which it does, being the drawer's own close — finds nothing
      // left to clear rather than a handle for a timer that has already fired.
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
 * Whether this person's answer is on the chart as things stand.
 *
 * With no isolation on, everybody's is: the heatmap is the sum of all of them.
 * With one on, exactly one is, and everybody else has been taken off it.
 *
 * This is what the eye on a respondent's row draws itself from. The glyph
 * reports the **state** — an open eye for an answer that is on the chart, a
 * struck-through one for an answer that is not — and the label reports the
 * gesture ("Show only Ada", "Show everyone again"), because those are two
 * different facts and a control that conflated them was reading backwards: the
 * isolated row, the one row you *can* see, wore the hidden glyph.
 *
 * The resting state falls straight out of it. Nobody isolated means nobody
 * hidden, so every row rests on the open eye — the list agrees with the chart,
 * which is showing everyone. Isolation is then one row keeping its eye while
 * the rest close theirs, which is a picture of what actually happened.
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
    // Set first: `leaveEditing` moves `editing`, and the watcher below is what
    // would otherwise undo this in the same tick.
    key.value = next;
    if (options.editing.value) options.leaveEditing();
  }

  function toggle(next: string): void {
    if (key.value === next) clear();
    else show(next);
  }

  // Only on the way *in*. Leaving the edit tab is how `show` gets there, so
  // clearing on every change would make the eye-from-edit-tab case impossible.
  watch(options.editing, (on) => {
    if (on) clear();
  });

  return { key, show, clear, toggle };
}
