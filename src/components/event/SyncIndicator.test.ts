/**
 * The indicator is the only save feedback, so each state's wording is behaviour.
 * Rendered via the SSR renderer: a status the template stopped covering shows up
 * as an empty render.
 */
import { describe, expect, it } from "vitest";
import { renderToString } from "vue/server-renderer";
import { createSSRApp, h } from "vue";
import SyncIndicator from "./SyncIndicator.vue";
import type { SyncStatus } from "../../lib/sync";

function render(
  status: SyncStatus,
  error: string | null = null,
  detail: string | null = null,
): Promise<string> {
  return renderToString(
    createSSRApp({ render: () => h(SyncIndicator, { status, error, detail }) }),
  );
}

/** Tag-free text, so an assertion is about what is read rather than markup. */
function text(html: string): string {
  return html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

describe("sync indicator", () => {
  it("says a name with no answer behind it has no selection", async () => {
    const html = await render("empty");
    expect(text(html)).toBe("No selection");
    // Muted, and quiet: a resting state gets no colour of its own.
    expect(html).toContain("resting");
    expect(html).not.toContain("icon--ok");
  });

  it("says a loaded answer is up to date", async () => {
    const html = await render("current");
    expect(text(html)).toBe("Up to date");
    expect(html).toContain("resting");
    // The tick alone carries the green — the words stay at caption weight.
    expect(html).toContain("icon--ok");
  });

  it("distinguishes the two green states", async () => {
    const current = await render("current");
    const saved = await render("saved");
    expect(text(saved)).toBe("Saved");
    // `saved` is an event and colours the whole line; `current` is a condition.
    expect(saved).toContain("status saved");
    expect(current).not.toContain("status saved");
  });

  it("shows the spinner while a save is in flight", async () => {
    const html = await render("syncing");
    expect(text(html)).toContain("Saving");
    expect(html).toContain("status syncing");
  });

  it("shows the failure and a way to retry", async () => {
    const html = await render("error", "Network unreachable");
    expect(text(html)).toContain("Network unreachable");
    expect(text(html)).toContain("Retry");
    expect(html).toContain('role="alert"');
  });

  it("falls back to a message when the failure carries none", async () => {
    const html = await render("error", null);
    expect(text(html)).toContain("Could not save your availability");
  });

  it("prints the admin-only detail under the failure, when there is one", async () => {
    const html = await render(
      "error",
      "Could not save your availability",
      "EACCES: permission denied [EACCES] /var/events/x.json",
    );
    expect(text(html)).toContain("EACCES: permission denied");
    expect(html).toContain('class="detail"');
  });

  it("prints no detail line for a guest's failure, which never carries one", async () => {
    const html = await render("error", "Event not found");
    expect(html).not.toContain('class="detail"');
  });

  it("renders something for every state", async () => {
    const statuses: SyncStatus[] = ["empty", "current", "syncing", "saved", "error"];
    for (const status of statuses) {
      expect(text(await render(status)), status).not.toBe("");
    }
  });
});
