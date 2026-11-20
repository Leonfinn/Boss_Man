// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Company } from "../src/api";
import { Sidebar } from "../src/components/Sidebar";
import { LinkPanel } from "../src/pages/Feedback";
import { Features } from "../src/pages/Features";
import { SetupChecklist } from "../src/pages/Setup";
import { ProjectsPage } from "../src/pages/Settings";

// BOS-1971: create and save buttons are off while their request runs, so a double click makes one thing, and a failure shows a sentence.

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
/** A request the test finishes by hand, so the "while it runs" state can be looked at. */
const hold = () => {
  let release!: (r: Response) => void;
  const pending = new Promise<Response>((r) => (release = r));
  return { pending, release };
};

describe("Feedback: create and link", () => {
  it("a double click on 'Create … and link it' makes one feature and one link", async () => {
    const gate = hold();
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push(`${init?.method ?? "GET"} ${url}`);
        if (url.endsWith("/features")) return gate.pending;
        return json({});
      }),
    );
    render(<LinkPanel companyId="c1" noteId="n1" highlight="" features={[]} onLinked={() => {}} onClearHighlight={() => {}} />);
    fireEvent.change(screen.getByLabelText("Feature"), { target: { value: "Dark mode" } });
    const btn = screen.getByRole("button", { name: /Create\s+Dark mode\s+and link it/ }) as HTMLButtonElement;
    fireEvent.click(btn);
    fireEvent.click(btn);
    const busy = (await screen.findByRole("button", { name: /Creating…\s+Dark mode/ })) as HTMLButtonElement;
    expect(busy.disabled).toBe(true);
    await act(async () => gate.release(json({ id: "f1" }, 201)));
    await waitFor(() => expect(calls.some((c) => c.includes("/insights"))).toBe(true));
    expect(calls.filter((c) => c.startsWith("POST") && c.endsWith("/features"))).toHaveLength(1);
    expect(calls.filter((c) => c.includes("/insights"))).toHaveLength(1);
  });

  it("a failed create shows the error and gives the button back", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ error: "internal_error" }, 500)));
    render(<LinkPanel companyId="c1" noteId="n1" highlight="" features={[]} onLinked={() => {}} onClearHighlight={() => {}} />);
    fireEvent.change(screen.getByLabelText("Feature"), { target: { value: "Dark mode" } });
    fireEvent.click(screen.getByRole("button", { name: /Create\s+Dark mode/ }));
    await waitFor(() => expect(document.body.textContent).toMatch(/wrong|error|failed|try/i));
    expect((screen.getByRole("button", { name: /Create\s+Dark mode\s+and link it/ }) as HTMLButtonElement).disabled).toBe(false);
  });
});

describe("Features: Add criterion and Add area (BOS-2065)", () => {
  it("submitting twice posts once, and the button reads Adding… meanwhile", async () => {
    const gate = hold();
    const posts: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (init?.method === "POST") {
          posts.push(url);
          return gate.pending;
        }
        if (url.endsWith("/features")) return json({ settings: { demandWeight: 1, ceoTriage: false }, drivers: [], maxDemand: 0, features: [] });
        return json({ demandWeight: 1, ceoTriage: false, portalEnabled: true, portalToken: null, portalTitle: null, portalIntro: null, hasLogo: false, drivers: [], areas: [] });
      }),
    );
    const company: Company = { id: "c1", name: "App Co", mission: null, paused: false, agents: [], projects: [] };
    render(<Features companies={[company]} companyId="c1" featureId={undefined} go={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Criteria and areas" }));
    fireEvent.change(await screen.findByLabelText("New criterion"), { target: { value: "Revenue" } });
    const form = screen.getByLabelText("New criterion").closest("form")!;
    fireEvent.submit(form);
    fireEvent.submit(form);
    const btns = (await screen.findAllByRole("button", { name: "Adding…" })) as HTMLButtonElement[];
    expect(btns).toHaveLength(1);
    expect(btns[0]!.disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Add" }) as HTMLButtonElement).disabled).toBe(true);
    expect(posts).toHaveLength(1);
    await act(async () => gate.release(json({})));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Adding…" })).toBeNull());
  });
});

