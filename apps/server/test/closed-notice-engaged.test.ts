import { describe, expect, it } from "vitest";
import { engagedRecently, ENGAGED_MS, NOTICE_MS, replacedNotice } from "../src/services/closed-notice.js";

// BOS-739/BOS-1010: whether the owner was acting on a card when Boss Man closed it,
// and the notice a runner-update card leaves when a newer one replaces it.
const MIN = 60_000;
const now = new Date("2026-11-13T12:00:00Z");
const ago = (ms: number) => new Date(now.getTime() - ms).toISOString();
// Old enough that only the context decides, never the card's own age.
const oldCard = { createdAt: new Date(now.getTime() - 24 * 60 * MIN) };

describe("engagedRecently (BOS-739)", () => {
  it("says no when the card has no engagement context", () => {
    expect(engagedRecently({ ...oldCard, context: {} }, now)).toBe(false);
  });

  it.fails("says no when the card's context is null (currently throws)", () => {
    expect(engagedRecently({ ...oldCard, context: null }, now)).toBe(false);
  });

  it("says yes when the owner opened the steps 10 minutes ago", () => {
    expect(engagedRecently({ ...oldCard, context: { ownerOpenedAt: ago(10 * MIN) } }, now)).toBe(true);
  });

  it("says yes at exactly the 30-minute edge", () => {
    expect(engagedRecently({ ...oldCard, context: { ownerOpenedAt: ago(ENGAGED_MS) } }, now)).toBe(true);
  });

  it("says no one second past the 30-minute edge", () => {
    expect(engagedRecently({ ...oldCard, context: { ownerOpenedAt: ago(ENGAGED_MS + 1_000) } }, now)).toBe(false);
  });

  it("says no when the opened time cannot be read", () => {
    expect(engagedRecently({ ...oldCard, context: { ownerOpenedAt: "soon" } }, now)).toBe(false);
  });

  it("says yes when a step failed 5 minutes ago", () => {
    expect(engagedRecently({ ...oldCard, context: { lastFailure: { at: ago(5 * MIN) } } }, now)).toBe(true);
  });

  it("says yes when a hand-apply to-do was approved 20 minutes ago", () => {
    expect(engagedRecently({ createdAt: new Date(now.getTime() - 20 * MIN), context: { type: "owner_todo" } }, now)).toBe(true);
  });

  it("says no when a hand-apply to-do was approved 31 minutes ago", () => {
    expect(engagedRecently({ createdAt: new Date(now.getTime() - 31 * MIN), context: { type: "owner_todo" } }, now)).toBe(false);
  });

  it("says no for another kind of card created recently", () => {
    expect(engagedRecently({ createdAt: new Date(now.getTime() - 5 * MIN), context: { type: "self_deploy" } }, now)).toBe(false);
  });

  it("counts an opened time in the future as recent, as it does today", () => {
    expect(engagedRecently({ ...oldCard, context: { ownerOpenedAt: new Date(now.getTime() + 5 * MIN).toISOString() } }, now)).toBe(true);
  });
});

describe("replacedNotice (BOS-1010)", () => {
  const commit = "d".repeat(40);
  const text = "A newer server update replaced this one. You can stop.";

  it("marks the notice as replaced and passes the commit and text through", () => {
    const n = replacedNotice({ commit, text, now });
    expect(n.why).toBe("replaced");
    expect(n.commit).toBe(commit);
    expect(n.text).toBe(text);
  });

  it("shows the notice from now until two hours later", () => {
    const n = replacedNotice({ commit, text, now });
    expect(n.at).toBe(now.toISOString());
    expect(n.until).toBe(new Date(now.getTime() + NOTICE_MS).toISOString());
    expect(Date.parse(n.until) - Date.parse(n.at)).toBe(NOTICE_MS);
    expect(NOTICE_MS).toBe(2 * 3_600_000);
  });
});
