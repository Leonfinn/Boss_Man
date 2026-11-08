// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { collapsedByDefault } from "../src/App";

// The side menu starts collapsed on a tablet or foldable and expanded on a desktop, and the
// owner's saved choice wins on every width (BOS-290).
const width = (px: number) => {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: px <= 1180,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia;
};

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("side menu default", () => {
  it("is expanded on a desktop and collapsed on a tablet/foldable", () => {
    width(1600);
    expect(collapsedByDefault()).toBe(false);
    width(840);
    expect(collapsedByDefault()).toBe(true);
  });

  it("remembers an explicit expanded choice on a tablet", () => {
    width(840);
    localStorage.setItem("bm-side-collapsed", "0");
    expect(collapsedByDefault()).toBe(false);
  });

  it("remembers an explicit collapsed choice on a desktop", () => {
    width(1600);
    localStorage.setItem("bm-side-collapsed", "1");
    expect(collapsedByDefault()).toBe(true);
  });
});
