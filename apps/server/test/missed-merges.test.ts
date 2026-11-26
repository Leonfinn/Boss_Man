// BOS-1645 (R27): on 16 Nov BOS-1635's merge reached main at about 11:13, but a runner rebuild cut the gate off just after
// the push. Boss Man never recorded the merge, the ticket kept saying "not merged", and the live commit couldn't be placed
// (wrong "not live" answers, a refused runner update). Three fixes, one test each:
//  1. the runner swap waits for a merge that is being pushed and recorded, not only for checks and agent runs;
//  2. a sweep reads main's newest first-parent commits from the runner and records any gate merge no ticket has
//     recorded (mergeCommit, mergedAt at the commit's own time, ticket moved on, assignee told), never twice;
//  3. a live commit that still can't be placed after that wakes the CEO once per commit, not on every sweep.
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import type { MainLogResult, RunnerCommand } from "@boss-man/shared";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { activity, checkJobs, projects, runners, settings, ticketMerges, tickets, wakes } from "../src/db/schema.js";
import { gateMergeMessage, isGateMergeOf, LIVE_UNPLACED_REASON, mergeMessageTicket } from "../src/services/missed-merges.js";
import { allMergeOrder, serverHas } from "../src/services/go-live-wait.js";
import { runnerUpdateNeed } from "../src/services/runner-update-need.js";

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
  // An injected clock (BOS-1951): a test moves it forward instead of waiting.
  let offset = 0;
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false, limits: { quickBatchMs: 0 }, workspaceRoot: "/ws", now: () => new Date(Date.now() + offset), fetch, deployerDir: dir, launcher: { url: "http://launcher:3105", keyFile: path.join(dir, "key") } });
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
  const main: Array<{ sha: string; subject: string; message?: string; at: string; files: string[] }> = [];
  const mainLogAsks: Array<Extract<RunnerCommand, { type: "workspace.mainLog" }>> = [];
  /** When set, the runner holds its answer to the merge push until released (a push in flight). */
  let holdPush = false;
  const heldPush: Array<() => void> = [];
  /** The next merge's commit and changed files (BOS-2653: a ticket merged twice). */
  const next = { commit: sha("c"), files: DIFF.files };
  const starts: Array<Extract<RunnerCommand, { type: "run.start" }>> = [];
  built.runners.connect(
    reg.runnerId,
    (c) => {
      const ok = (data: unknown) => queueMicrotask(() => built.runners.resolveReply({ requestId: (c as { requestId: string }).requestId, ok: true, data }));
      if (c.type === "run.start") starts.push(c);
      if (c.type === "workspace.diff") ok({ ...DIFF, files: next.files });
      if (c.type === "workspace.carried") ok({ carried: [] });
      if (c.type === "workspace.migrations") ok({ needed: false, reason: "free" });
      if (c.type === "workspace.merge") {
        const commit = next.commit;
        const answer = () => ok({ status: "merged", commit });
        if (holdPush) heldPush.push(answer);
        else answer();
      }
      if (c.type === "workspace.mainLog") {
        mainLogAsks.push(c);
        const want = new Set(c.filesFor ?? []);
        const data: MainLogResult = { commits: main.slice(0, c.max).map((m) => ({ sha: m.sha, subject: m.subject, message: m.message ?? m.subject, at: m.at, ...(want.has(m.sha) ? { files: m.files } : {}) })) };
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
  return { ...built, db, close, dir, req, company, ceo, worker, project, row, ticket, main, mainLogAsks, recreated, next, runnerId: reg.runnerId, wakesOf, setHoldPush: (v: boolean) => (holdPush = v), heldPush, starts, advance: (ms: number) => (offset += ms) };
}

describe("reading a gate merge message (BOS-1645)", () => {
  const id = "a8ae3af1-edea-42d0-83bb-73b810e8ca30";
  const other = "0c5917c5-0000-4000-8000-000000000000";
  it("names the ticket id of the gate's own merge message, and nothing else", () => {
    expect(mergeMessageTicket(`Merge "Go-live line says "not live" (BOS-1601: 0c5917c5)" (${id})`)).toBe(id);
    expect(mergeMessageTicket(`Merge "x" (${id.toUpperCase()})`)).toBe(id);
    expect(mergeMessageTicket("Merge branch 'main' into bossman/x")).toBeNull();
    expect(mergeMessageTicket(`Hotfix by hand (${id})`)).toBeNull();
    expect(mergeMessageTicket(`Merge "x" (${id}) and more`)).toBeNull();
    // The whole message: a first paragraph naming another id is not what the message names.
    expect(mergeMessageTicket(`Merge "x" (${other})\n\nbar" (${id})`)).toBe(id);
  });

  it("the gate's message is one line, and only the exact message for a ticket's own row counts as its merge", () => {
    const evil = `x" (${other})\n\nbar`;
    expect(gateMergeMessage(evil, id)).toBe(`Merge "x" (${other}) bar" (${id})`);
    expect(isGateMergeOf(gateMergeMessage("Fix it", id), { id, title: "Fix it" })).toBe(true);
    // A merge made before the flattening, title line breaks and all, still counts for its own ticket.
    expect(isGateMergeOf(`Merge "${evil}" (${id})`, { id, title: evil })).toBe(true);
    // Neither form of the crafted title's merge is ever the other ticket's merge.
    expect(isGateMergeOf(`Merge "${evil}" (${id})`, { id: other, title: "x" })).toBe(false);
    expect(isGateMergeOf(gateMergeMessage(evil, id), { id: other, title: "x" })).toBe(false);
    // A message naming the right id but a different title (a hand-made look-alike) is not recorded either.
    expect(isGateMergeOf(`Merge "Something else" (${id})`, { id, title: "Fix it" })).toBe(false);
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

// BOS-2058 (20 Nov 11:44): a landing record that has stopped beating is not work. The record said "merging since 11:23" while the
// Merges tab showed nothing running, and it held the runner swap. A wait counts live work only: no heartbeat, no hold.
describe("a landing that stopped beating doesn't hold the runner swap (BOS-2058)", () => {
  it("is counted while its ticket beats, and dropped once the ticket has been silent longer than a merge can take", async () => {
    const c = (ctx = await setup());
    const t = await c.ticket("Fix the orphaned thing");
    c.setHoldPush(true);
    await c.review.startLanding(t.id, "Sam", null, { skipChecks: true });
    await until(() => c.heldPush.length > 0, "the merge push");
    expect((await c.review.landingMergesByCompany()).get(c.company.id)).toBe(1);
    expect((await c.review.landingWaitFacts()).ids).toEqual([t.id]);
    // The record is still "running" and "merging", but nothing has beat for a day.
    await c.db.update(tickets).set({ lastActivityAt: new Date(Date.now() - 24 * 60 * 60_000) }).where(eq(tickets.id, t.id));
    expect((await c.review.landingMergesByCompany()).size).toBe(0);
    expect(await c.review.landingWaitFacts()).toEqual({ since: null, ids: [], names: [], endsAt: null });
    await c.req("POST", "/api/maintenance/start", {});
    await c.maintenance.step();
    expect(c.recreated).toEqual(["app-co"]); // the swap does not wait for it
    c.heldPush.shift()!();
  });
});

// BOS-1954 (19 Nov 22:13) dropped a "merging" landing whose merge check was queued; BOS-2479 replaced that exception with
// one rule: only the push call counts. A merge waiting for its check, a train seat or GitHub CI is not in a push call, so it
// never counts (landing-wait-pushing.test.ts); a push call under way counts whatever the check queue holds.
describe("only a push under way holds the runner swap (BOS-1954, BOS-2479)", () => {
  it("a push in flight is waited for even with a merge check row queued for the ticket, and stops counting when it ends", async () => {
    const c = (ctx = await setup());
    const t = await c.ticket("Fix the other thing");
    c.setHoldPush(true);
    await c.review.startLanding(t.id, "Sam", null, { skipChecks: true });
    await until(() => c.heldPush.length > 0, "the merge push");
    await c.db.insert(checkJobs).values({ companyId: c.company.id, projectId: c.project.id, ticketId: t.id, kind: "merge", scope: "full", commit: sha("b"), tree: "t1", state: "queued" });
    expect((await c.review.landingMergesByCompany()).get(c.company.id)).toBe(1);
    // The Merges tab shows that push in Running now, so the banner's "being pushed" always has a row to match.
    expect(c.review.runningMerges().find((m) => m.ticketId === t.id)?.pushingSince).toEqual(expect.any(String));
    await c.req("POST", "/api/maintenance/start", {});
    await c.maintenance.step();
    expect(c.recreated).toEqual([]);
    c.heldPush.shift()!();
    await until(async () => !(await c.review.landingMergesByCompany()).size, "the landing to end");
    await c.maintenance.step();
    expect(c.recreated).toEqual(["app-co"]);
  });
});

// BOS-1951: on 19 Nov the banner said only "runner updating" and the owner's CEO chat was paused for the whole wait, because
// the banner and the chat allowance counted agent runs and checks but not the merges being pushed (or anything else).
describe("what holds the swap is named, and chat keeps answering until the swap itself (BOS-1951)", () => {
  type Status = { phase: string; overdue: boolean; chatOpen: boolean; merges: number; mergesList: Array<{ ticket: string | null }>; unknownWait: boolean; expectedFinishAt: string | null };
  /** Owner chat message, then one scheduling pass: how many new runs it started. */
  async function chatStarts(c: Awaited<ReturnType<typeof setup>>) {
    const before = c.starts.length;
    await c.req("POST", `/api/companies/${c.company.id}/chat`, { text: "Are you there?" });
    await c.scheduler.tick();
    return c.starts.length - before;
  }

  it("a merge being pushed is named in the status, the swap waits, and chat is answered meanwhile", async () => {
    const c = (ctx = await setup());
    const t = await c.ticket("Fix the thing");
    c.setHoldPush(true);
    await c.review.startLanding(t.id, "Sam", null, { skipChecks: true });
    await until(() => c.heldPush.length > 0, "the merge push");
    await c.req("POST", "/api/maintenance/start", {});
    const st = (await c.req("GET", "/api/maintenance")).json() as Status;
    expect(st).toMatchObject({ phase: "waiting", merges: 1, chatOpen: true, unknownWait: false, expectedFinishAt: null, overdue: false });
    expect(st.mergesList).toHaveLength(1);
    expect(st.mergesList[0]!.ticket).toMatch(/-\d+$/); // named by its ticket reference
    // BOS-2479: the latest go-ahead is given (the drain's own end here, later than the push's 20-minute cap); no worker checks.
    const extra = st as unknown as { goAheadAt: string | null; workerChecksList: unknown[] };
    expect(Date.parse(extra.goAheadAt!)).toBeGreaterThan(Date.now());
    expect(extra.workerChecksList).toEqual([]);
    // Chat is answered although no agent run or check is going: the old code held it (wake stayed queued "update pending").
    expect(await chatStarts(c)).toBe(1);
    // Past the hold's deadline it is running late, still named, still answering.
    c.advance(31 * 60_000);
    expect(((await c.req("GET", "/api/maintenance")).json() as Status)).toMatchObject({ merges: 1, overdue: true, chatOpen: true });
    c.heldPush.shift()!();
    await until(async () => !(await c.review.landingMergesByCompany()).size, "the landing to end");
  });

  it("held by nothing it can name: first 'swapping', then it says late; chat answers throughout (BOS-2404)", async () => {
    const c = (ctx = await setup());
    await c.req("POST", "/api/maintenance/start", {});
    // The first minutes: "swapping", but no runner is being recreated yet, so chat answers (BOS-1951 held it here).
    expect(((await c.req("GET", "/api/maintenance")).json() as Status)).toMatchObject({ phase: "swapping", unknownWait: false, chatOpen: true });
    expect(await chatStarts(c)).toBe(1);
    // Nothing swapped it by 3 minutes: late, said so, chat is open (the 19 Nov wait was 86 minutes of this).
    c.advance(3 * 60_000);
    expect(((await c.req("GET", "/api/maintenance")).json() as Status)).toMatchObject({ phase: "waiting", overdue: true, unknownWait: true, chatOpen: true, expectedFinishAt: null });
    // The chat run started above is still answering (one chat run per agent at a time).
    expect(((await c.req("GET", `/api/companies/${c.company.id}/chat`)).json() as { state: string }).state).toBe("answering");
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

  it("a title holding a blank line and another ticket's id never closes that other ticket (Jane, BOS-1645)", async () => {
    const c = (ctx = await setup());
    const victim = await c.ticket("Victim, still in review");
    // A's title, as an agent could set it: its merge's first paragraph (git's %s) would read as the victim's merge.
    const title = `x" (${victim.id})\n\nbar`;
    const a = await c.ticket("placeholder");
    await c.db.update(tickets).set({ title }).where(eq(tickets.id, a.id));
    const old = `Merge "${title}" (${a.id})`;
    c.main.push({ sha: sha("9"), subject: `Merge "x" (${victim.id})`, message: old, at: "2026-11-16T11:30:00Z", files: [] });

    // The sweep reads the whole message: it is A's merge (A is recorded), never the victim's.
    expect((await c.review.recordMissedMerges()).recorded).toEqual([a.id]);
    const v = await c.row(victim.id);
    expect(v.mergeCommit).toBeNull();
    expect(v.systemState).toBe("review");
    expect((await c.row(a.id)).mergeCommit).toBe(sha("9"));
    // And the gate now writes that title on one line, so even git's %s ends in A's own id.
    expect(gateMergeMessage(title, a.id).split("\n")).toHaveLength(1);
  });

  it("a message naming a ticket that isn't exactly its gate merge message records nothing", async () => {
    const c = (ctx = await setup());
    const t = await c.ticket("Real title");
    c.main.push({ sha: sha("e"), subject: `Merge "Look-alike" (${t.id})`, at: "2026-11-16T11:40:00Z", files: [] });
    expect((await c.review.recordMissedMerges()).recorded).toEqual([]);
    expect((await c.row(t.id)).mergeCommit).toBeNull();
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

// BOS-2653 (25-26 Nov): BOS-2627 merged as 25dcf039, the deployer switched to it and the runners were built from it; the
// ticket was reopened and merged again as 4595cb74, which overwrote tickets.mergeCommit. Merge order then had no 25dcf039,
// so Settings → Updates said the runners were built from "a merge Boss Man never recorded", and a runner change in the
// first merge could have been counted as "runners not needed". Every merge of a ticket is now kept.
describe("a ticket merged twice keeps both merges (BOS-2653)", () => {
  const live = (c: NonNullable<typeof ctx>, s: string) =>
    c.db.insert(settings).values({ key: `live_release:${c.company.id}`, value: { old: s, new: s } }).onConflictDoUpdate({ target: settings.key, set: { value: { old: s, new: s } } });
  const image = (c: NonNullable<typeof ctx>, s: string) => c.db.update(runners).set({ imageCommit: s }).where(eq(runners.id, c.runnerId));

  it("through the gate: the first merge's runner change still counts, and a version built from it is placed", async () => {
    const c = (ctx = await setup());
    // An earlier merge the runners were built from.
    const older = await c.ticket("Older work", "done");
    await c.db.update(tickets).set({ mergeCommit: sha("0"), mergedAt: new Date("2026-11-01T10:00:00Z"), touchesRunner: false }).where(eq(tickets.id, older.id));

    // First merge: changes runner code.
    const t = await c.ticket("CEO manages at risk");
    c.next.commit = sha("c");
    c.next.files = [{ path: "apps/runner/src/workspace.ts", added: 1, removed: 0 }];
    await c.review.startLanding(t.id, "Sam", null, { skipChecks: true });
    await until(async () => (await c.row(t.id)).mergeCommit === sha("c"), "the first merge record");
    await until(async () => !(await c.review.landingMergesByCompany()).size, "the first landing to end");

    // Reopened for a second round, then merged again: server code only.
    await c.db.update(tickets).set({ systemState: "review" }).where(eq(tickets.id, t.id));
    c.next.commit = sha("d");
    c.next.files = [{ path: "apps/server/src/x.ts", added: 1, removed: 0 }];
    await c.review.startLanding(t.id, "Sam", null, { skipChecks: true });
    await until(async () => (await c.row(t.id)).mergeCommit === sha("d"), "the second merge record");

    const kept = await c.db.select().from(ticketMerges).where(eq(ticketMerges.ticketId, t.id));
    expect(kept.map((m) => [m.commit, m.touchesRunner]).sort()).toEqual([
      [sha("c"), true],
      [sha("d"), false],
    ]);
    expect(await allMergeOrder(c.db, c.company.id)).toEqual([sha("0"), sha("c"), sha("d")]);

    // Runners built before both merges, server on the second: the first merge's runner change makes an update needed
    // (before the fix: only the second merge was in range, server-only, so "up to date").
    await image(c, sha("0"));
    await live(c, sha("d"));
    expect(await runnerUpdateNeed(c.db, c.company.id)).toMatchObject({ state: "needed" });

    // Runners built from the first merge (25dcf039's case): placed, not "isn't a merge Boss Man recorded".
    await image(c, sha("c"));
    expect(await runnerUpdateNeed(c.db, c.company.id)).toMatchObject({ state: "not_needed" });
    // And a server running the first merge contains it, and not yet the second.
    expect(serverHas(sha("c"), sha("c"), await allMergeOrder(c.db, c.company.id))).toEqual({ state: "yes" });
    expect(serverHas(sha("c"), sha("d"), await allMergeOrder(c.db, c.company.id))).toEqual({ state: "no" });
  });

  it("the sweep adds an earlier merge of a ticket that already has one, without touching the ticket", async () => {
    const c = (ctx = await setup());
    const t = await c.ticket("Merged twice", "done");
    await c.db.update(tickets).set({ mergeCommit: sha("e"), mergedAt: new Date("2026-11-16T12:00:00Z"), touchesRunner: false }).where(eq(tickets.id, t.id));
    c.main.push(
      { sha: sha("e"), subject: `Merge "Merged twice" (${t.id})`, at: "2026-11-16T12:00:00Z", files: ["apps/server/src/x.ts"] },
      { sha: sha("f"), subject: "Hand-made commit, no ticket", at: "2026-11-16T11:30:00Z", files: [] },
      { sha: sha("d"), subject: `Merge "Merged twice" (${t.id})`, at: "2026-11-16T11:00:00Z", files: ["apps/runner/src/workspace.ts"] },
    );

    expect((await c.review.recordMissedMerges()).recorded).toEqual([]);
    const r = await c.row(t.id);
    expect([r.mergeCommit, r.systemState, r.touchesRunner]).toEqual([sha("e"), "done", false]);
    const kept = await c.db.select().from(ticketMerges).where(eq(ticketMerges.ticketId, t.id));
    expect(kept.map((m) => [m.commit, m.touchesRunner, m.mergedAt.toISOString()])).toEqual([[sha("d"), true, "2026-11-16T11:00:00.000Z"]]);
    expect(c.mainLogAsks.at(-1)!.filesFor).toEqual([sha("d")]);
    expect(await allMergeOrder(c.db, c.company.id)).toEqual([sha("d"), sha("e")]);
    expect(await c.wakesOf(c.worker.id, "merge recorded late")).toHaveLength(0);

    // Never twice.
    const asks = c.mainLogAsks.length;
    await c.review.recordMissedMerges();
    expect(c.mainLogAsks.length).toBe(asks + 1); // the log read only, no second files read
    expect(await c.db.select().from(ticketMerges).where(eq(ticketMerges.ticketId, t.id))).toHaveLength(1);
  });

  // BOS-2654: merged once, reopened, merged again, and the gate's answer to the second merge lost (a runner restart).
  // Before: the sweep only added the second merge to the ticket's merges; the ticket stayed open as "not merged".
  it("a reopened ticket whose second merge wasn't recorded is closed by the sweep, its assignee told; never twice", async () => {
    const c = (ctx = await setup());
    const t = await c.ticket("Merged again");
    await c.db.update(tickets).set({ mergeCommit: sha("a"), mergedAt: new Date("2026-11-16T11:00:00Z"), touchesRunner: true }).where(eq(tickets.id, t.id));
    // Its first merge is older than main's log read: the newer one is told by its time.
    const far = await c.ticket("Merged again, long ago", "in_progress");
    await c.db.update(tickets).set({ mergeCommit: sha("9"), mergedAt: new Date("2026-11-01T09:00:00Z") }).where(eq(tickets.id, far.id));
    c.main.push(
      { sha: sha("b"), subject: `Merge "Merged again" (${t.id})`, at: "2026-11-16T12:00:00Z", files: ["apps/server/src/x.ts"] },
      { sha: sha("8"), subject: `Merge "Merged again, long ago" (${far.id})`, at: "2026-11-16T11:30:00Z", files: ["apps/server/src/y.ts"] },
      { sha: sha("a"), subject: `Merge "Merged again" (${t.id})`, at: "2026-11-16T11:00:00Z", files: ["apps/runner/src/workspace.ts"] },
    );

    expect((await c.review.recordMissedMerges()).recorded.sort()).toEqual([t.id, far.id].sort());
    const r = await c.row(t.id);
    expect([r.mergeCommit, r.mergedAt?.toISOString(), r.systemState, r.touchesRunner]).toEqual([sha("b"), "2026-11-16T12:00:00.000Z", "done", false]);
    const f = await c.row(far.id);
    expect([f.mergeCommit, f.systemState]).toEqual([sha("8"), "done"]);
    // Both merges of each are kept, the first with its own runner change, so merge order places both.
    const kept = await c.db.select().from(ticketMerges).where(eq(ticketMerges.ticketId, t.id));
    expect(kept.map((m) => [m.commit, m.touchesRunner, m.mergedAt.toISOString()]).sort()).toEqual([
      [sha("a"), true, "2026-11-16T11:00:00.000Z"],
      [sha("b"), false, "2026-11-16T12:00:00.000Z"],
    ]);
    expect(await allMergeOrder(c.db, c.company.id)).toEqual([sha("9"), sha("a"), sha("8"), sha("b")]);
    expect(await c.wakesOf(c.worker.id, "merge recorded late")).toHaveLength(2);

    // The next sweep finds nothing new.
    expect((await c.review.recordMissedMerges()).recorded).toEqual([]);
    expect(await c.db.select().from(activity).where(and(eq(activity.ticketId, t.id), eq(activity.kind, "merge_recorded_late")))).toHaveLength(1);
    expect(await c.wakesOf(c.worker.id, "merge recorded late")).toHaveLength(2);
  });

  it("a reopened ticket with no newer merge on main, and a done one, are left as they are", async () => {
    const c = (ctx = await setup());
    // Reopened after its merge, not merged again: its recorded merge is still main's newest for it.
    const open = await c.ticket("Reopened, not merged again");
    await c.db.update(tickets).set({ mergeCommit: sha("c"), mergedAt: new Date("2026-11-16T12:00:00Z") }).where(eq(tickets.id, open.id));
    // Reopened; its recorded merge is older than the log read, and the only one on main is older still.
    const old = await c.ticket("Recorded merge is newer", "in_progress");
    await c.db.update(tickets).set({ mergeCommit: sha("5"), mergedAt: new Date("2026-11-16T13:00:00Z") }).where(eq(tickets.id, old.id));
    // Done: a newer merge is only added to its merges, never "closes" it again.
    const done = await c.ticket("Done already", "done");
    await c.db.update(tickets).set({ mergeCommit: sha("d"), mergedAt: new Date("2026-11-16T10:00:00Z") }).where(eq(tickets.id, done.id));
    c.main.push(
      { sha: sha("e"), subject: `Merge "Done already" (${done.id})`, at: "2026-11-16T12:30:00Z", files: [] },
      { sha: sha("c"), subject: `Merge "Reopened, not merged again" (${open.id})`, at: "2026-11-16T12:00:00Z", files: [] },
      { sha: sha("6"), subject: `Merge "Recorded merge is newer" (${old.id})`, at: "2026-11-16T11:00:00Z", files: [] },
      { sha: sha("d"), subject: `Merge "Done already" (${done.id})`, at: "2026-11-16T10:00:00Z", files: [] },
    );

    expect((await c.review.recordMissedMerges()).recorded).toEqual([]);
    expect([(await c.row(open.id)).mergeCommit, (await c.row(open.id)).systemState]).toEqual([sha("c"), "review"]);
    expect([(await c.row(old.id)).mergeCommit, (await c.row(old.id)).systemState]).toEqual([sha("5"), "in_progress"]);
    expect([(await c.row(done.id)).mergeCommit, (await c.row(done.id)).systemState]).toEqual([sha("d"), "done"]);
    expect((await c.db.select().from(ticketMerges).where(eq(ticketMerges.ticketId, done.id))).map((m) => m.commit)).toEqual([sha("e")]);
    expect(await c.wakesOf(c.worker.id, "merge recorded late")).toHaveLength(0);
  });

  it("the migration backfills each ticket's merge and the earlier merges the merge line recorded", async () => {
    const c = (ctx = await setup());
    const t = await c.ticket("BOS-2627 stand-in", "done");
    await c.db.update(tickets).set({ mergeCommit: sha("9"), mergedAt: new Date("2026-11-26T00:00:35Z"), touchesRunner: false }).where(eq(tickets.id, t.id));
    for (const [commit, at] of [
      [sha("8"), "2026-11-25T22:03:40Z"],
      [sha("9"), "2026-11-26T00:00:35Z"],
    ] as const)
      await c.db.insert(activity).values({ companyId: c.company.id, ticketId: t.id, kind: "merge_line", summary: "Merge line: merged", detail: { event: "merged", commit }, at: new Date(at) });
    await c.db.insert(activity).values({ companyId: c.company.id, ticketId: t.id, kind: "merge_line", summary: "Merge line: merged", detail: { event: "merged", commit: null } });
    await c.db.delete(ticketMerges);

    // Found by name: the gate may renumber the migration.
    const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "drizzle");
    const file = (await readdir(dir)).find((f) => /^\d{4}_ticket_merges\.sql$/.test(f))!;
    const inserts = (await readFile(path.join(dir, file), "utf8")).split("--> statement-breakpoint").filter((s) => s.includes('INSERT INTO "ticket_merges"'));
    expect(inserts).toHaveLength(2);
    for (const s of inserts) await c.db.execute(sql.raw(s));
    for (const s of inserts) await c.db.execute(sql.raw(s)); // runs again harmlessly

    const kept = await c.db.select().from(ticketMerges).where(eq(ticketMerges.ticketId, t.id));
    expect(kept.map((m) => [m.commit, m.mergedAt.toISOString(), m.touchesRunner]).sort()).toEqual([
      [sha("8"), "2026-11-25T22:03:40.000Z", null],
      [sha("9"), "2026-11-26T00:00:35.000Z", false],
    ]);
    expect(await allMergeOrder(c.db, c.company.id)).toEqual([sha("8"), sha("9")]);
  });
});
