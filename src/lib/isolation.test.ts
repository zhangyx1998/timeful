import { describe, expect, it } from "vitest";
import { nextTick, ref } from "vue";
import { useIsolation } from "./isolation";

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
