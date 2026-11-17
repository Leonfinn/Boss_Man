// BOS-1645 (R27): on 16 Nov BOS-1635's merge reached main at about 11:13, but a runner rebuild cut the gate off just after
// the push. Boss Man never recorded the merge, the ticket kept saying "not merged", and the live commit couldn't be placed
// (wrong "not live" answers, a refused runner update). Three fixes, one test each:
//  1. the runner swap waits for a merge that is being pushed and recorded, not only for checks and agent runs;
//  2. a sweep reads main's newest first-parent commits from the runner and records any gate merge no ticket has
//     recorded (mergeCommit, mergedAt at the commit's own time, ticket moved on, assignee told), never twice;
//  3. a live commit that still can't be placed after that wakes the CEO once per commit, not on every sweep.
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type { MainLogResult, RunnerCommand } from "@boss-man/shared";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { activity, projects, runners, settings, tickets, wakes } from "../src/db/schema.js";
import { LIVE_UNPLACED_REASON, mergeSubjectTicket } from "../src/services/missed-merges.js";

const KEY = "k".repeat(43);
const sha = (c: string) => c.repeat(40);
const DIFF = { baseCommit: sha("a"), head: sha("b"), commits: [{ sha: sha("b"), subject: "Work" }], files: [{ path: "apps/server/src/x.ts", added: 1, removed: 0 }], diff: "diff --git a/apps/server/src/x.ts b/apps/server/src/x.ts", truncated: false };

let ctx: Awaited<ReturnType<typeof setup>> | undefined;
afterEach(async () => {
  await ctx?.app.close();
  await ctx?.close();
  if (ctx?.dir) await rm(ctx.dir, { recursive: true, force: true });
  ctx = undefined;
});

