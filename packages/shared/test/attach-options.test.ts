import { describe, expect, it } from "vitest";
import { attachmentIds, optionNeedsAttachment, optionNeedsNote } from "../src/attach-options.js";

// BOS-2742: which card options can only be pressed with a screenshot attached.
describe("optionNeedsAttachment", () => {
  it.each([
    // The two cards the owner hit (BOS-2597 on 26 Nov, BOS-1574 on 16 Nov) and Boss Man's own R19 option.
    "Done, screenshot of the result attached",
    "Done, screenshot attached",
    "My screen looks different (I'll attach a screenshot)",
    "I'll attach the log",
    "Done (attached)",
    "Done, with a screenshot",
    "It failed, here's a photo",
    "Attaching the error page",
    "I've attached what I see",
  ])("needs one: %s", (option) => {
    expect(optionNeedsAttachment(option)).toBe(true);
  });

  it.each([
    "Done",
    "Pass - the screenshot meets the criterion",
    "Yes, the attached screenshot looks right",
    "Yes, and the image looks right",
    "Done, no screenshot needed",
    "Done, with no screenshot",
    "Skip the screenshot",
    "Keep the emails",
  ])("needs none: %s", (option) => {
    expect(optionNeedsAttachment(option)).toBe(false);
  });

  it("an option the raiser flagged needs one whatever its words", () => {
    expect(optionNeedsAttachment("Done", ["Done"])).toBe(true);
    expect(optionNeedsAttachment("Not yet", ["Done"])).toBe(false);
  });
});

// BOS-2798: which card options can only be pressed with text in the note.
describe("optionNeedsNote", () => {
  it.each([
    // The card the owner hit on 27 Nov (BOS-2775), and the usual ways of saying the same.
    "Done, output pasted in my note",
    "Other (see my note)",
    "Something else, in my note",
    "Ran it, output below",
    "It failed, error below",
    "I'll paste the output",
    "Done, pasted the log",
    "Not done yet, details in my note",
  ])("needs one: %s", (option) => {
    expect(optionNeedsNote(option)).toBe(true);
  });

  it.each([
    "Done",
    "Yes, go ahead",
    "Done, no output to paste",
    "Done, nothing to note",
    "Skip it",
    "Keep the notes page as it is",
  ])("needs none: %s", (option) => {
    expect(optionNeedsNote(option)).toBe(false);
  });

  it("an option the raiser flagged needs one whatever its words", () => {
    expect(optionNeedsNote("Sent", ["Sent"])).toBe(true);
    expect(optionNeedsNote("Not yet", ["Sent"])).toBe(false);
  });
});

describe("attachmentIds", () => {
  const a = "0f8fad5b-d9cb-469f-a165-70867728950e";
  const b = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
  it("lists each image or file link once, in order", () => {
    expect(attachmentIds(`Done\n![shot.png](/api/ticket-images/${a})\n[📎 log.txt](/api/ticket-images/${b.toUpperCase()})\n![again](/api/ticket-images/${a})`)).toEqual([a, b]);
  });
  it("ignores text with no link, and a malformed id", () => {
    expect(attachmentIds("Done, screenshot attached")).toEqual([]);
    expect(attachmentIds("/api/ticket-images/------------------------------------")).toEqual([]);
    expect(attachmentIds(null)).toEqual([]);
  });
});
