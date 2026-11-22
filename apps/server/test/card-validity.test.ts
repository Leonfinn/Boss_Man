// BOS-2147 (background lane): the two row-in-hand predicates of the card validity table. No database and
// no clock: both read only the fields already on the card.
import { describe, expect, it } from "vitest";
import { isCheckableCard, isOwnerOnly } from "../src/services/card-validity.js";

const AGENT = "agent-1";

describe("isCheckableCard", () => {
  it("accepts an agent's own question card", () => {
    expect(isCheckableCard({ raisedByAgentId: AGENT, context: { type: "question" } })).toBe(true);
  });

  it("accepts an agent's engagement card", () => {
    expect(isCheckableCard({ raisedByAgentId: AGENT, context: { type: "engagement" } })).toBe(true);
  });

  it("accepts an agent's permission card that carries a plan", () => {
    expect(isCheckableCard({ raisedByAgentId: AGENT, context: { type: "permission", plan: true } })).toBe(true);
  });

  it("rejects a permission card without a plan", () => {
    expect(isCheckableCard({ raisedByAgentId: AGENT, context: { type: "permission" } })).toBe(false);
    expect(isCheckableCard({ raisedByAgentId: AGENT, context: { type: "permission", plan: false } })).toBe(false);
  });

  it("rejects a card no agent raised (Boss Man's own or the owner's)", () => {
    expect(isCheckableCard({ raisedByAgentId: null, context: { type: "question" } })).toBe(false);
  });

  it("rejects a ladder alert even when an agent raised it", () => {
    expect(isCheckableCard({ raisedByAgentId: AGENT, context: { type: "question", ladder: { ticketId: null } } })).toBe(false);
  });

  it("rejects card types it does not judge", () => {
    expect(isCheckableCard({ raisedByAgentId: AGENT, context: { type: "signoff" } })).toBe(false);
    expect(isCheckableCard({ raisedByAgentId: AGENT, context: {} })).toBe(false);
  });
});

describe("isOwnerOnly", () => {
  it("accepts a question card marked ownerOnly", () => {
    expect(isOwnerOnly({ type: "question", ownerOnly: "secret" })).toBe(true);
    expect(isOwnerOnly({ type: "question", ownerOnly: "host" })).toBe(true);
  });

  it("accepts a question card marked ownerMustDo", () => {
    expect(isOwnerOnly({ type: "question", ownerMustDo: true })).toBe(true);
  });

  it("rejects a question card with neither mark", () => {
    expect(isOwnerOnly({ type: "question" })).toBe(false);
    expect(isOwnerOnly({ type: "question", ownerOnly: false, ownerMustDo: false })).toBe(false);
  });

  it("rejects a mark on any type other than a question", () => {
    expect(isOwnerOnly({ type: "permission", ownerOnly: "secret" })).toBe(false);
    expect(isOwnerOnly({ type: "permission", ownerMustDo: true })).toBe(false);
    expect(isOwnerOnly({ ownerOnly: "secret", ownerMustDo: true })).toBe(false);
  });
});
