import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { agents, projects, ticketMessages, tickets } from "../src/db/schema.js";
import { areaOf, errorLines, knownRedOnly, mainCiFailures, mainCiService, namedFiles, NEVER_WEAKEN, redScope, type OpenFailure } from "../src/services/main-ci.js";
import { GitHostError, type CompareDetail, type WorkflowJob, type WorkflowRun } from "../src/services/git-hosts.js";

const sha = (c: string) => c.repeat(40);
const run = (id: number, conclusion: string | null, head: string, extra: Partial<WorkflowRun> = {}): WorkflowRun => ({
  id,
  attempt: 1,
  name: "CI",
  event: "push",
  status: conclusion ? "completed" : "in_progress",
  conclusion,
  headSha: head,
  headMessage: "Merge something",
  url: `https://github.com/leon/site/actions/runs/${id}`,
  createdAt: "2026-11-11T03:17:00Z",
  updatedAt: "2026-11-11T03:20:00Z",
  ...extra,
});
const job = (name: string, steps: Array<[string, string]>): WorkflowJob => ({
  id: 900 + name.length,
  name,
  status: "completed",
  conclusion: steps.some(([, c]) => c === "failure") ? "failure" : "success",
  url: `https://github.com/leon/site/actions/jobs/${name}`,
  steps: steps.map(([n, c], i) => ({ number: i + 1, name: n, status: "completed", conclusion: c })),
});

let ctx: Awaited<ReturnType<typeof setup>> | undefined;
afterEach(async () => {
  await ctx?.app.close();
  await ctx?.close();
  ctx = undefined;
});

async function setup(opts: { token?: string | undefined; github?: boolean } = {}) {
  const { db, close } = await openPglite();
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false, limits: { quickBatchMs: 0 }, workspaceRoot: "/ws" });
  await built.app.listen({ host: "127.0.0.1", port: 0 });
  const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
  const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
  const req = (method: "GET" | "POST" | "PATCH" | "PUT", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const { company } = (await req("POST", "/api/companies", { name: "App Co" })).json() as { company: { id: string } };
  const project = (await req("POST", `/api/companies/${company.id}/projects`, { name: "Site" })).json() as { id: string };
  await db
    .update(projects)
    .set(opts.github === false ? { repoUrl: "https://git.example.com/leon/site.git", gitHost: "gitea", gitApiBase: "https://git.example.com/api/v1" } : { repoUrl: "https://github.com/leon/site.git", gitHost: "github", gitApiBase: "https://api.github.com" })
    .where(eq(projects.id, project.id));
  const [dev] = await db.insert(agents).values({ companyId: company.id, name: "Dana", role: "worker", agentKind: "claude" }).returning();
  const [ceo] = await db.select().from(agents).where(and(eq(agents.companyId, company.id), eq(agents.role, "ceo")));

  // A fake GitHub: the runs, jobs and logs the test sets.
  const gh = { runs: [] as WorkflowRun[], jobs: {} as Record<number, WorkflowJob[]>, log: "", logError: null as Error | null, runsError: null as Error | null, calls: 0, compare: {} as Record<string, CompareDetail>, tree: null as string[] | null };
  const gitHosts = {
    // Keyed "from...to"; an unset pair answers like a token without Contents read.
    compareDetail: async (_c: unknown, _t: unknown, from: string, to: string) => {
      const d = gh.compare[`${from}...${to}`];
      if (!d) throw new GitHostError(403, "Resource not accessible by personal access token");
      return d;
    },
    workflowRuns: async () => {
      gh.calls++;
      if (gh.runsError) throw gh.runsError;
      return gh.runs;
    },
    runJobs: async (_c: unknown, _t: unknown, id: number) => gh.jobs[id] ?? [],
    jobLog: async () => {
      if (gh.logError) throw gh.logError;
      return gh.log;
    },
    commitAnnotations: async () => [],
    // R40: main's file list; null answers like a failed read.
    treePaths: async () => {
      if (!gh.tree) throw new GitHostError(404, "Not Found");
      return gh.tree;
    },
  };
  const woken: Array<{ agentId: string; ticketId: string }> = [];
  const service = mainCiService(db, {
    gitHosts: gitHosts as never,
    gitToken: async () => ("token" in opts ? opts.token : "tok"),
    createTicket: (projectId, input) => built.work.createTicket(projectId, input),
    notify: async (agentId, input) => void woken.push({ agentId, ticketId: input.ticketId }),
  });
  const failingTickets = async () => (await db.select().from(tickets).where(eq(tickets.projectId, project.id))).filter((t) => t.title.startsWith("Main's CI is failing"));
  const notesOn = async (ticketId: string) => (await db.select().from(ticketMessages).where(eq(ticketMessages.ticketId, ticketId))).map((m) => m.text);
  return { ...built, db, close, req, company, project, dev: dev!, ceo: ceo!, gh, service, woken, failingTickets, notesOn };
}

