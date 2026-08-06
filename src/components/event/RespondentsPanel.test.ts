/**
 * Asserts which rows the list has and what the fraction counts — presence adds
 * rows that exist but must not be counted. Rendered via the SSR renderer: real
 * SFC, no DOM needed.
 */
import { describe, expect, it } from "vitest";
import { renderToString } from "vue/server-renderer";
import { createSSRApp, h } from "vue";
import RespondentsPanel from "./RespondentsPanel.vue";
import { userKey } from "../../lib/user-key";
import type { PresenceEntry } from "../../lib/realtime";

/** Tests are written in names; the keys are derived here exactly as the page derives them. */
interface Options {
  /** The phone's drawer: no card, no heading, no fraction. */
  embedded?: boolean;
  /** Respondents with a stored answer, by display name. */
  names?: string[];
  /** Who is on the page: a display name, or an entry that spells itself. */
  present?: (string | PresenceEntry)[];
  availableNames?: string[] | null;
  ifNeededNames?: string[];
  currentName?: string | null;
  slotLabel?: string | null;
  solo?: string | null;
}

const entry = (person: string | PresenceEntry): PresenceEntry =>
  typeof person === "string" ? { key: userKey(person), displayName: person } : person;

function render(options: Options = {}): Promise<string> {
  const names = options.names ?? [];
  const props = {
    embedded: options.embedded ?? false,
    keys: names.map(userKey),
    labels: new Map(names.map((name) => [userKey(name), name])),
    present: (options.present ?? []).map(entry),
    availableNames: options.availableNames
      ? new Set(options.availableNames.map(userKey))
      : null,
    ifNeededNames: new Set((options.ifNeededNames ?? []).map(userKey)),
    slotLabel: options.slotLabel ?? null,
    pinned: false,
    highlight: null,
    currentKey: options.currentName == null ? null : userKey(options.currentName),
    deleting: null,
    deleteError: null,
    solo: options.solo == null ? null : userKey(options.solo),
  };
  return renderToString(createSSRApp({ render: () => h(RespondentsPanel, props) }));
}

