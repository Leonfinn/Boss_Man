// R40 (BOS-1685): a GitHub-only red holds only the merges that touch it, marking it warns, and a main fix that keeps
// failing wakes the CEO once with quarantine-or-revert. Before R40, any open fixesMergeCheck ticket held every approved
// ticket in the project (16 Nov: BOS-1641 held the whole line for about six hours while the gate's own check was green).
import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { activity, agents, projects, reviewHolds, reviewRequests, settings, tickets } from "../src/db/schema.js";
import { record } from "../src/services/activity.js";
import { escalateStuckLineHolders, githubOnlyMarkWarning, LINE_HOLDER_ESCALATED, tellCeoLineHolderSentBack } from "../src/services/line-holder.js";
import type { OpenFailure, Suspect } from "../src/services/main-ci.js";
import { ensureSystemHold, mergeWaits, releaseReadyHolds } from "../src/services/review-holds.js";

let ctx: Awaited<ReturnType<typeof setup>> | undefined;
afterEach(async () => {
  await ctx?.app.close();
  await ctx?.close();
  ctx = undefined;
});

const HOUR = 60 * 60_000;

async function setup() {
  const { db, close } = await openPglite();
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false, limits: { quickBatchMs: 0 }, workspaceRoot: "/ws" });
  const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
  const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
  const req = (method: "GET" | "POST" | "PATCH", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const { company } = (await req("POST", "/api/companies", { name: "App Co" })).json() as { company: { id: string } };
  const project = (await req("POST", `/api/companies/${company.id}/projects`, { name: "Site" })).json() as { id: string };
  const [dev] = await db.insert(agents).values({ companyId: company.id, name: "Dana", role: "worker", agentKind: "claude" }).returning();
  const [ceo] = await db.select().from(agents).where(and(eq(agents.companyId, company.id), eq(agents.role, "ceo")));
  const approved = async (title: string, files: string[]) => {
    const t = (await req("POST", `/api/projects/${project.id}/tickets`, { title })).json() as { id: string };
    await db.update(tickets).set({ systemState: "review", diffFiles: files }).where(eq(tickets.id, t.id));
    await db.insert(reviewRequests).values({ ticketId: t.id, kind: "code", round: 1, status: "approved" });
    return t.id;
  };
  /** The main-CI watcher's fix ticket, marked, with its open failure in the watcher's state row. */
  const fix = async (red: Partial<OpenFailure> = {}) => {
    const t = (await req("POST", `/api/projects/${project.id}/tickets`, { title: "Main's CI is failing: CI / check / Run pnpm test" })).json() as { id: string };
    await db.update(tickets).set({ fixesMergeCheck: true, assigneeAgentId: dev!.id, systemState: "in_progress" }).where(eq(tickets.id, t.id));
    await record(db, { companyId: company.id, ticketId: t.id, kind: "main_ci_failure", summary: "Opened for a failing step on main" });
    const open: Record<string, OpenFailure> = { "ci / check / run pnpm test": { ticketId: t.id, workflow: "CI", runs: [], job: "check", step: "Run pnpm test", named: ["test/page.test.tsx"], scope: [".github/workflows/ci.yml", "apps/web/"], suspects: [], ...red } };
    await db.insert(settings).values({ key: `main_ci:${project.id}`, value: { status: { state: "failing", detail: "", at: "" }, seen: {}, open } });
    return t.id;
  };
  const wakes: Array<{ agentId: string; ticketId: string; note: string }> = [];
  const wake = async (input: { agentId: string; ticketId: string; note: string }) => void wakes.push(input);
  const t = (id: string) => ({ id, projectId: project.id, fixesMergeCheck: false });
  return { ...built, db, close, req, company, project, dev: dev!, ceo: ceo!, approved, fix, wakes, wake, t };
}

describe("a GitHub-only red holds only the merges that touch it (R40)", () => {
  it("holds a ticket touching the red's area, .github/, a root file or an unknown diff, and not one outside it", async () => {
    const c = (ctx = await setup());
    const fixId = await c.fix();
    const web = await c.approved("Web change", ["apps/web/src/page.tsx"]);
    const ci = await c.approved("CI change", [".github/dependabot.yml"]);
    const lock = await c.approved("Lockfile", ["apps/server/src/a.ts", "pnpm-lock.yaml"]);
    const unknown = await c.approved("No diff kept", []);
    const server = await c.approved("Server change", ["apps/server/src/a.ts", "apps/server/test/a.test.ts"]);
    for (const id of [web, ci, lock, unknown]) expect(await mergeWaits(c.db, c.t(id))).toEqual([fixId]);
    expect(await mergeWaits(c.db, c.t(server))).toEqual([]);
  });

  it("still holds every merge when the red's scope is unknown, or the gate's own check of main is red too", async () => {
    const c = (ctx = await setup());
    const fixId = await c.fix({ scope: null });
    const server = await c.approved("Server change", ["apps/server/src/a.ts"]);
    expect(await mergeWaits(c.db, c.t(server))).toEqual([fixId]);
    await c.db.update(settings).set({ value: { status: { state: "failing", detail: "", at: "" }, seen: {}, open: { k: { ticketId: fixId, workflow: "CI", runs: [], job: "check", scope: ["apps/web/"] } } } }).where(eq(settings.key, `main_ci:${c.project.id}`));
    expect(await mergeWaits(c.db, c.t(server))).toEqual([]);
    await c.db.update(projects).set({ mainState: "red" }).where(eq(projects.id, c.project.id));
    expect(await mergeWaits(c.db, c.t(server))).toEqual([fixId]);
  });

  it("holds every merge for a fix that isn't a main-CI ticket (a gate fault), as before", async () => {
    const c = (ctx = await setup());
    const gateFix = (await c.req("POST", `/api/projects/${c.project.id}/tickets`, { title: "Runner fault" })).json() as { id: string };
    await c.db.update(tickets).set({ fixesMergeCheck: true }).where(eq(tickets.id, gateFix.id));
    const server = await c.approved("Server change", ["apps/server/src/a.ts"]);
    expect(await mergeWaits(c.db, c.t(server))).toEqual([gateFix.id]);
  });

  it("releases a ticket held before go-live on a red it doesn't touch, and keeps one that touches it", async () => {
    const c = (ctx = await setup());
    const fixId = await c.fix();
    const server = await c.approved("Server change", ["apps/server/src/a.ts"]);
    const web = await c.approved("Web change", ["apps/web/src/page.tsx"]);
    for (const id of [server, web]) await ensureSystemHold(c.db, id, [fixId], "Waits on the merge-check fix.");
    const started: string[] = [];
    expect(await releaseReadyHolds(c.db, async (id) => void started.push(id))).toEqual([server]);
    expect(started).toEqual([server]);
    const open = await c.db.select().from(reviewHolds).where(eq(reviewHolds.status, "open"));
    expect(open.map((h) => h.ticketId)).toEqual([web]);
  });
});

