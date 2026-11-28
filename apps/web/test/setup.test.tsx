// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Company } from "../src/api";
import { Setup, SetupChecklist } from "../src/pages/Setup";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const company: Company = { id: "c1", name: "App Co", mission: "x", paused: false, agents: [] };
const project = { id: "p1", companyId: "c1", name: "Site", repoUrl: "https://github.com/a/b.git", defaultBranch: "main", verifyCommand: null, deepVerifyCommand: null, landing: "merge", gitHost: "github" };

function mock(step: number) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const body = url === "/api/setup-progress" ? { dismissed: false, step, companyId: "c1" } : url.endsWith("/projects") ? [project] : url.endsWith("/setup-checklist") || url.endsWith("/grants") || url === "/api/secrets" ? [] : { standard: [], none: { id: "none", label: "Nothing", command: "", needs: [] }, detected: [], tools: null, error: null };
      return new Response(JSON.stringify(body), { status: 200 });
    }),
  );
}

describe("setup wizard checks", () => {
  it("keeps the check pickers off the project step", async () => {
    mock(1);
    render(<Setup companies={[company]} go={() => {}} onChanged={() => {}} />);
    expect(await screen.findByLabelText("Git repo")).toBeTruthy();
    expect(screen.queryByText("Before merging, Boss Man will")).toBeNull();
    expect(vi.mocked(fetch).mock.calls.some(([u]) => String(u).includes("check-presets"))).toBe(false);
  });

  it("offers them on their own step, without the repo fields", async () => {
    mock(5);
    render(<Setup companies={[company]} go={() => {}} onChanged={() => {}} />);
    expect(await screen.findByText("Before merging, Boss Man will")).toBeTruthy();
    expect(screen.getByText("For high-risk work, also")).toBeTruthy();
    expect(screen.queryByLabelText("Git repo")).toBeNull();
  });

  it("explains how to get a git token, for the project's host only", async () => {
    mock(4);
    render(<Setup companies={[company]} go={() => {}} onChanged={() => {}} />);
    const link = await screen.findByText("How do I get a token?");
    const details = link.closest("details")!;
    expect(details.open).toBe(false);
    fireEvent.click(link);
    details.open = true; // jsdom doesn't toggle <details> on summary click
    expect(screen.getByLabelText("GitHub token steps")).toBeTruthy();
    expect(screen.queryByLabelText("Gitea token steps")).toBeNull();
  });
});

describe("setup wizard: what will your team work on (BOS-2813)", () => {
  const docsProject = { ...project, repoUrl: null };
  function mockDocs(step: number, work?: "docs" | "code") {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const body = url === "/api/setup-progress" ? { dismissed: false, step, companyId: "c1", ...(work ? { work } : {}) } : url.endsWith("/projects") ? [docsProject] : [];
        return new Response(JSON.stringify(body), { status: 200 });
      }),
    );
  }

  it("defaults to Documents: no repo fields, no git-token or checks steps, 'Step 2 of 7'", async () => {
    mockDocs(1);
    render(<Setup companies={[company]} go={() => {}} onChanged={() => {}} />);
    expect(((await screen.findByLabelText("Documents, research and writing", { exact: false })) as HTMLInputElement).checked).toBe(true);
    expect(screen.queryByLabelText("Git repo")).toBeNull();
    expect(screen.queryByText(/A git token/)).toBeNull();
    expect(screen.queryByText(/Checks before merging/)).toBeNull();
    expect(screen.getByText(/Step 2 of 7/)).toBeTruthy();
  });

  it("Code shows the repo fields, saves the choice and brings the two steps back", async () => {
    mockDocs(1);
    render(<Setup companies={[company]} go={() => {}} onChanged={() => {}} />);
    fireEvent.click(await screen.findByLabelText("Code in a git repository", { exact: false }));
    expect(await screen.findByLabelText("Git repo")).toBeTruthy();
    expect(screen.getByText(/A git token/)).toBeTruthy();
    expect(screen.getByText(/Step 2 of 9/)).toBeTruthy();
    const put = vi.mocked(fetch).mock.calls.find(([u, i]) => u === "/api/setup-progress" && (i as RequestInit | undefined)?.method === "PUT");
    expect(JSON.parse(String((put![1] as RequestInit).body))).toEqual({ work: "code" });
  });

  it("goes from the runner and connect steps straight on to funding without the code steps", async () => {
    mockDocs(3);
    render(<Setup companies={[company]} go={() => {}} onChanged={() => {}} />);
    // The connect step is a closed list of equal rows, so no command or token box shows until a row is opened.
    await screen.findByRole("list", { name: "Ways to connect an agent" });
    // A team that has never used git sees none of these words on the connect step (criterion 5).
    const page = document.body.cloneNode(true) as HTMLElement;
    page.querySelectorAll("code").forEach((c) => c.remove()); // any command a provider's step names
    const wizardText = page.textContent ?? "";
    expect(wizardText).not.toMatch(/\b(repo|branch|merge|merging|token)\b/i);
    fireEvent.click(screen.getByText("Skip for now"));
    expect((await screen.findByRole("heading", { level: 1 })).textContent).toBe("What pays for the CEO");
  });
});