/** Tag-free text, so an assertion is about what is read rather than markup. */
function text(html: string): string {
  return html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * The names the list actually shows, in the order it shows them. The dashed
 * action row at the end wears the same class and is not one of them, whichever
 * of the two it currently is.
 */
const ACTIONS = ["Add someone", "Show everyone"];

function rows(html: string): string[] {
  return [...html.matchAll(/class="text[^"]*"[^>]*>([^<]*)/g)]
    .map((m) => m[1].trim())
    .filter((name) => !ACTIONS.includes(name));
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

  it("spells a row the way the record does, not the way the tab claims", async () => {
    // Same person, two spellings of one key: the stored answer says
    // "Ada Lovelace" and the open tab announces itself as "ada LOVELACE".
    const html = await render({
      names: ["Ada Lovelace"],
      present: [{ key: userKey("Ada Lovelace"), displayName: "ada LOVELACE" }],
    });

    // One key is one person, so one row — and it wears the name the group
    // already recognises rather than the shouting of whoever is online.
    expect(rows(html)).toEqual(["Ada Lovelace"]);
    expect(html).not.toContain("ada LOVELACE");
    expect(dotGroups(html)).toBe(1);
    expect(text(html)).toContain("Ada Lovelace (online)");
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

  // -------------------------------------------------------------------------
  // in the phone's drawer
  // -------------------------------------------------------------------------

  it("drops the fraction in the drawer, and the rule that carried it", async () => {
    // It counts who is free at the slot under the pointer, and a sheet sitting
    // on the chart is exactly where there is no pointing at one. What is left
    // is the list, with nothing above it holding a gap open.
    const html = await render({ embedded: true, names: ["Ada", "Bo"] });
    expect(text(html)).not.toContain("available");
    expect(html).not.toContain("Respondents");
    expect(html).not.toContain('class="head"');
    expect(rows(html)).toEqual(["Ada", "Bo"]);
  });

  it("still says which slot a pinned one is, and how each answered it", async () => {
    // A slot pinned by a tap before the drawer was opened is a real reading,
    // and the per-row glyphs are how it is read — those are not the fraction.
    const html = await render({
      embedded: true,
      names: ["Ada", "Bo"],
      availableNames: ["Ada"],
      slotLabel: "Mon 3 Aug, 13:00 – 13:30",
    });
    expect(text(html)).toContain("Mon 3 Aug, 13:00 – 13:30");
    expect(text(html)).not.toContain("available");
    expect(html).toContain("avatar--available");
    expect(html).toContain("avatar--unavailable");
    expect(html).toContain("head--slim");
  });

  it("keeps the fraction on the desktop, where a pointer can move it", async () => {
    const html = await render({ names: ["Ada", "Bo"], availableNames: ["Ada"] });
    expect(text(html)).toContain("1/2 available");
  });

  // -------------------------------------------------------------------------
  // one person's answer, alone
  // -------------------------------------------------------------------------

  it("offers every drawer row a view of its own, answered or not", async () => {
    // Including somebody who is only here: "have they marked anything yet?" is
    // a real question, and an empty chart that says so is a real answer to it.
    // A row missing its eye only reads as broken.
    const html = await render({ embedded: true, names: ["Ada", "Bo"], present: ["Cy"] });
    expect(html).toContain("Show only Ada");
    expect(html).toContain("Show only Bo");
    expect(html).toContain("Show only Cy");
  });

  it("keeps the desktop list free of eyes", async () => {
    // The desktop previews a person by hovering their row: the list is beside
    // the chart, so the answer appears under the pointer and leaves with it.
    // An eye there would be a second control for a thing the pointer already
    // does — and persistent state with a pill the desktop never shows.
    const html = await render({ names: ["Ada", "Bo"], present: ["Cy"] });
    expect(html).not.toContain("Show only");
    expect(html).not.toContain("reveal");
  });

  it("changes nothing about itself when one of them is on", async () => {
    // The isolated view outlives this panel being open — closing the drawer is
    // how you look at it — so a list that collapsed onto the row, dropped its
    // rows and hid its bins would be describing a state it no longer owns.
    const html = await render({
      embedded: true,
      names: ["Ada", "Bo", "Cy"],
      present: ["Dee"],
      solo: "Bo",
    });

    expect(rows(html)).toEqual(["Ada", "Bo", "Cy", "Dee"]);
    expect(html).toContain("Add someone");
    expect(html).toContain("Remove Bo");
  });

  it("says on the row itself which view is on", async () => {
    const off = await render({ embedded: true, names: ["Ada", "Bo"] });
    const on = await render({ embedded: true, names: ["Ada", "Bo"], solo: "Bo" });
    expect(off).not.toContain("reveal--on");
    expect(on).toContain("reveal--on");
    expect(on).toContain('aria-pressed="true"');
    // The way out is on the row that put it on, as well as on the pill.
    expect(on).toContain("Show everyone again");
  });

  it("draws each eye as the state of that answer rather than as the tap", async () => {
    // The open eye is the one with a pupil in it; the struck-through one is the
    // one with a slash across it. Counting them is how this asserts on the
    // glyph rather than on the class beside it.
    const open = (html: string) => html.split('r="2.9"').length - 1;
    const shut = (html: string) => html.split("M4.4 4.4").length - 1;

    // Nobody isolated: every answer is on the chart, so every eye is open and
    // nothing is drawn as hidden.
    const off = await render({ embedded: true, names: ["Ada", "Bo", "Cy"] });
    expect(open(off)).toBe(3);
    expect(shut(off)).toBe(0);
    expect(off).not.toContain("reveal--hidden");

    // One isolated: that row is what the chart shows, so it keeps the open eye
    // — the others are the ones that have been taken off it.
    const on = await render({ embedded: true, names: ["Ada", "Bo", "Cy"], solo: "Bo" });
    expect(open(on)).toBe(1);
    expect(shut(on)).toBe(2);
    expect(on.split("reveal--hidden").length - 1).toBe(2);
    // And the open one is the isolated row, not a neighbour.
    const start = on.indexOf("reveal--on");
    const soloEye = on.slice(start, on.indexOf("</button>", start));
    expect(soloEye).toContain('r="2.9"');
    expect(soloEye).not.toContain("M4.4 4.4");
  });

  it("marks a presence-only row as the isolated one too", async () => {
    const html = await render({
      embedded: true,
      names: ["Ada", "Bo"],
      present: ["Cy"],
      solo: "Cy",
    });
    expect(rows(html)).toEqual(["Ada", "Bo", "Cy"]);
    expect(html).toContain("reveal--on");
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
