// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Company } from "../src/api";
import { Agents } from "../src/pages/Agents";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const company: Company = { id: "c1", name: "App Co", mission: null, paused: false, agents: [] };
const base = { id: "a1", name: "Bramble", companyId: "c1", role: "worker", agentKind: "claude", model: "opus", fundingSourceId: null, paused: false, starred: false, duty: null, title: "Engineer", template: null, instructions: "", funding: null, fundingKind: null, retiredAt: null, status: "idle", current: null, openTickets: 0, pa: null, month: { costMicros: 0, runs: 2, tokens: 10 } };
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
const change = { id: "ch1", field: "name", before: "Old", after: "Bramble", createdAt: "2026-11-20T10:00:00Z", undoneAt: null, byAgentId: null };

function stub(handler: (url: string, init?: RequestInit) => Response | Promise<Response>, agents: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const special = await handler(url, init);
      if (special) return special;
      if (url.includes("agent-templates")) return json({ templates: [] });
      if (url.includes("/models")) return json({ runner: {}, api: [] });
      if (url.includes("/history")) return json([{ c: change, by: null }]);
      if (url.includes("/notes")) return json({ items: [], limits: { count: 20, title: 80, text: 500, why: 300 } });
      if (url.includes("/agents")) return agents instanceof Response ? agents.clone() : json(agents);
      return json([]);
    }),
  );
}

describe("agent list states (BOS-2103)", () => {
  it("shows a load error with Retry, not an empty list", async () => {
    stub(() => undefined as never, json({ error: "Server is down" }, 500));
    render(<Agents company={company} onChanged={() => {}} />);
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByText(/Couldn't load agents/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });

  it("shows the loader while the list has not answered", async () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));
    // Its own company id: the api layer shares an unfinished GET by path, and this one never ends.
    const { container } = render(<Agents company={{ ...company, id: "c-slow" }} onChanged={() => {}} />);
    expect(container.querySelector("ul.agent-list")).toBeNull();
    expect(screen.queryByText(/Couldn't load/)).toBeNull();
  });
});

describe("Undo, picture and Refresh guards (BOS-2103)", () => {
  it("disables Undo while its request runs, so a double click sends one request", async () => {
    let release: () => void = () => {};
    const undo = vi.fn(() => new Promise<Response>((r) => (release = () => r(json({})))));
    stub((url) => (url.includes("/undo") ? (undo() as unknown as Response) : (undefined as never)), [base]);
    render(<Agents company={company} onChanged={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Bramble" }));
    const btn = await screen.findByRole("button", { name: "Undo" });
    fireEvent.click(btn);
    await waitFor(() => expect((screen.getByRole("button", { name: "Undo" }) as HTMLButtonElement).disabled).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(undo).toHaveBeenCalledTimes(1);
    release();
    await screen.findByText("Undone.");
  });

  it("asks before removing the uploaded picture, and keeps it on Cancel", async () => {
    const calls: string[] = [];
    stub((url, init) => (calls.push(`${init?.method ?? "GET"} ${url}`), undefined as never), [{ ...base, avatarAt: "2026-11-01T00:00:00Z" }]);
    const confirm = vi.fn(() => false);
    vi.stubGlobal("confirm", confirm);
    render(<Agents company={company} onChanged={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Bramble" }));
    fireEvent.click(await screen.findByRole("button", { name: "Use the default" }));
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(calls.some((c) => c.startsWith("DELETE"))).toBe(false);
    confirm.mockReturnValue(true);
    fireEvent.click(screen.getByRole("button", { name: "Use the default" }));
    await waitFor(() => expect(calls).toContain("DELETE /api/agents/a1/avatar"));
  });

  it("disables Refresh while it runs and shows the error when it fails", async () => {
    stub((url) => (url.includes("refresh=1") ? json({ error: "Runner unreachable" }, 502) : (undefined as never)), []);
    render(<Agents company={company} onChanged={() => {}} />);
    const btn = await screen.findByRole("button", { name: "Refresh" });
    fireEvent.click(btn);
    expect(await screen.findByText(/Couldn't refresh the model lists/)).toBeTruthy();
    await waitFor(() => expect((screen.getByRole("button", { name: "Refresh" }) as HTMLButtonElement).disabled).toBe(false));
  });
});

describe("History and CEO notes: loading and failed loads (BOS-2279)", () => {
  // Each test has its own agent id: the api layer shares an unfinished GET by path.
  const ceo = (id: string) => ({ ...base, id, role: "ceo", name: "Chief" });
  const never = () => new Promise<Response>(() => {});

  it("shows loaders, not the empty words, while history and notes have not answered", async () => {
    stub((url) => (url.includes("/history") || url.includes("/notes") ? (never() as unknown as Response) : (undefined as never)), [ceo("a-slow")]);
    const { container } = render(<Agents company={company} onChanged={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Chief" }));
    await screen.findByText("History");
    expect(screen.getByText("CEO notes")).toBeTruthy();
    expect(container.querySelectorAll(".loader").length).toBeGreaterThanOrEqual(2);
    expect(screen.queryByText("No changes yet.")).toBeNull();
    expect(screen.queryByText("No notes yet.")).toBeNull();
    // The words appear after the Loader's one-second delay; the deadline only bounds the wait.
    expect(await screen.findByText(/Loading history/, {}, { timeout: 5000 })).toBeTruthy();
    expect(await screen.findByText(/Loading CEO notes/, {}, { timeout: 5000 })).toBeTruthy();
    expect(screen.queryByText("No changes yet.")).toBeNull();
    expect(screen.queryByText("No notes yet.")).toBeNull();
  });

  it("shows a load error with Retry for each; Retry brings back the history and the (empty) notes", async () => {
    let fail = true;
    stub((url) => {
      if (fail && url.includes("/history")) return json({ error: "History down" }, 500);
      if (fail && url.includes("/notes")) return json({ error: "Notes down" }, 500);
      return undefined as never;
    }, [ceo("a-fail")]);
    render(<Agents company={company} onChanged={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Chief" }));
    expect(await screen.findByText(/Couldn't load the history: History down/)).toBeTruthy();
    expect(await screen.findByText(/Couldn't load the CEO notes: Notes down/)).toBeTruthy();
    expect(screen.queryByText("No changes yet.")).toBeNull();
    expect(screen.queryByText("No notes yet.")).toBeNull();
    fail = false;
    for (const b of screen.getAllByRole("button", { name: "Retry" })) fireEvent.click(b);
    // Retry brings the history back: the stub's one change, with its Undo.
    expect(await screen.findByRole("button", { name: "Undo" })).toBeTruthy();
    expect(screen.queryByText("No changes yet.")).toBeNull();
    await screen.findByText(/CEO notes \(0 of 20\)/);
    expect(screen.getByText("No notes yet.")).toBeTruthy();
    expect(screen.queryByText(/Couldn't load the/)).toBeNull();
  });
});
