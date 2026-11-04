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

describe("ticket conversation: who to ask", () => {
  const agent = (id: string, name: string, role: "ceo" | "worker") => ({ id, companyId: "c1", name, role, agentKind: "claude", model: null, fundingSourceId: null, paused: false, starred: false, duty: null });

  it("defaults to the agent working on it, and can ask the CEO instead", async () => {
    const posts: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (init?.method === "POST") return posts.push(JSON.parse(String(init.body))), json({}, 201);
        if (url.includes("/messages")) return json({ live: null, items: [msg({ author: "owner", agent: "CEO", text: "Worth it?" })] });
        return json([]);
      }),
    );
    render(<TicketActivity ticketId="t1" assignee="Engineer" assigneeId="a2" agents={[agent("a1", "CEO", "ceo"), agent("a2", "Engineer", "worker")]} />);
    expect(await screen.findByText(/^You to CEO/)).toBeTruthy();
    const to = screen.getByLabelText("To") as HTMLSelectElement;
    expect([...to.options].map((o) => o.text)).toEqual(["Engineer (working on it)", "CEO"]);
    const box = screen.getByLabelText("Message to the agent");
    fireEvent.change(box, { target: { value: "Fix it" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(posts).toEqual([{ text: "Fix it", interrupt: false }]));

    fireEvent.change(to, { target: { value: "a1" } });
    expect(box.getAttribute("placeholder")).toBe("Ask CEO about this task. Engineer carries on undisturbed.");
    fireEvent.change(box, { target: { value: "Is this worth doing?" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(posts.at(-1)).toEqual({ text: "Is this worth doing?", interrupt: false, agentId: "a1" }));
  });
});

describe("ticket activity: where reviews fell", () => {
  it("puts a line in the feed when a round went to review and when each review was decided, in time order", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/messages")) return json({ live: null, items: [msg({ text: "Both tools check out.", createdAt: "2026-10-21T14:30:00Z" })] });
        if (url.includes("/runs") && url.includes("/tickets/")) return json([{ id: "r2", agent: "Researcher", startedAt: "2026-10-21T14:27:00Z", endedAt: "2026-10-21T14:29:00Z", outcome: "end_turn" }]);
        return json([]);
      }),
    );
    const review = (round: number, status: string, createdAt: string, decidedAt: string | null, notes: string | null) => ({ id: `v${round}`, kind: "code", round, seq: 0, status, reviewer: "CEO", notes, overruleReason: null, createdAt, decidedAt });
    const reviews = [review(2, "approved", "2026-10-21T14:31:00Z", "2026-10-21T14:35:00Z", null), review(1, "changes_requested", "2026-10-21T14:20:00Z", "2026-10-21T14:26:00Z", "Review from CEO (CEO): changes requested.\n\nCrawl4ai is still untested.")];
    const { container } = render(<TicketActivity ticketId="t1" assignee="Researcher" reviews={reviews} />);
    await screen.findByText("Both tools check out.");
    const marks = [...container.querySelectorAll(".activity-mark")].map((e) => e.textContent!.split(" · ")[0]);
    expect(marks).toEqual([
      "Sent for review, round 1: code review by CEO",
      "CEO, code review round 1: Changes requested. Crawl4ai is still untested.",
      "Sent for review, round 2: code review by CEO",
      "CEO, code review round 2: Approved",
    ]);
    // The rework run sits between the round 1 verdict and round 2.
    const order = [...container.querySelectorAll(".activity-mark, .run-block")].map((e) => (e.classList.contains("run-block") ? "run" : "mark"));
    expect(order).toEqual(["mark", "mark", "run", "mark", "mark"]);
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
        if (url.endsWith("/artifacts") || url.endsWith("/reviews") || url.includes("/runs") || url.includes("risk") || url.includes("objectives")) return json([]);
        if (url.includes("/messages")) return json({ live: null, items: [] });
        return json({});
      }),
    );
    render(<Ticket id="t1" companies={[company]} />);
    fireEvent.click(await screen.findByRole("button", { name: "Approve and merge" }));
    expect(await screen.findByText(/Approved\. Running the pre-merge check \(pnpm test\); this can take several minutes\. Elapsed: 0:0\d/)).toBeTruthy();
    // While the merge runs the card says so, and no button invites a second approval.
    expect(await screen.findByText(/Checking and merging\./)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Approve and merge" })).toBeNull();
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
        if (url.endsWith("/artifacts") || url.endsWith("/reviews") || url.includes("/runs") || url.includes("risk") || url.includes("objectives")) return json([]);
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
        if (url.endsWith("/artifacts") || url.endsWith("/reviews") || url.includes("/runs") || url.includes("risk") || url.includes("objectives")) return json([]);
        return json({});
      }),
    );
    render(<Ticket id="t1" companies={[{ id: "c1", name: "App Co", mission: null, paused: false, agents: [] }]} />);
    expect(await screen.findByText("Not rated yet — the CEO rates it when it reviews the task (treated as medium until then).")).toBeTruthy();
  });
});

