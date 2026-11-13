// BOS-1313: quotedAnswer is the one line an agent sees when a repeated ask is refused, naming
// what the owner answered and when (BOS-123, BOS-175). Pure function.
import { describe, expect, it } from "vitest";
import { quotedAnswer } from "../src/services/stale-requests.js";

const at = new Date("2026-11-12T18:05:33Z");

describe("quotedAnswer", () => {
  it("quotes the question and the answer of a decision", () => {
    expect(quotedAnswer({ kind: "decision", question: "Stripe or Mollie?", answer: "Stripe", at })).toBe(
      'The owner already answered your question "Stripe or Mollie?" on 2026-11-12 18:05 UTC: "Stripe"',
    );
  });

  it("says 'this ticket' when a decision has no question", () => {
    expect(quotedAnswer({ kind: "decision", question: null, answer: "Stripe", at })).toBe(
      'The owner already answered this ticket on 2026-11-12 18:05 UTC: "Stripe"',
    );
  });

  it("says 'this ticket' for a message", () => {
    expect(quotedAnswer({ kind: "message", question: null, answer: "Go ahead", at })).toBe(
      'The owner already answered this ticket on 2026-11-12 18:05 UTC: "Go ahead"',
    );
  });

  it("says 'this ticket' for a message even when it carries a question", () => {
    // Only decisions quote the question; pin today's behaviour.
    expect(quotedAnswer({ kind: "message", question: "Stripe or Mollie?", answer: "Go ahead", at })).toBe(
      'The owner already answered this ticket on 2026-11-12 18:05 UTC: "Go ahead"',
    );
  });

  it("drops the seconds and the T from the default time, even just before midnight", () => {
    expect(
      quotedAnswer({ kind: "decision", question: "Ship tonight?", answer: "Yes", at: new Date("2026-11-12T23:59:59Z") }),
    ).toBe('The owner already answered your question "Ship tonight?" on 2026-11-12 23:59 UTC: "Yes"');
  });

  it("uses a custom at formatter in place of the default", () => {
    expect(quotedAnswer({ kind: "decision", question: "Stripe or Mollie?", answer: "Stripe", at }, () => "yesterday")).toBe(
      'The owner already answered your question "Stripe or Mollie?" on yesterday UTC: "Stripe"',
    );
  });

  it("passes an answer containing double quotes through unchanged, without escaping it", () => {
    expect(quotedAnswer({ kind: "decision", question: "Which plan?", answer: 'Use "Stripe" for the EU', at })).toBe(
      'The owner already answered your question "Which plan?" on 2026-11-12 18:05 UTC: "Use "Stripe" for the EU"',
    );
  });
});