describe("setup wizard: connect and runner steps (BOS-1495, BOS-2815)", () => {
  const withCeo: Company = { ...company, agents: [{ id: "a1", name: "CEO", role: "ceo", fundingSourceId: null } as Company["agents"][number]] };

  /** The step 3 page answering every write with an id, as the server would. */
  const stubConnect = (calls: Array<{ url: string; method: string; body: unknown }>, extra: (url: string, method: string) => unknown = () => undefined) =>
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const method = init?.method ?? "GET";
        calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : null });
        const body =
          extra(url, method) ??
          (url === "/api/setup-progress" ? { dismissed: false, step: 3, companyId: "c1" }
          : url === "/api/secrets" && method === "POST" ? { secret: { id: "s1" }, warnings: [] }
          : url === "/api/funding-sources" && method === "POST" ? { id: "f1" }
          : url.endsWith("/setup-checklist") || url.endsWith("/grants") || url === "/api/secrets" || url === "/api/funding-sources" ? []
          : {});
        return new Response(JSON.stringify(body), { status: 200 });
      }),
    );

  it("saves the setup token, makes the funding source and points the CEO at it", async () => {
    const calls: Array<{ url: string; method: string; body: unknown }> = [];
    stubConnect(calls);
    render(<Setup companies={[withCeo]} go={() => {}} onChanged={() => {}} />);
    // One row per way to pay; the setup-token row opens its own steps, and nothing else is open.
    await screen.findByRole("list", { name: "Ways to connect an agent" });
    expect(screen.queryByLabelText("The setup token")).toBeNull();
    fireEvent.click(screen.getByText("Claude Pro or Max plan"));
    const box = await screen.findByLabelText("The setup token");
    fireEvent.change(box, { target: { value: "sk-ant-oat01-made-up" } });
    fireEvent.click(screen.getByText("Save and connect"));
    await screen.findByText(/stored encrypted/);
    const mine = calls.filter((c) => c.method !== "GET" && c.url !== "/api/setup-progress");
    expect(mine.map((c) => `${c.method} ${c.url}`)).toEqual(["POST /api/secrets", "POST /api/secrets/s1/grants", "POST /api/funding-sources", "PATCH /api/agents/a1"]);
    expect(mine[0]!.body).toMatchObject({ kind: "claude_oauth_token" });
    expect(mine[1]!.body).toMatchObject({ envName: "CLAUDE_CODE_OAUTH_TOKEN" });
    expect(mine[2]!.body).toMatchObject({ kind: "subscription", provider: "anthropic", secretId: "s1" });
    expect(mine[3]!.body).toEqual({ fundingSourceId: "f1" });
  });

  const allDone = ["company", "project", "runner", "credential", "git", "checks", "funding", "ticket"].map((id) => ({ id, label: id, done: true }));

  it("leaves a company that is already set up alone: connected, no writes, funding step still done", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push(`${init?.method ?? "GET"} ${url}`);
        const body =
          url === "/api/setup-progress" ? { dismissed: false, step: 3, companyId: "c1" }
          : url.endsWith("/grants") ? [{ id: "g1", envName: "CLAUDE_CODE_OAUTH_TOKEN", secretId: "s1", secretName: "App Co Claude setup-token", hint: null, deployTargetId: null, agentIds: [] }]
          : url.endsWith("/setup-checklist") ? allDone
          : [];
        return new Response(JSON.stringify(body), { status: 200 });
      }),
    );
    const funded: Company = { ...company, agents: [{ id: "a1", name: "CEO", role: "ceo", fundingSourceId: "f1" } as Company["agents"][number]] };
    render(<Setup companies={[funded]} go={() => {}} onChanged={() => {}} />);
    expect(await screen.findByText("Connected")).toBeTruthy();
    expect(screen.queryByLabelText("The setup token")).toBeNull();
    expect(screen.getByText("What pays for the CEO").closest("li")!.className).toBe("done");
    expect(calls.filter((c) => !c.startsWith("GET") && !c.startsWith("PUT /api/setup-progress"))).toEqual([]);
  });

  it("skips 'What pays for the CEO' going forward once the token is saved", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const method = init?.method ?? "GET";
        const body =
          url === "/api/setup-progress" ? { dismissed: false, step: 3, companyId: "c1" }
          : url === "/api/secrets" && method === "POST" ? { secret: { id: "s1" }, warnings: [] }
          : url === "/api/funding-sources" && method === "POST" ? { id: "f1" }
          : url.endsWith("/setup-checklist") ? allDone
          : url.endsWith("/projects") ? [project]
          : url.endsWith("/grants") || url === "/api/secrets" ? []
          : url.includes("check-presets") ? { standard: [], none: { id: "none", label: "Nothing", command: "", needs: [] }, detected: [], tools: null, error: null }
          : {};
        return new Response(JSON.stringify(body), { status: 200 });
      }),
    );
    render(<Setup companies={[{ ...company, agents: [{ id: "a1", name: "CEO", role: "ceo", fundingSourceId: null } as Company["agents"][number]] }]} go={() => {}} onChanged={() => {}} />);
    fireEvent.click(await screen.findByText("Claude Pro or Max plan"));
    fireEvent.change(await screen.findByLabelText("The setup token"), { target: { value: "sk-ant-oat01-made-up" } });
    fireEvent.click(screen.getByText("Save and connect"));
    await screen.findByText(/stored encrypted/);
    fireEvent.click(await screen.findByText("Next")); // connect -> git token
    expect((await screen.findByRole("heading", { level: 1 })).textContent).toBe("A git token");
    fireEvent.click(await screen.findByText("Next")); // git token -> checks
    await screen.findByText("Before merging, Boss Man will");
    fireEvent.click(screen.getByText("Next")); // checks -> would be funding, goes to the first task
    expect((await screen.findByRole("heading", { level: 1 })).textContent).toBe("A first task");
  });

  it("shows the runner as one line, with the one thing to do when it is not connected", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const body = url === "/api/setup-progress" ? { dismissed: false, step: 2, companyId: "c1" } : url.endsWith("/runner") ? { registered: false } : [];
        return new Response(JSON.stringify(body), { status: 200 });
      }),
    );
    render(<Setup companies={[company]} go={() => {}} onChanged={() => {}} />);
    expect((await screen.findByTestId("setup-runner-line")).textContent).toContain("not connected");
    expect(screen.getByText("Settings → Server and runner → Runner").getAttribute("href")).toBe("#/settings/c1/runner");
    expect(screen.queryByText("Add-ons")).toBeNull();
    expect(screen.queryByTestId("setup-runner-memory")).toBeNull(); // no launcher line: nothing shown
  });

  it("BOS-1498: says what memory the runner is given and why", async () => {
    const line = "11 GB: 6 agents at once and 1 check, on a 16 GB machine.";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const body = url === "/api/setup-progress" ? { dismissed: false, step: 2, companyId: "c1" } : url.endsWith("/runner") ? { registered: false, launcher: null, memoryLine: line } : [];
        return new Response(JSON.stringify(body), { status: 200 });
      }),
    );
    render(<Setup companies={[company]} go={() => {}} onChanged={() => {}} />);
    expect((await screen.findByTestId("setup-runner-memory")).textContent).toBe(`Memory: ${line}`);
  });

  const runnerWith = async (runner: object) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const body = url === "/api/setup-progress" ? { dismissed: false, step: 2, companyId: "c1" } : url.endsWith("/runner") ? runner : [];
        return new Response(JSON.stringify(body), { status: 200 });
      }),
    );
    render(<Setup companies={[company]} go={() => {}} onChanged={() => {}} />);
    return screen.findByTestId("setup-runner-line");
  };
  const docLink = (testId: string) => screen.getByTestId(testId).querySelector("a")!.getAttribute("href");

  it("BOS-1895: shows the launcher's error with a link to its docs/29 section", async () => {
    await runnerWith({ registered: false, launcher: { slug: "acme", container: null, error: "connect ECONNREFUSED 192.168.1.50:3105" } });
    expect(screen.getByTestId("setup-runner-problem-launcher").textContent).toContain("couldn't reach the launcher, which starts the runner. It said: connect ECONNREFUSED 192.168.1.50:3105");
    expect(docLink("setup-runner-problem-launcher")).toMatch(/docs\/29-tune-and-troubleshoot\.md#the-launcher-cant-be-reached$/);
    expect(screen.getByText("Start the runner")).toBeTruthy(); // the owner can still retry
  });

  it("BOS-1895: shows an exited container and the guard's reason, each with its own link", async () => {
    await runnerWith({ registered: true, connected: false, launcher: { slug: "acme", container: { state: "exited", status: "Exited (1) 2 minutes ago", image: "x", guard: "down", guardReason: "nft rules did not load in 20 s" } } });
    expect(screen.getByTestId("setup-runner-problem-container").textContent).toContain(`The runner's container is exited (Docker says "Exited (1) 2 minutes ago").`);
    expect(docLink("setup-runner-problem-container")).toMatch(/#the-runners-container-has-stopped$/);
    expect(screen.getByTestId("setup-runner-problem-guard").textContent).toContain("network guard didn't start: nft rules did not load in 20 s");
    expect(docLink("setup-runner-problem-guard")).toMatch(/#the-runners-network-guard-wont-start$/);
    expect(screen.queryByTestId("setup-runner-problem-launcher")).toBeNull();
  });

  it("BOS-1895: keeps today's line while a launched runner is only starting", async () => {
    const line = await runnerWith({ registered: false, launcher: { slug: "acme", container: { state: "running", status: "Up 3 seconds", image: "x", guard: "on" } } });
    expect(line.textContent).toContain("The runner is not connected yet.");
    expect(screen.queryByTestId("setup-runner-problems")).toBeNull();
  });

  it("BOS-1895: shows no problems once the runner is connected", async () => {
    const line = await runnerWith({ registered: true, connected: true, launcher: { slug: "acme", container: { state: "running", status: "Up", image: "x", guardReason: "old reason" }, error: "stale" } });
    expect(line.textContent).toContain("The runner is connected.");
    expect(screen.queryByTestId("setup-runner-problems")).toBeNull();
  });
});

describe("docs/29 anchors the runner step links to (BOS-1895)", () => {
  it("each anchor matches a heading in docs/29", () => {
    const doc = readFileSync(resolve(process.cwd(), "../../docs/29-tune-and-troubleshoot.md"), "utf8");
    // GitHub's slug: lower case, punctuation other than - and spaces dropped, spaces to -.
    const slugs = doc.split("\n").filter((l) => l.startsWith("#")).map((l) => l.replace(/^#+\s*/, "").toLowerCase().replace(/[^a-z0-9 -]/g, "").replace(/ /g, "-"));
    for (const a of ["the-launcher-cant-be-reached", "the-runners-container-has-stopped", "the-runners-network-guard-wont-start", "the-runner-stays-offline-or-never-says-connected"]) expect(slugs).toContain(a);
  });
});

describe("setup wizard refresh", () => {
  it("shows Next right after the CEO's funding is saved, without waiting for a poll", async () => {
    let saved = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (init?.method === "PATCH") saved = true;
        const body =
          url === "/api/setup-progress" ? { dismissed: false, step: 6, companyId: "c1" }
          : url.endsWith("/setup-checklist") ? [{ id: "funding", label: "Funding", done: saved }]
          : url === "/api/funding-sources" ? [{ id: "f1", name: "Max", kind: "subscription", provider: "anthropic" }]
          : url.endsWith("/projects") ? [project]
          : {};
        return new Response(JSON.stringify(body), { status: 200 });
      }),
    );
    const withCeo: Company = { ...company, agents: [{ id: "a1", name: "CEO", role: "ceo", fundingSourceId: null } as Company["agents"][number]] };
    render(<Setup companies={[withCeo]} go={() => {}} onChanged={() => {}} />);
    expect(await screen.findByText("Skip for now")).toBeTruthy();
    await screen.findByRole("option", { name: "Max" });
    fireEvent.change(await screen.findByLabelText("The CEO runs on"), { target: { value: "f1" } });
    expect(await screen.findByText("Next")).toBeTruthy();
  });
});

