/**
 * The SSR contract for event pages (ARCHITECTURE.md § Routing / SSR): the
 * markup carries a real availability preview — cells, tones, gutter labels —
 * and no loading splash, in the geometry the hint asked for.
 */
import { describe, expect, it } from "vitest";
import { render } from "./entry-server";
import { buildPreview } from "./lib/preview";
import type { EventDoc } from "./lib/event";

function makeEvent(overrides: Partial<EventDoc> = {}): EventDoc {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    slug: "team-offsite",
    name: "Team Offsite",
    type: "specific_dates",
    dates: ["2026-08-01T16:00:00.000Z", "2026-08-02T16:00:00.000Z"],
    duration: 8,
    timeIncrement: 30,
    startOnMonday: false,
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    responses: {
      "ada-lovelace": {
        displayName: "Ada Lovelace",
        availability: ["2026-08-01T16:00:00.000Z", "2026-08-01T16:30:00.000Z"],
        ifNeeded: [],
        updatedAt: "2026-07-01T00:00:00.000Z",
      },
      "grace-hopper": {
        displayName: "Grace Hopper",
        availability: ["2026-08-01T16:00:00.000Z"],
        ifNeeded: [],
        updatedAt: "2026-07-01T00:00:00.000Z",
      },
    },
    ...overrides,
  };
}

describe("event page SSR", () => {
  it("renders the availability preview instead of a loading splash", async () => {
    const event = makeEvent();
    const { html } = await render(`/${event.slug}/view`, { event });

    expect(html).not.toContain("Loading availability");
    // Column headings and gutter labels, laid out at UTC.
    expect(html).toContain("Sat");
    expect(html).toContain("Aug 1");
    expect(html).toContain("4 pm");
    // Heatmap tones ride classes and a custom property, never baked RGB.
    expect(html).toContain("is-heat");
    expect(html).toContain("--heat:100.0%");
    // One of two respondents: floor(0.5 * 225) / 255.
    expect(html).toContain("--heat:43.9%");
    expect(html).not.toMatch(/background-color:\s*rgba?\(/);
  });

  it("renders every canonical shape with the preview", async () => {
    const event = makeEvent();
    for (const path of [
      `/${event.slug}`,
      `/${event.slug}/view`,
      `/${event.slug}/edit/ada-lovelace`,
    ]) {
      const { html } = await render(path, { event });
      expect(html, path).toContain("is-heat");
      expect(html, path).not.toContain("Loading availability");
    }
  });

  it("takes its geometry from the compact hint", async () => {
    const event = makeEvent();
    const desktop = await render(`/${event.slug}/view`, { event, compact: false });
    const compact = await render(`/${event.slug}/view`, { event, compact: true });

    const desktopWidth = buildPreview(event, false).colWidth;
    const compactWidth = buildPreview(event, true).colWidth;
    expect(desktopWidth).not.toBe(compactWidth);
    expect(desktop.html).toContain(`width:${desktopWidth}px`);
    expect(desktop.html).not.toContain(`width:${compactWidth}px`);
    expect(compact.html).toContain(`width:${compactWidth}px`);
  });
});
