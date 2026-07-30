import { describe, expect, it } from "vitest";
import {
  createHistoryStack,
  historyShortcut,
  shortcutBlocked,
  type HistoryAction,
} from "./history";
import type { SlotSnapshot } from "./grid";

const empty: SlotSnapshot = { available: [], ifNeeded: [], empty: [] };

function snapshot(partial: Partial<SlotSnapshot>): SlotSnapshot {
  return { ...empty, ...partial };
}

/** One action: `slots` were blank, and are now available. */
function painted(id: number, slots: number[]): HistoryAction {
  return {
    id,
    before: snapshot({ empty: slots }),
    after: snapshot({ available: slots }),
  };
}

describe("createHistoryStack", () => {
  it("starts with nothing to undo or redo", () => {
    const stack = createHistoryStack();
    expect(stack.canUndo.value).toBe(false);
    expect(stack.canRedo.value).toBe(false);
    expect(stack.undo()).toBeNull();
    expect(stack.redo()).toBeNull();
  });

  it("undoes an action by replaying what the slots were", () => {
    const stack = createHistoryStack();
    stack.record(painted(1, [10, 20]));

    expect(stack.canUndo.value).toBe(true);
    expect(stack.undo()).toEqual([{ emit: "paint", type: "remove", slots: [10, 20] }]);
    expect(stack.canUndo.value).toBe(false);
    expect(stack.canRedo.value).toBe(true);
  });

  it("redoes it by replaying what they became", () => {
    const stack = createHistoryStack();
    stack.record(painted(1, [10]));
    stack.undo();

    expect(stack.redo()).toEqual([{ emit: "flip", type: "available", slots: [10] }]);
    expect(stack.canRedo.value).toBe(false);
    expect(stack.canUndo.value).toBe(true);
  });

  it("puts each mark of a mixed rectangle back as its own kind", () => {
    const stack = createHistoryStack();
    stack.record({
      id: 1,
      before: snapshot({ available: [1], ifNeeded: [2], empty: [3] }),
      after: snapshot({ empty: [1, 2, 3] }),
    });

    expect(stack.undo()).toEqual([
      { emit: "paint", type: "remove", slots: [3] },
      { emit: "flip", type: "available", slots: [1] },
      { emit: "flip", type: "if_needed", slots: [2] },
    ]);
  });

  it("walks back and forth through several actions", () => {
    const stack = createHistoryStack();
    stack.record(painted(1, [1]));
    stack.record(painted(2, [2]));
    stack.record(painted(3, [3]));

    expect(stack.undo()).toEqual([{ emit: "paint", type: "remove", slots: [3] }]);
    expect(stack.undo()).toEqual([{ emit: "paint", type: "remove", slots: [2] }]);
    expect(stack.redo()).toEqual([{ emit: "flip", type: "available", slots: [2] }]);
    expect(stack.redo()).toEqual([{ emit: "flip", type: "available", slots: [3] }]);
    expect(stack.canRedo.value).toBe(false);
  });

  it("amends the open gesture instead of stacking every commit of it", () => {
    const stack = createHistoryStack();
    // A tap, then two steps of a handle drag: one selection, one entry.
    stack.record(painted(7, [1]));
    stack.record(painted(7, [1, 2]));
    stack.record(painted(7, [1, 2, 3]));

    expect(stack.entries.value).toHaveLength(1);
    expect(stack.undo()).toEqual([{ emit: "paint", type: "remove", slots: [1, 2, 3] }]);
    expect(stack.canUndo.value).toBe(false);
  });

  it("treats a different gesture as a different entry", () => {
    const stack = createHistoryStack();
    stack.record(painted(7, [1]));
    stack.record(painted(8, [2]));

    expect(stack.entries.value).toHaveLength(2);
  });

  it("closes the open gesture on undo, so a later commit cannot amend it", () => {
    const stack = createHistoryStack();
    stack.record(painted(7, [1]));
    stack.undo();
    stack.record(painted(7, [5]));

    expect(stack.entries.value).toHaveLength(1);
    expect(stack.entries.value[0].after.available).toEqual([5]);
  });

  it("drops the redo tail once something else is done", () => {
    const stack = createHistoryStack();
    stack.record(painted(1, [1]));
    stack.record(painted(2, [2]));
    stack.undo();
    expect(stack.canRedo.value).toBe(true);

    stack.record(painted(3, [3]));
    expect(stack.canRedo.value).toBe(false);
    expect(stack.entries.value.map((entry) => entry.id)).toEqual([1, 3]);
  });

  it("caps its depth, dropping the oldest entries", () => {
    const stack = createHistoryStack(3);
    for (let i = 1; i <= 5; i += 1) stack.record(painted(i, [i]));

    expect(stack.entries.value.map((entry) => entry.id)).toEqual([3, 4, 5]);
    expect(stack.undo()).toEqual([{ emit: "paint", type: "remove", slots: [5] }]);
    expect(stack.undo()).toEqual([{ emit: "paint", type: "remove", slots: [4] }]);
    expect(stack.undo()).toEqual([{ emit: "paint", type: "remove", slots: [3] }]);
    expect(stack.undo()).toBeNull();
  });

  it("empties completely when the edit session ends", () => {
    const stack = createHistoryStack();
    stack.record(painted(1, [1]));
    stack.undo();
    stack.clear();

    expect(stack.entries.value).toEqual([]);
    expect(stack.canUndo.value).toBe(false);
    expect(stack.canRedo.value).toBe(false);
  });

  it("reverts nothing for an action that moved nothing", () => {
    const stack = createHistoryStack();
    stack.record({ id: 1, before: empty, after: empty });
    expect(stack.undo()).toEqual([]);
  });
});