const failedRun = (c: Awaited<ReturnType<typeof setup>>, id: number, head: string, steps: Array<[string, string]> = [["Run tests", "failure"]]) => {
  c.gh.runs.unshift(run(id, "failure", head));
  c.gh.jobs[id] = [job("test", [["Set up", "success"], ...steps])];
};

describe("errorLines", () => {
  it("keeps the error-looking lines, drops timestamps and redacts secrets", () => {
    // Built at run time so the source holds no token-shaped string for the secrets scan to flag.
    const fakeToken = ["ghp", "_", "abcdefghijklmnopqrstuvwxyz", "0123456789ABCD"].join("");
    const log = ["2026-11-11T03:17:01.1234567Z all good", "2026-11-11T03:17:02.0000000Z FAIL test/a.test.ts > adds", "2026-11-11T03:17:03.0000000Z AssertionError: expected 1 to be 2", `token ${fakeToken} failed`].join("\n");
    const lines = errorLines(log);
    expect(lines).toContain("FAIL test/a.test.ts > adds");
    expect(lines.some((l) => l.includes("all good"))).toBe(false);
    expect(lines.join("\n")).not.toContain(fakeToken);
  });
});

describe("namedFiles (BOS-1688)", () => {
  it("finds the paths and test files a log names, not URLs, node_modules or a bare source name", () => {
    const lines = [
      "FAIL test/a.test.ts > adds",
      "  at run (apps/server/src/services/x.ts:12:3)",
      "see https://github.com/leon/site/blob/main/apps/web/y.ts",
      "  at node_modules/vitest/dist/index.js:1:1",
      "error in index.ts",
      "✗ b.spec.tsx",
    ];
    expect(namedFiles(lines).sort()).toEqual(["apps/server/src/services/x.ts", "b.spec.tsx", "test/a.test.ts"]);
  });
});

describe("redScope (R40, BOS-1685)", () => {
  const tree = ["package.json", "apps/server/test/a.test.ts", "apps/web/test/a.test.ts", "packages/shared/src/x.ts", "scripts/check-quick.sh", ".github/workflows/ci.yml"];
  it("reduces each named file to its area and adds the workflow file", () => {
    expect(areaOf("apps/web/src/page.tsx")).toBe("apps/web/");
    expect(areaOf("scripts/a.sh")).toBe("scripts/");
    expect(areaOf("package.json")).toBe("package.json");
    expect(redScope(["packages/shared/src/x.ts", "scripts/check-quick.sh"], ".github/workflows/ci.yml", tree)).toEqual([".github/workflows/ci.yml", "packages/shared/", "scripts/"]);
  });
  it("covers every area a package-relative name could be", () => {
    expect(redScope(["test/a.test.ts"], null, tree)).toEqual(["apps/server/", "apps/web/"]);
  });
  it("is unknown (null) with no named file, an unreadable tree, or a name that matches nothing", () => {
    expect(redScope([], ".github/workflows/ci.yml", tree)).toBeNull();
    expect(redScope(["test/a.test.ts"], null, null)).toBeNull();
    expect(redScope(["test/gone.test.ts"], null, tree)).toBeNull();
  });
});

