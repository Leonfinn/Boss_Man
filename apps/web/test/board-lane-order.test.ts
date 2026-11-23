import { describe, expect, it } from "vitest";
import { yourReviewFirst } from "../src/board-lane-order";

const lane = (name: string, n: number, mine = false) => ({ name, mine, tickets: Array.from({ length: n }, () => ({})) });

describe("yourReviewFirst", () => {
  it("moves a Your review lane with cards to the front and keeps the others in order", () => {
    const out = yourReviewFirst([lane("backlog", 1), lane("awaiting", 2), lane("held", 1), lane("mine", 3, true)]);
    expect(out.map((l) => l.name)).toEqual(["mine", "backlog", "awaiting", "held"]);
  });
  it("leaves the order alone when the lane is empty", () => {
    const input = [lane("backlog", 1), lane("mine", 0, true)];
    expect(yourReviewFirst(input).map((l) => l.name)).toEqual(["backlog", "mine"]);
  });
  it("leaves the order alone when there is no such lane", () => {
    expect(yourReviewFirst([lane("a", 1)]).map((l) => l.name)).toEqual(["a"]);
  });
});
