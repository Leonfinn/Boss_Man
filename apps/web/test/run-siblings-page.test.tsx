// @vitest-environment jsdom
// "Other runs on this ticket" and Previous/Next run on the Run page.
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Company } from "../src/api";
import { Run } from "../src/pages/Run";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const company = { id: "c1", name: "App Co", agents: [] } as unknown as Company;
const run = (id: string, ticketId: string | null, startedAt: string, extra: object = {}) => ({
  id, companyId: "c1", agent: "Ada", agentId: "a1", ticketId, ticket: ticketId ? "Fix it" : null, runTicketRef: ticketId ? "BOS-1" : null, startedAt, endedAt: startedAt.replace("10:", "11:"), outcome: "end_turn", costMicros: 1_000_000, ...extra,
});

function stub(open: object, recent: Response | object[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.includes("/api/runs/recent")) return recent instanceof Response ? recent : new Response(JSON.stringify(recent), { status: 200 });
      if (url.includes("/transcript")) return new Response(JSON.stringify({ run: open, items: [], next: 0, more: false }), { status: 200 });
      return new Response(JSON.stringify(url.includes("/permissions") ? { entries: [] } : []), { status: 200 });
    }),
  );
}

const all = [run("r1", "t1", "2026-11-01T10:00:00Z"), run("r2", "t1", "2026-11-02T10:00:00Z"), run("r3", "t1", "2026-11-03T10:00:00Z"), run("other", "t2", "2026-11-02T12:00:00Z")];

describe("other runs on this ticket", () => {
  it("lists the ticket's runs, marks this one and links its neighbours", async () => {
    stub(all[1]!, all);
    render(<Run runId="r2" companies={[company]} />);
    expect(await screen.findByText("Other runs on this ticket (3)")).toBeTruthy();
    const fold = screen.getByTestId("run-siblings");
    expect(within(fold).getAllByRole("row")).toHaveLength(4);
    expect(within(fold).getAllByText("This run")).toHaveLength(1);
    expect((screen.getByText("Previous run") as HTMLAnchorElement).getAttribute("href")).toBe("#/runs/r1");
    expect((screen.getByText("Next run") as HTMLAnchorElement).getAttribute("href")).toBe("#/runs/r3");
  });
  it("hides Previous at the first run and Next at the last", async () => {
    stub(all[0]!, all);
    const first = render(<Run runId="r1" companies={[company]} />);
    await screen.findByText("Other runs on this ticket (3)");
    expect(screen.queryByText("Previous run")).toBeNull();
    expect(screen.getByText("Next run")).toBeTruthy();
    first.unmount();
    stub(all[2]!, all);
    render(<Run runId="r3" companies={[company]} />);
    await screen.findByText("Other runs on this ticket (3)");
    expect(screen.queryByText("Next run")).toBeNull();
    expect(screen.getByText("Previous run")).toBeTruthy();
  });
  it("shows neither for a run with no ticket", async () => {
    stub(run("n", null, "2026-11-01T10:00:00Z"), all);
    render(<Run runId="n" companies={[company]} />);
    expect(await screen.findByText("Permissions in this run")).toBeTruthy();
    expect(screen.queryByTestId("run-siblings")).toBeNull();
    expect(screen.queryByText("Previous run")).toBeNull();
    expect(screen.queryByText("Next run")).toBeNull();
  });
  it("shows the load error with Retry inside the fold when the read fails", async () => {
    stub(all[1]!, new Response(JSON.stringify({ error: "down" }), { status: 500 }));
    render(<Run runId="r2" companies={[company]} />);
    const fold = await screen.findByTestId("run-siblings");
    expect(await within(fold).findByRole("button", { name: "Retry" })).toBeTruthy();
    expect(screen.getByText("Permissions in this run")).toBeTruthy();
  });
});
