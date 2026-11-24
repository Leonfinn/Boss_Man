// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Company } from "../src/api";
import { Board } from "../src/pages/Board";

afterEach(() => {
  cleanup();
  sessionStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const company: Company = { id: "c1", name: "App Co", ticketPrefix: "APP", mission: null, paused: false, agents: [{ id: "a1", name: "Developer" }] } as Company;
const tk = (n: number, title: string, state: string, extra: Record<string, unknown> = {}) => ({ id: `t${n}`, number: n, title, systemState: state, outcome: null, assigneeAgentId: "a1", assignedToOwner: false, dueDate: null, blockedBy: [], branch: null, risk: null, planFirst: false, plan: null, planApprovedAt: null, lastActivityAt: "2026-11-20T09:00:00Z", featureId: null, featureTitle: null, ...extra });

function stub(columns: unknown[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.endsWith("/projects")) return json([{ id: "p1", companyId: "c1", name: "My App!", repoUrl: null }]);
      if (url.includes("/board")) return json({ project: { id: "p1", companyId: "c1", name: "My App!" }, doneTotal: 0, columns });
      if (url.endsWith("/features")) return json({ settings: { demandWeight: 1, ceoTriage: false }, drivers: [], maxDemand: 0, features: [] });
      return json([]);
    }),
  );
}
const open = () => render(<Board companies={[company]} projectId="p1" go={() => {}} onCompaniesChanged={() => {}} />);

/** Runs the click and returns what was downloaded. */
function capture() {
  let text = "";
  let name = "";
  const blobs: Blob[] = [];
  (URL as unknown as { createObjectURL: (b: Blob) => string }).createObjectURL = (b) => (blobs.push(b), "blob:x");
  (URL as unknown as { revokeObjectURL: () => void }).revokeObjectURL = () => {};
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
    name = this.download;
  });
  return { get name() { return name; }, text: async () => { text = await blobs[0]!.text(); return text; } };
}

const cols = () => [
  { id: "c1", name: "Backlog", systemState: "backlog", wipLimit: null, tickets: [tk(1, "Fix, \"it\"\nnow", "backlog", { risk: "high", size: 3, featureTitle: "Export", urgentByOwner: true })] },
  { id: "c2", name: "In progress", systemState: "in_progress", wipLimit: null, tickets: [tk(2, "Second", "in_progress"), tk(3, "Third", "in_progress")] },
];

describe("Board Download CSV (BOS-2258)", () => {
  it("exports every ticket shown, named board-<project>-<date>.csv, with awkward titles quoted", async () => {
    stub(cols());
    const got = capture();
    open();
    await screen.findByText("Second");
    fireEvent.click(screen.getByRole("button", { name: "Download CSV" }));
    const text = await got.text();
    expect(got.name).toMatch(/^board-my-app-\d{4}-\d{2}-\d{2}\.csv$/);
    expect(text.startsWith("Reference,Title,Column,Assignee,Risk,Size,Feature,Priority 1,Last activity,Days in state,Build\r\n")).toBe(true);
    expect(text).toContain('APP-1,"Fix, ""it""\nnow",Backlog,Developer,high,3,Export,yes,');
    expect(text.trimEnd().split("\r\n").length).toBe(4);
  });

  it("with a search active exports only the tickets that match", async () => {
    stub(cols());
    const got = capture();
    open();
    await screen.findByText("Second");
    fireEvent.change(screen.getByRole("searchbox", { name: "Search tasks" }), { target: { value: "third" } });
    fireEvent.click(screen.getByRole("button", { name: "Download CSV" }));
    const rows = (await got.text()).trimEnd().split("\r\n");
    expect(rows.length).toBe(2);
    expect(rows[1]).toContain("Third");
  });

  it("is disabled while the board loads and when it is empty", async () => {
    stub([{ id: "c1", name: "Backlog", systemState: "backlog", wipLimit: null, tickets: [] }]);
    open();
    expect(((await screen.findByRole("button", { name: "Download CSV" })) as HTMLButtonElement).disabled).toBe(true);
    await screen.findByRole("heading", { name: "Backlog" });
    expect((screen.getByRole("button", { name: "Download CSV" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