describe("the Finish setting up card and the first merge", () => {
  const ids = ["company", "project", "runner", "credential", "git", "checks", "funding", "ticket"];
  const show = (merged: boolean) => {
    const items = [...ids.map((id) => ({ id, label: id, done: true })), { id: "merged", label: merged ? "First ticket merged: BOS-12, 2 h 40 min after setup started" : "First ticket merged", done: merged }];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => new Response(JSON.stringify(url === "/api/setup-progress" ? { dismissed: false, step: 0, companyId: "c1", firstMerge: null } : items), { status: 200 })));
    render(<SetupChecklist companyId="c1" go={() => {}} />);
  };

  it("stays while only the merge is left", async () => {
    show(false);
    expect(await screen.findByText(/First ticket merged/)).toBeTruthy();
    expect(screen.getByText("Finish setting up")).toBeTruthy();
  });

  it("stays once the merge is done, showing how long it took", async () => {
    show(true);
    expect(await screen.findByText(/First ticket merged: BOS-12, 2 h 40 min after setup started/)).toBeTruthy();
    expect(screen.getByText("Setup finished")).toBeTruthy();
    expect(screen.getByText("Dismiss")).toBeTruthy();
  });
});

describe("the connect step: one equal list of every way to pay (BOS-2815)", () => {
  const withCeo: Company = { ...company, agents: [{ id: "a1", name: "CEO", role: "ceo", fundingSourceId: null } as Company["agents"][number]] };
  // The owner's list (the card's answer): plans and keys by provider, nothing favoured; the rows come from funding.ts.
  const TEST_SITE_STEPS = [
    { name: "Claude Pro or Max plan", cost: "Fixed monthly", needs: "One command on a computer" },
    { name: "Anthropic API key", cost: "Pay as you go", needs: "Browser only" },
    { name: "ChatGPT plan", cost: "Fixed monthly", needs: "One command on a computer" },
    { name: "OpenAI API key", cost: "Pay as you go", needs: "Browser only" },
    { name: "Ollama Cloud plan", cost: "Fixed monthly", needs: "One command on a computer" },
    { name: "Ollama Cloud API key", cost: "Pay as you go", needs: "Browser only" },
    { name: "Synthetic", cost: "Pay as you go, or a fixed monthly plan", needs: "Browser only" },
    { name: "OpenRouter", cost: "Pay as you go", needs: "Browser only" },
    { name: "Other API provider", cost: "Pay as you go", needs: "Browser only" },
  ];

  const stub = (opts: { grants?: unknown; sources?: unknown; writes?: Array<{ url: string; method: string; body: unknown }> } = {}) =>
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const method = init?.method ?? "GET";
        opts.writes?.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : null });
        const body =
          url === "/api/setup-progress" ? { dismissed: false, step: 3, companyId: "c1" }
          : url.endsWith("/grants") ? (opts.grants ?? [])
          : url === "/api/funding-sources" && method === "GET" ? (opts.sources ?? [])
          : url === "/api/secrets" && method === "POST" ? { secret: { id: "s9" }, warnings: [] }
          : url === "/api/funding-sources" && method === "POST" ? { id: "f9" }
          : url.endsWith("/setup-checklist") ? [] : [];
        return new Response(JSON.stringify(body), { status: 200 });
      }),
    );

  it("shows the step as a plain list of every option, each with its cost and what you need, and none picked or favoured", async () => {
    stub();
    render(<Setup companies={[withCeo]} go={() => {}} onChanged={() => {}} />);
    const list = await screen.findByRole("list", { name: "Ways to connect an agent" });
    const rows = Array.from(list.querySelectorAll<HTMLElement>("[data-testid^='setup-connect-row-']"));
    const picked = rows.map((r) => {
      const button = r.querySelector("button")!;
      const name = button.querySelector(".connect-name")!.textContent;
      const meta = button.querySelector(".connect-meta")!.textContent!;
      const [cost, needs] = meta.split(" · ");
      return { name, cost, needs, expanded: button.getAttribute("aria-expanded"), classes: r.className };
    });
    expect(picked.map(({ classes: _, ...rest }) => rest)).toEqual(TEST_SITE_STEPS.map((s) => ({ ...s, expanded: "false" })));
    // Equal rows: one class, so no row is styled apart, and no text marks one as recommended or the default.
    expect(new Set(picked.map((p) => p.classes))).toEqual(new Set(["connect-row"]));
    expect(list.textContent).not.toMatch(/recommended|best|default|suggested/i);
    // No detail is open until the owner picks one.
    expect(screen.queryByText("Save and connect")).toBeNull();
  });

  it("a plan that needs a command says to install the tool first, with a link, before the command and the paste", async () => {
    stub();
    render(<Setup companies={[withCeo]} go={() => {}} onChanged={() => {}} />);
    fireEvent.click(await screen.findByText("Claude Pro or Max plan"));
    const steps = screen.getByText("Save and connect").closest(".connect-detail")!.querySelector("ol")!;
    const items = Array.from(steps.querySelectorAll("li")).map((li) => li.textContent!);
    expect(items[0]).toContain("Install Claude Code on your own computer");
    expect(steps.querySelector("li a")!.getAttribute("href")).toBe("https://code.claude.com/docs/en/setup");
    expect(items.some((t) => t.includes("claude setup-token"))).toBe(true);
    expect(items.some((t) => t.includes("shown once"))).toBe(true);
    expect(items.at(-1)).toMatch(/checked 27 November 2026/);
    expect(screen.getByText(/starts with "sk-ant-oat01"/)).toBeTruthy();
  });

  it("saves an Anthropic API key from this step alone: secret, grant, funding source, then the CEO", async () => {
    const writes: Array<{ url: string; method: string; body: unknown }> = [];
    stub({ writes });
    render(<Setup companies={[withCeo]} go={() => {}} onChanged={() => {}} />);
    fireEvent.click(await screen.findByText("Anthropic API key"));
    // Browser-only steps: the Console's pages, and a spending limit where the site has one.
    const detail = screen.getByText("Save and connect").closest(".connect-detail")!;
    expect(detail.textContent).toContain("platform.claude.com");
    expect(detail.textContent).toContain("spending limit");
    expect(detail.textContent).toMatch(/27 November 2026, checked against/);
    fireEvent.change(screen.getByLabelText("Anthropic key"), { target: { value: "sk-ant-api03-made-up" } });
    fireEvent.click(screen.getByText("Save and connect"));
    await screen.findByText(/stored encrypted/);
    const mine = writes.filter((c) => c.method !== "GET" && c.url !== "/api/setup-progress");
    expect(mine.map((c) => `${c.method} ${c.url}`)).toEqual(["POST /api/secrets", "POST /api/secrets/s9/grants", "POST /api/funding-sources", "PATCH /api/agents/a1"]);
    expect(mine[0]!.body).toMatchObject({ kind: "anthropic_api_key" });
    expect(mine[1]!.body).toMatchObject({ envName: "ANTHROPIC_API_KEY", companyId: "c1" });
    expect(mine[2]!.body).toMatchObject({ kind: "api_payg", provider: "anthropic", secretId: "s9" });
    expect(mine[3]!.body).toEqual({ fundingSourceId: "f9" });
  });

  it("a key that doesn't start the way the provider's keys do says what to copy, tied to the field, and saves nothing", async () => {
    const writes: Array<{ url: string; method: string; body: unknown }> = [];
    stub({ writes });
    render(<Setup companies={[withCeo]} go={() => {}} onChanged={() => {}} />);
    fireEvent.click(await screen.findByText("Anthropic API key"));
    const box = screen.getByLabelText("Anthropic key");
    fireEvent.change(box, { target: { value: "sk-ant-oat01-a-setup-token" } });
    fireEvent.click(screen.getByText("Save and connect"));
    const error = await screen.findByRole("alert");
    expect(error.textContent).toContain("That's a setup token, not an API key");
    expect(error.textContent).toContain("See the guide");
    expect(box.getAttribute("aria-describedby")).toBe(error.id);
    expect(box.getAttribute("aria-invalid")).toBe("true");
    const openAiWrites = writes.filter((c) => c.method !== "GET");
    expect(openAiWrites).toEqual([]);
  });

  it("saving an option reuses the key this company already holds, instead of making a second secret", async () => {
    const writes: Array<{ url: string; method: string; body: unknown }> = [];
    stub({
      writes,
      grants: [{ id: "g9", envName: "ANTHROPIC_API_KEY", secretId: "s5", secretName: "App Co Anthropic API key", hint: null, deployTargetId: null, agentIds: [] }],
      sources: [{ id: "f5", name: "App Co Anthropic", kind: "api_payg", provider: "anthropic", secretId: "s5" }],
    });
    render(<Setup companies={[withCeo]} go={() => {}} onChanged={() => {}} />);
    fireEvent.click(await screen.findByText("Anthropic API key"));
    fireEvent.change(screen.getByLabelText("Anthropic key"), { target: { value: "sk-ant-api03-made-up" } });
    fireEvent.click(screen.getByText("Save and connect"));
    await screen.findByText(/stored encrypted/);
    expect(writes.filter((c) => c.method !== "GET").map((c) => `${c.method} ${c.url}`)).toEqual(["POST /api/secrets/s5/grants", "PATCH /api/agents/a1"]);
  });

  it("the other API provider row sends the owner to Settings > Secrets rather than a box that would fail", async () => {
    stub();
    render(<Setup companies={[withCeo]} go={() => {}} onChanged={() => {}} />);
    fireEvent.click(await screen.findByText("Other API provider"));
    expect(screen.getByText(/Amazon Bedrock, Microsoft Foundry and LLM gateways each use two or three values/)).toBeTruthy();
    expect(screen.getByText("Open Settings → Secrets").getAttribute("href")).toBe("#/settings/c1/secrets");
    expect(screen.queryByText("Save and connect")).toBeNull();
  });

  it("a plan signed in to in its own tool says to install it first, with a link, then sign in and set it up in Settings", async () => {
    stub();
    render(<Setup companies={[withCeo]} go={() => {}} onChanged={() => {}} />);
    fireEvent.click(await screen.findByText("ChatGPT plan"));
    const detail = screen.getByTestId("setup-connect-row-chatgpt-plan").querySelector(".connect-detail")!;
    const items = Array.from(detail.querySelectorAll("ol li")).map((li) => li.textContent!);
    expect(items[0]).toContain("Install Codex");
    expect(detail.querySelector("ol li a")!.getAttribute("href")).toBe("https://github.com/openai/codex");
    expect(items[1]).toContain("codex login");
    expect(detail.textContent).toContain("Settings → Funding");
    expect(detail.textContent).toMatch(/not yet confirmed/);
    // No value box that would fail: this row is not connected by pasting here.
    expect(screen.queryByText("Save and connect")).toBeNull();
    // The Ollama Cloud plan is the same: install first, with a link.
    fireEvent.click(screen.getByText("Ollama Cloud plan"));
    const ollama = screen.getByTestId("setup-connect-row-ollama-plan").querySelector(".connect-detail")!;
    expect(ollama.querySelector("ol li")!.textContent).toContain("Install Ollama");
    expect(ollama.querySelector("ol li a")!.getAttribute("href")).toBe("https://ollama.com/download");
  });

  it("a plan row that saves nothing still becomes the CEO's funding source: pick it on step 7 and the line goes", async () => {
    const writes: Array<{ url: string; method: string; body: unknown }> = [];
    stub({
      writes,
      sources: [{ id: "f7", name: "App Co OpenAI", kind: "subscription", provider: "openai", secretId: null }],
    });
    render(<Setup companies={[withCeo]} go={() => {}} onChanged={() => {}} />);
    // Open the ChatGPT plan's steps: install and sign in, then finish in Settings.
    fireEvent.click(await screen.findByText("ChatGPT plan"));
    await screen.findByText(/Install Codex/);
    // Step 7: the funding source for it is chosen for the CEO, which is what pays for it.
    fireEvent.click(screen.getByRole("button", { name: /What pays for the CEO/ }));
    const pick = (await screen.findByLabelText("The CEO runs on")) as HTMLSelectElement;
    fireEvent.change(pick, { target: { value: "f7" } });
    await waitFor(() => expect(writes.some((c) => c.method === "PATCH" && c.url === "/api/agents/a1")).toBe(true));
    const patch = writes.filter((c) => c.method === "PATCH" && c.url === "/api/agents/a1").at(-1)!;
    expect(patch.body).toEqual({ fundingSourceId: "f7" });
  });

  it("step 7 says to go back to the connect step until something there is saved, above the form", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        new Response(
          JSON.stringify(
            url === "/api/setup-progress" ? { dismissed: false, step: 6, companyId: "c1" }
            : url.endsWith("/setup-checklist") ? []
            : url === "/api/funding-sources" ? []
            : url.endsWith("/projects") ? [project]
            : url.includes("check-presets") ? { standard: [], none: { id: "none", label: "Nothing", command: "", needs: [] }, detected: [], tools: null, error: null }
            : [],
          ),
          { status: 200 },
        ),
      ),
    );
    render(<Setup companies={[withCeo]} go={() => {}} onChanged={() => {}} />);
    const hint = await screen.findByTestId("setup-funding-hint");
    expect(hint.textContent).toContain("Go back to the connect step; it sets this up for you.");
    fireEvent.click(screen.getByText("Go back to the connect step"));
    expect((await screen.findByRole("heading", { level: 1 })).textContent).toBe("How do you want to connect your first agent?");
  });
});

