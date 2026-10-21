// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Company } from "../src/api";
import { Board } from "../src/pages/Board";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const company: Company = { id: "c1", name: "App Co", mission: null, paused: false, agents: [] };
const project = { id: "p1", companyId: "c1", name: "App", repoUrl: null, defaultBranch: "main", landing: "merge", gitHost: null, gitApiBase: null, verifyCommand: null, deepVerifyCommand: null, ticketCostCapMicros: 5_000_000, monthlyCapMicros: null, starred: false };

function stub(patched: unknown[] = []) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "PATCH") return patched.push(JSON.parse(String(init.body))), json({ ...project, starred: true });
      if (url.endsWith("/projects")) return json([project]);
      if (url.endsWith("/board")) return json({ project, columns: [{ id: "col1", name: "Ready", systemState: "ready", wipLimit: null, tickets: [] }] });
      if (url.endsWith("/spend")) return json({ tokens: { month: { input: 1_200_000, output: 45_000 }, total: { input: 3_400_000, output: 98_000 } }, monthMicros: 3_500_000, totalMicros: 4_500_000, ticketCostCapMicros: 5_000_000, monthlyCapMicros: 10_000_000, monthStart: "", topTickets: [{ id: "t1", title: "Big job", micros: 4_000_000 }] });
      if (url.endsWith("/check-presets")) return json({ detected: [], standard: [], none: { id: "none", label: "Nothing", command: null, plain: "", needs: [] }, tools: null, error: null });
      return json([]);
    }),
  );
}
const show = (subpage?: string, go: (to: string) => void = () => {}) => render(<Board companies={[company]} projectId="p1" subpage={subpage} go={go} onCompaniesChanged={() => {}} />);

describe("project page tabs", () => {
  it("opens on the Kanban and goes to the other tabs by address", async () => {
    stub();
    const go = vi.fn();
    show(undefined, go);
    expect(await screen.findByText("Ready")).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Kanban" }).getAttribute("aria-selected")).toBe("true");
    fireEvent.click(screen.getByRole("tab", { name: "Budget" }));
    expect(go).toHaveBeenCalledWith("board/p1/budget");
    fireEvent.click(screen.getByRole("tab", { name: "Config" }));
    expect(go).toHaveBeenCalledWith("board/p1/config");
  });

  it("budget tab shows spend and the costliest tasks", async () => {
    stub();
    show("budget");
    expect(await screen.findByText("$3.50")).toBeTruthy();
    expect(screen.getByText("$4.50")).toBeTruthy();
    expect(screen.getByLabelText("$3.50 of the $10.00 monthly cap").getAttribute("max")).toBe("10000000");
    expect(screen.getByRole("link", { name: "Big job" }).getAttribute("href")).toBe("#/tickets/t1");
    expect(screen.getByText("Tokens")).toBeTruthy();
    expect(screen.getByText(/1\.2M \/ 45K/)).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Budget" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.queryByText("Ready")).toBeNull();
  });

  it("config tab shows the project's settings, and the header star saves", async () => {
    const patched: unknown[] = [];
    stub(patched);
    show("config");
    expect(await screen.findByLabelText("Git repo")).toBeTruthy();
    expect((screen.getByLabelText("Cost cap per task (USD)") as HTMLInputElement).value).toBe("5");
    fireEvent.click(screen.getByRole("button", { name: "Star App" }));
    await vi.waitFor(() => expect(patched).toEqual([{ starred: true }]));
  });
});
