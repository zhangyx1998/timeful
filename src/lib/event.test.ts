import { describe, expect, it } from "vitest";
import { publicEvent, publicResponse, type EventDoc, type EventResponse } from "./event";

const LAST_EDIT = { ip: "203.0.113.7", userAgent: "Test/1.0", at: "2026-08-01T10:00:00.000Z" };

function response(extra: Partial<EventResponse> = {}): EventResponse {
  return {
    displayName: "Ada Lovelace",
    availability: ["2026-08-03T13:00:00.000Z"],
    ifNeeded: [],
    updatedAt: "2026-08-01T10:00:00.000Z",
    ...extra,
  };
}

function doc(responses: Record<string, EventResponse>): EventDoc {
  return {
    id: "00000000-0000-4000-8000-000000000000",
    slug: "abc",
    name: "Offsite",
    type: "specific_dates",
    dates: ["2026-08-03T00:00:00.000Z"],
    duration: 8,
    timeIncrement: 30,
    startOnMonday: true,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T10:00:00.000Z",
    responses,
  };
}

/**
 * The one field of an event document that a link-holder may not read, and the
 * one function that decides so. Everything else about the document is public —
 * it is inlined into the server-rendered page — which is why the strip has to
 * be a gate rather than a habit.
 */
describe("publicEvent", () => {
  it("takes the origin off every response", () => {
    const event = doc({
      "ada-lovelace": response({ lastEdit: LAST_EDIT }),
      "grace-hopper": response({ displayName: "Grace Hopper", lastEdit: LAST_EDIT }),
    });

    const out = publicEvent(event);

    expect(JSON.stringify(out)).not.toContain("lastEdit");
    // Everything else survives untouched.
    expect(out.responses["ada-lovelace"].availability).toEqual(
      event.responses["ada-lovelace"].availability,
    );
    expect(out.responses["grace-hopper"].displayName).toBe("Grace Hopper");
  });

  it("leaves the document it was given alone", () => {
    const event = doc({ "ada-lovelace": response({ lastEdit: LAST_EDIT }) });

    publicEvent(event);

    // Stripping in place would delete the field from the next write — the
    // caller is holding the document the storage layer just read.
    expect(event.responses["ada-lovelace"].lastEdit).toEqual(LAST_EDIT);
  });

  it("hands back the same object when there is nothing to remove", () => {
    // Every event written before tracking existed takes this path, on every
    // read and every broadcast.
    const event = doc({ "ada-lovelace": response() });
    expect(publicEvent(event)).toBe(event);
  });

  it("copes with a document that has no responses at all", () => {
    const event = doc({});
    expect(publicEvent(event)).toBe(event);
  });
});

describe("publicResponse", () => {
  it("removes the origin and keeps everything else", () => {
    expect(publicResponse(response({ lastEdit: LAST_EDIT }))).toEqual(response());
  });

  it("is the identity for a record that never had one", () => {
    const record = response();
    expect(publicResponse(record)).toBe(record);
  });
});
