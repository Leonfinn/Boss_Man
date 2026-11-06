// @vitest-environment jsdom
// BOS-416: an ended run with no events (pruned after the retention period) says so, instead of "Nothing recorded yet."
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Company } from "../src/api";
import { Run } from "../src/pages/Run";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const company = { id: "c1", name: "App Co", agents: [] } as unknown as Company;
function stub(endedAt: string | null) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) =>
      new Response(
        JSON.stringify(
          url.includes("/transcript")
            ? { run: { id: "r1", companyId: "c1", agent: "Ada", agentId: "a1", ticketId: null, ticket: null, startedAt: "2026-01-05T10:00:00Z", endedAt }, items: [], next: 0, more: false }
            : [],
        ),
        { status: 200 },
      ),
    ),
  );
}

describe("run page with no events (BOS-416)", () => {
  it("an ended run says its events are deleted after the retention period", async () => {
    stub("2026-01-05T11:00:00Z");
    render(<Run runId="r1" companies={[company]} />);
    expect(await screen.findByText(/older than the retention period .* are deleted/)).toBeTruthy();
  });
  it("a run still going keeps the plain 'Nothing recorded yet.'", async () => {
    stub(null);
    render(<Run runId="r1" companies={[company]} />);
    expect(await screen.findByText("Nothing recorded yet.")).toBeTruthy();
  });
});
