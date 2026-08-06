import { describe, expect, it } from "vitest";
import { eventPageTitle, parseEventPath } from "./event-routes";

describe("parseEventPath", () => {
  it("classifies the three canonical shapes", () => {
    expect(parseEventPath("/happy-hour")).toEqual({
      slug: "happy-hour",
      canonical: true,
      sub: { kind: "root" },
    });
    expect(parseEventPath("/happy-hour/view")).toEqual({
      slug: "happy-hour",
      canonical: true,
      sub: { kind: "view" },
    });
    expect(parseEventPath("/happy-hour/edit/ada-lovelace")).toEqual({
      slug: "happy-hour",
      canonical: true,
      sub: { kind: "edit", key: "ada-lovelace" },
    });
  });

  it("decodes each segment", () => {
    expect(parseEventPath("/happy%2Dhour/edit/Ada%20Lovelace")).toEqual({
      slug: "happy-hour",
      canonical: true,
      sub: { kind: "edit", key: "Ada Lovelace" },
    });
  });

  it("sends every other page-like path under a slug back to the root", () => {
    // The 302 / router-redirect set: page territory, but not a canonical URL.
    for (const path of [
      "/slug/", // bare trailing slash
      "/slug/view/",
      "/slug/edit", // edit without a key
      "/slug/edit/",
      "/slug/view/extra",
      "/slug/edit/key/extra",
      "/slug/other",
      "/slug/View", // exact word, not a case
      "/slug/%zz", // malformed escape below the slug is junk under it
      "/slug//",
    ]) {
      expect(parseEventPath(path)).toEqual({ slug: "slug", canonical: false });
    }
  });

  it("keeps the slug rules the single-segment path always had", () => {
    expect(parseEventPath("/")).toBeNull();
    expect(parseEventPath("/favicon.ico")).toBeNull();
    expect(parseEventPath("/style.css/view")).toBeNull();
    expect(parseEventPath("/%zz")).toBeNull(); // malformed escape in the slug
    // A %2F cannot smuggle a separator into a slug.
    expect(parseEventPath("/a%2Fb")).toBeNull();
  });

  it("leaves the reserved API sub-segments to the API router", () => {
    // Never a page and never a redirect: `/…/data`, `/…/users/<key>` and the
    // rest keep their exact API semantics whatever else the path carries.
    expect(parseEventPath("/slug/data")).toBeNull();
    expect(parseEventPath("/slug/data/x")).toBeNull();
    expect(parseEventPath("/slug/users/ada-lovelace")).toBeNull();
    expect(parseEventPath("/slug/ws")).toBeNull();
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
