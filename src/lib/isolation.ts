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
import { ref, watch, type Ref } from "vue";

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