describe("Before you go, leaving and the checklist count (BOS-2818)", () => {
  const items = [
    { id: "company", label: "Say what the company is for", done: true },
    { id: "runner", label: "Start the runner", done: true },
    { id: "credential", label: "Add a Claude sign-in code", done: false },
    { id: "ticket", label: "Write a first ticket", done: false },
  ];
  const stub = (step: number) => {
    const puts: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (init?.method === "PUT") puts.push(JSON.parse(String(init.body)));
        const body = url === "/api/setup-progress" ? { dismissed: false, step, companyId: "c1", work: "docs" } : url.endsWith("/setup-checklist") ? items : url.endsWith("/projects") ? [] : [];
        return new Response(JSON.stringify(body), { status: 200 });
      }),
    );
    return puts;
  };

  it("lists what is ready and what stops agents, explains permission cards and links the phone push", async () => {
    stub(8);
    render(<Setup companies={[company]} go={() => {}} onChanged={() => {}} />);
    expect((await screen.findByRole("heading", { level: 1 })).textContent).toBe("Before you go");
    expect(await screen.findByText(/Start the runner/, { selector: "span" })).toBeTruthy();
    expect(screen.getByText(/Add a Claude sign-in code/, { selector: "span" })).toBeTruthy();
    expect(screen.queryByText(/Write a first ticket/, { selector: "span" })).toBeNull();
    expect(screen.getByText(/treated as No/)).toBeTruthy();
    expect(screen.getByText("Get a push on your phone when agents need you").getAttribute("href")).toBe("#/settings/notifications");
    fireEvent.click(screen.getByText("Fix this"));
    expect((await screen.findByRole("heading", { level: 1 })).textContent).toBe("How do you want to connect your first agent?");
  });

  it("Leave setup for now closes the wizard without dismissing the checklist", async () => {
    const puts = stub(8);
    const go = vi.fn();
    render(<Setup companies={[company]} go={go} onChanged={() => {}} />);
    fireEvent.click(await screen.findByText("Leave setup for now"));
    expect(go).toHaveBeenCalledWith("board");
    expect(puts.some((p) => (p as { left?: boolean }).left === true)).toBe(true);
    expect(puts.some((p) => "dismissed" in (p as object))).toBe(false);
  });

  it("shows 'Setup: 2 of 4 done' on the card", async () => {
    stub(0);
    render(<SetupChecklist companyId="c1" go={() => {}} />);
    expect(await screen.findByText("Setup: 2 of 4 done")).toBeTruthy();
  });
});
