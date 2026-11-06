// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Company } from "../src/api";
import { Ticket } from "../src/pages/Ticket";

// Vitest stubs a `?raw` CSS import to an empty string, so read the sheet the app ships.
const styles = readFileSync(resolve(process.cwd(), "src/styles.css"), "utf8");

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
    expect(container.textContent).toContain("Not every criterion to check before merge");
  });

  it("counts criteria as '1 criterion' or 'N criteria'", async () => {
    vi.stubGlobal("fetch", stub({ acceptanceCriteria: ["Only one"], stateNote: null }));
    render(<Ticket id="t1" companies={[company]} />);
    expect(await screen.findByText("1 criterion")).toBeTruthy();
    cleanup();
    vi.stubGlobal("fetch", stub({ acceptanceCriteria: ["A", "B"], stateNote: null }));
    render(<Ticket id="t1" companies={[company]} />);
    expect(await screen.findByText("2 criteria")).toBeTruthy();
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

  it("marks an on-a-real-host criterion, skips it in the review warning, and saves the tick with a text edit (DR-024 #5)", async () => {
    const patches: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      stub({ acceptanceCriteria: [{ text: "Health check returns 200", after: "merge" }, "Secrets are never logged"], stateNote: "Secrets are never logged pass" }, patches),
    );
    const { container } = render(<Ticket id="t1" companies={[company]} />);
    await screen.findByText("Done when");
    const rows = container.querySelectorAll('[data-testid="criterion"]');
    expect([...rows].map((r) => r.getAttribute("data-after"))).toEqual(["merge", null]);
    expect(container.textContent).toContain("on a real host, checked after merge");
    // The after-merge check is unreported but doesn't raise the "reviewer has been told" warning.
    expect(container.textContent).not.toContain("Not every criterion to check before merge has the author");
    fireEvent.click(screen.getByText("Edit criteria"));
    const box = screen.getByLabelText("Acceptance criteria, one per line") as HTMLTextAreaElement;
    expect(box.value).toBe("Health check returns 200\nSecrets are never logged");
    // A text edit keeps the after-merge mark on its line.
    fireEvent.change(box, { target: { value: "Health check returns 200\nSecrets are never logged\nAnswers from the owner's Tailscale name on a real host" } });
    fireEvent.click(screen.getByRole("button", { name: "Save criteria" }));
    await waitFor(() =>
      expect(patches.at(-1)).toEqual({
        acceptanceCriteria: [{ text: "Health check returns 200", after: "merge" }, "Secrets are never logged", "Answers from the owner's Tailscale name on a real host"],
      }),
    );
    // A tick saves the after-merge mark; a plain save adds new lines as before-merge ones.
    const ticks = screen.getAllByRole("checkbox") as HTMLInputElement[];
    fireEvent.click(ticks.at(-1)!);
    fireEvent.click(screen.getByRole("button", { name: "Save criteria" }));
    await waitFor(() => expect((patches.at(-1) as { acceptanceCriteria: unknown[] }).acceptanceCriteria.at(-1)).toEqual({ text: "Answers from the owner's Tailscale name on a real host", after: "merge" }));
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
describe("the last post on the ticket", () => {
  it("shows how long ago an agent last posted, next to the ticket's activity", async () => {
    const posted = new Date(Date.now() - 12 * 60_000).toISOString();
    vi.stubGlobal("fetch", stub({ lastPostAt: posted }));
    render(<Ticket id="t1" companies={[company]} />);
    await screen.findByText("Last activity");
    expect(screen.getByText("Last post")).toBeTruthy();
    expect(screen.getByText("12m ago")).toBeTruthy();
  });

  it("has nothing to show when no agent has posted", async () => {
    vi.stubGlobal("fetch", stub({ lastPostAt: null }));
    render(<Ticket id="t1" companies={[company]} />);
    await screen.findByText("Last activity");
    expect(screen.queryByText(/Last post/)).toBeNull();
  });
});
describe("the collapsible Work panel", () => {
  it("hides and shows the panel, and remembers the choice on this device", async () => {
    localStorage.clear();
    vi.stubGlobal("fetch", stub({}));
    vi.stubGlobal("innerWidth", 1440);
    const first = render(<Ticket id="t1" companies={[company]} />);
    const hide = await screen.findByRole("button", { name: "Hide" });
    expect(first.container.querySelector("#ticket-props-body")!.hasAttribute("hidden")).toBe(false);
    fireEvent.click(hide);
    expect(first.container.querySelector(".ticket-layout")!.classList.contains("props-collapsed")).toBe(true);
    expect(first.container.querySelector("#ticket-props-body")!.hasAttribute("hidden")).toBe(true);
    expect(first.container.querySelector("#ticket-props-body")!.contains(screen.getByText("Last activity"))).toBe(true);
    first.unmount();
    const second = render(<Ticket id="t1" companies={[company]} />);
    fireEvent.click(await screen.findByRole("button", { name: "Show" }));
    expect(second.container.querySelector("#ticket-props-body")!.hasAttribute("hidden")).toBe(false);
    expect(localStorage.getItem("bossman.ticket.workCollapsed")).toBe("0");
  });

  it("starts collapsed on a narrow tablet with no saved choice, expanded on desktop", async () => {
    localStorage.clear();
    vi.stubGlobal("fetch", stub({}));
    vi.stubGlobal("innerWidth", 1000);
    const tablet = render(<Ticket id="t1" companies={[company]} />);
    await screen.findByRole("button", { name: "Show" });
    tablet.unmount();
    vi.stubGlobal("innerWidth", 1440);
    render(<Ticket id="t1" companies={[company]} />);
    await screen.findByRole("button", { name: "Hide" });
  });

  it("starts collapsed on a phone, with the status and assignee on the one-line heading (BOS-245)", async () => {
    localStorage.clear();
    vi.stubGlobal("fetch", stub({ assignee: "Bungle" }));
    vi.stubGlobal("innerWidth", 390);
    const { container } = render(<Ticket id="t1" companies={[company]} />);
    await screen.findByRole("button", { name: "Show" });
    expect(container.querySelector("#ticket-props-body")!.hasAttribute("hidden")).toBe(true);
    expect(screen.getByText("· In review · Bungle")).toBeTruthy();
  });

  it("still remembers the owner's own choice on a phone, so an opened panel stays open", async () => {
    localStorage.setItem("bossman.ticket.workCollapsed", "0");
    vi.stubGlobal("fetch", stub({}));
    vi.stubGlobal("innerWidth", 390);
    const { container } = render(<Ticket id="t1" companies={[company]} />);
    await screen.findByRole("button", { name: "Hide" });
    expect(container.querySelector("#ticket-props-body")!.hasAttribute("hidden")).toBe(false);
    expect(screen.queryByText(/^· In review/)).toBeNull();
  });

  // jsdom has no layout, and Ticket is not exported as a DOM-tree helper, so assert the phone rules
  // that decide the order: the review and the conversation come before the description, the Work
  // panel goes last. A later rule that quietly inverts them fails here too (BOS-246 review).
  it("on a phone, the review and the conversation are ordered above the description and the Work panel", () => {
    const phones = [...styles.matchAll(/@media \(max-width: 640px\)\s*\{/g)].map((m) => {
      let depth = 1;
      let i = (m.index ?? 0) + m[0].length;
      const start = i;
      for (; i < styles.length && depth > 0; i++) depth += styles[i] === "{" ? 1 : styles[i] === "}" ? -1 : 0;
      return styles.slice(start, i - 1);
    });
    const order = (selector: string): number => {
      const rule = new RegExp(`(?:^|[;{])\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[^{]*\\{[^}]*\\border:\\s*(-?\\d+)`, "m");
      let value = 0;
      for (const block of phones) {
        const found = rule.exec(block);
        if (found) value = Number(found[1]);
      }
      return value;
    };
    const review = order(".ticket-main > .review-card");
    const activity = order(".ticket-main > .activity");
    const desc = order(".ticket-main > section.card");
    const work = order(".ticket-props");
    expect(review).toBeLessThan(activity);
    expect(activity).toBeLessThan(desc);
    expect(desc).toBeLessThan(work);
  });
});