describe("task page", () => {
  const long = Array.from({ length: 12 }, (_, i) => `Line ${i + 1}`).join("\n\n");
  function stub(extra: Record<string, unknown>) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === "/api/tickets/t1") return json({ id: "t1", title: "Add limiter", systemState: "review", risk: "low", projectId: "p1", project: "App", companyId: "c1", assignee: null, createdAt: "2026-10-19T09:00:00Z", lastActivityAt: "2026-10-19T09:00:00Z", ...extra });
        if (url.includes("/links")) return json({ waitsOn: [], blocks: [], blockedBy: [] });
        if (url.includes("/features")) return json({ features: [] });
        if (url.includes("/messages")) return json({ live: null, items: [] });
        if (url.endsWith("/artifacts") || url.endsWith("/reviews") || url.includes("/runs") || url.includes("risk") || url.includes("objectives")) return json([]);
        return json({});
      }),
    );
    render(<Ticket id="t1" companies={[{ id: "c1", name: "App Co", mission: null, paused: false, agents: [] }]} />);
  }

  it("collapses a long description to its first lines, and opens it", async () => {
    stub({ body: long });
    const toggle = await screen.findByRole("button", { name: /Description/ });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(document.getElementById("desc-body")!.className).toBe("clamp-8");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(document.getElementById("desc-body")!.className).toBe("");
  });

  it("counts code changes in What it produced", async () => {
    stub({ body: "Short.", repoUrl: "https://x/y.git", branch: "boss-man/t1" });
    expect(await screen.findByText("code on its branch")).toBeTruthy();
    expect(screen.queryByText(/Nothing yet\. Documents agents write/)).toBeNull();
    expect(screen.queryByRole("button", { name: /Description/ })).toBeNull();
  });
});

describe("owner moves the status", () => {
  const company: Company = { id: "c1", name: "App Co", mission: null, paused: false, agents: [] };
  it("posts the chosen state, and asks first before Done", async () => {
    const posts: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === "/api/tickets/t1/state" && init?.method === "POST") return posts.push(JSON.parse(String(init.body))), json({});
        if (url === "/api/tickets/t1") return json({ id: "t1", title: "Docs", systemState: "in_progress", risk: "low", projectId: "p1", project: "App", companyId: "c1", assignee: "Engineer", createdAt: "2026-10-19T09:00:00Z", lastActivityAt: "2026-10-19T09:00:00Z" });
        if (url.includes("/links")) return json({ waitsOn: [], blocks: [], blockedBy: [] });
        if (url.includes("/features")) return json({ features: [] });
        if (url.endsWith("/artifacts") || url.endsWith("/reviews") || url.includes("/runs") || url.includes("risk") || url.includes("objectives")) return json([]);
        if (url.includes("/messages")) return json({ live: null, items: [] });
        return json({});
      }),
    );
    const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValue(true);
    render(<Ticket id="t1" companies={[company]} />);
    const pick = await screen.findByLabelText("Change status");
    fireEvent.change(pick, { target: { value: "done" } });
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("without merging"));
    expect(posts).toEqual([]);
    fireEvent.change(pick, { target: { value: "done" } });
    await waitFor(() => expect(posts).toEqual([{ state: "done" }]));
    fireEvent.change(pick, { target: { value: "review" } });
    await waitFor(() => expect(posts.at(-1)).toEqual({ state: "review" }));
  });
});

