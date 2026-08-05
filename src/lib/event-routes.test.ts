import { describe, expect, it } from "vitest";
import { eventPageTitle, parseEventPath } from "./event-routes";

describe("parseEventPath", () => {
  it("reads the three shapes of an event path", () => {
    expect(parseEventPath("/happy-hour")).toEqual({
      slug: "happy-hour",
      sub: { kind: "root" },
    });
    expect(parseEventPath("/happy-hour/view")).toEqual({
      slug: "happy-hour",
      sub: { kind: "view" },
    });
    expect(parseEventPath("/happy-hour/edit/ada-lovelace")).toEqual({
      slug: "happy-hour",
      sub: { kind: "edit", key: "ada-lovelace" },
    });
  });

  it("decodes each segment", () => {
    expect(parseEventPath("/happy%2Dhour/edit/Ada%20Lovelace")).toEqual({
      slug: "happy-hour",
      sub: { kind: "edit", key: "Ada Lovelace" },
    });
  });

  it("keeps the slug rules the single-segment path always had", () => {
    expect(parseEventPath("/")).toBeNull();
    expect(parseEventPath("/favicon.ico")).toBeNull();
    expect(parseEventPath("/style.css/view")).toBeNull();
    expect(parseEventPath("/%zz")).toBeNull(); // malformed escape
    // A %2F cannot smuggle a separator into a slug.
    expect(parseEventPath("/a%2Fb")).toBeNull();
  });

  it("rejects every shape that is not one of the three", () => {
    expect(parseEventPath("/slug/edit")).toBeNull(); // edit without a key
    expect(parseEventPath("/slug/edit/")).toBeNull(); // empty key
    expect(parseEventPath("/slug/view/extra")).toBeNull();
    expect(parseEventPath("/slug/edit/key/extra")).toBeNull();
    expect(parseEventPath("/slug/other")).toBeNull();
    expect(parseEventPath("/slug/view/")).toBeNull(); // trailing slash
    expect(parseEventPath("/slug/View")).toBeNull(); // exact word, not a case
  });
});

describe("eventPageTitle", () => {
  const event = {
    name: "Team Offsite",
    responses: { "ada-lovelace": { displayName: "Ada Lovelace" } },
  };

  it("names the event alone on the root and the group view", () => {
    expect(eventPageTitle(event, { kind: "root" })).toBe("Team Offsite · Timeful");
    expect(eventPageTitle(event, { kind: "view" })).toBe("Team Offsite · Timeful");
  });

  it("names the respondent on their edit page, in the event's spelling", () => {
    expect(eventPageTitle(event, { kind: "edit", key: "ada-lovelace" })).toBe(
      "Ada Lovelace’s availability for Team Offsite · Timeful",
    );
    // The key in the URL is re-normalized like any arriving key.
    expect(eventPageTitle(event, { kind: "edit", key: "Ada Lovelace" })).toBe(
      "Ada Lovelace’s availability for Team Offsite · Timeful",
    );
  });

  it("falls back to the event for a key nobody has answered under", () => {
    expect(eventPageTitle(event, { kind: "edit", key: "grace-hopper" })).toBe(
      "Team Offsite · Timeful",
    );
  });

  it("takes the editor's confirmed name where the event has none", () => {
    expect(
      eventPageTitle(event, { kind: "edit", key: "grace-hopper" }, "Grace Hopper"),
    ).toBe("Grace Hopper’s availability for Team Offsite · Timeful");
    // The event's stored spelling still wins over the local one.
    expect(
      eventPageTitle(event, { kind: "edit", key: "ada-lovelace" }, "ada lovelace"),
    ).toBe("Ada Lovelace’s availability for Team Offsite · Timeful");
  });
});