/** Polls until `f` is true, with a deadline: never a fixed sleep. */
async function until(f: () => Promise<boolean> | boolean, what: string, ms = 10_000) {
  const end = Date.now() + ms;
  while (!(await f())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function setup() {
  const dir = await mkdtemp(path.join(tmpdir(), "bm-missed-"));
  await mkdir(path.join(dir, "inbox"));
  await mkdir(path.join(dir, "outbox"));
  await writeFile(path.join(dir, "key"), `${KEY}\n`);
  // A stand-in launcher with one runner, "app-co", not yet on the new image; recreate puts it there.
  const fleet = new Map<string, { current: boolean }>([["app-co", { current: false }]]);
  const recreated: string[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const json = (status: number, b: unknown) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
    if (method === "GET" && url.pathname === "/runners") return json(200, [...fleet].map(([slug, r]) => ({ slug, state: "running", status: "Up", image: "boss-man-runner:current", current: r.current })));
    const m = /^\/runners\/([^/]+)\/recreate$/.exec(url.pathname);
    if (method === "POST" && m) {
      recreated.push(m[1]!);
      fleet.get(m[1]!)!.current = true;
      return json(200, { slug: m[1] });
    }
    if (method === "PUT") return json(200, { slug: url.pathname.split("/")[2], id: "x" });
    return json(404, { error: "unknown" });
  }) as typeof globalThis.fetch;
  const { db, close } = await openPglite();
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false, limits: { quickBatchMs: 0 }, workspaceRoot: "/ws", fetch, deployerDir: dir, launcher: { url: "http://launcher:3105", keyFile: path.join(dir, "key") } });
  const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
  const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
  const req = (method: "GET" | "POST" | "PATCH", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const { company, ceo } = (await req("POST", "/api/companies", { name: "App Co" })).json() as { company: { id: string }; ceo: { id: string } };
  const worker = (await req("POST", `/api/companies/${company.id}/agents`, { name: "Engineer" })).json() as { id: string };
  const project = (await req("POST", `/api/companies/${company.id}/projects`, { name: "Customer app" })).json() as { id: string };
  await req("PATCH", `/api/projects/${project.id}`, { repoUrl: "https://github.com/example/customer-app.git" });
  const reg = (await req("POST", `/api/companies/${company.id}/runner`)).json() as { runnerId: string };
  await db.insert(settings).values({ key: `runner-slug:${company.id}`, value: "app-co" }).onConflictDoUpdate({ target: settings.key, set: { value: "app-co" } });
  // The launcher's PUT named it by the company; the fake fleet holds "app-co" only.

  /** What main's newest first-parent commits are, as the runner reads them; filesFor adds each commit's files. */
  const main: Array<{ sha: string; subject: string; at: string; files: string[] }> = [];
  const mainLogAsks: Array<Extract<RunnerCommand, { type: "workspace.mainLog" }>> = [];
  /** When set, the runner holds its answer to the merge push until released (a push in flight). */
  let holdPush = false;
  const heldPush: Array<() => void> = [];
  built.runners.connect(
    reg.runnerId,
    (c) => {
      const ok = (data: unknown) => queueMicrotask(() => built.runners.resolveReply({ requestId: (c as { requestId: string }).requestId, ok: true, data }));
      if (c.type === "workspace.diff") ok(DIFF);
      if (c.type === "workspace.carried") ok({ carried: [] });
      if (c.type === "workspace.migrations") ok({ needed: false, reason: "free" });
      if (c.type === "workspace.merge") {
        const answer = () => ok({ status: "merged", commit: sha("c") });
        if (holdPush) heldPush.push(answer);
        else answer();
      }
      if (c.type === "workspace.mainLog") {
        mainLogAsks.push(c);
        const want = new Set(c.filesFor ?? []);
        const data: MainLogResult = { commits: main.slice(0, c.max).map((m) => ({ sha: m.sha, subject: m.subject, at: m.at, ...(want.has(m.sha) ? { files: m.files } : {}) })) };
        ok(data);
      }
      return true;
    },
    ["carried-check", "main-log"],
  );
  const row = async (id: string) => (await db.select().from(tickets).where(eq(tickets.id, id)))[0]!;
  const ticket = async (title: string, state: "review" | "in_progress" | "done" = "review") => {
    const t = (await req("POST", `/api/projects/${project.id}/tickets`, { title, assigneeAgentId: worker.id })).json() as { id: string };
    await db.update(tickets).set({ branch: `bossman/${t.id}`, systemState: state }).where(eq(tickets.id, t.id));
    return row(t.id);
  };
  const wakesOf = (agentId: string, reason: string) => db.select().from(wakes).where(and(eq(wakes.agentId, agentId), eq(wakes.reason, reason)));
  return { ...built, db, close, dir, req, company, ceo, worker, project, row, ticket, main, mainLogAsks, recreated, wakesOf, setHoldPush: (v: boolean) => (holdPush = v), heldPush };
}

describe("reading a gate merge subject (BOS-1645)", () => {
  it("names the ticket id of the gate's own merge message, and nothing else", () => {
    const id = "a8ae3af1-edea-42d0-83bb-73b810e8ca30";
    expect(mergeSubjectTicket(`Merge "Go-live line says "not live" (BOS-1601: 0c5917c5)" (${id})`)).toBe(id);
    expect(mergeSubjectTicket(`Merge "x" (${id.toUpperCase()})`)).toBe(id);
    expect(mergeSubjectTicket("Merge branch 'main' into bossman/x")).toBeNull();
    expect(mergeSubjectTicket(`Hotfix by hand (${id})`)).toBeNull();
    expect(mergeSubjectTicket(`Merge "x" (${id}) and more`)).toBeNull();
  });
});

