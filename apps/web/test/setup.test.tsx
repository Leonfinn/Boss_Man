// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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

describe("setup wizard: Claude and runner steps (BOS-1495)", () => {
  const withCeo: Company = { ...company, agents: [{ id: "a1", name: "CEO", role: "ceo", fundingSourceId: null } as Company["agents"][number]] };

  it("saves the setup token, makes the funding source and points the CEO at it", async () => {
    const calls: Array<{ url: string; method: string; body: unknown }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const method = init?.method ?? "GET";
        calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : null });
        const body =
          url === "/api/setup-progress" ? { dismissed: false, step: 3, companyId: "c1" }
          : url === "/api/secrets" && method === "POST" ? { secret: { id: "s1" }, warnings: [] }
          : url === "/api/funding-sources" && method === "POST" ? { id: "f1" }
          : url.endsWith("/setup-checklist") || url.endsWith("/grants") || url === "/api/secrets" ? []
          : {};
        return new Response(JSON.stringify(body), { status: 200 });
      }),
    );
    render(<Setup companies={[withCeo]} go={() => {}} onChanged={() => {}} />);
    const box = await screen.findByLabelText("Claude setup token");
    expect(screen.queryByLabelText("Add")).toBeTruthy(); // the general form is there, but inside the closed details
    expect(screen.getByText("Use an API key instead").closest("details")!.open).toBe(false);
    fireEvent.change(box, { target: { value: "sk-ant-oat01-made-up" } });
    fireEvent.click(screen.getByText("Save the token"));
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
    expect(screen.queryByLabelText("Claude setup token")).toBeNull();
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
    fireEvent.change(await screen.findByLabelText("Claude setup token"), { target: { value: "sk-ant-oat01-made-up" } });
    fireEvent.click(screen.getByText("Save the token"));
    await screen.findByText(/stored encrypted/);
    fireEvent.click(await screen.findByText("Next")); // Claude -> git token
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
    expect(screen.getByText(/8 of 9 done|Finish setting up/)).toBeTruthy();
  });

  it("hides once the merge is done", async () => {
    show(true);
    await new Promise((r) => setTimeout(r, 50)); // test-lines-ok: waiting for a card that must NOT appear
    expect(screen.queryByText(/after setup started/)).toBeNull();
  });
});
