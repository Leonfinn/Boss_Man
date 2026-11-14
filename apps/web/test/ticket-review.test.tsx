// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Company } from "../src/api";
import { Ticket } from "../src/pages/Ticket";

Element.prototype.scrollIntoView = () => {};
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const company: Company = { id: "c1", name: "App Co", mission: null, paused: false, agents: [] };
const review = (status: string) => ({ id: "r1", kind: "code", round: 1, seq: 0, status, reviewer: "Ada", notes: null, overruleReason: null });

function show(over: Record<string, unknown>, reviews: unknown[]) {
  const at = new Date().toISOString();
  const ticket = { id: "t1", title: "Fix typo", systemState: "review", risk: "trivial", repoUrl: "https://github.com/Leonfinn/customer-app.git", defaultBranch: "main", branch: "bm/fix-typo", landing: "merge", verifyCommand: "pnpm test", ownerSignoff: false, projectId: "p1", project: "App", companyId: "c1", assignee: "Wiki Maintainer", assigneeAgentId: "a1", createdAt: at, lastActivityAt: at, monitorAttempts: 0, monitorMax: 5, ...over };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url === "/api/tickets/t1") return json(ticket);
      if (url === "/api/tickets/t1/reviews") return json(reviews);
      if (url.includes("/links")) return json({ waitsOn: [], blocks: [], blockedBy: [] });
      if (url.includes("/features")) return json({ features: [] });
      if (url.endsWith("/artifacts") || url.endsWith("/reviews") || url.includes("/runs") || url.includes("risk") || url.includes("objectives")) return json([]);
      if (url.includes("/messages")) return json({ live: null, items: [] });
      return json({});
    }),
  );
  render(<Ticket id="t1" companies={[company]} />);
}