describe("the runner swap waits for a merge being pushed (BOS-1645)", () => {
  it("a swap requested between push and record waits for the record, then goes ahead", async () => {
    const c = (ctx = await setup());
    const t = await c.ticket("Fix the thing");
    c.setHoldPush(true);
    await c.review.startLanding(t.id, "Sam", null, { skipChecks: true });
    // The push is on its way to the runner and has no answer yet: the merge is in its "merging" phase.
    await until(() => c.heldPush.length > 0, "the merge push");
    expect((await c.review.landingMergesByCompany()).get(c.company.id)).toBe(1);

    await c.req("POST", "/api/maintenance/start", {});
    await c.maintenance.step();
    expect(c.recreated).toEqual([]);
    // Even the owner's "stop the checks and update now" doesn't cut a push off.
    await c.db.update(settings).set({ value: { ...((await c.db.select().from(settings).where(eq(settings.key, "maintenance")))[0]!.value as object), force: true } }).where(eq(settings.key, "maintenance"));
    await c.maintenance.step();
    expect(c.recreated).toEqual([]);
    expect((await c.row(t.id)).mergeCommit).toBeNull();

    // The runner answers: the merge is recorded, and only then is the runner swapped.
    c.heldPush.shift()!();
    await until(async () => (await c.row(t.id)).mergeCommit === sha("c"), "the merge record");
    await until(async () => !(await c.review.landingMergesByCompany()).size, "the landing to end");
    await c.maintenance.step();
    expect(c.recreated).toEqual(["app-co"]);
    expect((await c.row(t.id)).systemState).toBe("done");
  });
});

describe("a merge on main that was never recorded (BOS-1645)", () => {
  it("is recorded by the next sweep: mergeCommit at the commit's time, ticket done, assignee told; never twice", async () => {
    const c = (ctx = await setup());
    const lost = await c.ticket("BOS-1635 stand-in");
    const recorded = await c.ticket("Already recorded");
    await c.db.update(tickets).set({ mergeCommit: sha("1"), mergedAt: new Date("2026-11-16T10:00:00Z"), systemState: "done" }).where(eq(tickets.id, recorded.id));
    const otherCompanysId = "0c5917c5-0000-4000-8000-000000000000";
    c.main.push(
      { sha: sha("3"), subject: "Hand-made commit, no ticket", at: "2026-11-16T11:20:00Z", files: [] },
      { sha: sha("2"), subject: `Merge "BOS-1635 stand-in" (${lost.id})`, at: "2026-11-16T11:13:00Z", files: ["apps/server/src/services/review.ts"] },
      { sha: sha("4"), subject: `Merge "someone else's" (${otherCompanysId})`, at: "2026-11-16T11:05:00Z", files: [] },
      { sha: sha("1"), subject: `Merge "Already recorded" (${recorded.id})`, at: "2026-11-16T10:00:00Z", files: [] },
    );

    const first = await c.review.recordMissedMerges();
    expect(first.recorded).toEqual([lost.id]);
    const r = await c.row(lost.id);
    expect(r.mergeCommit).toBe(sha("2"));
    // The commit's own time, so merge order (go-live, runner update) places it before later merges.
    expect(r.mergedAt?.toISOString()).toBe("2026-11-16T11:13:00.000Z");
    expect(r.systemState).toBe("done");
    // Its files were read, so it is known to be server-only rather than assumed to touch the runner.
    expect(r.touchesRunner).toBe(false);
    expect(c.mainLogAsks.at(-1)!.filesFor).toEqual([sha("2")]);
    expect((await c.row(recorded.id)).mergeCommit).toBe(sha("1"));
    const told = await c.wakesOf(c.worker.id, "merge recorded late");
    expect(told).toHaveLength(1);
    expect(told[0]!.note).toContain("don't merge or push it again");
    const trail = await c.db.select().from(activity).where(and(eq(activity.ticketId, lost.id), eq(activity.kind, "merge_recorded_late")));
    expect(trail).toHaveLength(1);

    // The next sweep finds nothing new: no second record, no second message.
    const second = await c.review.recordMissedMerges();
    expect(second.recorded).toEqual([]);
    expect(await c.db.select().from(activity).where(and(eq(activity.ticketId, lost.id), eq(activity.kind, "merge_recorded_late")))).toHaveLength(1);
    expect(await c.wakesOf(c.worker.id, "merge recorded late")).toHaveLength(1);
  });

  it("two records racing for one merge: exactly one wins", async () => {
    const c = (ctx = await setup());
    const t = await c.ticket("Raced");
    const both = await Promise.all([c.review.recordMissedMerge(t.id, sha("5"), { at: "2026-11-16T11:13:00Z" }), c.review.recordMissedMerge(t.id, sha("5"), { at: "2026-11-16T11:13:00Z" })]);
    expect(both.filter(Boolean)).toHaveLength(1);
    expect(await c.db.select().from(activity).where(and(eq(activity.ticketId, t.id), eq(activity.kind, "merge_recorded_late")))).toHaveLength(1);
  });

  it("a ticket already closed by hand only gets the merge facts: no state change, no message", async () => {
    const c = (ctx = await setup());
    const t = await c.ticket("Closed by hand", "done");
    c.main.push({ sha: sha("6"), subject: `Merge "Closed by hand" (${t.id})`, at: "2026-11-16T09:00:00Z", files: ["apps/runner/src/workspace.ts"] });
    expect((await c.review.recordMissedMerges()).recorded).toEqual([t.id]);
    const r = await c.row(t.id);
    expect(r.mergeCommit).toBe(sha("6"));
    expect(r.touchesRunner).toBe(true);
    expect(await c.wakesOf(c.worker.id, "merge recorded late")).toHaveLength(0);
  });

  it("a project with no repo is never asked about", async () => {
    const c = (ctx = await setup());
    const [r] = await c.db.select().from(runners).where(eq(runners.companyId, c.company.id));
    expect(c.runners.can(r!.id, "main-log")).toBe(true);
    const [p] = await c.db.select().from(projects).where(eq(projects.id, c.project.id));
    await c.db.update(projects).set({ repoUrl: null }).where(eq(projects.id, p!.id));
    await c.review.recordMissedMerges();
    expect(c.mainLogAsks).toHaveLength(0);
  });
});

