// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Company } from "../src/api";
import { Ticket } from "../src/pages/Ticket";

Element.prototype.scrollIntoView = () => {};
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const company: Company = { id: "c1", name: "App Co", mission: null, paused: false, agents: [] };
const base = { id: "t1", title: "Add limiter", systemState: "review", risk: "low", projectId: "p1", project: "App", companyId: "c1", assignee: null, createdAt: "2026-10-19T09:00:00Z", lastActivityAt: "2026-10-19T09:00:00Z" };
const stub = (ticket: Record<string, unknown>, patches: unknown[] = []) =>
  vi.fn(async (url: string, init?: RequestInit) => {
    if (url === "/api/tickets/t1" && init?.method === "PATCH") return (patches.push(JSON.parse(String(init.body))), json({}));
    if (url === "/api/tickets/t1") return json({ ...base, ...ticket });
    if (url.includes("/links")) return json({ waitsOn: [], blocks: [], blockedBy: [] });
    if (url.includes("/features")) return json({ features: [] });
    if (url.endsWith("/artifacts") || url.endsWith("/reviews") || url.includes("/runs") || url.includes("risk") || url.includes("objectives")) return json([]);
    if (url.includes("/messages")) return json({ live: null, items: [] });
    return json({});
  });

describe("acceptance criteria on the ticket page", () => {
  it("shows the criteria with the author's pass or fail, and who hasn't reported yet", async () => {
    vi.stubGlobal("fetch", stub({ acceptanceCriteria: ["Health check returns 200", "Migration is expand-only"], stateNote: "Health check returns 200 pass." }));
    const { container } = render(<Ticket id="t1" companies={[company]} />);
    await screen.findByText("Done when");
    const rows = container.querySelectorAll('[data-testid="criterion"]');
    expect([...rows].map((r) => r.getAttribute("data-verdict"))).toEqual(["pass", "none"]);
    expect(container.textContent).toContain("Not every criterion has the author's pass or fail");
  });

  it("saves the owner's edit through the ticket patch, and clearing leaves none", async () => {
    const patches: unknown[] = [];
    vi.stubGlobal("fetch", stub({ acceptanceCriteria: ["Health check returns 200"], stateNote: null }, patches));
    render(<Ticket id="t1" companies={[company]} />);
    fireEvent.click(await screen.findByText("Edit criteria"));
    const box = screen.getByLabelText("Acceptance criteria, one per line") as HTMLTextAreaElement;
    expect(box.value).toBe("Health check returns 200");
    fireEvent.change(box, { target: { value: "Health check returns 200\n\nSecrets are never logged" } });
    fireEvent.click(screen.getByRole("button", { name: "Save criteria" }));
    await waitFor(() => expect(patches).toEqual([{ acceptanceCriteria: ["Health check returns 200", "Secrets are never logged"] }]));
    fireEvent.change(box, { target: { value: "   " } });
    fireEvent.click(screen.getByRole("button", { name: "Save criteria" }));
    await waitFor(() => expect(patches.at(-1)).toEqual({ acceptanceCriteria: [] }));
  });

  it("a ticket with no criteria shows just the editor", async () => {
    vi.stubGlobal("fetch", stub({ acceptanceCriteria: [], stateNote: null }));
    render(<Ticket id="t1" companies={[company]} />);
    await screen.findByText("Done when");
    expect(screen.queryByRole("button", { name: "Edit criteria" })).toBeNull();
    expect(screen.getByLabelText("Acceptance criteria, one per line")).toBeTruthy();
  });
});
describe("the no-code flag on the ticket page", () => {
  it("saves the owner's tick through the ticket patch", async () => {
    const patches: unknown[] = [];
    vi.stubGlobal("fetch", stub({ repoUrl: "https://github.com/x/y.git", noCode: false }, patches));
    render(<Ticket id="t1" companies={[company]} />);
    fireEvent.click(await screen.findByLabelText(/Doesn't need code changes/));
    await waitFor(() => expect(patches).toContainEqual({ noCode: true }));
  });

  it("is hidden when the project has no repo", async () => {
    vi.stubGlobal("fetch", stub({ repoUrl: null, noCode: false }));
    render(<Ticket id="t1" companies={[company]} />);
    await screen.findByText("Done when");
    expect(screen.queryByLabelText(/Doesn't need code changes/)).toBeNull();
  });
});
