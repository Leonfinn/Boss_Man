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

let briefState: Record<string, unknown> = { slug: "brief-p1", exists: false, commit: null, branch: null, updatedAt: null, ticketId: null };

function stub(patched: unknown[] = [], posted: string[] = []) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/brief")) {
        if (init?.method === "POST") return posted.push(url), json({ id: "t9" });
        return json(briefState);
      }
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

  it("config tab offers to write the project brief, and links the page once it exists", async () => {
    const posted: string[] = [];
    briefState = { slug: "brief-p1", exists: false, commit: null, branch: null, updatedAt: null, ticketId: null };
    stub([], posted);
    show("config");
    expect(await screen.findByText("No brief yet.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Write brief" }));
    await vi.waitFor(() => expect(posted).toEqual(["/api/projects/p1/brief"]));
    cleanup();

    briefState = { slug: "brief-p1", exists: true, commit: "abc1234def", branch: "main", updatedAt: "2026-10-01T12:00:00Z", ticketId: null };
    stub();
    show("config");
    expect(await screen.findByRole("link", { name: "App project brief" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "App project brief" }).getAttribute("href")).toBe("#/wiki/c1/brief-p1");
    expect(screen.getByText(/Describes commit abc1234 on main, updated/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Refresh brief" })).toBeTruthy();
    cleanup();

    briefState = { ...briefState, ticketId: "t9" };
    stub();
    show("config");
    expect((await screen.findByRole("link", { name: /open the ticket/ })).getAttribute("href")).toBe("#/tickets/t9");
    expect(screen.queryByRole("button", { name: "Refresh brief" })).toBeNull();
  });
});