describe("a live commit that still can't be placed (BOS-1645)", () => {
  it("wakes the CEO once per commit, not on every sweep, and forgets it once placed", async () => {
    const c = (ctx = await setup());
    const live = (s: string) => c.db.insert(settings).values({ key: `live_release:${c.company.id}`, value: { old: s, new: s } }).onConflictDoUpdate({ target: settings.key, set: { value: { old: s, new: s } } });
    await live(sha("7"));
    c.main.push({ sha: sha("7"), subject: "Hotfix pushed by hand", at: "2026-11-16T12:00:00Z", files: [] });

    await c.review.recordMissedMerges();
    const woken = await c.wakesOf(c.ceo.id, LIVE_UNPLACED_REASON);
    expect(woken).toHaveLength(1);
    expect(woken[0]!.note).toContain(sha("7").slice(0, 12));
    expect(woken[0]!.note).toContain("not a merge by the gate");
    // Later sweeps: the same commit never wakes again.
    await c.db.delete(wakes).where(eq(wakes.reason, LIVE_UNPLACED_REASON));
    await c.review.recordMissedMerges();
    await c.review.recordMissedMerges();
    expect(await c.wakesOf(c.ceo.id, LIVE_UNPLACED_REASON)).toHaveLength(0);

    // A different unplaceable commit is a new cause: one wake for it.
    await live(sha("8"));
    await c.review.recordMissedMerges();
    const again = await c.wakesOf(c.ceo.id, LIVE_UNPLACED_REASON);
    expect(again).toHaveLength(1);
    expect(again[0]!.note).toContain("isn't among main's newest");

    // Once the live commit is a recorded merge, the record clears and nobody is woken.
    const t = await c.ticket("Now placed", "done");
    await c.db.update(tickets).set({ mergeCommit: sha("8"), mergedAt: new Date() }).where(eq(tickets.id, t.id));
    await c.db.delete(wakes).where(eq(wakes.reason, LIVE_UNPLACED_REASON));
    await c.review.recordMissedMerges();
    expect(await c.wakesOf(c.ceo.id, LIVE_UNPLACED_REASON)).toHaveLength(0);
    expect(await c.db.select().from(settings).where(eq(settings.key, `live_unplaced:${c.company.id}`))).toHaveLength(0);
  });
});