describe("Feature page: Priority 1 switch (BOS-2091)", () => {
  const row = { id: "f1", companyId: "c1", areaId: null, parentId: null, title: "Dark mode", description: null, status: "in_progress", effort: null, driverScores: {}, milestoneId: null, portalVisible: false, keepOffPortal: false, keepOffReason: null, publicSummary: null, publicTitle: null, showPublicly: false, priorityOne: false, createdAt: "2026-10-19T09:00:00Z", updatedAt: "2026-10-19T09:00:00Z", releasedAt: null, demand: 0, insightCount: 0, customerCount: 0, value: 0, demandPart: 0, priority: 0, tickets: { total: 0, done: 0, items: [] }, portal: { onPortal: false, reason: null } };
  const tk = (id: string, state: string) => ({ id, title: `Task ${id}`, state, outcome: null, assignee: null });
  function setup() {
    const gate = hold();
    const puts: Array<{ url: string; body: string }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (init?.method === "PUT") {
          puts.push({ url, body: String(init.body) });
          return gate.pending;
        }
        if (url.endsWith("/features")) return json({ settings: { demandWeight: 1, ceoTriage: false }, drivers: [], maxDemand: 0, features: [row] });
        if (url.startsWith("/api/features/")) return json({ feature: row, drivers: [], settings: { demandWeight: 1 }, maxDemand: 0, subfeatures: [], insights: [], tickets: [tk("a", "in_progress"), tk("b", "ready"), tk("c", "done")] });
        if (url.includes("/feedback-settings")) return json({ demandWeight: 1, ceoTriage: false, portalEnabled: true, portalToken: null, portalTitle: null, portalIntro: null, hasLogo: false, drivers: [], areas: [] });
        return json([]);
      }),
    );
    const company: Company = { id: "c1", name: "App Co", mission: null, paused: false, agents: [], projects: [] };
    render(<Features companies={[company]} companyId="c1" featureId="f1" go={() => {}} />);
    return { gate, puts };
  }

  it("asks first with the open-task count, and Cancel sends nothing", async () => {
    const { puts } = setup();
    const confirm = vi.fn(() => false);
    vi.stubGlobal("confirm", confirm);
    fireEvent.click(await screen.findByLabelText(/^Priority 1:/));
    expect(confirm).toHaveBeenCalledWith('Put all 2 open tasks of "Dark mode" first? They go ahead of other work and past the usage-limit hold.');
    expect(puts).toHaveLength(0);
  });

  it("on confirm sends once, is disabled while it runs, then says how many tasks moved", async () => {
    const { gate, puts } = setup();
    vi.stubGlobal("confirm", vi.fn(() => true));
    const box = (await screen.findByLabelText(/^Priority 1:/)) as HTMLInputElement;
    fireEvent.click(box);
    fireEvent.click(box);
    await waitFor(() => expect(box.disabled).toBe(true));
    expect(puts).toHaveLength(1);
    expect(puts[0]!.body).toBe(JSON.stringify({ on: true }));
    await act(async () => gate.release(json({ ok: true, priorityOne: true, tickets: 2 })));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Priority 1 on: 2 tasks marked to go first."));
    expect(box.disabled).toBe(false);
  });
});

describe("Sidebar: new company", () => {
  const company: Company = { id: "c1", name: "App Co", mission: null, paused: false, agents: [], projects: [] };
  const show = (onCreateCompany: (n: string) => Promise<void>) => {
    const noop = () => {};
    render(<Sidebar active="chat" companies={[company]} current={company} decisions={[]} unread={0} feedback={0} mergeWaiting={0} mergeStuck={0} notifications="unsupported" collapsed={false} narrow={false} onToggleCollapsed={noop} onPickCompany={noop} onCreateCompany={onCreateCompany} onEnableNotifications={noop} onLogout={noop} />);
    fireEvent.click(screen.getByRole("button", { name: /Switch company/ }));
    fireEvent.click(screen.getByRole("button", { name: "+ New company" }));
    fireEvent.change(screen.getByLabelText("New company name"), { target: { value: "Fresh Co" } });
  };

  it("submitting twice creates one company, and the button reads Creating… meanwhile", async () => {
    let release!: () => void;
    const create = vi.fn(() => new Promise<void>((r) => (release = r)));
    show(create);
    const form = screen.getByLabelText("New company name").closest("form")!;
    fireEvent.submit(form);
    fireEvent.submit(form);
    const btn = (await screen.findByRole("button", { name: "Creating…" })) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(create).toHaveBeenCalledTimes(1);
    await act(async () => release());
  });

  it("a failed create shows the message and the button comes back", async () => {
    show(async () => {
      throw new Error("A company with that name already exists.");
    });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    expect((await screen.findByRole("alert")).textContent).toContain("already exists");
    expect((screen.getByRole("button", { name: "Create" }) as HTMLButtonElement).disabled).toBe(false);
  });
});

