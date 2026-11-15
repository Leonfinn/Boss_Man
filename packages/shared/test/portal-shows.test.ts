import { describe, expect, it } from "vitest";
import { portalShows } from "../src/feedback";

const base = { portalVisible: true, keepOffPortal: false, status: "planned", publicTitle: null, publicSummary: "Export your data." };

describe("portalShows (BOS-1496)", () => {
  it("shows a ticked feature with a plain public summary", () => expect(portalShows(base)).toEqual({ shown: true }));
  it("says a missing summary is the reason", () => expect(portalShows({ ...base, publicSummary: "  " })).toEqual({ shown: false, ticked: true, reason: "needs public summary" }));
  it("holds back a kept-off feature even when ticked", () => expect(portalShows({ ...base, keepOffPortal: true })).toMatchObject({ shown: false, reason: "kept off (sensitive)" }));
  it("holds back security wording in the public text", () => expect(portalShows({ ...base, publicSummary: "Rotate the api key." })).toMatchObject({ shown: false, reason: "looks like security work" }));
  it("holds back a status the portal does not list", () => expect(portalShows({ ...base, status: "rejected" })).toMatchObject({ shown: false, reason: "status not shown" }));
  it("gives no reason for an unticked feature that would otherwise show", () => expect(portalShows({ ...base, portalVisible: false })).toEqual({ shown: false, ticked: false, reason: null }));
});