describe("historyShortcut", () => {
  const press = (overrides: Partial<Parameters<typeof historyShortcut>[0]>) => ({
    key: "z",
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    ...overrides,
  });

  it("reads cmd+Z and cmd+shift+Z on a mac", () => {
    expect(historyShortcut(press({ metaKey: true }), true)).toBe("undo");
    expect(historyShortcut(press({ metaKey: true, shiftKey: true }), true)).toBe("redo");
  });

  it("reads ctrl+Z and ctrl+shift+Z elsewhere", () => {
    expect(historyShortcut(press({ ctrlKey: true }), false)).toBe("undo");
    expect(historyShortcut(press({ ctrlKey: true, shiftKey: true }), false)).toBe("redo");
  });

  it("takes the platform's modifier and no other", () => {
    expect(historyShortcut(press({ ctrlKey: true }), true)).toBeNull();
    expect(historyShortcut(press({ metaKey: true }), false)).toBeNull();
    expect(historyShortcut(press({ metaKey: true, ctrlKey: true }), true)).toBeNull();
  });

  it("ignores an unmodified Z, another key, and anything with alt held", () => {
    expect(historyShortcut(press({}), true)).toBeNull();
    expect(historyShortcut(press({ key: "y", ctrlKey: true }), false)).toBeNull();
    expect(historyShortcut(press({ metaKey: true, altKey: true }), true)).toBeNull();
  });

  it("does not care how the key is capitalised", () => {
    expect(historyShortcut(press({ key: "Z", metaKey: true, shiftKey: true }), true)).toBe(
      "redo",
    );
  });
});

describe("shortcutBlocked", () => {
  const element = (tagName: string, extra: Record<string, unknown> = {}) => ({
    tagName,
    isContentEditable: false,
    closest: () => null,
    ...extra,
  });

  it("leaves the chart's own keystrokes alone", () => {
    expect(shortcutBlocked(element("DIV"))).toBe(false);
    expect(shortcutBlocked(element("BODY"))).toBe(false);
    expect(shortcutBlocked(null)).toBe(false);
  });

  it("stands aside for a field", () => {
    expect(shortcutBlocked(element("INPUT"))).toBe(true);
    expect(shortcutBlocked(element("textarea"))).toBe(true);
    expect(shortcutBlocked(element("SELECT"))).toBe(true);
    expect(shortcutBlocked(element("DIV", { isContentEditable: true }))).toBe(true);
  });

  it("stands aside inside a dialog", () => {
    const inDialog = element("BUTTON", { closest: (selector: string) => ({ selector }) });
    expect(shortcutBlocked(inDialog)).toBe(true);
  });
});
