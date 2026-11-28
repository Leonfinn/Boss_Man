import { describe, expect, it } from "vitest";
import { attachmentIds, handOverRefusal, optionNeeds, promisedHandOver } from "../src/attach-options.js";

// BOS-2742 and BOS-2798 (DR-078): which card options need a picture or a note before they can be pressed.
describe("promisedHandOver", () => {
  it.each([
    // The cards the owner hit (BOS-2597 on 26 Nov, BOS-1574 on 16 Nov) and Boss Man's own R19 option.
    "Done, screenshot of the result attached",
    "Done, screenshot attached",
    "My screen looks different (I'll attach a screenshot)",
    "I'll attach the log",
    "Done (attached)",
    "Done, with a screenshot",
    "It failed, here's a photo",
    "Attaching the error page",
    "I've attached what I see",
  ])("an attachment: %s", (option) => {
    expect(promisedHandOver(option)).toBe("attachment");
  });

  it.each([
    // The card the owner hit on 27 Nov (BOS-2775), and the other hand-over phrases the CEO named.
    "Done, output pasted in my note",
    "Done, output in my note",
    "Other (see my note)",
    "Something else, in my note",
    "Ran it, output below",
    "It failed, error below",
    "Done, link below",
    "I'll paste the output",
    "Done, pasted the log",
    "Done, I've entered the code",
    "I've typed the value",
    "Not done yet, details in my note",
  ])("a note: %s", (option) => {
    expect(promisedHandOver(option)).toBe("note");
  });

  it.each([
    "Done",
    "Sent",
    "Yes, go ahead",
    "Pass - the screenshot meets the criterion",
    "Yes, the attached screenshot looks right",
    "Yes, and the image looks right",
    "Done, no screenshot needed",
    "Done, with no screenshot",
    "Skip the screenshot",
    "Keep the emails",
    // Bare words in ordinary options pass (CEO narrowing, DR-078).
    "Leave a note for Zebedee",
    "Link it to BOS-12",
    "Done, no output to paste",
    "Keep the notes page as it is",
    "Use the steps below",
    "Write it in the wiki",
  ])("nothing: %s", (option) => {
    expect(promisedHandOver(option)).toBeNull();
  });
});

describe("optionNeeds", () => {
  it("the card's flags decide, whatever the words", () => {
    expect(optionNeeds("Sent", { noteOptions: ["Sent"] })).toBe("note");
    expect(optionNeeds("Sent", { attachOptions: ["Sent"] })).toBe("attachment");
    expect(optionNeeds("Not yet", { attachOptions: ["Sent"], noteOptions: ["Sent"] })).toBeNull();
  });
  it("the words are the backstop for a card with no flags", () => {
    expect(optionNeeds("Done, output pasted in my note", undefined)).toBe("note");
    expect(optionNeeds("Done, screenshot attached", {})).toBe("attachment");
    expect(optionNeeds("Done", null)).toBeNull();
  });
});

describe("handOverRefusal", () => {
  it("refuses an unflagged hand-over option, naming the flag to add", () => {
    expect(handOverRefusal(["Done, link below", "Not now"], undefined)).toMatch(/"Done, link below".*flag this option needsNote.*or reword it/);
    expect(handOverRefusal(["Done, screenshot attached", "No"], {})).toMatch(/flag this option needsAttachment/);
  });
  it("passes once flagged, or when no option promises a hand-over", () => {
    expect(handOverRefusal(["Done, link below", "Not now"], { noteOptions: ["Done, link below"] })).toBeNull();
    expect(handOverRefusal(["Done, screenshot attached", "No"], { attachOptions: ["Done, screenshot attached"] })).toBeNull();
    expect(handOverRefusal(["Leave a note for Zebedee", "Link it to BOS-12"], undefined)).toBeNull();
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
