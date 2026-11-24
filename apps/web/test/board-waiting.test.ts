import { describe, expect, it } from "vitest";
import { waitingOnThis, waitingWords } from "../src/board-waiting";

const c = (id: string, blocked: Array<string | null> = [], extra: Record<string, unknown> = {}) => ({ id, systemState: "ready", outcome: null, blockedBy: blocked.map((ticketId) => ({ ticketId })), ...extra });

describe("waitingOnThis", () => {
  it("counts the open cards that name a card in blockedBy", () => {
    const m = waitingOnThis([c("a"), c("b", ["a"]), c("c", ["a", "b"]), c("d")]);
    expect(m.get("a")?.map((x) => x.id)).toEqual(["b", "c"]);
    expect(m.get("b")?.map((x) => x.id)).toEqual(["c"]);
    expect(m.has("d")).toBe(false);
  });

  it("ignores done and cancelled cards, decisions, self-links and repeats", () => {
    const m = waitingOnThis([c("a"), c("b", ["a"], { systemState: "done" }), c("x", ["a"], { outcome: "cancelled" }), c("e", [null]), c("f", ["f", "a", "a"])]);
    expect(m.get("a")?.map((x) => x.id)).toEqual(["f"]);
    expect(m.has("f")).toBe(false);
  });

  it("does not count a done blocker", () => {
    expect(waitingOnThis([c("a", [], { systemState: "done" }), c("b", ["a"])]).size).toBe(0);
  });

  it("words", () => {
    expect(waitingWords(1)).toBe("1 waiting on this");
  });
});
