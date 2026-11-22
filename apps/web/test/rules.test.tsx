// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Company } from "../src/api";
import { Rules, expiryOf } from "../src/pages/Rules";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const company: Company = { id: "c1", name: "App Co", mission: null, paused: false, agents: [] };

describe("decision rules", () => {
  // BOS-2236: before the list arrives, or when it fails, the page must not pass for "no rules".
  it("shows Loading, not 'None yet.', and no add controls while the rules are on their way", async () => {
    let release: (r: Response) => void = () => {};
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => { release = resolve; })));
    render(<Rules companies={[company]} companyId="c1" go={() => {}} />);
    expect(screen.getByText("Loading…")).toBeTruthy();
    expect(screen.queryByText("None yet.")).toBeNull();
    expect(screen.queryByText("Add a rule")).toBeNull();
    expect(screen.queryByRole("checkbox")).toBeNull();
    // Let the request finish so it does not hold the page's request line for later tests.
    release(new Response(JSON.stringify({ company: [], global: [], defaults: [] }), { status: 200 }));
    await screen.findByText("None yet.");
  });

  it("shows an error with Retry on a failed load, then the list once Retry works", async () => {
    let ok = false;
    vi.stubGlobal("fetch", vi.fn(async () => (ok ? new Response(JSON.stringify({ company: [], global: [], defaults: [] }), { status: 200 }) : new Response(JSON.stringify({ error: "Boom" }), { status: 500 }))));
    render(<Rules companies={[company]} companyId="c1" go={() => {}} />);
    const retry = await screen.findByRole("button", { name: /retry/i });
    expect(screen.queryByText("None yet.")).toBeNull();
    expect(screen.queryByText("Add a rule")).toBeNull();
    ok = true;
    fireEvent.click(retry);
    await waitFor(() => expect(screen.getByText("None yet.")).toBeTruthy());
    expect(screen.getByText("Add a rule")).toBeTruthy();
  });

  it("asks the CEO in plain words, with the manual form folded away", async () => {
    const fetch = vi.fn(async (url: string) => new Response(JSON.stringify(url.includes("rule-requests") ? { ceo: { name: "Ada" } } : { company: [], global: [], defaults: [] }), { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    render(<Rules companies={[company]} companyId="c1" go={() => {}} />);
    await screen.findByText("Add a rule");

    const advanced = screen.getByText("Advanced: write the rule yourself").closest("details")!;
    expect(advanced.open).toBe(false);

    fireEvent.change(screen.getByLabelText("What should this rule do?"), { target: { value: "Let agents read GitHub freely" } });
    fireEvent.click(screen.getByRole("button", { name: "Ask the CEO to draft it" }));
    await waitFor(() => expect(screen.getByText("Sent to Ada. Their proposal will appear in your Decisions queue.")).toBeTruthy());
    expect(fetch).toHaveBeenCalledWith("/api/companies/c1/rule-requests", expect.objectContaining({ method: "POST", body: JSON.stringify({ text: "Let agents read GitHub freely" }) }));
    expect((screen.getByLabelText("What should this rule do?") as HTMLTextAreaElement).value).toBe("");
  });

  // BOS-2154: a double-click must not make two requests or two rules.
  it("sends one request to the CEO and adds one rule when a button is double-clicked", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        await gate;
        return new Response(JSON.stringify({ ceo: { name: "Ada" } }), { status: 200 });
      }
      return new Response(JSON.stringify({ company: [], global: [], defaults: [] }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetch);
    render(<Rules companies={[company]} companyId="c1" go={() => {}} />);
    await screen.findByText("Add a rule");
    const posts = () => fetch.mock.calls.filter((c) => c[1]?.method === "POST").length;

    fireEvent.change(screen.getByLabelText("What should this rule do?"), { target: { value: "Let agents read GitHub" } });
    const ask = screen.getByRole("button", { name: "Ask the CEO to draft it" });
    fireEvent.click(ask);
    fireEvent.click(ask);
    expect(posts()).toBe(1);
    await waitFor(() => expect((ask as HTMLButtonElement).disabled).toBe(true));
    release();
    await waitFor(() => expect(screen.getByText(/Sent to Ada/)).toBeTruthy());

    fireEvent.change(screen.getByLabelText("New rule"), { target: { value: "Restarts" } });
    const add = screen.getByRole("button", { name: "Add rule" });
    fireEvent.click(add);
    fireEvent.click(add);
    expect(posts()).toBe(2);
    await waitFor(() => expect((add as HTMLButtonElement).disabled).toBe(false));
  });

  it("re-enables the buttons and shows the error when a submit fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => (init?.method === "POST" ? new Response(JSON.stringify({ error: "Nope" }), { status: 500 }) : new Response(JSON.stringify({ company: [], global: [], defaults: [] }), { status: 200 }))));
    render(<Rules companies={[company]} companyId="c1" go={() => {}} />);
    await screen.findByText("Add a rule");
    fireEvent.change(screen.getByLabelText("What should this rule do?"), { target: { value: "Something" } });
    const ask = screen.getByRole("button", { name: "Ask the CEO to draft it" }) as HTMLButtonElement;
    fireEvent.click(ask);
    await screen.findByRole("alert");
    await waitFor(() => expect(ask.disabled).toBe(false));
  });

  it("names the agents a rule is for, and falls back for an unknown id", async () => {
    const agent = (id: string, name: string) => ({ id, companyId: "c1", name, role: "worker" as const, agentKind: "claude", model: null, fundingSourceId: null, paused: false, starred: false, duty: null });
    const co: Company = { ...company, agents: [agent("a1", "Kit"), agent("a2", "Zippy")] };
    const rule = (id: string, agentIds: string[]) => ({ id, companyId: "c1", name: `Rule ${id}`, match: { agentIds }, outcome: "allow", position: 0 });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ company: [rule("r1", ["a1"]), rule("r2", ["a1", "a2"]), rule("r3", ["zz"])], global: [], defaults: [] }), { status: 200 })));
    render(<Rules companies={[co]} companyId="c1" go={() => {}} />);
    expect(await screen.findByText("When the request is from Kit")).toBeTruthy();
    expect(screen.getByText("When the request is from Kit or Zippy")).toBeTruthy();
    expect(screen.getByText("When the request is from one named agent")).toBeTruthy();
  });

  // BOS-2186: edit a rule in place.
  describe("editing a rule", () => {
    const mk = (id: string, name: string, extra = {}) => ({ id, companyId: "c1", name, match: { commandPattern: "^docker", safeOnly: true, ...extra }, outcome: "allow", position: 0, createdBy: "Kit", createdAt: "2026-11-01T10:00:00Z", sourceDecisionId: "d1" });
    const setup = (patchReply: () => Response) => {
      const fetch = vi.fn(async (_url: string, init?: RequestInit) => (init?.method === "PATCH" ? patchReply() : new Response(JSON.stringify({ company: [mk("r1", "First"), mk("r2", "Second")], global: [], defaults: [] }), { status: 200 })));
      vi.stubGlobal("fetch", fetch);
      render(<Rules companies={[company]} companyId="c1" go={() => {}} />);
      return fetch;
    };

    it("saves name, pattern and outcome in one PATCH, keeping the other match fields", async () => {
      const fetch = setup(() => new Response("{}", { status: 200 }));
      fireEvent.click(await screen.findByRole("button", { name: "Edit First" }));
      const form = within(screen.getByRole("form", { name: "Edit First" }));
      fireEvent.change(form.getByLabelText("Rule name"), { target: { value: "Docker only" } });
      fireEvent.change(form.getByLabelText("Command matches (regex)"), { target: { value: "^docker\\s+restart" } });
      fireEvent.change(form.getByLabelText("Then"), { target: { value: "owner" } });
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
      await waitFor(() => expect(screen.queryByRole("button", { name: "Save" })).toBeNull());
      const call = fetch.mock.calls.find((c) => c[1]?.method === "PATCH")!;
      expect(call[0]).toBe("/api/policy-rules/r1");
      expect(JSON.parse(call[1]!.body as string)).toEqual({ name: "Docker only", match: { safeOnly: true, commandPattern: "^docker\\s+restart" }, outcome: "owner" });
    });

    it("shows the server's refusal under the form and stays in edit mode", async () => {
      setup(() => new Response(JSON.stringify({ error: "rejected", message: "The command pattern is not a valid regular expression." }), { status: 422 }));
      fireEvent.click(await screen.findByRole("button", { name: "Edit First" }));
      fireEvent.change(within(screen.getByRole("form", { name: "Edit First" })).getByLabelText("Command matches (regex)"), { target: { value: "(" } });
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
      expect((await screen.findByRole("alert")).textContent).toContain("not a valid regular expression");
      expect(screen.getByRole("button", { name: "Save" })).toBeTruthy();
    });

    it("has one row in edit mode at a time, and Cancel puts the row back with its history", async () => {
      setup(() => new Response("{}", { status: 200 }));
      fireEvent.click(await screen.findByRole("button", { name: "Edit First" }));
      fireEvent.click(screen.getByRole("button", { name: "Edit Second" }));
      expect(screen.getAllByRole("button", { name: "Save" }).length).toBe(1);
      expect(screen.queryByRole("button", { name: "Edit First" })).not.toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      expect(screen.getAllByText(/Made by Kit/).length).toBe(2);
    });
  });

  // BOS-2188: timed rules.
  describe("timed rules", () => {
    const at = new Date("2026-11-22T10:00:00");
    it("words the end time: minutes, today, another day, expired", () => {
      expect(expiryOf(null, at)).toEqual({ expired: false, text: "" });
      expect(expiryOf(new Date("2026-11-22T10:45:00").toISOString(), at)).toEqual({ expired: false, text: "Expires in 45 min" });
      expect(expiryOf(new Date("2026-11-22T23:59:00").toISOString(), at)).toEqual({ expired: false, text: "Expires today at 23:59" });
      expect(expiryOf(new Date("2026-11-24T08:05:00").toISOString(), at).text).toBe("Expires on 24 Nov at 08:05");
      expect(expiryOf(new Date("2026-11-22T09:42:00").toISOString(), at)).toEqual({ expired: true, text: "Expired at 09:42" });
      // The very moment it ends it is already over.
      expect(expiryOf(at.toISOString(), at).expired).toBe(true);
    });

    it("shows an ended rule greyed with Delete and no Edit, and a running one with its end", async () => {
      const row = (id: string, name: string, expiresAt: string | null) => ({ id, companyId: "c1", name, match: { commandPattern: "^docker" }, outcome: "allow", position: 0, createdBy: "Kit", expiresAt });
      const soon = new Date(Date.now() + 30 * 60_000).toISOString();
      const past = new Date(Date.now() - 60 * 60_000).toISOString();
      vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ company: [row("r1", "Running", soon), row("r2", "Ended", past), row("r3", "Forever", null)], global: [], defaults: [] }), { status: 200 })));
      render(<Rules companies={[company]} companyId="c1" go={() => {}} />);
      await screen.findByText("Running");
      expect(screen.getByText(/Expires in \d+ min/)).toBeTruthy();
      expect(screen.getByText(/Expired (at|on) /).textContent).toContain("no longer matches");
      expect(screen.queryByRole("button", { name: "Edit Ended" })).toBeNull();
      expect(screen.getByRole("button", { name: "Edit Running" })).toBeTruthy();
      expect(screen.getByRole("button", { name: "Edit Forever" })).toBeTruthy();
      expect(screen.getAllByRole("button", { name: "Delete" })).toHaveLength(3);
    });

    it("Try a command can include the rule being typed, and sends it as a draft without saving", async () => {
      const fetch = vi.fn(async (url: string, _init?: RequestInit) => new Response(JSON.stringify(url.includes("/test") ? { outcome: "allow", rule: "Your draft rule" } : { company: [], global: [], defaults: [] }), { status: 200 }));
      vi.stubGlobal("fetch", fetch);
      render(<Rules companies={[company]} companyId="c1" go={() => {}} />);
      await screen.findByText("Add a rule");
      expect(screen.queryByLabelText(/Try it with the rule I'm typing/)).toBeNull();
      fireEvent.change(screen.getByLabelText("Command matches (regex)"), { target: { value: "^docker\\s+restart" } });
      fireEvent.click(screen.getByLabelText(/Try it with the rule I'm typing/));
      fireEvent.change(screen.getByLabelText("wants to run"), { target: { value: "docker restart web" } });
      fireEvent.click(screen.getByRole("button", { name: "Check" }));
      await screen.findByText(/decided by "Your draft rule"/);
      const call = fetch.mock.calls.find((c) => (c[0] as string).includes("/test")) as unknown as [string, { body: string }];
      expect(JSON.parse(call[1].body)).toMatchObject({ command: "docker restart web", draft: { match: { commandPattern: "^docker\\s+restart" }, outcome: "owner" } });
      expect(fetch.mock.calls.some((c) => (c[1] as RequestInit | undefined)?.method === "POST" && c[0] === "/api/policy-rules")).toBe(false);
    });
  });

  // BOS-786: the built-in defaults line must say the CEO is asked first, as the code does.
  it("says an unmatched request goes to the CEO first, and what comes straight to the owner", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => new Response(JSON.stringify(url.includes("rule-requests") ? { ceo: { name: "Ada" } } : { company: [], global: [], defaults: [] }), { status: 200 })));
    render(<Rules companies={[company]} companyId="c1" go={() => {}} />);
    const line = screen.getByText(/Checked last, and can't be changed\./);
    expect(line.textContent).toContain("A request nothing matches goes to the CEO first, and to you if the CEO does not settle it.");
    expect(line.textContent).toContain("Deletes, moves and requests that name a path come straight to you.");
    expect(line.textContent).not.toContain("goes to you.");
  });
});
