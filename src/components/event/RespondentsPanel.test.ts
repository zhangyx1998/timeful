/**
 * The respondents list, as markup.
 *
 * Two things about it are behaviour rather than decoration and both are easy to
 * break from a distance: which rows the list has, and what the fraction at the
 * top counts. Presence adds rows for people who have answered nothing, so the
 * two now pull in opposite directions — a row that exists and must not be
 * counted — and that is exactly what is asserted here.
 *
 * Rendered through the SSR renderer, like the sync indicator: it compiles the
 * real SFC, needs no DOM, and a template that stopped emitting a row would show
 * up here rather than as a gap in a panel nobody was looking at.
 */
import { describe, expect, it } from "vitest";
import { renderToString } from "vue/server-renderer";
import { createSSRApp, h } from "vue";
import RespondentsPanel from "./RespondentsPanel.vue";

interface Options {
  names?: string[];
  present?: string[];
  availableNames?: string[] | null;
  ifNeededNames?: string[];
  currentName?: string | null;
  slotLabel?: string | null;
}

function render(options: Options = {}): Promise<string> {
  const props = {
    names: options.names ?? [],
    present: options.present ?? [],
    availableNames: options.availableNames ? new Set(options.availableNames) : null,
    ifNeededNames: new Set(options.ifNeededNames ?? []),
    slotLabel: options.slotLabel ?? null,
    pinned: false,
    highlight: null,
    currentName: options.currentName ?? null,
    deleting: null,
    deleteError: null,
  };
  return renderToString(createSSRApp({ render: () => h(RespondentsPanel, props) }));
}

/** Tag-free text, so an assertion is about what is read rather than markup. */
function text(html: string): string {
  return html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * The names the list actually shows, in the order it shows them. The dashed
 * "Add someone" row at the end wears the same class and is not one of them.
 */
function rows(html: string): string[] {
  return [...html.matchAll(/class="text[^"]*"[^>]*>([^<]*)/g)]
    .map((m) => m[1].trim())
    .filter((name) => name !== "Add someone");
}

/** How many animated dot groups the list drew. */
function dotGroups(html: string): number {
  return html.split(/class="dots"/).length - 1;
}

describe("respondents list", () => {
  it("shows who answered, with a count of them", async () => {
    const html = await render({ names: ["Ada", "Bo"] });
    expect(rows(html)).toEqual(["Ada", "Bo"]);
    expect(text(html)).toContain("2/2 available");
    // Nobody is here, so there is nothing pulsing anywhere.
    expect(dotGroups(html)).toBe(0);
    expect(html).not.toContain("(online)");
  });

  // -------------------------------------------------------------------------
  // who is here
  // -------------------------------------------------------------------------

  it("marks an online respondent, and says so in words as well", async () => {
    const html = await render({ names: ["Ada", "Bo"], present: ["Bo"] });

    expect(dotGroups(html)).toBe(1);
    // The dots are decoration; the word is what a screen reader gets, and it
    // reads as part of the name rather than as a stray parenthesis.
    expect(html).toMatch(/Bo<span class="hidden"[^>]*> \(online\)<\/span>/);
    expect(text(html)).toContain("Bo (online)");
    expect(text(html)).not.toContain("Ada (online)");
  });

  it("gives the visitor their own dots", async () => {
    // Simplest rule there is, and the honest one: they are online too.
    const html = await render({ names: ["Ada"], present: ["Ada"], currentName: "Ada" });
    expect(dotGroups(html)).toBe(1);
    expect(text(html)).toContain("Ada (online)");
  });

  it("puts somebody who is here but has not answered in the list", async () => {
    const html = await render({ names: ["Ada"], present: ["Bo"] });

    // Arriving is the moment you most want to know somebody is there, and the
    // row is the only way the list can say it.
    expect(rows(html)).toEqual(["Ada", "Bo"]);
    expect(dotGroups(html)).toBe(1);
    // But the fraction is about answers, and there is still only one.
    expect(text(html)).toContain("1/1 available");
  });

  it("sorts the two kinds of row into one list", async () => {
    const html = await render({
      names: ["Cy", "Ada"],
      present: ["Bo", "Dee", "Ada"],
    });
    // One alphabetical run, so a row does not jump when its owner finally
    // saves something.
    expect(rows(html)).toEqual(["Ada", "Bo", "Cy", "Dee"]);
    expect(text(html)).toContain("2/2 available");
  });

  it("keeps a presence-only row out of the count at an active slot", async () => {
    const html = await render({
      names: ["Ada", "Bo"],
      present: ["Cy"],
      availableNames: ["Ada"],
      slotLabel: "Mon 3 Aug, 13:00 – 13:30",
    });

    // One of the two respondents is free there. Cy has marked nothing at all,
    // so he is on neither side of it.
    expect(text(html)).toContain("1/2 available");
    expect(rows(html)).toEqual(["Ada", "Bo", "Cy"]);
  });

  it("does not claim a presence-only row said no to the slot", async () => {
    const withSlot = await render({
      names: ["Ada"],
      present: ["Cy"],
      availableNames: ["Ada"],
      slotLabel: "Mon 3 Aug, 13:00 – 13:30",
    });
    const withoutSlot = await render({ names: ["Ada"], present: ["Cy"] });

    // Ada answered and gets the slot's own mark; Cy answered nothing, so his
    // row looks the same whether a slot is active or not — no cross, no
    // strike-through, just a person who is here.
    expect(withSlot).toContain("avatar--available");
    const cyRow = (html: string) => html.slice(html.indexOf("Cy") - 400, html.indexOf("Cy"));
    expect(cyRow(withSlot)).not.toContain("avatar--unavailable");
    expect(cyRow(withSlot)).not.toContain("unavailable");
    expect(dotGroups(withSlot)).toBe(dotGroups(withoutSlot));
  });

  it("offers no delete for a row with nothing stored behind it", async () => {
    const html = await render({ names: ["Ada"], present: ["Ada", "Cy"] });

    // A respondent can be removed …
    expect(html).toContain("Remove Ada");
    // … and somebody who has merely arrived cannot: there is nothing to
    // delete, and a button that deleted nothing would only ask to be pressed.
    expect(html).not.toContain("Remove Cy");
  });

  it("still offers a presence-only row as somebody to answer as", async () => {
    const html = await render({ names: [], present: ["Cy"] });
    // The switch flow does not care whether a response exists yet: adopting a
    // name that has answered nothing is how answering starts.
    expect(html).toContain("Answer as Cy");
    // And with no answers at all, the list still says so.
    expect(text(html)).toContain("No answers yet.");
    expect(text(html)).toContain("0/0 available");
  });
});