describe("knownRedOnly (R40, BOS-1685): the gate takes a branch's GitHub failure as main's only on an exact match", () => {
  const red: OpenFailure = { ticketId: "t1", workflow: "CI", runs: [], job: "check", step: "Run pnpm test", named: ["test/a.test.ts"], scope: ["apps/server/"] };
  it("matches the same job, step and failing test", () => {
    expect(knownRedOnly([{ job: "check", step: "Run pnpm test", files: ["apps/server/test/a.test.ts"] }], [red])).toEqual([red]);
  });
  it("refuses another job", () => {
    expect(knownRedOnly([{ job: "e2e", step: "Run pnpm test", files: ["apps/server/test/a.test.ts"] }], [red])).toBeNull();
  });
  it("refuses another failing step", () => {
    expect(knownRedOnly([{ job: "check", step: "Typecheck", files: ["apps/server/test/a.test.ts"] }], [red])).toBeNull();
  });
  it("refuses a failure that names a test file main's red doesn't", () => {
    expect(knownRedOnly([{ job: "check", step: "Run pnpm test", files: ["apps/server/test/a.test.ts", "apps/server/test/b.test.ts"] }], [red])).toBeNull();
  });
  it("refuses a failure that names no file (nothing to compare)", () => {
    expect(knownRedOnly([{ job: "check", step: "Run pnpm test", files: [] }], [red])).toBeNull();
  });
  it("refuses when one of several failed jobs doesn't match, and when the red's scope is unknown", () => {
    expect(knownRedOnly([{ job: "check", files: ["test/a.test.ts"] }, { job: "lint", files: ["x.test.ts"] }], [red])).toBeNull();
    expect(knownRedOnly([{ job: "check", step: "Run pnpm test", files: ["apps/server/test/a.test.ts"] }], [{ ...red, scope: null }])).toBeNull();
  });
});

