// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { BuildLine, type BuildResult } from "../src/pages/Ticket";

// The git host's build result on the ticket page (BOS-1418).
afterEach(cleanup);

const base: BuildResult = { state: "passed", failing: [], total: 2, url: "https://example.com/runs/1", sha: "abcdef1234567890" };

describe("BuildLine", () => {
  it("shows nothing when the host reported nothing", () => {
    const { container } = render(<BuildLine ci={null} />);
    expect(container.innerHTML).toBe("");
  });
  it("says passed with a link to the run", () => {
    render(<BuildLine ci={base} />);
    expect(screen.getByTestId("build-result").textContent).toContain("passed");
    const a = screen.getByRole("link", { name: "View run" });
    expect(a.getAttribute("href")).toBe("https://example.com/runs/1");
    expect(a.getAttribute("rel")).toContain("noopener");
  });
  it("names failing checks and says running for pending", () => {
    const { rerender } = render(<BuildLine ci={{ ...base, state: "failed", failing: ["lint", "test"] }} />);
    expect(screen.getByTestId("build-result").textContent).toContain("failed (lint, test)");
    rerender(<BuildLine ci={{ ...base, state: "pending", url: null }} />);
    expect(screen.getByTestId("build-result").textContent).toContain("running");
    expect(screen.queryByRole("link")).toBeNull();
  });
});
