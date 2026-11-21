// BOS-2136: pin the pure word handling behind create_ticket's duplicate refusal. These functions take no
// database, so this file imports only the service and runs with made-up titles.
import { describe, expect, it } from "vitest";
import { duplicateRefusal, titleWords, type SimilarTicket } from "../src/services/duplicate-titles.js";
import type { MeaningTicket } from "../src/services/ticket-meaning.js";

const similar = (over: Partial<SimilarTicket> = {}): SimilarTicket => ({ id: "id-1", ref: "BOS-42", title: "Board stuck cards", state: "in_progress", ...over });

describe("titleWords", () => {
  it("lower-cases and splits on punctuation and spaces", () => {
    expect([...titleWords("Board Cards: Stuck in Review!")].sort()).toEqual(["board", "card", "review", "stuck"]);
  });

  it("drops short words and common words, and folds a trailing s", () => {
    expect([...titleWords("Add a new list of the cards")]).toEqual(["card"]);
  });

  it("leaves a three-letter word ending in s alone, and keeps numbers", () => {
    expect([...titleWords("bus gas cars")].sort()).toEqual(["bus", "car", "gas"]);
    expect([...titleWords("v2 API 123")].sort()).toEqual(["123", "api"]);
  });

  it("counts each word once, including a singular and its plural", () => {
    expect([...titleWords("Card card CARD cards")]).toEqual(["card"]);
    expect(titleWords("Ticket tickets").size).toBe(0);
  });

  it("returns an empty set for empty text", () => {
    expect(titleWords("").size).toBe(0);
    expect(titleWords("   ").size).toBe(0);
  });
});

describe("duplicateRefusal", () => {
  it("says nothing was created and gives both ways forward when nothing matches", () => {
    const out = duplicateRefusal([]);
    expect(out).toMatch(/^Nothing was created: \n/);
    expect(out).not.toContain("similar titles");
    expect(out).not.toContain("mean the same");
    expect(out).toContain("notDuplicateOf");
    expect(out).toContain("notDuplicateReason");
  });

  it("lists one close match with its ref, title and state", () => {
    const out = duplicateRefusal([similar()]);
    expect(out).toContain("open or recently done tickets in this project have similar titles:");
    expect(out).toContain('- BOS-42 "Board stuck cards" (in_progress)');
    expect(out).not.toContain("(and ");
  });

  it("shows at most five matches and counts the rest", () => {
    const list = Array.from({ length: 7 }, (_, i) => similar({ id: `id-${i}`, ref: `BOS-${100 + i}`, title: `Card ${i}` }));
    const out = duplicateRefusal(list);
    expect(out).toContain('- BOS-100 "Card 0" (in_progress)');
    expect(out).toContain('- BOS-104 "Card 4" (in_progress)');
    expect(out).not.toContain('- BOS-105');
    expect(out).toContain("(and 2 more)");
  });

  it("falls back to the ticket id when it has no ref", () => {
    const out = duplicateRefusal([{ id: "abc-123", ref: null, title: "Board stuck cards", state: "blocked" }]);
    expect(out).toContain('- abc-123 "Board stuck cards" (blocked)');
  });

  it("adds meaning matches after the word matches", () => {
    const meaning: MeaningTicket[] = [{ id: "m-1", ref: "BOS-77", title: "Stuck board cards", state: "in_progress", merged: false, live: false, score: 0.8 }];
    const out = duplicateRefusal([similar()], meaning);
    expect(out).toContain("And tickets that mean the same in other words:");
    expect(out).toContain('- BOS-77 "Stuck board cards" (in_progress); same idea in other words, 80% match by meaning');
  });

  it("says only the meaning matches when the word list is empty", () => {
    const meaning: MeaningTicket[] = [{ id: "m-1", ref: "BOS-77", title: "Stuck board cards", state: "done", merged: true, live: true, score: 0.9 }];
    const out = duplicateRefusal([], meaning);
    expect(out).not.toContain("And tickets that mean the same");
    expect(out).toContain("tickets that mean the same in other words:");
    expect(out).toContain("(done, merged, live); same idea in other words, 90% match by meaning");
  });
});