describe("Projects: star and Unarchive", () => {
  const company: Company = { id: "c1", name: "App Co", mission: null, paused: false, agents: [] };
  const project = (id: string, name: string, extra: Record<string, unknown> = {}) => ({ id, companyId: "c1", name, repoUrl: null, defaultBranch: "main", landing: "merge", gitHost: null, gitApiBase: null, verifyCommand: null, deepVerifyCommand: null, ticketCostCapMicros: null, reviewPolicy: null, starred: false, createdAt: "", ...extra });

  it("a failed Unarchive shows a message; while it runs the button is off and says Saving…", async () => {
    const gate = hold();
    let fail = false;
    const patches: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === "/api/companies/c1/projects") return json([project("p1", "Old site", { archivedAt: "2026-01-01" })]);
        if (url.endsWith("/check-presets")) return json({ detected: [], standard: [], none: { id: "none", label: "Nothing", command: null, plain: "", needs: [] }, tools: null, error: null });
        if (url === "/api/projects/p1" && init?.method === "PATCH") {
          patches.push(String(init.body));
          return fail ? json({ error: "internal_error" }, 500) : gate.pending;
        }
        return json({});
      }),
    );
    render(<ProjectsPage companies={[company]} companyId="c1" go={() => {}} />);
    fireEvent.click(await screen.findByText(/Archived \(1\)/));
    const btn = screen.getByRole("button", { name: "Unarchive" }) as HTMLButtonElement;
    fireEvent.click(btn);
    fireEvent.click(btn);
    const busy = (await screen.findByRole("button", { name: "Saving…" })) as HTMLButtonElement;
    expect(busy.disabled).toBe(true);
    expect(patches).toHaveLength(1);
    fail = true;
    await act(async () => gate.release(json({ error: "internal_error" }, 500)));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Unarchive" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("the star button is off while its request runs and a failure shows a message", async () => {
    const gate = hold();
    const patches: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === "/api/companies/c1/projects") return json([project("p1", "Website")]);
        if (url.endsWith("/check-presets")) return json({ detected: [], standard: [], none: { id: "none", label: "Nothing", command: null, plain: "", needs: [] }, tools: null, error: null });
        if (url === "/api/projects/p1" && init?.method === "PATCH") {
          patches.push(String(init.body));
          return gate.pending;
        }
        return json({});
      }),
    );
    render(<ProjectsPage companies={[company]} companyId="c1" go={() => {}} />);
    const star = (await screen.findByRole("button", { name: "Star Website" })) as HTMLButtonElement;
    fireEvent.click(star);
    fireEvent.click(star);
    await waitFor(() => expect(star.disabled).toBe(true));
    expect(patches).toHaveLength(1);
    await act(async () => gate.release(json({ error: "internal_error" }, 500)));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(star.disabled).toBe(false);
  });
});

describe("Setup: Dismiss", () => {
  it("is off and reads Saving… while it runs; a failure shows a message", async () => {
    const gate = hold();
    const puts: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === "/api/setup-progress" && init?.method === "PUT") {
          puts.push(String(init.body));
          return gate.pending;
        }
        if (url === "/api/setup-progress") return json({ dismissed: false });
        if (url.endsWith("/setup-checklist")) return json([{ id: "a", label: "Add a project", done: false }, { id: "b", label: "Add an agent", done: true }]);
        return json({});
      }),
    );
    render(<SetupChecklist companyId="c1" go={() => {}} />);
    const dismiss = (await screen.findByRole("button", { name: "Dismiss" })) as HTMLButtonElement;
    fireEvent.click(dismiss);
    fireEvent.click(dismiss);
    const busy = (await screen.findByRole("button", { name: "Saving…" })) as HTMLButtonElement;
    expect(busy.disabled).toBe(true);
    expect(puts).toHaveLength(1);
    await act(async () => gate.release(json({ error: "internal_error" }, 500)));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Dismiss" }) as HTMLButtonElement).disabled).toBe(false);
  });
});
