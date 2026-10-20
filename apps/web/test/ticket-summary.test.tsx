// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Company } from "../src/api";
import { splitDetails, TicketActivity } from "../src/components/TicketActivity";
import { Ticket } from "../src/pages/Ticket";

Element.prototype.scrollIntoView = () => {};
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const msg = (over: Record<string, unknown>) => ({ id: "m1", author: "agent", agent: "Engineer", runId: null, text: "", delivery: null, createdAt: "2026-10-19T10:00:00Z", ...over });

describe("ticket conversation", () => {
  it("splits a reply at Details:, and leaves older replies alone", () => {
    expect(splitDetails("Added the limiter.\n\nDetails:\nsrc/limit.ts, 3 tests")).toEqual({ summary: "Added the limiter.", details: "src/limit.ts, 3 tests" });
    expect(splitDetails("Just a note.")).toEqual({ summary: "Just a note.", details: null });
  });

  it("shows the summary, folds the technical report, and folds a run's interim messages under Show working", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/messages")) return json({ live: null, items: [msg({ text: "Rate limiting is in. Nothing for you to do.\nDetails:\nsrc/limit.ts changed; 12 tests pass." }), msg({ id: "m2", text: "Older reply, no marker." })] });
        if (url.includes("/runs") && url.includes("/tickets/")) return json([{ id: "r1", agent: "Engineer", startedAt: "2026-10-19T09:00:00Z", endedAt: "2026-10-19T09:30:00Z", outcome: "end_turn" }]);
        if (url.includes("/transcript")) return json({ run: { endedAt: "x" }, items: [{ seq: 1, type: "run.update", at: "2026-10-19T09:01:00Z", event: { update: { kind: "agent_message", text: "Transient EAGAIN; retry" } } }], next: 1, more: false });
        return json({});
      }),
    );
    render(<TicketActivity ticketId="t1" assignee="Engineer" />);
    const summary = await screen.findByText("Rate limiting is in. Nothing for you to do.");
    expect(summary.closest("details")).toBeNull();
    const details = screen.getByText("src/limit.ts changed; 12 tests pass.").closest("details")!;
    expect(details.open).toBe(false);
    expect(details.querySelector("summary")!.textContent).toBe("Details");
    expect(screen.getByText("Older reply, no marker.").closest("details")).toBeNull();

    const working = (await screen.findByText("Show working")).closest("details")!;
    expect(working.open).toBe(false);
    expect(screen.getByText("See the whole run").getAttribute("href")).toBe("#/runs/r1");
    working.open = true;
    fireEvent(working, new Event("toggle"));
    expect(await screen.findByText("Transient EAGAIN; retry")).toBeTruthy();
  });
});

describe("approve and merge", () => {
  const company: Company = { id: "c1", name: "App Co", mission: null, paused: false, agents: [] };
  const ticket = { id: "t1", title: "Add limiter", systemState: "review", risk: "medium", repoUrl: "https://x/y.git", defaultBranch: "main", landing: "merge", projectId: "p1", project: "App", companyId: "c1", assignee: "Engineer", createdAt: "2026-10-19T09:00:00Z", lastActivityAt: "2026-10-19T09:00:00Z" };

  it("shows what is running with a timer, then the outcome in plain words", async () => {
    let landing: unknown = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === "/api/tickets/t1/review" && init?.method === "POST") {
          landing = { state: "running", startedAt: new Date().toISOString(), command: "pnpm test" };
          return json({ verdict: "approved", outcome: "landing", landing }, 202);
        }
        if (url === "/api/tickets/t1/landing") return json({ landing });
        if (url === "/api/tickets/t1") return json(ticket);
        if (url.includes("/links")) return json({ waitsOn: [], blocks: [], blockedBy: [] });
        if (url.includes("/features")) return json({ features: [] });
        if (url.endsWith("/artifacts") || url.includes("/runs") || url.includes("risk") || url.includes("objectives")) return json([]);
        if (url.includes("/messages")) return json({ live: null, items: [] });
        return json({});
      }),
    );
    render(<Ticket id="t1" companies={[company]} />);
    fireEvent.click(await screen.findByRole("button", { name: "Approve and merge" }));
    expect(await screen.findByText(/Approved\. Running the pre-merge check \(pnpm test\); this can take several minutes\. Elapsed: 0:0\d/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Approve and merge" }) as HTMLButtonElement).disabled).toBe(true);
    landing = { state: "finished", outcome: "verify_failed", text: "Approved, but not merged: the check failed (exit code 1). It's gone back to Engineer to fix; the check's output is in the conversation below.", url: null, finishedAt: "x" };
    expect(await screen.findByText(/the check failed \(exit code 1\)\. It's gone back to Engineer/, undefined, { timeout: 4000 })).toBeTruthy();
    await waitFor(() => expect(screen.queryByText(/Running the pre-merge check/)).toBeNull());
  });

  it("asks for comments only when sending the work back, and sends them", async () => {
    const posted: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === "/api/tickets/t1/review" && init?.method === "POST") return (posted.push(JSON.parse(String(init.body))), json({ verdict: "changes_requested", delivered: "Engineer" }));
        if (url === "/api/tickets/t1") return json(ticket);
        if (url.includes("/links")) return json({ waitsOn: [], blocks: [], blockedBy: [] });
        if (url.includes("/features")) return json({ features: [] });
        if (url.endsWith("/artifacts") || url.includes("/runs") || url.includes("risk") || url.includes("objectives")) return json([]);
        if (url.includes("/messages")) return json({ live: null, items: [] });
        return json({});
      }),
    );
    render(<Ticket id="t1" companies={[company]} />);
    await screen.findByRole("button", { name: "Approve and merge" });
    expect(screen.queryByLabelText("What should the agent change?")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Request changes" }));
    const send = screen.getByRole("button", { name: "Send it back" }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("What should the agent change?"), { target: { value: "Keep the old tests" } });
    fireEvent.click(send);
    await waitFor(() => expect(posted).toEqual([{ verdict: "changes_requested", summary: "Keep the old tests" }]));
  });
});

describe("unrated task", () => {
  it("says the CEO rates it when it reviews the task", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === "/api/tickets/t1") return json({ id: "t1", title: "Add limiter", systemState: "backlog", risk: null, projectId: "p1", project: "App", companyId: "c1", assignee: null, createdAt: "2026-10-19T09:00:00Z", lastActivityAt: "2026-10-19T09:00:00Z" });
        if (url.includes("/links")) return json({ waitsOn: [], blocks: [], blockedBy: [] });
        if (url.includes("/features")) return json({ features: [] });
        if (url.includes("/messages")) return json({ live: null, items: [] });
        if (url.endsWith("/artifacts") || url.includes("/runs") || url.includes("risk") || url.includes("objectives")) return json([]);
        return json({});
      }),
    );
    render(<Ticket id="t1" companies={[{ id: "c1", name: "App Co", mission: null, paused: false, agents: [] }]} />);
    expect(await screen.findByText("Not rated yet — the CEO rates it when it reviews the task (treated as medium until then).")).toBeTruthy();
  });
});