describe("review card during a merge", () => {
  const company: Company = { id: "c1", name: "App Co", mission: null, paused: false, agents: [] };
  const ticket = { id: "t1", title: "Add limiter", systemState: "review", risk: "medium", repoUrl: "https://x/y.git", defaultBranch: "main", landing: "merge", projectId: "p1", project: "App", companyId: "c1", assignee: "Engineer", createdAt: "2026-10-19T09:00:00Z", lastActivityAt: new Date().toISOString() };

  function stub(landing: () => unknown, onReview?: () => Response) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === "/api/tickets/t1/landing") return json({ landing: landing() });
        if (url === "/api/tickets/t1/review" && init?.method === "POST" && onReview) return onReview();
        if (url === "/api/tickets/t1") return json(ticket);
        if (url.includes("/links")) return json({ waitsOn: [], blocks: [], blockedBy: [] });
        if (url.includes("/features")) return json({ features: [] });
        if (url.endsWith("/artifacts") || url.endsWith("/reviews") || url.includes("/runs") || url.includes("risk") || url.includes("objectives")) return json([]);
        if (url.includes("/messages")) return json({ live: null, items: [] });
        return json({});
      }),
    );
  }

  it("on load, a merge already running shows in the card instead of 'waiting for you'", async () => {
    const startedAt = new Date(Date.now() - 6 * 60_000).toISOString();
    stub(() => ({ state: "running", startedAt, command: "pnpm test", startedBy: "the owner" }));
    render(<Ticket id="t1" companies={[company]} />);
    expect(await screen.findByText(/Checking and merging\./)).toBeTruthy();
    expect(screen.getByText(/Started by the owner at/)).toBeTruthy();
    expect(screen.getByText("checking and merging")).toBeTruthy();
    expect(screen.queryByText("waiting for you")).toBeNull();
    expect(screen.queryByRole("button", { name: "Approve and merge" })).toBeNull();
  });

  it("shows a merge started by the last reviewer, waiting for its check or the lock, with no approval buttons", async () => {
    const startedAt = new Date(Date.now() - 11 * 60_000).toISOString();
    // A reviewer's approval starts the merge; no command yet means it may be waiting for the shared lock.
    stub(() => ({ state: "running", startedAt, command: null, startedBy: "Senior Developer (Senior Developer)" }));
    render(<Ticket id="t1" companies={[company]} />);
    expect(await screen.findByText(/Checking and merging\./)).toBeTruthy();
    expect(screen.getByText(/Started by Senior Developer \(Senior Developer\) at/)).toBeTruthy();
    expect(screen.getByText("checking and merging")).toBeTruthy();
    expect(screen.queryByText("waiting for you")).toBeNull();
    expect(screen.queryByRole("button", { name: "Approve and merge" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Request changes" })).toBeNull();
  });

  it("turns the server's 'already being checked' refusal into a neutral notice and shows the check", async () => {
    let started = false;
    const startedAt = new Date().toISOString();
    stub(
      () => (started ? { state: "running", startedAt, command: "pnpm test", startedBy: "the owner" } : null),
      () => {
        started = true;
        return json({ error: "review", message: "This ticket is already being checked and merged." }, 409);
      },
    );
    render(<Ticket id="t1" companies={[company]} />);
    fireEvent.click(await screen.findByRole("button", { name: "Approve and merge" }));
    expect(await screen.findByText(/Already being checked and merged since .*nothing more to do\./)).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(await screen.findByText(/Checking and merging\./)).toBeTruthy();
  });

  it("sends only one review request when the button is double-clicked", async () => {
    let posts = 0;
    stub(
      () => null,
      () => {
        posts++;
        return json({ verdict: "approved", outcome: "landing", landing: { state: "running", startedAt: new Date().toISOString(), command: "pnpm test", startedBy: "the owner" } }, 202);
      },
    );
    render(<Ticket id="t1" companies={[company]} />);
    const approve = await screen.findByRole("button", { name: "Approve and merge" });
    fireEvent.click(approve);
    fireEvent.click(approve);
    await screen.findByText(/Checking and merging\./);
    await waitFor(() => expect(posts).toBe(1));
  });

  it("when the in-progress marker is stale, says so and lets the owner try again", async () => {
    const startedAt = new Date(Date.now() - 60 * 60_000).toISOString();
    stub(() => ({ state: "running", startedAt, command: "pnpm test", startedBy: "Ada (CEO)", stale: true }));
    render(<Ticket id="t1" companies={[company]} />);
    expect(await screen.findByText(/The merge check looks stuck\./)).toBeTruthy();
    expect(screen.getByText("the merge check looks stuck; you can try again")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Approve and merge" }) as HTMLButtonElement).disabled).toBe(false);
  });
});

describe("typing on a phone (BOS-245)", () => {
  // jsdom has no matchMedia; a coarse pointer is what a phone reports.
  const coarse = (matches: boolean) =>
    vi.stubGlobal("matchMedia", (q: string) => ({ matches, media: q, addEventListener: () => {}, removeEventListener: () => {} }));

  it("Return adds a line in the ticket reply box instead of sending, and the hint drops Shift+Enter", async () => {
    const posts: unknown[] = [];
    coarse(true);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (init?.method === "POST") return posts.push(JSON.parse(String(init.body))), json({}, 201);
        if (url.includes("/messages")) return json({ live: null, items: [] });
        return json([]);
      }),
    );
    render(<TicketActivity ticketId="t1" assignee="Engineer" />);
    const box = (await screen.findByLabelText("Message to the agent")) as HTMLTextAreaElement;
    expect(box.getAttribute("placeholder")).toBe("Message Engineer");
    expect(box.getAttribute("enterKeyHint")).toBe("newline");
    fireEvent.change(box, { target: { value: "line one" } });
    fireEvent.keyDown(box, { key: "Enter" });
    await new Promise((r) => setTimeout(r, 50));
    expect(posts).toEqual([]);
  });

  it("on a desktop, Return still sends, so the quick reply stays quick", async () => {
    const posts: unknown[] = [];
    coarse(false);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (init?.method === "POST") return posts.push(JSON.parse(String(init.body))), json({}, 201);
        if (url.includes("/messages")) return json({ live: null, items: [] });
        return json([]);
      }),
    );
    render(<TicketActivity ticketId="t1" assignee="Engineer" />);
    const box = (await screen.findByLabelText("Message to the agent")) as HTMLTextAreaElement;
    expect(box.getAttribute("placeholder")).toBe("Message Engineer. Enter sends, Shift+Enter adds a line.");
    fireEvent.change(box, { target: { value: "quick reply" } });
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() => expect(posts).toEqual([{ text: "quick reply", interrupt: false }]));
  });
});
