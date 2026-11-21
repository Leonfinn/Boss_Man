// @vitest-environment jsdom
// BOS-2179: the ticket page's overlap line names the other ticket, up to 5 shared files and how many more; nothing when none.
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { BranchOverlaps } from "../src/components/BranchOverlaps";

afterEach(cleanup);

describe("overlap line on the ticket page", () => {
  it("names the other ticket, its state, the shared files and how many more, with a link", () => {
    const { container } = render(<BranchOverlaps t={{ branchOverlaps: [{ ticketId: "t2", ref: "BOS-12", title: "Merge line", state: "review", files: ["a.ts", "b.ts"], more: 3 }] }} />);
    expect(container.textContent).toContain('Changes the same files as BOS-12 "Merge line" (in review): a.ts, b.ts and 3 more.');
    expect(container.textContent).toContain("Nothing is held");
    expect(container.querySelector("a")?.getAttribute("href")).toBe("#/tickets/t2");
  });
  it("shows nothing without an overlap", () => {
    expect(render(<BranchOverlaps t={{ branchOverlaps: [] }} />).container.textContent).toBe("");
    expect(render(<BranchOverlaps t={{}} />).container.textContent).toBe("");
  });
});
