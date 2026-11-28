// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { RightNow, type HealthLine } from "../src/components/DashboardPanels";
import { GUIDE_BASE } from "../src/guide-links";

// BOS-2832: the Dashboard's "Right now" shows "What's the runner?" only when the runner is offline,
// right after that line. On a connected runner there is no link (one per term, at its first appearance).

afterEach(cleanup);

const line = (over: Partial<HealthLine>): HealthLine => ({ key: "runner", tone: "ok", symbol: "✓", state: "Runner connected", pill: "Runner connected", text: "", href: "#/runner", linkText: "Runner settings", refresh: "Updates every 10 s.", ...over });
const lines = (runner: HealthLine) => [runner, line({ key: "merges", state: "Merges moving" }), line({ key: "usage", state: "No agent held by a usage limit" }), line({ key: "update", state: "No update waiting" })];

describe("Dashboard runner guide link", () => {
  it("links to the runner guide when the runner is offline", () => {
    render(<RightNow lines={lines(line({ tone: "bad", symbol: "✕", state: "Runner offline" }))} paused={false} companyId="c1" />);
    const link = screen.getByText("What's the runner?").closest("a")!;
    expect(link.getAttribute("href")).toBe(`${GUIDE_BASE}/guides/the-runner`);
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.textContent).toContain("(opens a guide)");
  });

  it("shows no runner guide link when the runner is connected", () => {
    render(<RightNow lines={lines(line({ state: "Runner connected" }))} paused={false} companyId="c1" />);
    expect(screen.queryByText("What's the runner?")).toBeNull();
  });
});