describe("ticket in review", () => {
  it("while an agent review waits and no sign-off is needed, says it lands by itself and tucks the buttons under Decide now", async () => {
    show({}, [review("pending")]);
    expect(await screen.findByText(/Waiting for Ada's review\. When it approves, this lands automatically/)).toBeTruthy();
    expect(screen.queryByText("waiting for you")).toBeNull();
    expect(screen.getByText("waiting for Ada")).toBeTruthy();
    expect(screen.getByText("Waiting for Ada")).toBeTruthy();
    expect(screen.getByText("Reviewed by Ada.")).toBeTruthy();
    expect(screen.getByText("Written by")).toBeTruthy();
    expect(screen.getByText("Decide now instead").closest("details")!.open).toBe(false);
    expect(screen.getByText("Deciding now skips the waiting review.")).toBeTruthy();
  });

  it("with sign-off required and a review pending, says you'll be asked after", async () => {
    show({ risk: "high", ownerSignoff: true }, [review("pending")]);
    expect(await screen.findByText(/you'll be asked to sign it off/)).toBeTruthy();
    expect(screen.getByText("waiting for Ada, then you")).toBeTruthy();
    expect(screen.queryByText("waiting for you")).toBeNull();
  });

  it("once the agent reviews have approved, it is waiting for you, and says what approving does", async () => {
    show({ risk: "high", ownerSignoff: true }, [review("approved")]);
    expect(await screen.findByText("waiting for you")).toBeTruthy();
    expect(screen.queryByText("Decide now instead")).toBeNull();
    expect(screen.getByText("Approving runs `pnpm test` and, if it passes, merges bm/fix-typo into main of Leonfinn/customer-app. The change is under Changes above.")).toBeTruthy();
  });

  it("says plainly that it waits on your sign-off, from the server's word, even while its card is being raised again (BOS-503)", async () => {
    show({ risk: "high", ownerSignoff: true, signoff: "missing" }, [review("approved")]);
    expect(await screen.findByText("waiting for your sign-off")).toBeTruthy();
    expect(screen.getByText(/This is also your sign-off: one press approves, signs off and merges\./)).toBeTruthy();
    cleanup();
    show({ risk: "high", ownerSignoff: true, signoff: "signed_off" }, [review("approved")]);
    expect(await screen.findByText("you signed it off; it merges next")).toBeTruthy();
  });

  it("when no agent can review it, the review is yours: no 'reviewer' to wait for, the buttons show straight away", async () => {
    show({}, [{ ...review("pending"), reviewer: null }]);
    expect(await screen.findByText("waiting for you")).toBeTruthy();
    expect(screen.queryByText(/Waiting for a reviewer/)).toBeNull();
    expect(screen.queryByText("Decide now instead")).toBeNull();
    expect(screen.getByRole("button", { name: "Approve and merge" })).toBeTruthy();
  });

  it("describes a pull request landing, and no repo", async () => {
    show({ landing: "pull_request" }, []);
    expect(await screen.findByText("Approving opens a pull request from bm/fix-typo into main of Leonfinn/customer-app. The change is under Changes above.")).toBeTruthy();
    cleanup();
    show({ repoUrl: null }, []);
    expect(await screen.findByText("Approving marks it done.")).toBeTruthy();
  });
});

describe("phone ordering hooks (BOS-245)", () => {
  it("the folded Review card still gets its marker, so the phone can put it above the conversation", async () => {
    show({}, []);
    const review = (await screen.findByText("waiting for you")).closest("details")!;
    expect(review.classList.contains("fold")).toBe(true);
    expect(review.classList.contains("review-card")).toBe(true);
  });
});

describe("Approve and merge settles the owner's sign-off (BOS-471)", () => {
  it("sends one press to the approve-merge path and says what it did", async () => {
    const calls: string[] = [];
    const at = new Date().toISOString();
    const ticket = { id: "t1", title: "Fix typo", systemState: "review", risk: "high", repoUrl: "https://github.com/Leonfinn/customer-app.git", defaultBranch: "main", branch: "bm/fix-typo", landing: "merge", verifyCommand: "pnpm test", ownerSignoff: true, signoffWaiting: true, projectId: "p1", project: "App", companyId: "c1", assignee: "Engineer", assigneeAgentId: "a1", createdAt: at, lastActivityAt: at };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === "/api/tickets/t1/approve-merge" && init?.method === "POST") {
          calls.push(url);
          return json({ outcome: "landing", signoffAnswered: true, landing: { state: "running", startedAt: at, command: "pnpm test", startedBy: "the owner" } });
        }
        if (url === "/api/tickets/t1") return json(ticket);
        if (url.includes("/links")) return json({ waitsOn: [], blocks: [], blockedBy: [] });
        if (url.includes("/features")) return json({ features: [] });
        if (url.endsWith("/artifacts") || url.endsWith("/reviews") || url.includes("/runs") || url.includes("risk") || url.includes("objectives")) return json([]);
        if (url.includes("/messages")) return json({ live: null, items: [] });
        return json({});
      }),
    );
    render(<Ticket id="t1" companies={[company]} />);
    expect(await screen.findByText(/This is also your sign-off: one press approves, signs off and merges\./)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Approve and merge" }));
    expect(await screen.findByText(/Signed off\. Checking and merging now\./)).toBeTruthy();
    expect(calls).toEqual(["/api/tickets/t1/approve-merge"]);
  });

  it("says it signed off and merged when the background merge already finished", async () => {
    const at = new Date().toISOString();
    const ticket = { id: "t1", title: "Fix typo", systemState: "review", risk: "high", repoUrl: "https://github.com/Leonfinn/customer-app.git", defaultBranch: "main", branch: "bm/fix-typo", landing: "merge", verifyCommand: "pnpm test", ownerSignoff: true, signoffWaiting: true, projectId: "p1", project: "App", companyId: "c1", assignee: "Engineer", assigneeAgentId: "a1", createdAt: at, lastActivityAt: at };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        // The background merge started by the sign-off's answer finished before the route read its state back.
        if (url === "/api/tickets/t1/approve-merge" && init?.method === "POST") return json({ outcome: "landing", signoffAnswered: true, landing: { state: "finished", outcome: "merged", text: "Merged bm/fix-typo into main.", url: null, finishedAt: at } });
        if (url === "/api/tickets/t1") return json(ticket);
        if (url.includes("/links")) return json({ waitsOn: [], blocks: [], blockedBy: [] });
        if (url.includes("/features")) return json({ features: [] });
        if (url.endsWith("/artifacts") || url.endsWith("/reviews") || url.includes("/runs") || url.includes("risk") || url.includes("objectives")) return json([]);
        if (url.includes("/messages")) return json({ live: null, items: [] });
        return json({});
      }),
    );
    render(<Ticket id="t1" companies={[company]} />);
    fireEvent.click(await screen.findByRole("button", { name: "Approve and merge" }));
    expect(await screen.findByText(/Signed off and merged\./)).toBeTruthy();
  });
});
