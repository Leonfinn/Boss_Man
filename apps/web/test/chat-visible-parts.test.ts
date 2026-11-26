import { describe, expect, it } from "vitest";
import { visibleParts } from "../src/pages/Chat";

// BOS-2644: what a chat message shows as words, for the find box (Chat.tsx visibleParts).
// A pure call only: it runs linkPieces with no company or ticket context.
describe("visibleParts", () => {
  it("returns plain text as itself", () => {
    expect(visibleParts("Build finished overnight")).toEqual(["Build finished overnight"]);
  });

  it("keeps a link's text and drops its address and markup", () => {
    expect(visibleParts("[the board](#/board)")).toEqual(["the board"]);
  });

  it("never includes an image's alt text or address", () => {
    const parts = visibleParts("before ![a screenshot](/api/ticket-images/88b936b3-0000-4000-8000-000000000001) after");
    expect(parts).toEqual(["before ", " after"]);
    expect(parts.join(" ")).not.toContain("screenshot");
    expect(parts.join(" ")).not.toContain("88b936b3");
  });

  it("gives an empty list for empty text", () => {
    expect(visibleParts("")).toEqual([]);
  });
});