describe("marking a main-CI ticket warns (R40)", () => {
  it("names the scope and the job for a known red, says it holds everything for an unknown one, and is silent for other tickets", async () => {
    const c = (ctx = await setup());
    const fixId = await c.fix();
    const known = await githubOnlyMarkWarning(c.db, fixId);
    expect(known).toContain("GitHub-only red");
    expect(known).toContain(".github/workflows/ci.yml, apps/web/");
    expect(known).toContain("failure in check");
    await c.db.update(projects).set({ mainState: "red" }).where(eq(projects.id, c.project.id));
    expect(await githubOnlyMarkWarning(c.db, fixId)).toContain("holds every approved merge in the project");
    const plain = await c.approved("Plain", ["apps/web/a.ts"]);
    expect(await githubOnlyMarkWarning(c.db, plain)).toBe("");
  });
});

describe("a main fix that keeps failing wakes the CEO once with quarantine-or-revert (R40)", () => {
  const suspect: Suspect = { sha: "c".repeat(40), message: "Merge test change", reason: "changed test/page.test.tsx" };

  it("from the second send-back: offers revert of R41's suspect, once per fix", async () => {
    const c = (ctx = await setup());
    const fixId = await c.fix({ suspects: [suspect] });
    await c.approved("Web change", ["apps/web/src/page.tsx"]);
    const sentBack = () => tellCeoLineHolderSentBack(c.db, (agentId, input) => c.wake({ agentId, ...input }), { id: fixId, companyId: c.company.id, assigneeAgentId: c.dev.id }, "GitHub CI failed");
    for (let i = 0; i < 3; i++) expect(await sentBack()).toBe(true);
    expect(c.wakes.map((w) => w.agentId)).toEqual([c.ceo.id, c.ceo.id, c.ceo.id]);
    expect(c.wakes[0]!.note).not.toContain("Quarantine");
    expect(c.wakes[1]!.note).toContain("sent back 2 times");
    expect(c.wakes[1]!.note).toContain("Quarantine: set the failing test aside");
    expect(c.wakes[1]!.note).toContain(`Or revert ${"c".repeat(8)} "Merge test change" (changed test/page.test.tsx)`);
    expect(c.wakes[2]!.note).not.toContain("Quarantine");
    // The 2-hour sweep finds it already escalated: still one choice in all.
    const later = new Date(Date.now() + 3 * HOUR);
    expect(await escalateStuckLineHolders(c.db, later, c.wake)).toBe(0);
  });

  it("held over 2 hours: wakes the CEO once, offers no revert without a suspect, and not before 2 hours", async () => {
    const c = (ctx = await setup());
    const fixId = await c.fix();
    const web = await c.approved("Web change", ["apps/web/src/page.tsx"]);
    await ensureSystemHold(c.db, web, [fixId], "Waits on the merge-check fix.");
    const now = Date.now();
    const soon = new Date(now + HOUR);
    expect(await escalateStuckLineHolders(c.db, soon, c.wake)).toBe(0);
    const later = new Date(now + 3 * HOUR);
    expect(await escalateStuckLineHolders(c.db, later, c.wake)).toBe(1);
    expect(await escalateStuckLineHolders(c.db, later, c.wake)).toBe(0);
    expect(c.wakes).toHaveLength(1);
    expect(c.wakes[0]).toMatchObject({ agentId: c.ceo.id, ticketId: fixId });
    expect(c.wakes[0]!.note).toContain("over 2 hours");
    expect(c.wakes[0]!.note).toContain("Quarantine");
    expect(c.wakes[0]!.note).toContain("don't revert");
    expect(c.wakes[0]!.note).not.toContain("Or revert");
    const rows = await c.db.select().from(activity).where(and(eq(activity.ticketId, fixId), eq(activity.kind, LINE_HOLDER_ESCALATED)));
    expect(rows).toHaveLength(1);
  });

  it("wakes nobody when nothing is held behind the fix, or the CEO is its assignee", async () => {
    const c = (ctx = await setup());
    const fixId = await c.fix();
    const later = new Date(Date.now() + 3 * HOUR);
    expect(await escalateStuckLineHolders(c.db, later, c.wake)).toBe(0);
    const web = await c.approved("Web change", ["apps/web/src/page.tsx"]);
    await ensureSystemHold(c.db, web, [fixId], "Waits on the merge-check fix.");
    await c.db.update(tickets).set({ assigneeAgentId: c.ceo.id }).where(eq(tickets.id, fixId));
    expect(await escalateStuckLineHolders(c.db, later, c.wake)).toBe(0);
    expect(c.wakes).toEqual([]);
  });
});
