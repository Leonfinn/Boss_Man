import { describe, expect, it } from "vitest";
import { distanceFromBottom, isFarUp, messageLink, newSince } from "../src/chat-scroll";

describe("chat-scroll (BOS-2440)", () => {
  it("measures the distance from the bottom, never below 0", () => {
    expect(distanceFromBottom({ scrollHeight: 3000, scrollTop: 1000, clientHeight: 500 })).toBe(1500);
    expect(distanceFromBottom({ scrollHeight: 1000, scrollTop: 600, clientHeight: 500 })).toBe(0);
  });
  it("is far up only past one screen", () => {
    expect(isFarUp({ scrollHeight: 3000, scrollTop: 1000, clientHeight: 500 })).toBe(true);
    expect(isFarUp({ scrollHeight: 3000, scrollTop: 2200, clientHeight: 500 })).toBe(false);
    expect(isFarUp({ scrollHeight: 3000, scrollTop: 2000, clientHeight: 500 })).toBe(false);
  });
  it("counts messages after the anchor", () => {
    expect(newSince(["a", "b", "c", "d"], "b")).toBe(2);
    expect(newSince(["a", "b"], "b")).toBe(0);
    expect(newSince(["a", "b"], null)).toBe(0);
    expect(newSince(["a", "b"], "gone")).toBe(0);
  });
  it("builds the message route the search results use", () => {
    expect(messageLink({ origin: "https://boss.example.com", pathname: "/" }, "c1", "a1", "m9")).toBe("https://boss.example.com/#/chat/c1/a1/m9");
  });
});
