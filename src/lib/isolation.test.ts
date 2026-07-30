import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { effectScope, nextTick, ref } from "vue";
import { ISOLATION_HOLD_MS, isOnChart, useHoldThenClose, useIsolation } from "./isolation";

/**
 * The isolated view and the edit tab, which are the only two things that can
 * move each other. Everything else about isolation is a key in a ref.
 */
function setup() {
  const editing = ref(false);
  const left: number[] = [];
  const isolation = useIsolation({
    editing,
    leaveEditing: () => {
      left.push(1);
      editing.value = false;
    },
  });
  return { editing, isolation, left };
}

describe("useIsolation", () => {
  it("starts on the group's answer", () => {
    expect(setup().isolation.key.value).toBeNull();
  });

  it("shows one person, and gives everyone back", () => {
    const { isolation } = setup();
    isolation.show("ada-lovelace");
    expect(isolation.key.value).toBe("ada-lovelace");
    isolation.clear();
    expect(isolation.key.value).toBeNull();
  });

  it("swaps straight from one person to another", () => {
    const { isolation } = setup();
    isolation.toggle("ada-lovelace");
    isolation.toggle("grace-hopper");
    expect(isolation.key.value).toBe("grace-hopper");
  });

  it("reads a second press on the same eye as the way out", () => {
    const { isolation } = setup();
    isolation.toggle("ada-lovelace");
    isolation.toggle("ada-lovelace");
    expect(isolation.key.value).toBeNull();
  });

  it("drops the view when the edit tab is entered", async () => {
    // Writing your own answer is not a view of anybody else's: the grid there
    // paints what you marked, so a filter over the group has nothing to filter.
    const { editing, isolation } = setup();
    isolation.show("ada-lovelace");

    editing.value = true;
    await nextTick();

    expect(isolation.key.value).toBeNull();
  });

  it("leaves the edit tab when an eye is pressed from inside it", async () => {
    // The alternative is a button that does nothing you can see.
    const { editing, isolation, left } = setup();
    editing.value = true;
    await nextTick();

    isolation.toggle("ada-lovelace");
    await nextTick();

    expect(left).toHaveLength(1);
    expect(editing.value).toBe(false);
    // And the view it asked for survives the mode change it caused, which is
    // the whole trick: the watcher only fires on the way *in* to editing.
    expect(isolation.key.value).toBe("ada-lovelace");
  });

  it("keeps the eyes agreeing with the chart", () => {
    // What each row's eye draws. Nobody isolated is nobody hidden, so every
    // answer is on the chart and every eye is open; isolating is one row
    // keeping its eye while the rest close theirs. Getting this backwards put
    // the struck-through eye on the one row you could actually see.
    expect(isOnChart(null, "ada-lovelace")).toBe(true);
    expect(isOnChart(null, "grace-hopper")).toBe(true);

    expect(isOnChart("ada-lovelace", "ada-lovelace")).toBe(true);
    expect(isOnChart("ada-lovelace", "grace-hopper")).toBe(false);

    // The panel's prop is optional, and an absent one means the same as null.
    expect(isOnChart(undefined, "ada-lovelace")).toBe(true);
  });

  it("does not resurrect a view when the edit tab is left by hand", async () => {
    const { editing, isolation } = setup();
    isolation.show("ada-lovelace");
    editing.value = true;
    await nextTick();
    editing.value = false;
    await nextTick();

    expect(isolation.key.value).toBeNull();
  });
});

/**
 * The half second between an eye pressed inside the phone's respondents drawer
 * and the drawer getting out of the way of what it changed.
 *
 * Everything worth asserting about it is a timer and a boolean, so none of this
 * needs the sheet it belongs to. The scope stands in for the component: it is
 * what owns the timer, and disposing it is what unmounting does.
 */
describe("useHoldThenClose", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function setup() {
    const closed: number[] = [];
    const scope = effectScope();
    const hold = scope.run(() => useHoldThenClose(() => closed.push(1)))!;
    return { hold, closed, scope };
  }

  it("holds the drawer shut against everything, then closes it itself", () => {
    const { hold, closed } = setup();
    expect(hold.holding.value).toBe(false);

    hold.begin();
    // The change has already landed on the chart; this is the beat in which the
    // eye is seen to move, and nothing may dismiss the sheet during it.
    expect(hold.holding.value).toBe(true);
    expect(closed).toHaveLength(0);

    vi.advanceTimersByTime(ISOLATION_HOLD_MS - 1);
    expect(closed).toHaveLength(0);

    vi.advanceTimersByTime(1);
    expect(closed).toHaveLength(1);
    expect(hold.holding.value).toBe(false);
  });

  it("takes a second press as the latest word, not as a second dismissal", () => {
    const { hold, closed } = setup();
    hold.begin();
    vi.advanceTimersByTime(ISOLATION_HOLD_MS - 100);

    // Another eye, inside the window. The timer restarts from here …
    hold.begin();
    vi.advanceTimersByTime(ISOLATION_HOLD_MS - 1);
    expect(closed).toHaveLength(0);

    // … and however many taps landed, the drawer goes down exactly once.
    vi.advanceTimersByTime(1);
    expect(closed).toHaveLength(1);
  });

  it("gives up a pending dismissal when it is cancelled", () => {
    // What a drawer closed by hand does, and what widening past the phone
    // layout does: there is nothing left to close.
    const { hold, closed } = setup();
    hold.begin();
    hold.cancel();
    expect(hold.holding.value).toBe(false);

    vi.advanceTimersByTime(ISOLATION_HOLD_MS * 2);
    expect(closed).toHaveLength(0);
  });

  it("takes its timer with it when its owner goes", () => {
    // A page closed, or a mode changed, mid-window: the callback would reach
    // into a component that is not there any more.
    const { hold, closed, scope } = setup();
    hold.begin();
    scope.stop();

    vi.advanceTimersByTime(ISOLATION_HOLD_MS * 2);
    expect(closed).toHaveLength(0);
  });
});
