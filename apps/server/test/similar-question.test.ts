// BOS-1149: similarQuestion decides whether a new ask to the owner repeats one they already
// answered (BOS-123) without blocking a genuinely different question (BOS-175). Pure function.
// BOS-2739: the ask is compared word for word, not by how many words overlap: a word-overlap pass
// made "do after another card" and "do before another card" one ask, so a later card closed itself.
import { describe, expect, it } from "vitest";
import { askedQuestion, similarQuestion } from "../src/services/stale-requests.js";

describe("similarQuestion", () => {
  it("treats the same ask in a different case and spacing as the same one", () => {
    expect(similarQuestion("Approve the deploy?", "approve   THE deploy?")).toBe(true);
    expect(similarQuestion("OK ?", "ok   ?")).toBe(true);
  });

  it("treats punctuation-only differences as the same ask", () => {
    expect(similarQuestion("Approve, the deploy.", "Approve the deploy")).toBe(true);
    expect(similarQuestion("Approve the runner-rebuild?", "Approve the runner rebuild?")).toBe(true);
  });

  it("does not treat two genuinely different asks as a repeat, however many words they share", () => {
    expect(similarQuestion("Approve the deploy of 10be777d?", "Approve the runner rebuild?")).toBe(false);
    expect(similarQuestion("approve deploy runner rebuild staging backup restore", "approve deploy runner rebuild staging plus something")).toBe(false);
    expect(similarQuestion("ok?", "Approve the deploy?")).toBe(false);
    // BOS-2739: these two closed each other as a 0.8 overlap; they are different asks.
    expect(similarQuestion("do after another card (BOS-551)", "do before another card (BOS-551)")).toBe(false);
    expect(similarQuestion("plain with summary", "plain without summary")).toBe(false);
  });

  it("is the same ask when the record line at one card's head is not part of the ask (BOS-2739)", () => {
    const plain = "Keep the address and close the ticket?";
    expect(similarQuestion(`Boss Man's record says: the phone reached it at 10.0.0.1. The record may be out of date, so this is asked.\n\n${plain}`, plain)).toBe(true);
    expect(similarQuestion(plain, `Boss Man's record says: the phone reached it at 10.0.0.1. The record may be out of date, so this is asked.\n\n${plain}`)).toBe(true);
    expect(askedQuestion(`Boss Man's record says: the phone reached it at 10.0.0.1.\n\n${plain}`)).toBe(plain);
  });
});
