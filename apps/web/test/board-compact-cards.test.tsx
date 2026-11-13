// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Company } from "../src/api";
import { Board } from "../src/pages/Board";

// jsdom has no layout: say that anything with a clamp class has more text than fits.
const heights = { scroll: Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollHeight"), client: Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight") };
beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", { configurable: true, get() { return (this as HTMLElement).className.includes("clamp") ? 100 : 20; } });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get() { return 20; } });
});
afterEach(() => {
  cleanup();
  sessionStorage.clear();
  localStorage.clear();
  vi.unstubAllGlobals();
  if (heights.scroll) Object.defineProperty(HTMLElement.prototype, "scrollHeight", heights.scroll);
  if (heights.client) Object.defineProperty(HTMLElement.prototype, "clientHeight", heights.client);
});

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const company: Company = { id: "c1", name: "App Co", mission: null, paused: false, ticketPrefix: "ACM", agents: [] };
const card = (over: Record<string, unknown>) => ({ systemState: "ready", outcome: null, assigneeAgentId: null, assignedToOwner: false, dueDate: null, blockedBy: [], branch: null, risk: null, planFirst: false, plan: null, planApprovedAt: null, ...over });
const LONG = "A very long title that goes on and on about many things so that it will not fit";

function stub(tickets: unknown[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.endsWith("/projects")) return json([{ id: "p1", companyId: "c1", name: "App", repoUrl: null }]);
      if (url.endsWith("/board")) return json({ project: { id: "p1", companyId: "c1", name: "App" }, columns: [{ id: "col1", name: "Ready", systemState: "ready", wipLimit: null, tickets }] });
      return json([]);
    }),
  );
}

describe("compact board cards", () => {
  it("cuts a long title, shows the full text on hover, and opens and closes with the arrow", async () => {
    stub([card({ id: "t1", number: 7, title: LONG })]);
    render(<Board companies={[company]} projectId="p1" go={() => {}} onCompaniesChanged={() => {}} />);
    const link = await screen.findByText(LONG, { selector: "h3 a" });
    const article = link.closest("article")!;
    expect(link.className).toContain("clamp2");
    expect(link.getAttribute("title")).toBe(LONG);
    const arrow = within(article).getByRole("button", { name: "Show all of ACM-7" });
    expect(arrow.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(arrow);
    expect(within(article).getByRole("button", { name: "Show less of ACM-7" }).getAttribute("aria-expanded")).toBe("true");
    expect(link.className).not.toContain("clamp2");
    expect(link.getAttribute("title")).toBeNull();
    fireEvent.click(within(article).getByRole("button", { name: "Show less of ACM-7" }));
    expect(link.className).toContain("clamp2");
  });

  it("shows the reference and a short title for what a card waits on, and every blocker when open", async () => {
    stub([card({ id: "t2", number: 9, title: "Short", blockedBy: [{ ticketId: "t1", ticketNumber: 3, ticketTitle: LONG, until: "merged", engagementId: null, decisionId: null }] })]);
    render(<Board companies={[company]} projectId="p1" go={() => {}} onCompaniesChanged={() => {}} />);
    const waits = (await screen.findByText(`ACM-3 · ${LONG}`)).closest("span")!;
    expect(waits.className).toContain("clamp1");
    expect(waits.textContent).not.toContain("until merged");
    const article = waits.closest("article")!;
    expect(within(article).getByText("Blocked by a task")).toBeTruthy();
    fireEvent.click(within(article).getByRole("button", { name: "Show all of ACM-9" }));
    expect(article.textContent).toContain("(until merged)");
  });

  it("lists only references when a card waits on several tickets, and counts them in the tag", async () => {
    const dep = (n: number) => ({ ticketId: `d${n}`, ticketNumber: n, ticketTitle: `Dep ${n}`, until: "merged", engagementId: null, decisionId: null });
    stub([card({ id: "t2", number: 9, title: "Short", blockedBy: [dep(3), dep(4)] })]);
    render(<Board companies={[company]} projectId="p1" go={() => {}} onCompaniesChanged={() => {}} />);
    expect(await screen.findByText("Blocked by 2")).toBeTruthy();
    expect(screen.getByRole("link", { name: "ACM-3" }).getAttribute("href")).toBe("#/tickets/d3");
    expect(screen.getByRole("link", { name: "ACM-4" })).toBeTruthy();
    expect(screen.queryByText("Dep 3")).toBeNull();
  });
});