describe("the main-CI watcher", () => {
  it("BOS-2299: a failed run that follows main's CI (Publish images) opens a ticket", async () => {
    ctx = await setup();
    const c = ctx;
    c.gh.runs = [run(41, "failure", sha("d"), { event: "workflow_run", name: "Publish images" })];
    c.gh.jobs[41] = [job("launcher", [["Install cosign", "failure"]])];
    c.gh.log = "curl: (22) The requested URL returned error: 503";
    await c.service.run();
    const made = await c.failingTickets();
    expect(made).toHaveLength(1);
    expect(made[0]!.body).toContain("Publish images");
  });

  it("BOS-1641's case: says where main was and the last green commit, and 'no suspect' when no commit since touched the failing test", async () => {
    ctx = await setup();
    const c = ctx;
    const colId = (await c.work.board(c.project.id)).columns.at(-1)!.id;
    await c.db.insert(tickets).values({ companyId: c.company.id, projectId: c.project.id, title: "Unrelated merge", systemState: "done", columnId: colId, assigneeAgentId: c.dev.id, mergeCommit: sha("d") });
    c.gh.runs = [run(31, "failure", sha("d"), { event: "schedule" }), run(30, "success", sha("c"))];
    c.gh.jobs[31] = [job("test", [["Run tests", "failure"]])];
    c.gh.log = "FAIL test/a.test.ts > adds\nError: expected 1 to be 2";
    c.gh.compare[`${sha("c")}...${sha("d")}`] = { commits: [{ sha: sha("d"), message: "Merge unrelated", parents: [sha("c")] }], files: ["apps/web/src/page.tsx"] };
    await c.service.run();
    const [made] = await c.failingTickets();
    expect(made!.body).not.toContain("First failing commit");
    expect(made!.body).toContain(`Main was at ${sha("d").slice(0, 8)}`);
    expect(made!.body).toContain(`Last green run of "CI": main at ${sha("c").slice(0, 8)}`);
    expect(made!.body).toContain("No suspect");
    expect(made!.body).toContain("Don't undo a commit");
    expect(made!.body).toContain("doesn't make it the cause");
    expect(await c.service.suspectsFor(c.project.id, made!.id)).toEqual([]);
  });

  it("ranks the commits since the last green run by the failing job's files, lists only main's own commits, and gives the ticket to the top suspect's author", async () => {
    ctx = await setup();
    const c = ctx;
    const colId = (await c.work.board(c.project.id)).columns.at(-1)!.id;
    const base = { companyId: c.company.id, projectId: c.project.id, systemState: "done" as const, columnId: colId };
    const [other] = await c.db.insert(agents).values({ companyId: c.company.id, name: "Omar", role: "worker", agentKind: "claude" }).returning();
    await c.db.insert(tickets).values({ ...base, title: "Changed the test", assigneeAgentId: c.dev.id, mergeCommit: sha("c") });
    await c.db.insert(tickets).values({ ...base, title: "Newest, CI file only", assigneeAgentId: other!.id, mergeCommit: sha("d") });
    const wf = { path: ".github/workflows/ci.yml" };
    c.gh.runs = [run(41, "failure", sha("d"), wf), run(40, "success", sha("a"), wf)];
    c.gh.jobs[41] = [job("test", [["Run tests", "failure"]])];
    c.gh.log = "FAIL test/a.test.ts > adds\nError: expected 1 to be 2";
    // Main: a (green) ← b ← c ← d (failed). e is an inner branch commit of c's merge: never listed apart.
    c.gh.compare[`${sha("a")}...${sha("d")}`] = {
      commits: [
        { sha: sha("b"), message: "Merge web change", parents: [sha("a")] },
        { sha: sha("e"), message: "wip", parents: [sha("b")] },
        { sha: sha("c"), message: "Merge test change", parents: [sha("b"), sha("e")] },
        { sha: sha("d"), message: "Merge CI change", parents: [sha("c")] },
      ],
      files: [],
    };
    c.gh.compare[`${sha("a")}...${sha("b")}`] = { commits: [], files: ["apps/web/src/page.tsx"] };
    c.gh.compare[`${sha("b")}...${sha("c")}`] = { commits: [], files: ["apps/server/test/a.test.ts"] };
    c.gh.compare[`${sha("c")}...${sha("d")}`] = { commits: [], files: [".github/workflows/ci.yml"] };
    await c.service.run();
    const [made] = await c.failingTickets();
    const suspects = await c.service.suspectsFor(c.project.id, made!.id);
    expect(suspects!.map((s) => s.sha)).toEqual([sha("c"), sha("d")]);
    expect(suspects![0]!.reason).toContain("test/a.test.ts");
    expect(suspects![1]!.reason).toContain("workflow file");
    expect(made!.body).toContain(`1. ${sha("c").slice(0, 8)} "Merge test change"`);
    expect(made!.body).toContain('(ticket "Changed the test")');
    expect(made!.body).toMatch(new RegExp(`Also since the last green run.*${sha("b").slice(0, 8)}`));
    expect(made!.body).not.toContain(sha("e").slice(0, 8));
    expect(made!.body).not.toContain("No suspect");
    expect(made!.assigneeAgentId).toBe(c.dev.id);
  });

  it("R40: records the red's job, step, named files and scope, resolving a package-relative name through main's tree", async () => {
    ctx = await setup();
    const c = ctx;
    c.gh.runs = [run(61, "failure", sha("d"), { path: ".github/workflows/ci.yml" })];
    c.gh.jobs[61] = [job("test", [["Run tests", "failure"]])];
    c.gh.log = "FAIL test/a.test.ts > adds\nError: expected 1 to be 2";
    c.gh.tree = ["package.json", "apps/server/test/a.test.ts", "apps/web/src/page.tsx", ".github/workflows/ci.yml"];
    await c.service.run();
    const [red] = await mainCiFailures(c.db, c.project.id);
    expect(red).toMatchObject({ job: "test", step: "Run tests", named: ["test/a.test.ts"], scope: [".github/workflows/ci.yml", "apps/server/"] });
  });

  it("R40: leaves the scope unknown when main's tree can't be read", async () => {
    ctx = await setup();
    const c = ctx;
    c.gh.runs = [run(62, "failure", sha("d"))];
    c.gh.jobs[62] = [job("test", [["Run tests", "failure"]])];
    c.gh.log = "FAIL test/a.test.ts > adds";
    await c.service.run();
    const [red] = await mainCiFailures(c.db, c.project.id);
    expect(red!.named).toEqual(["test/a.test.ts"]);
    expect(red!.scope).toBeNull();
  });

  it("says no commit broke it when main didn't move since the last green run, and says so when the token can't read commits", async () => {
    ctx = await setup();
    const c = ctx;
    c.gh.runs = [run(51, "failure", sha("d"), { event: "schedule" }), run(50, "success", sha("d"))];
    c.gh.jobs[51] = [job("test", [["Run tests", "failure"]])];
    await c.service.run();
    const [same] = await c.failingTickets();
    expect(same!.body).toContain("Main didn't change between the last green run and the first failure");
    expect(same!.body).toContain("No suspect");

    c.gh.runs = [run(53, "failure", sha("f"), { name: "Nightly" }), run(52, "success", sha("e"), { name: "Nightly" })];
    c.gh.jobs[53] = [job("e2e", [["Run e2e", "failure"]])];
    await c.service.run();
    const blind = (await c.failingTickets()).find((t) => t.title.includes("Nightly"));
    expect(blind!.body).toContain("Contents: Read-only");
    expect(blind!.body).toContain("No suspect");
    expect(await c.service.suspectsFor(c.project.id, blind!.id)).toEqual([]);
  });

  it("opens one ticket for a failing step, assigned to the ticket whose merge broke it, with the run link and the rule", async () => {
    ctx = await setup();
    const c = ctx;
    const [t] = await c.db.insert(tickets).values({ companyId: c.company.id, projectId: c.project.id, title: "Add widgets", systemState: "done", columnId: (await c.work.board(c.project.id)).columns.at(-1)!.id, assigneeAgentId: c.dev.id, mergeCommit: sha("b") }).returning();
    failedRun(c, 11, sha("b"));
    c.gh.log = "2026-11-11T03:17:02Z FAIL test/a.test.ts > adds\n2026-11-11T03:17:03Z Error: expected 1 to be 2";
    await c.service.run();
    const made = await c.failingTickets();
    expect(made).toHaveLength(1);
    expect(made[0]!.assigneeAgentId).toBe(c.dev.id);
    expect(made[0]!.urgent).toBe(true); // every main-CI ticket is urgent, whoever it goes to (BOS-1635)
    expect(made[0]!.body).toContain("https://github.com/leon/site/actions/runs/11");
    expect(made[0]!.body).toContain("test");
    expect(made[0]!.body).toContain("Run tests");
    expect(made[0]!.body).toContain("expected 1 to be 2");
    expect(made[0]!.body).toContain("Add widgets");
    expect(made[0]!.body).toContain(NEVER_WEAKEN);
    expect(c.woken).toEqual([{ agentId: c.dev.id, ticketId: made[0]!.id }]);
    expect(t).toBeTruthy();
  });

  it("with a token that reads runs but not logs or check-run annotations, still opens one ticket with link, job and step, and shows no fault", async () => {
    ctx = await setup();
    const c = ctx;
    failedRun(c, 40, sha("f"));
    c.gh.logError = new Error("HTTP 403");
    await c.service.run();
    await c.service.run();
    const made = await c.failingTickets();
    expect(made).toHaveLength(1);
    expect(made[0]!.body).toContain("https://github.com/leon/site/actions/runs/40");
    expect(made[0]!.body).toContain("Run tests");
    expect(made[0]!.body).toContain("The job log couldn't be read");
    const [s] = await c.service.statuses();
    expect(s!.status.state).toBe("failing");
    expect("detail" in s!.status ? s!.status.detail : "").not.toMatch(/can't read/);
  });

  it("finds the breaking commit within the failing workflow only, ignoring other workflows' runs", async () => {
    ctx = await setup();
    const c = ctx;
    const colId = (await c.work.board(c.project.id)).columns.at(-1)!.id;
    const base = { companyId: c.company.id, projectId: c.project.id, systemState: "done" as const, columnId: colId };
    const [other] = await c.db.insert(agents).values({ companyId: c.company.id, name: "Omar", role: "worker", agentKind: "claude" }).returning();
    await c.db.insert(tickets).values({ ...base, title: "Broke CI", assigneeAgentId: c.dev.id, mergeCommit: sha("c") });
    await c.db.insert(tickets).values({ ...base, title: "Newest change", assigneeAgentId: other!.id, mergeCommit: sha("d") });
    // Newest first. CI failed on c and d; the nightly passed on d (would cut a mixed walk short) and failed on b (would stretch it back).
    c.gh.runs = [
      run(30, "failure", sha("d")),
      run(29, "success", sha("d"), { name: "Nightly" }),
      run(28, "failure", sha("c")),
      run(27, "failure", sha("b"), { name: "Nightly" }),
      run(26, "success", sha("a")),
    ];
    c.gh.jobs[30] = [job("test", [["Run tests", "failure"]])];
    await c.service.run();
    const [made] = await c.failingTickets();
    expect(made!.assigneeAgentId).toBe(c.dev.id);
    expect(made!.body).toContain("Broke CI");
  });

  it("gives the ticket to the CEO, urgent, when the breaking ticket can't be told", async () => {
    ctx = await setup();
    failedRun(ctx, 12, sha("c"));
    await ctx.service.run();
    const [made] = await ctx.failingTickets();
    expect(made!.assigneeAgentId).toBe(ctx.ceo.id);
    expect(made!.urgent).toBe(true);
  });

  it("gives the ticket to the CEO, not a background-lane agent, and names them as a lead (BOS-1635)", async () => {
    ctx = await setup();
    const c = ctx;
    const [bg] = await c.db.insert(agents).values({ companyId: c.company.id, name: "Bea", title: "Background Developer", role: "worker", agentKind: "claude" }).returning();
    await c.db.insert(tickets).values({ companyId: c.company.id, projectId: c.project.id, title: "Tidy helpers", systemState: "done", columnId: (await c.work.board(c.project.id)).columns.at(-1)!.id, assigneeAgentId: bg!.id, mergeCommit: sha("e") });
    failedRun(c, 15, sha("e"));
    await c.service.run();
    const [made] = await c.failingTickets();
    expect(made!.assigneeAgentId).toBe(c.ceo.id);
    expect(made!.urgent).toBe(true);
    expect(made!.body).toContain("Lead: Bea");
    expect(made!.body).toContain("Tidy helpers");
  });

  it("adds a later failed run to the open ticket instead of opening another", async () => {
    ctx = await setup();
    failedRun(ctx, 13, sha("c"));
    await ctx.service.run();
    failedRun(ctx, 14, sha("d"));
    await ctx.service.run();
    const made = await ctx.failingTickets();
    expect(made).toHaveLength(1);
    expect(await ctx.notesOn(made[0]!.id)).toEqual([expect.stringContaining("actions/runs/14")]);
    // The same run read again changes nothing.
    await ctx.service.run();
    expect(await ctx.notesOn(made[0]!.id)).toHaveLength(1);
  });

  it("opens a separate ticket for each distinct failing step", async () => {
    ctx = await setup();
    failedRun(ctx, 15, sha("e"), [["Typecheck", "failure"], ["Run tests", "failure"]]);
    await ctx.service.run();
    const made = await ctx.failingTickets();
    expect(made.map((t) => t.title).sort()).toEqual(["Main's CI is failing: CI / test / Run tests", "Main's CI is failing: CI / test / Typecheck"]);
  });

  it("doesn't open a duplicate when a pass fails part-way through several new tickets", async () => {
    ctx = await setup();
    const c = ctx;
    failedRun(c, 30, sha("e"), [["Typecheck", "failure"], ["Run tests", "failure"]]);
    let calls = 0;
    const flaky = mainCiService(c.db, {
      gitHosts: { workflowRuns: async () => c.gh.runs, runJobs: async (_a: unknown, _b: unknown, id: number) => c.gh.jobs[id] ?? [], jobLog: async () => "", commitAnnotations: async () => [] } as never,
      gitToken: async () => "tok",
      createTicket: (projectId, input) => {
        if (++calls === 2) throw new Error("db hiccup");
        return c.work.createTicket(projectId, input);
      },
    });
    await flaky.run();
    expect(await c.failingTickets()).toHaveLength(1);
    await c.service.run();
    expect(await c.failingTickets()).toHaveLength(2);
  });

  it("says on the ticket when main is green again, and a second break opens a new ticket", async () => {
    ctx = await setup();
    failedRun(ctx, 16, sha("c"));
    await ctx.service.run();
    ctx.gh.runs.unshift(run(17, "success", sha("d")));
    await ctx.service.run();
    const [first] = await ctx.failingTickets();
    expect((await ctx.notesOn(first!.id)).join("\n")).toContain("green again");
    // Green stays quiet on the next pass.
    await ctx.service.run();
    expect(await ctx.notesOn(first!.id)).toHaveLength(1);
    // Breaks again: the old ticket is still open but was told it's green, so a fresh one opens.
    failedRun(ctx, 18, sha("e"));
    await ctx.service.run();
    expect(await ctx.failingTickets()).toHaveLength(2);
  });

  // BOS-1703: main's red run 43981883165 was hidden by a newer finished run of the same workflow.
  const redImagesRun = (c: Awaited<ReturnType<typeof setup>>) => {
    c.gh.runs.unshift(run(41, "failure", sha("a")));
    // Run 43981883165's shape: images (amd64) red; check, host-steps and web-browser skipped.
    const skipped = (name: string): WorkflowJob => ({ ...job(name, []), conclusion: "skipped" });
    c.gh.jobs[41] = [
      skipped("check"),
      skipped("host-steps"),
      skipped("web-browser"),
      job("images (amd64)", [["Set up", "success"], ["Shell script tests", "failure"]]),
    ];
  };

  it("sees a red run that a newer cancelled run and a queued run sit on top of (BOS-1703)", async () => {
    ctx = await setup();
    const c = ctx;
    c.gh.runs.unshift(run(40, "success", sha("9")));
    await c.service.run(); // main is green; run 40 is recorded
    redImagesRun(c);
    c.gh.runs.unshift(run(42, "cancelled", sha("b")), run(43, null, sha("c"), { status: "queued" }));
    await c.service.run();
    const made = await c.failingTickets();
    expect(made).toHaveLength(1);
    expect(made[0]!.title).toBe("Main's CI is failing: CI / images (amd64) / Shell script tests");
    await c.service.run();
    expect(await c.failingTickets()).toHaveLength(1);
  });

  it("opens nothing new when a ticket for the same failure was opened by hand (BOS-1703)", async () => {
    ctx = await setup();
    const c = ctx;
    c.gh.runs.unshift(run(40, "success", sha("9")));
    await c.service.run();
    await c.db.insert(tickets).values({ companyId: c.company.id, projectId: c.project.id, title: "Main's CI is failing: images (amd64) Shell script tests", systemState: "in_progress", columnId: (await c.work.board(c.project.id)).columns[0]!.id });
    redImagesRun(c);
    await c.service.run();
    expect(await c.failingTickets()).toHaveLength(1); // only the hand-made one
    expect((await c.failingTickets())[0]!.title).not.toContain("CI / images");
  });

  it("ignores pull request runs and runs that are still going", async () => {
    ctx = await setup();
    ctx.gh.runs.unshift(run(19, "failure", sha("a"), { event: "pull_request" }), run(20, null, sha("b")));
    await ctx.service.run();
    expect(await ctx.failingTickets()).toHaveLength(0);
  });

  it("stays quiet and says why when there's no GitHub, no token or the token can't read runs", async () => {
    ctx = await setup({ github: false });
    await ctx.service.run();
    expect(ctx.gh.calls).toBe(0);
    expect((await ctx.service.statuses())[0]!.status.state).toBe("no_github");
    await ctx.app.close();
    await ctx.close();

    ctx = await setup({ token: undefined });
    await ctx.service.run();
    expect(ctx.gh.calls).toBe(0);
    expect((await ctx.service.statuses())[0]!.status.state).toBe("no_token");
    await ctx.app.close();
    await ctx.close();

    ctx = await setup();
    ctx.gh.runsError = new GitHostError(403, "Resource not accessible by integration");
    await ctx.service.run();
    const [s] = await ctx.service.statuses();
    expect(s!.status.state).toBe("unreadable");
    expect(await ctx.failingTickets()).toHaveLength(0);
  });

  it("does nothing while the owner's switch is off, and the switch is on by default", async () => {
    ctx = await setup();
    expect(await ctx.service.isOn()).toBe(true);
    await ctx.service.setOn(false);
    failedRun(ctx, 21, sha("c"));
    await ctx.service.run();
    expect(ctx.gh.calls).toBe(0);
    expect(await ctx.failingTickets()).toHaveLength(0);
    expect((await ctx.service.statuses())[0]!.status.state).toBe("off");
    const r = await ctx.req("PUT", "/api/settings/main-ci", { on: true });
    expect(r.json()).toMatchObject({ on: true });
  });
});
