// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
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
    expect(screen.getByText("Being reviewed by Ada.")).toBeTruthy();
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

  it("describes a pull request landing, and no repo", async () => {
    show({ landing: "pull_request" }, []);
    expect(await screen.findByText("Approving opens a pull request from bm/fix-typo into main of Leonfinn/customer-app. The change is under Changes above.")).toBeTruthy();
    cleanup();
    show({ repoUrl: null }, []);
    expect(await screen.findByText("Approving marks it done.")).toBeTruthy();
  });
});
