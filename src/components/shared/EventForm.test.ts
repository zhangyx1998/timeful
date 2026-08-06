/**
 * The live-updates flag is tri-state on the way in and absent must read as on —
 * wrong, it silently disables live updates for every pre-feature event the owner
 * edits and saves. Rendered via the SSR renderer: real SFC, no DOM.
 */
import { describe, expect, it } from "vitest";
import { renderToString } from "vue/server-renderer";
import { createSSRApp, h } from "vue";
import EventForm from "./EventForm.vue";
import type { EventDoc } from "../../lib/event";

const BASE: EventDoc = {
  id: "1614943a-fb98-4853-9df9-feba252c78ad",
  slug: "eOlSuRgws3kv",
  name: "Team Offsite",
  type: "specific_dates",
  dates: ["2026-08-03T09:00:00.000Z"],
  duration: 8,
  timeIncrement: 30,
  startOnMonday: false,
  createdAt: "2026-07-28T00:00:00.000Z",
  updatedAt: "2026-07-28T00:00:00.000Z",
  responses: {},
};

function render(event: EventDoc | null): Promise<string> {
  return renderToString(createSSRApp({ render: () => h(EventForm, { event }) }));
}

/** The `<input>` carrying the live-updates label. */
function liveUpdatesInput(html: string): string {
  const label = html
    .split("<label")
    .find((chunk) => chunk.includes("Live updates"));
  if (!label) throw new Error("the form no longer offers a live-updates control");
  return label;
}

describe("the live-updates switch", () => {
  it("is on for a new event", async () => {
    expect(liveUpdatesInput(await render(null))).toContain("checked");
  });

  it("is on for an event that was saved with it on", async () => {
    expect(liveUpdatesInput(await render({ ...BASE, realtime: true }))).toContain(
      "checked",
    );
  });

  it("is off for an event that was saved with it off", async () => {
    expect(liveUpdatesInput(await render({ ...BASE, realtime: false }))).not.toContain(
      "checked",
    );
  });

  it("is on for an event written before the flag existed", async () => {
    // No `realtime` key at all — the shape every event file on disk had until
    // this feature landed, and none of them are rewritten.
    const legacy: EventDoc = { ...BASE };
    delete legacy.realtime;
    expect("realtime" in legacy).toBe(false);
    expect(liveUpdatesInput(await render(legacy))).toContain("checked");
  });
});
