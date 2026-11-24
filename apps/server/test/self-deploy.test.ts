import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { buildApp } from "../src/app.js";
import { DEPLOY_UNCHANGED_REASON, selfDeployService } from "../src/services/self-deploy.js";
import { setOwnerTodoFacts } from "../src/services/decisions.js";
import { signedInOwner } from "./helpers/owner-session.js";
import { openPglite } from "../src/db/client.js";
import { commandProblem, lintOwnerSteps, parseStep, sh, step } from "../src/services/steps.js";
import { agents, companies, activity, decisions, notifications, projects, settings, tickets, wakes } from "../src/db/schema.js";

let ctx: Awaited<ReturnType<typeof setup>> | undefined;
afterEach(async () => {
  await ctx?.app.close();
  await ctx?.close();
  if (ctx?.dir) await rm(ctx.dir, { recursive: true, force: true });
  ctx = undefined;
});

const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);
// What the host reports about itself (BOS-269): a deliberately non-default install, blue/green with green live.
const LAYOUT = { srcDir: "/srv/bm/src", deployerDir: "/srv/bm/deployer", bluegreen: true, liveColour: "green" };

async function setup(opts: { deployer?: boolean } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "bm-deployer-"));
  await mkdir(path.join(dir, "inbox"));
  await mkdir(path.join(dir, "outbox"));
  // What the host recorded about itself (BOS-427): its name goes on every command block.
  // BOS-990: it reports a deployer script that is the live version, so no "copy the deployer script" card is raised here.
  await writeFile(path.join(dir, "outbox", "host.json"), JSON.stringify({ version: 1, name: "nas01", writtenAt: "2026-10-20T12:00:00Z", ownership: [], deployer: { scriptSha: "1".repeat(64), repoSha: "1".repeat(64) } }));
  // The app uses a counting handle on the same database, so a test can prove a pass made no queries (BOS-414).
  const made: string[] = [];
  const logQuery = { logQuery: (sql: string) => made.push(sql) };
  const { db, close } = await openPglite(undefined, logQuery);
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false, deployerDir: opts.deployer === false ? undefined : dir });
  const cookie = await signedInOwner(db);
  const req = (method: "GET" | "POST" | "PUT", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  await req("POST", "/api/companies", { name: "App Co" });
  // The poller skips a pass when a file keeps its size and mtime (BOS-414), and a file system stamps mtime
  // to a coarse tick: two same-sized writes within one tick looked untouched (BOS-560). Each write gets
  // its own mtime, a second later than the last, so a rewrite is always a change, however fast the runner.
  let stamp = Date.now() / 1000;
  const outbox = async (name: string, body: unknown) => {
    const file = path.join(dir, "outbox", name);
    await writeFile(file, JSON.stringify(body));
    stamp += 1;
    await utimes(file, stamp, stamp);
  };
  const available = (over: Record<string, unknown> = {}) =>
    outbox("available.json", { version: 1, checkedAt: "2026-10-20T12:00:00Z", deployed: A, tip: B, commits: [{ sha: B, subject: "Add rate limiting" }], paths: ["apps/server/src/x.ts"], infraPaths: [], runnerChanged: false, ...over });
  const status = (over: Record<string, unknown>) =>
    outbox("status.json", { id: "", target: "server", result: "deployed", message: "Deployed.", from_commit: A, to_commit: B, started: "2026-10-20T12:01:00Z", ended: "2026-10-20T12:03:00Z", backup: "", ...over });
  const open = async () => (await db.select().from(decisions).where(eq(decisions.status, "open"))).filter((d) => (d.context as { type: string }).type === "self_deploy");
  const todos = async () => (await db.select().from(decisions).where(eq(decisions.status, "open"))).filter((d) => (d.context as { type: string }).type === "owner_todo");
  return { ...built, db, close, dir, req, available, status, open, todos, made };
}

describe("self-deploy (docs/09-self-deploy.md)", () => {
  it("saves the ticked runner add-ons for the host script and keeps ids it carries (BOS-1583)", async () => {
    const c = (ctx = await setup());
    expect((await c.req("GET", "/api/self-deploy/runner-addons")).json()).toEqual({ enabled: true, saved: null, built: null });
    // What update-runner.sh recorded after its last build: one add-on, plus one this catalogue does not list.
    await writeFile(path.join(c.dir, "outbox", "runner-addons.built"), "agent-browser,future-thing\n");
    expect((await c.req("GET", "/api/self-deploy/runner-addons")).json()).toMatchObject({ saved: null, built: ["agent-browser", "future-thing"] });
    const put = await c.req("PUT", "/api/self-deploy/runner-addons", { ids: ["webkit", "webkit", "nope"] });
    // Unknown ids from the owner are dropped; the one already built and unknown here is carried, so nothing is lost.
    expect(put.json()).toEqual({ saved: ["future-thing", "webkit"] });
    expect(await readFile(path.join(c.dir, "inbox", "runner-addons"), "utf8")).toBe("future-thing,webkit\n");
    expect((await readdir(path.join(c.dir, "inbox"))).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    // Unticking everything saves an empty line: the plain image.
    expect((await c.req("PUT", "/api/self-deploy/runner-addons", { ids: [] })).json()).toEqual({ saved: ["future-thing"] });
  });

  it("Recent updates pages older rows with `before`, newest first (BOS-2277)", async () => {
    const c = (ctx = await setup());
    const [co] = await c.db.select().from(companies);
    const ids: string[] = [];
    for (let i = 0; i < 7; i++) {
      const at = new Date(Date.UTC(2026, 9, 1 + i));
      const [d] = await c.db
        .insert(decisions)
        .values({ companyId: co!.id, kind: "question", tier: "owner", question: `u${i}`, options: ["Done"], recommendedOption: "Done", status: "answered", answeredAt: at, context: { type: "self_deploy", target: "server", commit: A, changes: [] } as never })
        .returning();
      ids.push(d!.id);
    }
    const newest = ids.slice().reverse(); // newest first
    const first = (await c.req("GET", "/api/self-deploy/history?limit=3")).json() as { id: string }[];
    expect(first.map((r) => r.id)).toEqual(newest.slice(0, 3));
    const next = (await c.req("GET", `/api/self-deploy/history?limit=10&before=${first[2]!.id}`)).json() as { id: string }[];
    expect(next.map((r) => r.id)).toEqual(newest.slice(3));
    const none = (await c.req("GET", `/api/self-deploy/history?before=${ids[0]}`)).json();
    expect(none).toEqual([]);
  });

  it("Recent updates settles old server rows with no result and counts the real changes (BOS-2549)", async () => {
    const c = (ctx = await setup());
    await c.available({});
    const [co] = await c.db.select().from(companies);
    const named = Array.from({ length: 20 }, (_, i) => ({ ticketId: `t${i}`, ref: `BOS-${i}`, title: `T${i}` }));
    const add = async (day: number, commit: string, update?: object) =>
      (await c.db.insert(decisions).values({ companyId: co!.id, kind: "question", tier: "owner", question: `u${day}`, options: ["Done"], recommendedOption: "Done", status: "answered", answeredAt: new Date(Date.UTC(2026, 9, day)), context: { type: "self_deploy", target: "server", commit, changes: ["a", "b"], ...(update ? { update } : {}) } as never }).returning())[0]!.id;
    const replaced = await add(1, "c".repeat(40));
    const live = await add(2, A, { changes: named, more: 18, total: 90 });
    const newest = await add(3, "d".repeat(40));
    const rows = (await c.req("GET", "/api/self-deploy/history?limit=10")).json() as { id: string; result: string | null; changes: number; shown: number; replacedBy: string | null }[];
    const by = (id: string) => rows.find((r) => r.id === id)!;
    expect(by(newest).result).toBeNull(); // the newest unfinished one may still wait
    expect(by(live)).toMatchObject({ result: "deployed", changes: 38, shown: 20 });
    expect(by(replaced)).toMatchObject({ result: "replaced", replacedBy: A.slice(0, 8), changes: 2, shown: 2 });
  });

  it("refuses to save add-ons when self-deploy is not set up (BOS-1583)", async () => {
    const c = (ctx = await setup({ deployer: false }));
    expect((await c.req("GET", "/api/self-deploy/runner-addons")).json()).toMatchObject({ enabled: false });
    expect((await c.req("PUT", "/api/self-deploy/runner-addons", { ids: ["webkit"] })).statusCode).toBe(409);
  });

  it("tells the owner a refused runner update is only a note, in plain words (BOS-364)", async () => {
    const c = (ctx = await setup());
    await c.status({ id: randomUUID(), target: "runner", result: "rejected", message: "The runners were not updated. Nothing is broken and nothing needs doing now.", to_commit: B, ended: "2026-10-20T12:03:00Z" });
    await c.selfDeploy.sync();
    expect((await c.db.select().from(notifications))[0]).toMatchObject({ level: "note", title: expect.stringContaining("Runner update not started") });
  });

  describe("the staging line on a deploy card (BOS-1472)", () => {
    const stagingResult = (over: Record<string, unknown>) => ({ id: randomUUID(), target: "staging", result: "deployed", message: "Staging runs it.", to_commit: B, started: "2026-10-20T12:00:00Z", ended: "2026-10-20T12:05:00Z", at: "2026-10-20T12:05:00Z", smoke: "passed", ...over });
    const cardFor = async (c: Awaited<ReturnType<typeof setup>>) => {
      await c.available();
      await c.selfDeploy.sync();
      const [d] = await c.open();
      return d!.question;
    };

    it("says not checked when staging has nothing for this commit", async () => {
      const c = (ctx = await setup());
      expect(await cardFor(c)).toContain("Staging: not checked.");
    });

    it("says passed on the commit when staging deployed exactly it and every smoke check passed", async () => {
      const c = (ctx = await setup());
      await writeFile(path.join(c.dir, "outbox", "staging-status.json"), JSON.stringify(stagingResult({})));
      expect(await cardFor(c)).toContain(`Staging: passed on ${B.slice(0, 8)}.`);
    });

    it("asks staging to check the commit once when a card is open, and keeps the card's line true to the result", async () => {
      const c = (ctx = await setup());
      const request = path.join(c.dir, "inbox", "staging-request.json");
      await c.selfDeploy.stagingTick(); // lane off: nothing is asked
      await writeFile(path.join(c.dir, "outbox", "staging-lane.json"), JSON.stringify({ configured: "true" }));
      await cardFor(c);
      await c.selfDeploy.stagingTick();
      expect(JSON.parse(await readFile(request, "utf8"))).toMatchObject({ target: "staging", commit: B });
      expect((await c.open())[0]!.question).toMatch(/Staging: being checked now/);
      await rm(request); // the host took it
      await c.selfDeploy.stagingTick(); // asked once per commit
      await expect(readFile(request, "utf8")).rejects.toThrow();
      await writeFile(path.join(c.dir, "outbox", "staging-status.json"), JSON.stringify(stagingResult({})));
      await c.selfDeploy.stagingTick();
      const q = (await c.open())[0]!.question;
      expect(q).toContain(`Staging: passed on ${B.slice(0, 8)}.`);
      expect(q.match(/Staging:/g)).toHaveLength(1);
    });

    it("names the failed checks, and says not checked on this commit when staging runs another one", async () => {
      const c = (ctx = await setup());
      await writeFile(path.join(c.dir, "outbox", "staging-status.json"), JSON.stringify(stagingResult({ smoke: "failed", failed_checks: "board, signin" })));
      expect(await cardFor(c)).toContain(`Staging: failed on ${B.slice(0, 8)} (board, signin).`);
      const d = (ctx = await setup());
      await writeFile(path.join(d.dir, "outbox", "staging-status.json"), JSON.stringify(stagingResult({ to_commit: A })));
      expect(await cardFor(d)).toContain(`not checked on this commit (staging runs ${A.slice(0, 8)})`);
    });
  });

  it("does not offer again a commit the host just refused as no longer the tip, until the host rewrites the offer", async () => {
    const c = (ctx = await setup());
    await c.status({ id: randomUUID(), result: "rejected", message: "Rejected: not the tip of main.", to_commit: B, ended: "2026-10-20T12:03:00Z" });
    await c.available({ checkedAt: "2026-10-20T12:00:00Z" });
    await c.selfDeploy.sync();
    expect(await c.open()).toHaveLength(0);
    await c.available({ checkedAt: "2026-10-20T12:04:00Z" });
    await c.selfDeploy.sync();
    expect(await c.open()).toHaveLength(1);
  });

  it("does not offer the commit it just deployed while the host's offer still names it", async () => {
    const c = (ctx = await setup());
    await c.status({ id: randomUUID(), result: "deployed", to_commit: B, ended: "2026-10-20T12:03:00Z" });
    await c.available({ checkedAt: "2026-10-20T12:00:00Z" });
    await c.selfDeploy.sync();
    expect(await c.open()).toHaveLength(0);
  });

  it("raises one owner decision when main moves, and approving it writes the request file", async () => {
    const c = (ctx = await setup());
    await c.available({ commits: [{ sha: B, subject: "Add rate limiting" }], paths: ["apps/server/src/x.ts", "apps/server/drizzle/0049_x.sql", "apps/server/drizzle/meta/_journal.json", "apps/server/drizzle/meta/0049_snapshot.json"] });
    await c.selfDeploy.sync();
    await c.selfDeploy.sync();
    const [d] = await c.open();
    expect(d!.question).toContain("4 files changed, 1 database migration.");
    expect(await c.open()).toHaveLength(1);
    expect(d).toMatchObject({ tier: "owner", options: ["Deploy", "Not now"], recommendedOption: "Deploy", context: { type: "self_deploy", target: "server", commit: B, fromCommit: A } });
    expect((d!.context as { update: { total: number; otherCommits: string[] } }).update).toMatchObject({ total: 1, otherCommits: ["Add rate limiting"] });
    expect(await c.notes.syncDecisions()).toBe(1);
    expect((await c.db.select().from(notifications))[0]).toMatchObject({ level: "ask", decisionId: d!.id });

    expect((await c.req("POST", `/api/decisions/${d!.id}/answer`, { answer: "Deploy" })).statusCode).toBe(200);
    const files = await readdir(path.join(c.dir, "inbox"));
    // BOS-753: the checked merges go beside the request (an empty list here: nothing has merged in this test).
    expect(files.sort()).toEqual(["checked", "request.json"]);
    const body = JSON.parse(await readFile(path.join(c.dir, "inbox", "request.json"), "utf8"));
    expect(body).toMatchObject({ id: d!.id, target: "server", commit: B });
    expect(Object.keys(body).sort()).toEqual(["approvedBy", "commit", "id", "requestedAt", "target"]);
    // A request is already waiting for the host, so nothing new is raised or approved until it is taken.
    await c.available({ tip: C });
    await c.selfDeploy.sync();
    expect(await c.open()).toHaveLength(0);
  });

  it("lists only the cards a restart would reset on the update card, not every owner to-do (BOS-551)", async () => {
    const c = (ctx = await setup());
    const [co] = await c.db.select().from(companies);
    const raise = (question: string, context: Record<string, unknown>) =>
      c.db.insert(decisions).values({ companyId: co!.id, kind: "question", tier: "owner", question, options: ["Done", "Skip"], recommendedOption: "Done", context: context as never }).returning();
    // A measurement the raising agent marked as reset by a restart: it must be done before the update.
    const [measure] = await raise("Read the memory figure", { type: "question", steps: ["Read the memory figure in Settings."], resetsOnRestart: true });
    // An unrelated setup card with steps: it must not clutter the update card.
    await raise("Turn on ntfy", { type: "question", steps: ["Open Settings → Add-ons → ntfy."] });
    // An update hand-apply to-do: it is itself an update, so leave it out.
    await c.db.insert(decisions).values({ companyId: co!.id, kind: "approval", tier: "owner", question: "Apply the last update by hand", options: ["Done"], recommendedOption: "Done", context: { type: "owner_todo", ofDecisionId: randomUUID(), steps: ["Apply it."], target: "server" } as never });

    await c.available({ commits: [{ sha: B, subject: "Add rate limiting" }], paths: ["apps/server/src/x.ts"] });
    await c.selfDeploy.sync();
    const [d] = await c.open();
    expect((d!.context as { doAfter?: Array<{ decisionId: string; label: string }> }).doAfter).toEqual([{ decisionId: measure!.id, label: "Read the memory figure" }]);
  });

  it("names the merged tickets and what changes the risk, on the card and the to-do (BOS-213)", async () => {
    const c = (ctx = await setup());
    const [co] = await c.db.select().from(companies).limit(1);
    await c.db.update(companies).set({ ticketPrefix: "BOS" }).where(eq(companies.id, co!.id));
    const [p] = await c.db.insert(projects).values({ companyId: co!.id, name: "Development" }).returning();
    const [t191] = await c.db.insert(tickets).values({ companyId: co!.id, projectId: p!.id, title: "rebuild-live.sh waits on hosts without node", number: 191 }).returning();
    const [t200] = await c.db.insert(tickets).values({ companyId: co!.id, projectId: p!.id, title: "Plan page titles are cut off", number: 200 }).returning();
    await c.available({
      commits: [
        { sha: C, subject: `Merge "rebuild-live.sh waits on hosts without node" (${t191!.id})` },
        { sha: B, subject: `Merge "Plan page titles are cut off" (${t200!.id})` },
        { sha: A, subject: "Bump a dependency" },
      ],
      paths: ["scripts/rebuild-live.sh", "apps/server/drizzle/0050_x.sql", "apps/launcher/src/main.ts", "scripts/host-deployer.sh", "apps/runner/Dockerfile"],
      infraPaths: ["scripts/rebuild-live.sh", "scripts/host-deployer.sh"],
      runnerChanged: true,
    });
    await c.selfDeploy.sync();
    const [d] = await c.open();
    type Update = { from: string; to: string; total: number; files: number; changes: Array<{ ticketId: string; ref: string; title: string }>; otherCommits: string[]; handBecause?: string; handFiles?: string[]; handEffect?: "server" | "deployer" | "both"; needsDeployerCopy?: boolean; needsRunnerUpdate?: boolean; risks: string[] };
    const update = (d!.context as { update: Update }).update;
    expect(update).toMatchObject({
      from: A,
      to: B,
      total: 3,
      files: 5,
      changes: [
        { ticketId: t191!.id, ref: "BOS-191", title: "rebuild-live.sh waits on hosts without node" },
        { ticketId: t200!.id, ref: "BOS-200", title: "Plan page titles are cut off" },
      ],
      otherCommits: ["Bump a dependency"],
    });
    expect(update.handBecause).toContain("scripts/rebuild-live.sh");
    expect(update.handFiles).toEqual(["scripts/rebuild-live.sh", "scripts/host-deployer.sh"]);
    expect(update.handEffect).toBe("both");
    expect(update.needsDeployerCopy).toBe(true);
    expect(update.needsRunnerUpdate).toBe(true);
    expect(update.risks.join(" ")).toContain("database migration");
    expect(update.risks.join(" ")).toContain("host-deployer.sh");
    expect(update.risks.join(" ")).toContain("launcher");
    expect(update.risks.join(" ")).toContain("runner");
    // The steps are on the approval card before it is approved (BOS-213).
    expect((d!.context as { handSteps: string[] }).handSteps.length).toBeGreaterThan(0);
    await c.req("POST", `/api/decisions/${d!.id}/answer`, { answer: "Approve" });
    const [todo] = await c.todos();
    expect((todo!.context as { update: Update }).update).toEqual(update);
  });

  it("a newer server update card covers the older hand-apply to-do and lists the tickets it carries (BOS-683, DR-036)", async () => {
    const c = (ctx = await setup());
    const [co] = await c.db.select().from(companies).limit(1);
    await c.db.update(companies).set({ ticketPrefix: "BOS" }).where(eq(companies.id, co!.id));
    const [p] = await c.db.insert(projects).values({ companyId: co!.id, name: "Development" }).returning();
    const [t490] = await c.db.insert(tickets).values({ companyId: co!.id, projectId: p!.id, title: "rebuild-live.sh fix", number: 490 }).returning();
    // An older server hand-apply to-do is open: its commit (C) was approved but never applied.
    await c.db.insert(decisions).values({ companyId: co!.id, kind: "question", tier: "owner", question: "Apply the last update by hand", options: ["Done"], recommendedOption: "Done", dedupeKey: `owner-todo:self-deploy:${C}`, context: { type: "owner_todo", ofDecisionId: randomUUID(), steps: ["Apply it."], target: "server", commit: C, fromCommit: A } as never });
    // Main moves again, carrying BOS-490, and the host offers the newer commit by hand.
    await c.available({ deployed: A, tip: B, commits: [{ sha: B, subject: `Merge "rebuild-live.sh fix" (${t490!.id})` }], paths: ["scripts/rebuild-live.sh"], infraPaths: ["scripts/rebuild-live.sh"] });
    await c.selfDeploy.sync();
    // The new card is raised, and it names the ticket it carries.
    const [card] = await c.open();
    expect(card!.question).toContain("BOS-490: rebuild-live.sh fix");
    // The older to-do is gone from the owner's queue, having been marked covered by the newer card.
    const [remaining] = await c.todos();
    expect(remaining).toBeUndefined();
    const answered = (await c.db.select().from(decisions)).find((d) => (d.context as { type: string; commit?: string }).type === "owner_todo" && (d.context as { commit?: string }).commit === C);
    expect(answered!.status).toBe("answered");
    expect(answered!.answer).toContain(`Covered by the newer update card ("Main has moved to ${B.slice(0, 8)}")`);
    expect(answered!.answer).toContain("BOS-490");
  });

  it("shows the first 20 tickets and says how many more there are (BOS-213)", async () => {
    const c = (ctx = await setup());
    const [co] = await c.db.select().from(companies).limit(1);
    await c.db.update(companies).set({ ticketPrefix: "BOS" }).where(eq(companies.id, co!.id));
    const [p] = await c.db.insert(projects).values({ companyId: co!.id, name: "Development" }).returning();
    const commits: Array<{ sha: string; subject: string }> = [];
    for (let i = 1; i <= 21; i++) {
      const [t] = await c.db.insert(tickets).values({ companyId: co!.id, projectId: p!.id, title: `Change ${i}`, number: 300 + i }).returning();
      commits.push({ sha: `${i}`.padStart(40, "0"), subject: `Merge "Change ${i}" (${t!.id})` });
    }
    await c.available({ commits, paths: ["apps/server/src/x.ts"] });
    await c.selfDeploy.sync();
    const [d] = await c.open();
    const update = (d!.context as { update: { total: number; changes: unknown[]; more: number } }).update;
    expect(update.total).toBe(21);
    expect(update.changes).toHaveLength(20);
    expect(update.more).toBe(1);
  });

  // BOS-1826: the host sent only the newest 30 commits, so the card said "30 changes" however many were waiting, and a
  // live fix further back lost its urgent heading. The host now sends the whole range; this pins that the server counts
  // and reads all of it: 120 commits, a live fix at the 45th, and every commit counted once as a ticket or another commit.
  it("counts and heads a range of 120 commits, a live fix at the 45th still heading the card (BOS-1826)", async () => {
    const c = (ctx = await setup());
    const [co] = await c.db.select().from(companies).limit(1);
    await c.db.update(companies).set({ ticketPrefix: "BOS" }).where(eq(companies.id, co!.id));
    const [p] = await c.db.insert(projects).values({ companyId: co!.id, name: "Development" }).returning();
    const commits: Array<{ sha: string; subject: string }> = [];
    const sha = () => (commits.length + 1).toString(16).padStart(40, "0");
    const ids: string[] = [];
    for (let i = 1; i <= 25; i++) {
      const [t] = await c.db.insert(tickets).values({ companyId: co!.id, projectId: p!.id, title: `Change ${i}`, number: 1000 + i, ...(i === 12 ? { fixesLive: "the board is blank" } : {}) }).returning();
      ids.push(t!.id);
      commits.push({ sha: sha(), subject: `Merge "Change ${i}" (${t!.id})` });
      for (let k = 1; k <= 3; k++) commits.push({ sha: sha(), subject: `Step ${k} of change ${i}` });
    }
    commits.push({ sha: sha(), subject: `Merge "Change 2" (${ids[1]})` }); // a ticket merged a second time
    while (commits.length < 120) commits.push({ sha: sha(), subject: `Bump ${commits.length}` });
    expect(commits.findIndex((x) => x.subject.includes(ids[11]!))).toBe(44);
    await c.available({ commits, paths: ["scripts/rebuild-live.sh", "apps/server/src/x.ts"], infraPaths: ["scripts/rebuild-live.sh"] });
    await c.selfDeploy.sync();
    const [d] = await c.open();
    type U = { total: number; changes: unknown[]; more: number; otherCommits: string[]; otherMore?: number };
    const u = (d!.context as { update: U }).update;
    expect(u.total).toBe(120);
    expect(u.changes).toHaveLength(20);
    expect(u.more).toBe(5);
    expect(u.otherCommits).toHaveLength(30);
    expect(u.otherMore).toBe(65);
    // Every commit is counted once: 25 tickets, plus 95 others (75 branch steps, the repeat merge, 19 bumps).
    expect(u.changes.length + u.more + u.otherCommits.length + u.otherMore!).toBe(u.total);
    const heading = "Urgent: contains the fix for the board is blank (BOS-1012)";
    expect(d!.question.split("\n\n")[0]).toBe(`${heading}.`);
    // The card that clears an older one names 10 tickets and counts the other 15, not only those past the 20th.
    expect(d!.question).toContain("BOS-1010: Change 10; and 15 more.");
    // Main moves on by one commit: the fix is still in the range, so the new card is headed again but is a repeat.
    await c.available({ tip: C, commits: [{ sha: C, subject: "Tidy a comment" }, ...commits], paths: ["scripts/rebuild-live.sh"], infraPaths: ["scripts/rebuild-live.sh"] });
    await c.selfDeploy.sync();
    const [d2] = await c.open();
    expect(d2!.id).not.toBe(d!.id);
    expect((d2!.context as { urgent?: { heading: string; repeat?: boolean } }).urgent).toMatchObject({ heading, repeat: true });
    expect((d2!.context as { update: U }).update.total).toBe(121);
  });

  it("will not take a second approval while a deploy is running, and withdraws a question main has outrun", async () => {
    const c = (ctx = await setup());
    await c.available();
    await c.selfDeploy.sync();
    const [first] = await c.open();
    await c.available({ tip: C });
    await c.selfDeploy.sync();
    const [second] = await c.open();
    expect(second!.id).not.toBe(first!.id);
    expect((await c.db.select().from(decisions).where(eq(decisions.id, first!.id)))[0]!.status).toBe("withdrawn");
    await c.status({ id: second!.id, result: "running", message: "Running", ended: "" });
    const r = await c.req("POST", `/api/decisions/${second!.id}/answer`, { answer: "Deploy" });
    expect(r.statusCode).toBe(422);
    expect(r.json().message).toContain("running");
    expect((await readdir(path.join(c.dir, "inbox"))).length).toBe(0);
  });

  it("tells the owner how it went once, and offers the runner update as its own decision", async () => {
    const c = (ctx = await setup());
    await c.available({ runnerChanged: true, commits: [{ sha: B, subject: 'Merge "Plan: rate limits" (x)' }, { sha: A, subject: "Add rate limiting" }] });
    await c.selfDeploy.sync();
    const [d] = await c.open();
    await c.req("POST", `/api/decisions/${d!.id}/answer`, { answer: "Deploy" });
    await rm(path.join(c.dir, "inbox", "request.json"));
    await c.status({ id: d!.id, result: "deployed", message: "Deployed aaaaaaaa to bbbbbbbb." });
    await c.available({ deployed: B, tip: B });
    await c.selfDeploy.sync();
    await c.selfDeploy.sync();
    const told = await c.db.select().from(notifications);
    expect(told).toHaveLength(1);
    expect(told[0]).toMatchObject({ level: "note", title: `Boss Man updated to ${B.slice(0, 8)}`, decisionId: null, body: "Deployed aaaaaaaa to bbbbbbbb.\n\nWhat changed:\n- Add rate limiting" });
    expect((await c.db.select().from(decisions).where(eq(decisions.id, d!.id)))[0]!.context).toMatchObject({ result: { result: "deployed" } });
    const [runner] = await c.open();
    expect(runner).toMatchObject({ options: ["Update runners", "Not now"], context: { type: "self_deploy", target: "runner", commit: B } });
    expect(runner!.question).toContain(`This rebuilds the runner containers from the version Boss Man runs (${B.slice(0, 8)}); the server itself doesn't change.`);
    // BOS-1805: the host's offer (here still listing "Add rate limiting") is what the next SERVER deploy brings; the runner
    // image is built from the live commit, so the runner card never lists that range as its own.
    expect((runner!.context as { update?: unknown; changes?: unknown }).update).toBeUndefined();
    expect((runner!.context as { changes?: unknown }).changes).toBeUndefined();
    expect((await c.req("POST", `/api/decisions/${runner!.id}/answer`, { answer: "Update runners" })).statusCode).toBe(200);
    expect(JSON.parse(await readFile(path.join(c.dir, "inbox", "request.json"), "utf8"))).toMatchObject({ target: "runner", commit: B });
    expect((await c.req("GET", "/api/self-deploy")).json()).toMatchObject({ enabled: true, pending: true, status: { result: "deployed" } });
  });

  // BOS-835: the merge gate runs in the runner, so a server update alone leaves it on old code (BOS-690's
  // renumbering was on main and live on the server, yet BOS-619 and BOS-708 still bounced).
  it("names Build and update runners and the stale merge gate on a server card whose update changes runner code", async () => {
    const c = (ctx = await setup());
    await c.available({ runnerChanged: true });
    await c.selfDeploy.sync();
    const [d] = await c.open();
    expect(d!.question).toContain("Settings → Server and runner → Updates → Build and update runners");
    expect(d!.question).toContain("the merge gate keeps running the old code");
    const risks = (d!.context as { update: { risks: string[] } }).update.risks;
    expect(risks.some((r) => r.includes("Build and update runners") && r.includes("merge gate"))).toBe(true);
  });

  it("says nothing about the runners on a server card whose update leaves runner code alone", async () => {
    const c = (ctx = await setup());
    await c.available({ runnerChanged: false });
    await c.selfDeploy.sync();
    const [d] = await c.open();
    expect(d!.question).not.toContain("Build and update runners");
    expect(d!.question).not.toContain("merge gate");
    const risks = (d!.context as { update: { risks: string[] } }).update.risks;
    expect(risks.some((r) => r.includes("merge gate") || r.includes("Build and update runners"))).toBe(false);
  });

  // QA (BOS-848): the hand-apply card is built on another branch of the same code, and the runner's own card must not repeat the line.
  it("names the stale merge gate in the risks of a hand-apply card whose update changes runner code, and not otherwise", async () => {
    const c = (ctx = await setup());
    await c.available({ infraPaths: ["docker-compose.yml"], paths: ["docker-compose.yml", "apps/runner/Dockerfile"], runnerChanged: true });
    await c.selfDeploy.sync();
    const [yes] = await c.open();
    const yesRisks = (yes!.context as { update: { risks: string[] } }).update.risks;
    expect(yesRisks.some((r) => r.includes("Build and update runners") && r.includes("merge gate"))).toBe(true);
    await c.db.delete(decisions);
    await c.available({ infraPaths: ["docker-compose.yml"], paths: ["docker-compose.yml"], runnerChanged: false });
    await c.selfDeploy.sync();
    const [no] = await c.open();
    const noRisks = (no!.context as { update: { risks: string[] } }).update.risks;
    expect(noRisks.some((r) => r.includes("merge gate") || r.includes("Build and update runners"))).toBe(false);
  });

  it("does not add the 'after this, rebuild the runners' line to the runner update card itself", async () => {
    const c = (ctx = await setup());
    await c.available({ runnerChanged: true });
    await c.req("POST", "/api/self-deploy/update-runners");
    const runnerCards = (await c.open()).filter((d) => (d.context as { target?: string }).target === "runner");
    expect(runnerCards.length).toBeGreaterThan(0);
    for (const d of runnerCards) expect(d.question).not.toContain("the merge gate keeps running the old code");
  });

  it("pages the owner when a deploy fails, and flags a refusal", async () => {
    const c = (ctx = await setup());
    await c.status({ id: "", result: "failed", message: "server not healthy after 120s" });
    await c.selfDeploy.sync();
    await c.status({ id: "not-a-uuid", result: "rejected", message: "Rejected: only one server deploy every 10 minutes." });
    await c.selfDeploy.sync();
    expect((await c.db.select().from(notifications)).map((n) => n.level).sort()).toEqual(["flag", "page"]);
  });

  it("leaves an owner to-do with the steps, the check and the rollback when a hand-apply change is approved", async () => {
    const c = (ctx = await setup());
    await c.available({ infraPaths: ["docker-compose.yml"], paths: ["docker-compose.yml"], ...LAYOUT });
    await c.selfDeploy.sync();
    const [d] = await c.open();
    expect(d).toMatchObject({ options: ["Approve", "Not now"], context: { infra: true } });
    expect(d!.question).toContain("applied by hand");
    // Only the server's deployment files changed: no deployer copy or runner update is needed (BOS-218).
    expect((d!.context as { update: { handEffect?: string; needsDeployerCopy?: boolean; needsRunnerUpdate?: boolean } }).update).toMatchObject({ handEffect: "server", needsDeployerCopy: false, needsRunnerUpdate: false });
    expect((await c.req("POST", `/api/decisions/${d!.id}/answer`, { answer: "Approve" })).statusCode).toBe(200);
    // Nothing goes to the host: the change can only be applied by hand.
    expect(await readdir(path.join(c.dir, "inbox"))).toEqual([]);
    // The approval clears, and an owner to-do takes its place on the queue.
    expect((await c.db.select().from(decisions).where(eq(decisions.id, d!.id)))[0]!.status).toBe("answered");
    const [todo] = await c.todos();
    // A server update offers to quiet the machine first (BOS-420).
    expect(todo).toMatchObject({ kind: "question", tier: "owner", options: ["Quiet the machine first", "Done, it's applied", "A step failed"], recommendedOption: "Quiet the machine first" });
    expect(todo!.context).toMatchObject({ type: "owner_todo", ofDecisionId: d!.id, target: "server", commit: B, fromCommit: A });
    const steps = (todo!.context as { steps: string[] }).steps;
    expect(steps.length).toBeGreaterThan(1);
    // The approved commit is pinned in every step: main may have moved on by the time it is applied (BOS-124).
    expect(steps.join("\n")).toContain(B);
    expect(steps.join("\n")).not.toContain("origin/main");
    expect(todo!.context).toMatchObject({ check: expect.stringContaining(B.slice(0, 8)), rollback: expect.stringContaining(A) });
    expect(todo!.question).toContain("waiting for you to apply it by hand");
    // Every command is written in full, with the folders the host reported.
    expect(steps.join("\n")).toContain("cd /srv/bm/src && git checkout main");
    // git runs in a umask 022 subshell (DR-028): under a root shell's 077 the checkout came out unreadable on 6 Nov.
    expect(steps.join("\n")).toContain("\n(umask 022 && cd /srv/bm/src && git checkout main && git fetch origin && git merge --ff-only " + B + " && git rev-parse HEAD)\n");
    // This change touches neither the deployer nor the launcher.
    expect(steps.join("\n")).toContain("host-deployer.sh didn't change; no copy needed.");
    expect(steps.join("\n")).not.toContain("chown root:root");
    expect(steps.join("\n")).not.toContain("docker compose build launcher");
    // The card still checks that the new server took charge, and how to recover it.
    expect(steps.join("\n")).toContain("docker compose kill -s SIGUSR2 server-green");
    expect(todo!.context).toMatchObject({ check: expect.stringContaining("This server: Role reads leader (or single on a server that runs one copy)") });
    // No fixed claim about the watchdog (a per-company setting an update never changes) or a vague Reviews look.
    expect((todo!.context as { check: string }).check).not.toMatch(/watchdog|look as expected/i);
    expect(todo!.context).toMatchObject({ rollback: expect.stringContaining("\n(umask 022 && cd /srv/bm/src && git checkout " + A + " && scripts/rebuild-live.sh)\n") });
  });

  describe("hand-apply cards (BOS-269)", () => {
    const stepsOf = async (c: Awaited<ReturnType<typeof setup>>, over: Record<string, unknown>) => {
      await c.available({ infraPaths: ["docker-compose.yml"], paths: ["docker-compose.yml"], ...over });
      await c.selfDeploy.sync();
      const [d] = await c.open();
      return d!.context as { handSteps?: string[]; rollback?: string; infra?: boolean; update?: { needsRunnerUpdate?: boolean } };
    };
    const commands = (texts: string[]) => texts.flatMap((t) => parseStep(t)).filter((p) => p.type === "command").map((p) => p.text);

    it("uses the folders the host reports and never the guide's", async () => {
      const c = (ctx = await setup());
      const x = await stepsOf(c, { ...LAYOUT, bluegreen: false });
      const text = [...x.handSteps!, x.rollback!].join("\n");
      // deploy.sh's own git checkout/merge write the checkout, so both run in the umask subshell (DR-028).
      expect(commands(x.handSteps!)).toContain("(umask 022 && cd /srv/bm/src && scripts/deploy.sh --commit " + B + ")");
      expect(text).not.toContain("rebuild-live.sh");
      expect(text).not.toContain("/mnt/tank/apps/boss-man");
      expect(commands([x.rollback!])).toEqual(["(umask 022 && cd /srv/bm/src && scripts/deploy.sh --rollback)"]);
    });

    it("picks rebuild-live.sh on blue/green and uses the reported live colour", async () => {
      const c = (ctx = await setup());
      const x = await stepsOf(c, LAYOUT);
      const cmds = commands(x.handSteps!);
      expect(cmds).toContain("cd /srv/bm/src && scripts/rebuild-live.sh");
      expect(cmds.some((k) => k.startsWith("cd /srv/bm/src && docker compose exec -T server-green "))).toBe(true);
      expect(cmds.join("\n")).not.toContain("scripts/deploy.sh");
      expect(x.rollback).toContain("scripts/rebuild-live.sh");
    });

    it("says plainly when the folder or layout is not reported, and prints no guessed command", async () => {
      const c = (ctx = await setup());
      const x = await stepsOf(c, {}); // an older host script reports neither
      const text = [...x.handSteps!, x.rollback!].join("\n");
      expect(commands(x.handSteps!)).toEqual([]);
      expect(text).not.toContain("```");
      expect(text).not.toContain("/mnt/tank/apps/boss-man");
      expect(text).toContain("can't tell where it is installed");
      expect(text).toContain("can't tell whether this install runs blue/green");
      expect(x.rollback).toContain("no command is shown");
    });

    it("does not print a folder that is unsafe to paste", async () => {
      const c = (ctx = await setup());
      const x = await stepsOf(c, { ...LAYOUT, srcDir: "/srv/my bm/src; rm -rf /" });
      expect(commands(x.handSteps!).join("\n")).not.toContain("rm -rf");
      expect(x.handSteps!.join("\n")).toContain("can't tell where it is installed");
    });

    it("shows no command when the host hasn't recorded its name yet (BOS-427), and still passes the lint", async () => {
      const c = (ctx = await setup());
      await rm(path.join(c.dir, "outbox", "host.json"));
      const x = await stepsOf(c, LAYOUT);
      expect(commands(x.handSteps!)).toEqual([]);
      expect([...x.handSteps!, x.rollback!].join("\n")).toContain("hasn't been told this machine's name");
      expect(lintOwnerSteps([...x.handSteps!, x.rollback!]).refuse).toEqual([]);
    });

    it("adds the rebuild-the-runners step only when the runner changed, and the card agrees", async () => {
      const c = (ctx = await setup());
      const no = await stepsOf(c, LAYOUT);
      expect(no.handSteps!.join("\n")).not.toContain("Build and update runners");
      expect(no.update!.needsRunnerUpdate).toBe(false);
      await c.db.delete(decisions);
      const yes = await stepsOf(c, { ...LAYOUT, runnerChanged: true, paths: ["docker-compose.yml", "apps/runner/Dockerfile"] });
      expect(yes.handSteps!.join("\n")).toContain("Build and update runners");
      expect(yes.update!.needsRunnerUpdate).toBe(true);
    });

    it("does not need applying by hand for a build-only script such as the icon generator", async () => {
      const c = (ctx = await setup());
      // The host decides infraPaths; make-app-icons.mjs is not on its list, so it arrives as an ordinary change.
      await c.available({ infraPaths: [], paths: ["scripts/make-app-icons.mjs", "apps/web/public/icon.png"] });
      await c.selfDeploy.sync();
      const [d] = await c.open();
      expect(d!.options).toEqual(["Deploy", "Not now"]);
      expect((d!.context as { infra?: boolean }).infra).toBeUndefined();
    });

    it("passes the owner-step lint on every hand-apply card Boss Man can build, and never points to a guide (BOS-417)", async () => {
      const c = (ctx = await setup());
      const layouts: Array<Record<string, unknown>> = [{}, LAYOUT, { ...LAYOUT, bluegreen: false }, { ...LAYOUT, liveColour: undefined }, { ...LAYOUT, deployerDir: undefined }, { srcDir: LAYOUT.srcDir }, { bluegreen: true }, { bluegreen: false }];
      const changes: Array<Record<string, unknown>> = [
        {},
        { infraPaths: ["scripts/host-deployer.sh"], paths: ["scripts/host-deployer.sh"] },
        { paths: ["docker-compose.yml", "apps/launcher/src/main.ts"] },
        { paths: ["docker-compose.yml", "apps/runner/Dockerfile"], runnerChanged: true },
        { infraPaths: ["scripts/host-deployer.sh"], paths: ["scripts/host-deployer.sh", "apps/launcher/src/main.ts", "apps/runner/Dockerfile"], runnerChanged: true },
      ];
      let cards = 0;
      let gitCommands = 0;
      for (const layout of layouts)
        for (const change of changes) {
          await c.db.delete(decisions);
          const x = (await stepsOf(c, { ...layout, ...change })) as { handSteps?: string[]; rollback?: string; check?: string };
          const all = [...x.handSteps!, ...(x.rollback ? [x.rollback] : []), ...(x.check ? [x.check] : [])];
          const where = JSON.stringify({ layout, change });
          // R11 (DR-024) is an agent's claim about rehearsal, checked when an agent raises a card (checkAsk); these
          // cards are Boss Man's own and never go through it, so only the other rules apply.
          expect(lintOwnerSteps(all, [{ name: "nas01", ownership: [] }]).refuse.filter((f) => f.rule !== "R11"), where).toEqual([]);
          expect(all.join("\n"), where).not.toMatch(/docs\/0\d/);
          // Every git the server writes runs in the umask subshell (DR-028), never after a bare umask; so does
          // deploy.sh, which runs git checkout/merge itself (the lint can't see inside a script).
          for (const k of commands(all).filter((k) => /\bgit\b|scripts\/deploy\.sh/.test(k))) {
            expect(k, where).toMatch(/^\(umask 022 && cd \/srv\/bm\/src && (git|scripts\/deploy\.sh) [^()]*\)/);
            gitCommands++;
          }
          cards++;
        }
      expect(cards).toBe(40);
      // The pin and the blue/green rollback are among them, so the loop above checked something.
      expect(gitCommands).toBeGreaterThan(20);
      // The 6 Nov card's own bare steps are refused by the lint (R14), so a generator that dropped the subshell fails here.
      for (const bare of ["cd /srv/bm/src && git checkout main && git fetch origin && git merge --ff-only " + B + " && git rev-parse HEAD", "cd /srv/bm/src && git checkout " + A + " && scripts/rebuild-live.sh"])
        expect(lintOwnerSteps([step("Run this:", sh(bare, { host: "nas01", as: "root" }))], [{ name: "nas01", ownership: [] }]).refuse.map((f) => f.rule)).toContain("R14");
      // The old fallback fails it, so this test would have caught it.
      expect(lintOwnerSteps(["Boss Man can't tell where it is installed, so no command is shown here. The folder is in docs/06-install-truenas.md; ask us on this ticket for the exact commands."]).refuse).not.toEqual([]);
    });

    it("renders every command as its own block holding only the command, on the recorded host as root (BOS-427)", async () => {
      const c = (ctx = await setup());
      const x = await stepsOf(c, { ...LAYOUT, infraPaths: ["scripts/host-deployer.sh"], paths: ["scripts/host-deployer.sh", "apps/launcher/src/main.ts"], runnerChanged: true });
      const all = [...x.handSteps!, x.rollback!];
      const cmds = commands(all);
      expect(cmds.length).toBeGreaterThan(4);
      for (const k of cmds) expect(commandProblem(k)).toBeNull();
      // Each fenced block is exactly one command; no command text is left in the sentences.
      for (const t of all) for (const p of parseStep(t)) if (p.type === "text") expect(p.text).not.toMatch(/\b(?:cd \/|scripts\/|docker compose|git (?:checkout|merge))/);
      // Every block says where it runs and as whom; the host line is not part of what the owner pastes.
      expect(all.join("\n").match(/```sh host="nas01" as="root"\n/g)!.length).toBe(cmds.length);
    });
  });

  it("copies host-deployer.sh and rebuilds the launcher only when the change touches them", async () => {
    const c = (ctx = await setup());
    await c.available({ infraPaths: ["scripts/host-deployer.sh"], paths: ["scripts/host-deployer.sh", "apps/launcher/src/main.ts"], ...LAYOUT });
    await c.selfDeploy.sync();
    const [d] = await c.open();
    // The deployer is the only deployment file touched, so hand-applying only needs the copy (BOS-218).
    const update = (d!.context as { update: { handEffect?: string; needsDeployerCopy?: boolean; needsRunnerUpdate?: boolean } }).update;
    expect(update).toMatchObject({ handEffect: "deployer", needsDeployerCopy: true, needsRunnerUpdate: false });
    await c.req("POST", `/api/decisions/${d!.id}/answer`, { answer: "Approve" });
    const [todo] = await c.todos();
    const steps = (todo!.context as { steps: string[] }).steps;
    const text = steps.join("\n");
    expect(text).toContain(
      "install -v -m 0750 -o root -g root /srv/bm/src/scripts/host-deployer.sh /srv/bm/deployer/host-deployer.sh",
    );
    expect(text).not.toContain("host-deployer.sh didn't change");
    expect(text).toContain("docker compose build launcher && docker compose up -d --no-deps launcher");
    expect(text).toContain("Runners keep their old limits until the next runner update.");
  });

  it("clears the owner to-do when the owner marks it done", async () => {
    const c = (ctx = await setup());
    await c.available({ infraPaths: ["docker-compose.yml"], paths: ["docker-compose.yml"] });
    await c.selfDeploy.sync();
    const [d] = await c.open();
    await c.req("POST", `/api/decisions/${d!.id}/answer`, { answer: "Approve" });
    const [todo] = await c.todos();
    expect((await c.req("POST", `/api/decisions/${todo!.id}/answer`, { answer: "Done, it's applied" })).statusCode).toBe(200);
    expect(await c.open()).toHaveLength(0);
    expect(await c.todos()).toHaveLength(0);
    expect((await c.db.select().from(decisions).where(eq(decisions.id, todo!.id)))[0]!.status).toBe("answered");
  });

  it("keeps the owner to-do while the live commit is still what ran at approval", async () => {
    const c = (ctx = await setup());
    await c.available({ infraPaths: ["docker-compose.yml"], paths: ["docker-compose.yml"] });
    await c.selfDeploy.sync();
    const [d] = await c.open();
    await c.req("POST", `/api/decisions/${d!.id}/answer`, { answer: "Approve" });
    // The host still reports the old commit: nothing has been applied yet.
    await c.available({ deployed: A, tip: A, infraPaths: ["docker-compose.yml"], paths: ["docker-compose.yml"] });
    await c.selfDeploy.sync();
    expect(await c.todos()).toHaveLength(1);
  });

  it("clears the owner to-do once the live commit changes, without the owner doing anything", async () => {
    const c = (ctx = await setup());
    await c.available({ infraPaths: ["docker-compose.yml"], paths: ["docker-compose.yml"] });
    await c.selfDeploy.sync();
    const [d] = await c.open();
    await c.req("POST", `/api/decisions/${d!.id}/answer`, { answer: "Approve" });
    expect(await c.todos()).toHaveLength(1);
    // The hand-apply landed on a later commit than the approved one (BOS-124): the live commit is no
    // longer what ran at approval, so the to-do clears itself.
    await c.available({ deployed: C, tip: C, infraPaths: ["docker-compose.yml"], paths: ["docker-compose.yml"] });
    await c.selfDeploy.sync();
    expect((await c.open()).some((x) => (x.context as { type: string }).type === "owner_todo")).toBe(false);
  });

  it("keeps the owner to-do when a step failed, so it is still on their queue", async () => {
    const c = (ctx = await setup());
    await c.available({ infraPaths: ["docker-compose.yml"], paths: ["docker-compose.yml"] });
    await c.selfDeploy.sync();
    const [d] = await c.open();
    await c.req("POST", `/api/decisions/${d!.id}/answer`, { answer: "Approve" });
    const [todo] = await c.todos();
    const res = await c.req("POST", `/api/decisions/${todo!.id}/answer`, { answer: "A step failed", note: "rebuild-live.sh stopped: disk full" });
    expect(res.statusCode).toBe(200);
    // The change is not applied, so the card stays open for another try, with the owner's note kept.
    const [after] = await c.todos();
    expect(after).toMatchObject({ id: todo!.id, status: "open", answer: null });
    expect((after!.context as { lastFailure: { note: string } }).lastFailure.note).toBe("rebuild-live.sh stopped: disk full");
    // No agent raised the to-do, so the CEO is told what went wrong.
    const ws = await c.db.select().from(wakes);
    expect(ws.some((w) => w.reason === "decision" && (w.note ?? "").includes("disk full"))).toBe(true);
  });

  it("keeps an approved one-click deploy closing as before: no to-do is left", async () => {
    const c = (ctx = await setup());
    await c.available();
    await c.selfDeploy.sync();
    const [d] = await c.open();
    expect((await c.req("POST", `/api/decisions/${d!.id}/answer`, { answer: "Deploy" })).statusCode).toBe(200);
    // The approval clears and nothing is left on the queue.
    expect((await c.db.select().from(decisions).where(eq(decisions.id, d!.id)))[0]!.status).toBe("answered");
    expect(await c.todos()).toHaveLength(0);
  });

  it("does not ask again about a commit the owner put off, until they press Deploy latest", async () => {
    const c = (ctx = await setup());
    await c.available();
    await c.selfDeploy.sync();
    const [d] = await c.open();
    await c.req("POST", `/api/decisions/${d!.id}/answer`, { answer: "Not now" });
    await c.selfDeploy.sync();
    expect(await c.open()).toHaveLength(0);
    const r = await c.req("POST", "/api/self-deploy/deploy-latest");
    expect(r.statusCode).toBe(200);
    expect(await c.open()).toHaveLength(1);
    await c.available({ deployed: B });
    const up = await c.req("POST", "/api/self-deploy/deploy-latest");
    expect(up.statusCode).toBe(409);
    // Nothing new yet: the host is asked to look at main on its next tick, in case something has just merged.
    expect(up.json().message).toContain("Looking at main again now");
    expect(await readdir(path.join(c.dir, "inbox"))).toContain("check");
  });

  it("refuses the runner update while a merged fix to the runner update itself is not live, and names the ticket (BOS-1467)", async () => {
    const c = (ctx = await setup());
    await c.available({ deployed: B });
    const [co] = await c.db.select().from(companies).limit(1);
    await c.db.update(companies).set({ ticketPrefix: "BOS" }).where(eq(companies.id, co!.id));
    const [p] = await c.db.insert(projects).values({ companyId: co!.id, name: "Development" }).returning();
    // Merged (C, after the live B) with a change to scripts/update-runner.sh; the server still runs B.
    await c.db.insert(tickets).values({ companyId: co!.id, projectId: p!.id, title: "Fix update-runner.sh", number: 1417, mergeCommit: C, mergedAt: new Date(), touchesRunnerUpdate: true });
    await c.db.insert(tickets).values({ companyId: co!.id, projectId: p!.id, title: "Earlier merge", number: 1400, mergeCommit: B, mergedAt: new Date(Date.now() - 60_000) });
    await c.db.insert(settings).values({ key: `live_release:${co!.id}`, value: { old: B, new: B } });
    const r = await c.req("POST", "/api/self-deploy/update-runners");
    expect(r.statusCode).toBe(409);
    expect(r.json().message).toBe("Waiting for BOS-1417 to go live: it fixes the runner update itself.");
    // Refused, not queued, and no card raised.
    expect(await c.open()).toHaveLength(0);
    // Once the server runs it, the press goes through.
    await c.db.update(settings).set({ value: { old: B, new: C } }).where(eq(settings.key, `live_release:${co!.id}`));
    expect((await c.req("POST", "/api/self-deploy/update-runners")).statusCode).toBe(200);
  });

  it("goes ahead, and says why it couldn't confirm, when the live commit can't be placed (BOS-1644, R26)", async () => {
    const c = (ctx = await setup());
    await c.available({ deployed: B });
    const [co] = await c.db.select().from(companies).limit(1);
    await c.db.update(companies).set({ ticketPrefix: "BOS" }).where(eq(companies.id, co!.id));
    const [p] = await c.db.insert(projects).values({ companyId: co!.id, name: "Development" }).returning();
    await c.db.insert(tickets).values({ companyId: co!.id, projectId: p!.id, title: "Fix update-runner.sh", number: 1417, mergeCommit: C, mergedAt: new Date(), touchesRunnerUpdate: true });
    // The server runs a commit that is no ticket's recorded merge and nothing places it: "can't tell", not "no".
    await c.db.insert(settings).values({ key: `live_release:${co!.id}`, value: { old: B, new: B } });
    const r = await c.req("POST", "/api/self-deploy/update-runners");
    expect(r.statusCode).toBe(200);
    expect(r.json().note).toContain("couldn't confirm that BOS-1417");
  });

  it("does not refuse for a merge that never touched the runner update path (BOS-1467)", async () => {
    const c = (ctx = await setup());
    await c.available({ deployed: B });
    const [co] = await c.db.select().from(companies).limit(1);
    const [p] = await c.db.insert(projects).values({ companyId: co!.id, name: "Development" }).returning();
    await c.db.insert(tickets).values({ companyId: co!.id, projectId: p!.id, title: "Other fix", number: 1418, mergeCommit: C, mergedAt: new Date(), touchesRunnerUpdate: false });
    await c.db.insert(settings).values({ key: `live_release:${co!.id}`, value: { old: B, new: B } });
    expect((await c.req("POST", "/api/self-deploy/update-runners")).statusCode).toBe(200);
  });

  it("builds the runners from what is deployed, on request", async () => {
    const c = (ctx = await setup());
    await c.available({ deployed: B });
    const r = await c.req("POST", "/api/self-deploy/update-runners");
    expect(r.statusCode).toBe(200);
    const [d] = await c.open();
    expect(d).toMatchObject({ options: ["Update runners", "Not now"], context: { target: "runner", commit: B } });
    // Pressing it again reuses the open question.
    expect((await c.req("POST", "/api/self-deploy/update-runners")).json()).toEqual({ decisionId: d!.id });
    expect((await c.req("POST", `/api/decisions/${d!.id}/answer`, { answer: "Update runners" })).statusCode).toBe(200);
    expect(JSON.parse(await readFile(path.join(c.dir, "inbox", "request.json"), "utf8"))).toMatchObject({ target: "runner", commit: B });
  });

  it("builds runners for what runs after a rolled-back deploy, but not for the commit that failed", async () => {
    const c = (ctx = await setup());
    await c.status({ id: randomUUID(), result: "rolled_back", message: "Switched back.", to_commit: C });
    await c.available({ deployed: B });
    await c.req("POST", "/api/self-deploy/update-runners");
    const [ok] = await c.open();
    expect((await c.req("POST", `/api/decisions/${ok!.id}/answer`, { answer: "Update runners" })).statusCode).toBe(200);
    await c.app.close();
    await c.close();
    await rm(c.dir, { recursive: true, force: true });
    const d = (ctx = await setup());
    await d.status({ id: randomUUID(), result: "rolled_back", message: "Switched back.", to_commit: C });
    await d.available({ deployed: C });
    await d.req("POST", "/api/self-deploy/update-runners");
    const [bad] = await d.open();
    const r = await d.req("POST", `/api/decisions/${bad!.id}/answer`, { answer: "Update runners" });
    expect(r.statusCode).toBeGreaterThanOrEqual(400);
    expect(r.json().message ?? r.body).toContain("has not succeeded");
  });

  it("is off without a deployer folder, and refuses a Deploy answer", async () => {
    const c = (ctx = await setup({ deployer: false }));
    expect((await c.req("GET", "/api/self-deploy")).json()).toMatchObject({ enabled: false, status: null });
    await c.selfDeploy.sync();
    expect(await c.open()).toHaveLength(0);
  });

  // BOS-414: the pass used to run every 5 s; now it skips the pass when the host's files haven't changed.
  describe("skips a pass when the host's files haven't changed (BOS-414)", () => {
    afterEach(() => vi.useRealTimers());

    it("makes no database queries when status.json and available.json are unchanged", async () => {
      const c = (ctx = await setup());
      await c.available();
      await c.selfDeploy.sync(); // the first pass reads the files
      const start = c.made.length;
      await c.selfDeploy.sync();
      await c.selfDeploy.sync();
      expect(c.made.slice(start)).toEqual([]);
    });

    it("runs again as soon as one of the files changes, and at least once a minute whatever the files say", async () => {
      // Only the clock: the pass must still be able to read the files.
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-10-20T12:05:00Z"));
      const c = (ctx = await setup());
      await c.available();
      await c.selfDeploy.sync();
      const start = c.made.length;
      await c.selfDeploy.sync();
      expect(c.made.slice(start)).toEqual([]);
      // A new offer changes available.json: the pass runs and raises the Deploy card.
      await c.available({ tip: C });
      await c.selfDeploy.sync();
      expect((await c.open()).filter((d) => (d.context as { commit: string }).commit === C)).toHaveLength(1);
      // Nothing new for a minute: the forced pass still reads the files and the database.
      vi.setSystemTime(new Date("2026-10-20T12:06:01Z"));
      const ranFrom = c.made.length;
      await c.selfDeploy.sync();
      expect(c.made.length).toBeGreaterThan(ranFrom);
    });

    // BOS-414 review: the poller runs every 30 s, so skipped calls must not push the forced pass back.
    it("forces a pass a minute after the last one that ran, even when every 30 s call since then was skipped", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-10-20T12:05:00Z"));
      const c = (ctx = await setup());
      await c.available({ deployed: B });
      await c.selfDeploy.sync(); // the pass that runs, at 12:05:00
      const ranFrom = c.made.length;
      // Unchanged files, called every 30 s: the 30 s call skips and must not move the clock.
      vi.setSystemTime(new Date("2026-10-20T12:05:30Z"));
      await c.selfDeploy.sync();
      expect(c.made.slice(ranFrom)).toEqual([]);
      // At the minute mark, still unchanged, the forced pass runs and reads the database.
      vi.setSystemTime(new Date("2026-10-20T12:06:00Z"));
      await c.selfDeploy.sync();
      expect(c.made.length).toBeGreaterThan(ranFrom);
      // And the next window is measured from that pass, not from the skipped call before it.
      const ranAgain = c.made.length;
      vi.setSystemTime(new Date("2026-10-20T12:06:30Z"));
      await c.selfDeploy.sync();
      expect(c.made.slice(ranAgain)).toEqual([]);
      vi.setSystemTime(new Date("2026-10-20T12:07:00Z"));
      await c.selfDeploy.sync();
      expect(c.made.length).toBeGreaterThan(ranAgain);
    });

    it("skips nothing once a deploy has finished, and runs again the moment its result lands", async () => {
      // Only the clock: the result lands well inside the minute, so the forced pass must not explain the run.
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-10-20T12:05:00Z"));
      const c = (ctx = await setup());
      await c.available();
      await c.selfDeploy.sync();
      // The host says it is deploying: status.json changed, so the pass reads it and records "running".
      await c.status({ id: randomUUID(), result: "running", message: "Deploying.", to_commit: B });
      await c.selfDeploy.sync();
      // Nothing has changed since: nothing to do.
      const start = c.made.length;
      await c.selfDeploy.sync();
      expect(c.made.slice(start)).toEqual([]);
      // The result lands: the pass runs at once, well inside the minute, and tells the owner.
      // The message differs in length from "running"/"Deploying.", so the file token (mtime:size) changes even when both writes land in one clock tick.
      await c.status({ id: randomUUID(), result: "deployed", message: "Deployed and healthy on the new version.", to_commit: B, ended: "2026-10-20T12:05:30Z" });
      await c.selfDeploy.sync();
      expect(c.made.length).toBeGreaterThan(start);
      expect((await c.db.select().from(notifications)).map((n) => n.title)).toContain("Boss Man updated to bbbbbbbb");
    });
  });

  describe("runner update waits for the server update trial (BOS-368)", () => {
    afterEach(() => vi.useRealTimers());
    const target = (d: { context: unknown }) => d.context as { target: string; commit: string };

    async function deployedInTrial(over: Record<string, unknown> = {}) {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-11-03T01:00:00Z"));
      const c = (ctx = await setup());
      // A runner card from before the server update, for what ran then.
      await c.available({ deployed: A, tip: A });
      await c.req("POST", "/api/self-deploy/update-runners");
      const [early] = await c.open();
      await c.available({ runnerChanged: true });
      await c.selfDeploy.sync();
      const [server] = (await c.open()).filter((d) => target(d).target === "server");
      await c.req("POST", `/api/decisions/${server!.id}/answer`, { answer: "Deploy" });
      await rm(path.join(c.dir, "inbox", "request.json"));
      await c.status({ id: server!.id, result: "deployed", message: "Switched in.", ended: "2026-11-03T01:01:00Z", ...over });
      await c.available({ deployed: B, tip: B, runnerChanged: true });
      await c.selfDeploy.sync();
      return { c, early: early!, server: server! };
    }

    it("holds the runner offer until the trial is over, and refuses the button and a runner card during it", async () => {
      const { c, early } = await deployedInTrial();
      expect((await c.open()).filter((d) => target(d).target === "runner" && target(d).commit === B)).toHaveLength(0);
      expect((await c.req("POST", "/api/self-deploy/update-runners")).json().message).toContain("trial");
      // BOS-1010: the earlier card was closed when the server update was approved, so answering it now says so (never a
      // silent refusal), and the reason is the trial.
      const r = await c.req("POST", `/api/decisions/${early.id}/answer`, { answer: "Update runners" });
      // BOS-1086: the card is no longer closed by a server update; answering it in the trial says so plainly.
      expect(r.statusCode).toBe(422);
      expect(JSON.stringify(r.json())).toContain("trial");
      // After the trial (the host's 900 s window), still on B: the runner card appears by itself (BOS-953: no margin).
      // The press made inside the trial was queued (BOS-1086), so the update starts by itself: a request for the host, no card.
      vi.setSystemTime(new Date("2026-11-03T01:16:01Z"));
      await c.selfDeploy.sync();
      expect(JSON.parse(await readFile(path.join(c.dir, "inbox", "request.json"), "utf8"))).toMatchObject({ target: "runner", commit: B });
    });

    const runnerCards = async (c: Awaited<ReturnType<typeof setup>>, commit: string) => (await c.open()).filter((d) => target(d).target === "runner" && target(d).commit === commit);

    it("takes the window from the host's status file, not from the server's own environment (BOS-401)", async () => {
      vi.stubEnv("BOSSMAN_SOAK_SECONDS", "9999");
      try {
        const { c } = await deployedInTrial({ soak_seconds: "60" });
        // 60 s window from 01:01:00 = 01:02:00 (BOS-953: the window itself, no extra margin); the env value would hold it for hours.
        vi.setSystemTime(new Date("2026-11-03T01:01:30Z"));
        await c.selfDeploy.sync();
        expect(await runnerCards(c, B)).toHaveLength(0);
        vi.setSystemTime(new Date("2026-11-03T01:02:30Z"));
        await c.selfDeploy.sync();
        expect(await runnerCards(c, B)).toHaveLength(1);
      } finally {
        vi.unstubAllEnvs();
      }
    });

    it("holds the runner update after a server update that has no self-deploy decision: a rollback, a hand-apply (BOS-401)", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-11-03T01:00:00Z"));
      const c = (ctx = await setup());
      await c.available({ deployed: A, tip: A });
      await c.req("POST", "/api/self-deploy/update-runners");
      const [early] = await c.open();
      // The host reports a server update nobody asked for through a decision (empty id).
      await c.status({ id: "", result: "deployed", message: "Switched in.", ended: "2026-11-03T01:01:00Z", soak_seconds: "300" });
      await c.available({ deployed: B, tip: B });
      await c.selfDeploy.sync();
      expect((await c.req("POST", "/api/self-deploy/update-runners")).json().message).toContain("trial");
      const r = await c.req("POST", `/api/decisions/${early!.id}/answer`, { answer: "Update runners" });
      expect(r.statusCode).toBeGreaterThanOrEqual(400);
      // After the host's 300 s window the hold is over and the button works again (BOS-953: the window itself, no margin).
      vi.setSystemTime(new Date("2026-11-03T01:06:30Z"));
      await c.selfDeploy.sync();
      // The press made during the trial (above) was queued, so the update now starts by itself (BOS-1086).
      expect(JSON.parse(await readFile(path.join(c.dir, "inbox", "request.json"), "utf8"))).toMatchObject({ target: "runner", commit: B });
    });

    it("keeps an older held runner update when a newer server update lands inside the window (BOS-401)", async () => {
      const { c } = await deployedInTrial();
      // A second server update to C, 5 minutes in, with no runner change of its own.
      vi.setSystemTime(new Date("2026-11-03T01:06:00Z"));
      await c.status({ id: "", result: "deployed", message: "Switched in.", from_commit: B, to_commit: C, ended: "2026-11-03T01:06:00Z" });
      await c.available({ deployed: C, tip: C });
      await c.selfDeploy.sync();
      vi.setSystemTime(new Date("2026-11-03T01:25:00Z"));
      await c.selfDeploy.sync();
      const cards = (await c.open()).filter((d) => target(d).target === "runner" && target(d).commit === C);
      expect(cards).toHaveLength(1);
      expect(cards[0]!.context).toMatchObject({ commit: C, fromCommit: A });
    });

    it("replaces an open runner card for an older commit by one for the live version, never leaving two (BOS-947)", async () => {
      const { c } = await deployedInTrial();
      vi.setSystemTime(new Date("2026-11-03T01:18:01Z"));
      await c.selfDeploy.sync();
      expect(await runnerCards(c, B)).toHaveLength(1);
      // A later server update to C with no runner change of its own, while the card for B is still open.
      vi.setSystemTime(new Date("2026-11-03T01:30:00Z"));
      await c.status({ id: "", result: "deployed", message: "Switched in.", from_commit: B, to_commit: C, ended: "2026-11-03T01:30:00Z" });
      await c.available({ deployed: C, tip: C });
      await c.selfDeploy.sync();
      vi.setSystemTime(new Date("2026-11-03T01:50:00Z"));
      await c.selfDeploy.sync();
      expect(await runnerCards(c, C)).toHaveLength(1);
      expect(await runnerCards(c, B)).toHaveLength(0);
      expect((await c.open()).filter((d) => target(d).target === "runner")).toHaveLength(1);
    });

    it("withdraws runner cards and drops the held offer when the server is switched back", async () => {
      const { c, server } = await deployedInTrial();
      // Switched back two minutes in; the host may name the commits either way round.
      await c.status({ id: server.id, result: "rolled_back", message: "Switched back.", from_commit: B, to_commit: A, ended: "2026-11-03T01:03:00Z" });
      await c.available({ deployed: A, tip: B, runnerChanged: true });
      await c.selfDeploy.sync();
      expect((await c.open()).filter((d) => target(d).target === "runner")).toHaveLength(0);
      vi.setSystemTime(new Date("2026-11-03T01:30:00Z"));
      await c.selfDeploy.sync();
      expect((await c.open()).filter((d) => target(d).target === "runner")).toHaveLength(0);
      // The withdrawn card for A must not block a fresh runner offer for A (Freddy, round 6: dedupe key kept).
      await c.req("POST", "/api/self-deploy/update-runners");
      expect((await c.open()).filter((d) => target(d).target === "runner" && target(d).commit === A)).toHaveLength(1);
    });

    // BOS-384 (Dougal): the trial length is the host's own SOAK_SECONDS, published in available.json as soakSeconds.
    it("takes the trial length from the host's setting, not a hard-coded 15 minutes", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-11-03T01:00:00Z"));
      const c = (ctx = await setup());
      await c.available({ runnerChanged: true, soakSeconds: 120 });
      await c.selfDeploy.sync();
      const [server] = await c.open();
      await c.req("POST", `/api/decisions/${server!.id}/answer`, { answer: "Deploy" });
      await rm(path.join(c.dir, "inbox", "request.json"));
      await c.status({ id: server!.id, result: "deployed", message: "Switched in.", ended: "2026-11-03T01:01:00Z" });
      await c.available({ deployed: B, tip: B, runnerChanged: true, soakSeconds: 120 });
      await c.selfDeploy.sync();
      // The message names the host's window, not a fixed 15 minutes.
      const msg = (await c.req("POST", "/api/self-deploy/update-runners")).json().message;
      expect(msg).toContain("2-minute trial");
      expect(msg).not.toContain("15-minute");
      // The hold ends at the host's 120 s window (BOS-953: no extra margin), not at the old 900 s.
      vi.setSystemTime(new Date("2026-11-03T01:03:01Z"));
      await c.selfDeploy.sync();
      // The press above was queued, so the update starts by itself at the end of the 120 s window (BOS-1086).
      expect(JSON.parse(await readFile(path.join(c.dir, "inbox", "request.json"), "utf8"))).toMatchObject({ target: "runner", commit: B });
    });

    it("falls back to 15 minutes when an older host reports no trial length", async () => {
      const { c } = await deployedInTrial();
      expect((await c.req("POST", "/api/self-deploy/update-runners")).json().message).toContain("15-minute trial");
    });

    // BOS-953: the trial ends as soon as the standby colour is stopped, or the window has passed, whichever is first.
    const coloursWith = (self: "blue" | "green", other: boolean): { enabled: true; self: string; colours: Array<{ colour: string; up: boolean; role: string | null; commit: string | null; startedAt: string | null }> } => ({
      enabled: true,
      self,
      colours: [self, self === "blue" ? "green" : "blue"].map((colour) => ({ colour, up: colour === self ? true : other, role: colour === self ? "leader" : "standby", commit: null, startedAt: null })),
    });
    /** A second copy of the same service over the box the app already set up, with a controlled colour probe. */
    const withColours = (c: Awaited<ReturnType<typeof setup>>, colours: () => Promise<ReturnType<typeof coloursWith>>) =>
      selfDeployService(c.db, { dir: c.dir, notify: async () => ({}), colours, log: () => {} });

    it("shows the time the trial ends while it is really running (BOS-953)", async () => {
      const { c } = await deployedInTrial();
      // Still inside the 15 minutes, standby up: the trial is running and names 01:16.
      const svc = withColours(c, async () => coloursWith("green", true));
      vi.setSystemTime(new Date("2026-11-03T01:05:00Z"));
      const o = await svc.overview();
      expect(o.trial).toBeTruthy();
      expect(Date.parse(o.trial!.endsAt)).toBe(Date.parse("2026-11-03T01:16:00Z"));
      // BOS-1010: the trial is named plainly with the time it ends; the reply is never a silent refusal.
      const msg = (await svc.updateRunners() as { message?: string }).message ?? "";
      expect(msg).toContain("Runners will update at");
      expect(msg).toContain("15-minute trial");
    });

    it("ends the trial at once once the standby colour is stopped, before the 15 minutes are up (BOS-953)", async () => {
      const { c } = await deployedInTrial();
      vi.setSystemTime(new Date("2026-11-03T01:10:00Z"));
      // BLUE is the standby here (green is live) and it is already "Not running": the trial is over.
      const stopped = withColours(c, async () => coloursWith("green", false));
      expect((await stopped.overview()).trial).toBeNull();
      expect((await stopped.updateRunners() as { decisionId?: string }).decisionId).toBeTruthy();
      // The other colour still up: the trial is not over.
      const running = withColours(c, async () => coloursWith("green", true));
      expect((await running.overview()).trial).toBeTruthy();
    });

    it("ends the trial when 15 minutes have passed with a deployed result (BOS-953)", async () => {
      const { c } = await deployedInTrial();
      const svc = withColours(c, async () => coloursWith("green", true));
      vi.setSystemTime(new Date("2026-11-03T01:15:59Z"));
      expect((await svc.overview()).trial).toBeTruthy();
      vi.setSystemTime(new Date("2026-11-03T01:16:00Z"));
      expect((await svc.overview()).trial).toBeNull();
    });

    it("still ends the trial 15 minutes on after a later deploy was refused for the rate limit (BOS-953)", async () => {
      const { c } = await deployedInTrial();
      const svc = withColours(c, async () => coloursWith("green", true));
      // A rate-limited refusal overwrote the host's status file; the older update's trial must still end on time.
      await c.status({ id: "", target: "server", result: "rejected", message: "Rejected: only one server deploy every 10 minutes. Try again in 4 minute(s).", from_commit: B, to_commit: C, ended: "2026-11-03T01:08:00Z" });
      vi.setSystemTime(new Date("2026-11-03T01:16:00Z"));
      await svc.sync();
      expect((await svc.overview()).trial).toBeNull();
      expect(await runnerCards(c, B)).toHaveLength(1);
    });

    it("counts the rate-limit wait down from the real time and says you can deploy now once it is over (BOS-953)", async () => {
      const c = (ctx = await setup());
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-11-03T01:20:00Z"));
      const svc = withColours(c, async () => coloursWith("green", true));
      // Refused at 01:11 with "try again in 4 minutes": the wait ends 01:15.
      await c.status({ id: "", target: "server", result: "rejected", message: "Rejected: only one server deploy every 10 minutes. Try again in 4 minute(s).", from_commit: A, to_commit: B, ended: "2026-11-03T01:11:00Z" });
      expect((await svc.overview()).deployWait).toMatchObject({ until: "2026-11-03T01:15:00.000Z" });
      // A later state replaces the refusal: no wait line.
      await c.status({ id: "", target: "server", result: "deployed", message: "Switched in.", from_commit: A, to_commit: B, ended: "2026-11-03T01:14:00Z" });
      expect((await svc.overview()).deployWait).toBeNull();
    });

    // BOS-384 (Freddy): a server-path withdraw frees its dedupe key, so a later offer for that commit is not dropped.
    it("frees the dedupe key of a server card it withdraws once main is back on what runs", async () => {
      const c = (ctx = await setup());
      await c.available();
      await c.selfDeploy.sync();
      const [first] = await c.open();
      // The host catches up by hand: what runs is now the offered commit, so the open question is withdrawn.
      await c.available({ deployed: B, tip: B });
      await c.selfDeploy.sync();
      expect((await c.db.select().from(decisions).where(eq(decisions.id, first!.id)))[0]).toMatchObject({ status: "withdrawn", dedupeKey: null });
      // Main moves on, then back to B: a fresh card is raised for B, not silently swallowed by the old key.
      await c.available({ tip: C });
      await c.selfDeploy.sync();
      await c.available({ tip: B });
      await c.selfDeploy.sync();
      expect((await c.open()).filter((d) => target(d).target === "server" && target(d).commit === B)).toHaveLength(1);
    });

    // BOS-384 (Freddy): the "seen" mark is saved after the notify and withdraws, so a crash between them loses nothing.
    it("re-runs the notify and withdraws after a crash before the seen mark is saved", async () => {
      const c = (ctx = await setup());
      // A runner card from before the server update, for what ran then; the switch-back must withdraw it.
      await c.available({ deployed: A, tip: A });
      await c.req("POST", "/api/self-deploy/update-runners");
      expect((await c.open()).filter((d) => target(d).target === "runner")).toHaveLength(1);
      // The owner is told the switch-back happened, but the notify fails: the run dies before the seen mark is saved.
      const notify = c.notes.notify;
      (c.notes as { notify: unknown }).notify = vi.fn().mockRejectedValueOnce(new Error("crash"));
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-11-03T01:03:30Z"));
      await c.status({ id: randomUUID(), result: "rolled_back", message: "Switched back.", from_commit: B, to_commit: A, ended: "2026-11-03T01:03:00Z" });
      await expect(c.selfDeploy.sync()).rejects.toThrow("crash");
      // Nothing was marked seen, and the card the crash left behind is still open.
      expect(await c.db.select().from(settings).where(eq(settings.key, "self_deploy"))).toHaveLength(0);
      (c.notes as { notify: unknown }).notify = notify;
      // The next pass (a minute later, after BOS-414's fingerprint window) runs it all again, safely: the
      // withdraw happens, and the owner gets exactly one note.
      vi.setSystemTime(new Date("2026-11-03T01:05:00Z"));
      await c.selfDeploy.sync();
      const seen = (await c.db.select().from(settings).where(eq(settings.key, "self_deploy")))[0]!.value as { notified: string };
      expect(seen.notified).toMatch(/:rolled_back:2026-11-03T01:03:00Z$/);
      const told = (await c.db.select().from(notifications)).filter((n) => n.level !== "ask");
      expect(told).toHaveLength(1);
      // A further pass changes nothing: the mark now holds.
      vi.setSystemTime(new Date("2026-11-03T01:06:00Z"));
      await c.selfDeploy.sync();
      expect((await c.db.select().from(notifications)).filter((n) => n.level !== "ask")).toHaveLength(1);
    });
  });

  // BOS-647: the owner's "Restart the server" button. The click is the approval; the host does the rest.
  describe("Restart the server (BOS-647)", () => {
    const inbox = (c: { dir: string }) => path.join(c.dir, "inbox", "request.json");

    it("writes one restart request for the commit that runs, with no decision card", async () => {
      const c = (ctx = await setup());
      await c.available({ deployed: B, tip: C, bluegreen: true });
      const r = await c.req("POST", "/api/self-deploy/restart");
      expect(r.statusCode).toBe(200);
      expect(r.json()).toMatchObject({ commit: B, bluegreen: true });
      const body = JSON.parse(await readFile(inbox(c), "utf8"));
      // The commit is what runs, never the tip: a restart must not bring anything new in.
      expect(body).toMatchObject({ id: r.json().requestId, target: "restart", commit: B });
      expect(body.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(Object.keys(body).sort()).toEqual(["approvedBy", "commit", "id", "requestedAt", "target"]);
      expect(await c.open()).toHaveLength(0);
      // One request at a time.
      const again = await c.req("POST", "/api/self-deploy/restart");
      expect(again.statusCode).toBe(409);
      expect(again.json().message).toContain("already waiting");
    });

    it("refuses when self-deploy is off, the host hasn't reported, or a deploy is running", async () => {
      const off = (ctx = await setup({ deployer: false }));
      expect((await off.req("POST", "/api/self-deploy/restart")).json().message).toContain("not set up");
      await off.app.close();
      await off.close();
      await rm(off.dir, { recursive: true, force: true });

      const c = (ctx = await setup());
      const none = await c.req("POST", "/api/self-deploy/restart");
      expect(none.statusCode).toBe(409);
      expect(none.json().message).toContain("has not reported");
      await c.available({ deployed: B });
      await c.status({ id: randomUUID(), result: "running", message: "Running", to_commit: C, ended: "" });
      const busy = await c.req("POST", "/api/self-deploy/restart");
      expect(busy.statusCode).toBe(409);
      expect(busy.json().message).toContain("running now");
      expect(await readdir(path.join(c.dir, "inbox"))).toEqual([]);
    });

    it("is owner-only: no session, no restart", async () => {
      const c = (ctx = await setup());
      await c.available({ deployed: B });
      const r = await c.app.inject({ method: "POST", url: "/api/self-deploy/restart", payload: {} });
      expect([401, 403]).toContain(r.statusCode);
      expect(await readdir(path.join(c.dir, "inbox"))).toEqual([]);
    });

    it("tells the owner how it went, and starts no runner trial", async () => {
      const c = (ctx = await setup());
      await c.available({ deployed: B, tip: B });
      await c.status({ id: randomUUID(), target: "restart", result: "deployed", message: "Restarted at bbbbbbbb.", from_commit: B, to_commit: B });
      await c.selfDeploy.sync();
      const told = async (title: string) => (await c.db.select().from(notifications)).find((n) => n.title === title);
      expect(await told("Boss Man restarted (bbbbbbbb)")).toMatchObject({ level: "note" });
      // A restart is not an update: the runner hold and the last-update record are left alone.
      const held = await c.db.select().from(settings).where(eq(settings.key, "self_deploy_runner_due"));
      const last = await c.db.select().from(settings).where(eq(settings.key, "self_deploy_last_server"));
      expect([held, last]).toEqual([[], []]);
      for (const [result, title, level] of [
        ["rejected", "Restart refused", "flag"],
        ["failed", "Restart failed (bbbbbbbb)", "page"],
        ["rolled_back", "Restart switched back (bbbbbbbb)", "page"],
      ] as const) {
        await c.status({ id: randomUUID(), target: "restart", result, message: "x", from_commit: B, to_commit: B });
        await c.selfDeploy.sync();
        expect(await told(title), result).toMatchObject({ level });
      }
    });
  });

  // BOS-487 (DR-020 B and C): the host says which services an update changes; a changed database or proxy gets its own card.
  describe("changed database and proxy (BOS-487)", () => {
    const commands = (texts: string[]) => texts.flatMap((t) => parseStep(t)).filter((p) => p.type === "command").map((p) => p.text);
    const handCard = async (c: Awaited<ReturnType<typeof setup>>, over: Record<string, unknown>) => {
      await c.available({ infraPaths: ["docker-compose.yml"], paths: ["docker-compose.yml"], ...LAYOUT, servicesChecked: true, ...over });
      await c.selfDeploy.sync();
      const [d] = await c.open();
      return d!.context as { handSteps?: string[]; rollback?: string; update?: { risks: string[] } };
    };
    const svcCards = async (c: Awaited<ReturnType<typeof setup>>) => (await c.todos()).filter((d) => d.dedupeKey?.startsWith("self-deploy:services:"));
    /** A second service instance on the same database with its own "quiet" answer, so a test can say the host is busy. */
    const withQuiet = (c: Awaited<ReturnType<typeof setup>>, quiet: () => Promise<boolean>) => selfDeployService(c.db, { dir: c.dir, notify: async () => undefined, hosts: async () => [{ name: "nas01", ownership: [] }], hostQuiet: quiet });
    /** Server update B ended well at 12:03; a call at 12:30 is past its standby window (the default 15 minutes + margin). */
    const deployedAndLater = async (c: Awaited<ReturnType<typeof setup>>, over: Record<string, unknown>, at = "2026-10-20T12:30:00Z") => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-10-20T12:04:00Z"));
      await c.available({ deployed: B, tip: B, commits: [], paths: [], ...LAYOUT, servicesChecked: true, changedServices: [], ...over });
      await c.status({ id: "", result: "deployed", from_commit: A, to_commit: B });
      await c.selfDeploy.sync();
      vi.setSystemTime(new Date(at));
    };
    afterEach(() => vi.useRealTimers());

    it("says plainly that the database's settings change, and never gives a restart as part of the server update", async () => {
      const c = (ctx = await setup());
      const x = await handCard(c, { changedServices: ["db"] });
      const text = x.handSteps!.join("\n");
      expect(x.update!.risks).toContain("This update changes the database's settings. Applying the update does not restart it; a separate card follows, with a backup first.");
      expect(text).toContain("A separate card follows");
      expect(text).not.toContain("Only if the database settings changed");
      expect(commands(x.handSteps!).join("\n")).not.toMatch(/ up -d --no-deps (db|proxy)|pg_dump/);
      expect(lintOwnerSteps([...x.handSteps!, x.rollback!], [{ name: "nas01", ownership: [] }]).refuse.filter((f) => f.rule !== "R11")).toEqual([]);
    });

    it("says the same about the proxy, and about both", async () => {
      const c = (ctx = await setup());
      const x = await handCard(c, { changedServices: ["proxy"] });
      expect(x.update!.risks).toContain("This update changes the proxy's settings. Applying the update does not restart it; a separate card follows.");
      await c.available({ changedServices: ["db", "proxy"], infraPaths: ["docker-compose.yml"], paths: ["docker-compose.yml"], ...LAYOUT, servicesChecked: true, tip: C });
      await c.selfDeploy.sync();
      const d = (await c.open()).find((o) => (o.context as { commit: string }).commit === C)!;
      const r = (d.context as { update: { risks: string[] } }).update.risks.join("\n");
      expect(r).toContain("database's settings");
      expect(r).toContain("proxy's settings");
    });

    it("says nothing about the database when the update does not change it", async () => {
      const c = (ctx = await setup());
      const x = await handCard(c, { changedServices: ["server"] });
      const all = [...x.handSteps!, ...x.update!.risks].join("\n");
      expect(all).not.toMatch(/database|proxy|separate card/i);
      // An older host script reports nothing about services at all: still nothing.
      const c2 = await handCard(c, { servicesChecked: undefined, tip: C });
      expect([...c2.handSteps!, ...c2.update!.risks].join("\n")).not.toMatch(/database's|proxy's|separate card|could not compare/i);
    });

    it("says honestly that the host could not compare, without a command, when the compose settings changed", async () => {
      const c = (ctx = await setup());
      const x = await handCard(c, { servicesChecked: false });
      const text = x.handSteps!.join("\n");
      expect(text).toContain("could not compare this host's service settings");
      expect(commands(x.handSteps!).join("\n")).not.toMatch(/ up -d --no-deps (db|proxy)/);
    });

    it("raises the database card once the server update has ended well, its standby window is over and the host is quiet", async () => {
      const c = (ctx = await setup());
      const svc = withQuiet(c, async () => true);
      // Inside the window: nothing yet.
      await deployedAndLater(c, { pendingServices: ["db"], dbStartedAt: "2026-10-20T10:00:00Z" }, "2026-10-20T12:10:00Z");
      await svc.sync();
      expect(await svcCards(c)).toHaveLength(0);
      // Past it: one card, with the backup first, the restart, and the checks.
      vi.setSystemTime(new Date("2026-10-20T12:30:00Z"));
      await c.available({ deployed: B, tip: B, commits: [], paths: [], ...LAYOUT, servicesChecked: true, changedServices: [], pendingServices: ["db"] });
      await svc.sync();
      const [card] = await svcCards(c);
      expect(card!.dedupeKey).toBe(`self-deploy:services:db:${B}`);
      expect(card!.tier).toBe("owner");
      const ctx2 = card!.context as { steps: string[]; check?: string; rollback?: string; target?: string };
      expect(ctx2.target).toBeUndefined(); // not a server update's to-do: the server catching up must not clear it
      const cmds = commands(ctx2.steps);
      expect(ctx2.steps[0]).toContain("unreachable for a few seconds");
      expect(cmds[0]).toContain("pg_dump");
      expect(cmds[0]).toContain(`db-backup-before-${B.slice(0, 8)}.sql.gz`);
      expect(cmds[0]).toContain("gzip -t");
      expect(cmds[1]).toBe("cd /srv/bm/src && docker compose up -d --no-deps db");
      expect(cmds.join("\n")).toContain("docker compose ps db");
      expect(cmds.join("\n")).toContain("server-green");
      // Raised before restart steps run: the order is backup, then the restart.
      expect(cmds.findIndex((x) => x.includes("pg_dump"))).toBeLessThan(cmds.findIndex((x) => x.includes("up -d")));
      expect(lintOwnerSteps(ctx2.steps, [{ name: "nas01", ownership: [] }]).refuse.filter((f) => f.rule !== "R11")).toEqual([]);
      // A second pass raises no second card (one per service and commit).
      vi.setSystemTime(new Date("2026-10-20T12:32:00Z"));
      await svc.sync();
      expect(await svcCards(c)).toHaveLength(1);
    });

    // BOS-2336: each refusal below fails on the old code, which put the owner's card out whatever the host's facts said.
    it("holds the database card when the host's own name is not the one its steps run on (R6): a CEO card, none for the owner", async () => {
      const c = (ctx = await setup());
      const svc = withQuiet(c, async () => true);
      await deployedAndLater(c, { pendingServices: ["db"] });
      setOwnerTodoFacts(async () => ({ serverHost: "other-box", hosts: [{ name: "other-box", ownership: [] }] }));
      try {
        await svc.sync();
      } finally {
        setOwnerTodoFacts(null);
      }
      expect(await svcCards(c)).toHaveLength(0);
      const fix = (await c.db.select().from(decisions)).filter((d) => d.dedupeKey?.startsWith("owner-todo-fix:self-deploy:services:db:"));
      expect(fix).toHaveLength(1);
      expect(fix[0]!.tier).toBe("ceo");
      expect(fix[0]!.question).toContain(`but Boss Man runs on "other-box"`); // the R6 host fence
    });

    it("holds the proxy card when its check names the standby colour (R31c): a CEO card, none for the owner", async () => {
      const c = (ctx = await setup());
      const svc = withQuiet(c, async () => true);
      await deployedAndLater(c, { pendingServices: ["proxy"] });
      setOwnerTodoFacts(async () => ({ serverHost: "nas01", values: { "compose.files": "docker-compose.yml,deploy/bluegreen.yml", "compose.bluegreen": "true", "compose.liveColour": "blue", "compose.cmd": "cd /srv/bm/src && docker compose -f docker-compose.yml -f deploy/bluegreen.yml", "paths.src": "/srv/bm/src" } }));
      try {
        await svc.sync();
      } finally {
        setOwnerTodoFacts(null);
      }
      expect(await svcCards(c)).toHaveLength(0);
      const fix = (await c.db.select().from(decisions)).filter((d) => d.dedupeKey?.startsWith("owner-todo-fix:self-deploy:services:proxy:"));
      expect(fix).toHaveLength(1);
      expect(fix[0]!.question).toContain("R31");
    });

    it("waits for a quiet host: nothing is raised while it is busy, and the next pass raises it", async () => {
      const c = (ctx = await setup());
      let quiet = false;
      const svc = withQuiet(c, async () => quiet);
      await deployedAndLater(c, { pendingServices: ["db"] });
      await svc.sync();
      expect(await svcCards(c)).toHaveLength(0);
      quiet = true;
      vi.setSystemTime(new Date("2026-10-20T12:32:00Z"));
      await svc.sync();
      expect(await svcCards(c)).toHaveLength(1);
    });

    it("raises nothing when the last server update did not end well, or the host did not compare", async () => {
      const c = (ctx = await setup());
      const svc = withQuiet(c, async () => true);
      await deployedAndLater(c, { pendingServices: ["db"], servicesChecked: false });
      await svc.sync();
      expect(await svcCards(c)).toHaveLength(0);
      const c2 = (ctx = await setup());
      const svc2 = withQuiet(c2, async () => true);
      vi.setSystemTime(new Date("2026-10-20T12:30:00Z"));
      await c2.available({ deployed: B, tip: B, commits: [], paths: [], ...LAYOUT, servicesChecked: true, pendingServices: ["db"] });
      await c2.status({ id: "", result: "rolled_back", from_commit: B, to_commit: B });
      await svc2.sync();
      expect(await svcCards(c2)).toHaveLength(0);
    });

    it("gives the proxy card no backup, and clears a card by itself once the host sees the service recreated", async () => {
      const c = (ctx = await setup());
      const svc = withQuiet(c, async () => true);
      await deployedAndLater(c, { pendingServices: ["proxy"] });
      await svc.sync();
      const [card] = await svcCards(c);
      expect(card!.dedupeKey).toBe(`self-deploy:services:proxy:${B}`);
      const steps = (card!.context as { steps: string[] }).steps;
      expect(commands(steps).join("\n")).not.toContain("pg_dump");
      expect(commands(steps)[0]).toBe("cd /srv/bm/src && docker compose up -d --no-deps proxy");
      expect(lintOwnerSteps(steps, [{ name: "nas01", ownership: [] }]).refuse.filter((f) => f.rule !== "R11")).toEqual([]);
      // The host reports nothing pending any more: the card clears. An answer-less pass from an older host does not clear it.
      vi.setSystemTime(new Date("2026-10-20T12:31:00Z"));
      await c.available({ deployed: B, tip: B, commits: [], paths: [], ...LAYOUT, pendingServices: [] });
      await svc.sync();
      expect(await svcCards(c)).toHaveLength(1);
      vi.setSystemTime(new Date("2026-10-20T12:32:00Z"));
      await c.available({ deployed: B, tip: B, commits: [], paths: [], ...LAYOUT, servicesChecked: true, pendingServices: [] });
      await svc.sync();
      expect(await svcCards(c)).toHaveLength(0);
    });

    it("lints every variant of the card: db, proxy, both, unknown host, unknown folder", async () => {
      const facts = [{ name: "nas01", ownership: [] }];
      const seen: string[][] = []; // the first card of each variant, by variant number
      for (const [i, over] of [
        { pendingServices: ["db"] },
        { pendingServices: ["proxy"] },
        { pendingServices: ["db", "proxy"] },
        { pendingServices: ["db", "proxy"], bluegreen: undefined, liveColour: undefined },
        { pendingServices: ["db", "proxy"], srcDir: undefined },
        { pendingServices: ["db", "proxy"], bluegreen: false },
      ].entries()) {
        const c = (ctx = await setup());
        const svc = withQuiet(c, async () => true);
        await deployedAndLater(c, over);
        await svc.sync();
        const cards = await svcCards(c);
        expect(cards.length, `variant ${i}`).toBe((over.pendingServices as string[]).length);
        for (const card of cards) {
          const x = card.context as { steps: string[]; rollback?: string; check?: string };
          seen[i] ??= x.steps;
          expect(lintOwnerSteps([...x.steps, ...(x.rollback ? [x.rollback] : [])], facts).refuse.filter((f) => f.rule !== "R11"), `variant ${i}`).toEqual([]);
        }
        vi.useRealTimers();
        await ctx?.app.close();
        await ctx?.close();
        await rm(ctx!.dir, { recursive: true, force: true });
        ctx = undefined;
      }
      // Unknown host folder: no command at all, and it says so.
      const noSrc = seen[4]!.join("\n");
      expect(noSrc).toContain("can't tell where it is installed");
      expect(commands(seen[4]!)).toEqual([]);
      // Unknown blue/green layout: the ready check falls back to words.
      expect(seen[3]!.join("\n")).toContain("can't tell which server copy is live");
    });
  });
});

// BOS-420: the Deploy button and the hand-apply to-do go through the quiet-machine wait (deploy-wait.ts).
describe("self-deploy waits for a quiet machine (BOS-420)", () => {
  const headroom = (c: Awaited<ReturnType<typeof setup>>, availableMb: number) =>
    writeFile(path.join(c.dir, "outbox", "headroom.json"), JSON.stringify({ version: 1, writtenAt: new Date().toISOString(), availableMb, needMb: 4096 }));
  const waitRow = async (c: Awaited<ReturnType<typeof setup>>) => (await c.db.select().from(settings).where(eq(settings.key, "deploy_wait")))[0]?.value as { phase: string; origin: string; decisionId: string } | undefined;

  it("Deploy on a machine short of memory writes no request; the wait sends it once memory is free", async () => {
    const c = (ctx = await setup());
    await headroom(c, 1024);
    await c.available();
    await c.selfDeploy.sync();
    const [d] = await c.open();
    expect((await c.req("POST", `/api/decisions/${d!.id}/answer`, { answer: "Deploy" })).statusCode).toBe(200);
    expect(await readdir(path.join(c.dir, "inbox"))).toEqual([]);
    expect(await waitRow(c)).toMatchObject({ phase: "waiting", origin: "approve", decisionId: d!.id });
    expect((await c.req("GET", "/api/self-deploy/wait")).json()).toMatchObject({ on: true, phase: "waiting", quiet: { ready: false } });

    await headroom(c, 8192);
    await c.deployWait.step();
    // The request, plus the checked-merges list BOS-753 writes beside every server request.
    expect((await readdir(path.join(c.dir, "inbox"))).sort()).toEqual(["checked", "request.json"]);
    expect(JSON.parse(await readFile(path.join(c.dir, "inbox", "request.json"), "utf8"))).toMatchObject({ id: d!.id, commit: B });
    expect((await waitRow(c))?.phase).toBe("sent");
  });

  it("the owner can cancel a waiting update from Settings; nothing reaches the host", async () => {
    const c = (ctx = await setup());
    await headroom(c, 1024);
    await c.available();
    await c.selfDeploy.sync();
    const [d] = await c.open();
    await c.req("POST", `/api/decisions/${d!.id}/answer`, { answer: "Deploy" });
    expect((await c.req("POST", "/api/self-deploy/wait/cancel")).json()).toEqual({ cancelled: true });
    expect(await waitRow(c)).toBeUndefined();
    expect(await readdir(path.join(c.dir, "inbox"))).toEqual([]);
  });

  it("Quiet the machine first on a hand-apply to-do starts a hand wait, keeps the to-do open and shows how quiet it is", async () => {
    const c = (ctx = await setup());
    await headroom(c, 1024);
    await c.available({ infraPaths: ["docker-compose.yml"], paths: ["docker-compose.yml"], ...LAYOUT });
    await c.selfDeploy.sync();
    const [d] = await c.open();
    await c.req("POST", `/api/decisions/${d!.id}/answer`, { answer: "Approve" });
    const [todo] = await c.todos();
    expect((await c.req("POST", `/api/decisions/${todo!.id}/answer`, { answer: "Quiet the machine first" })).statusCode).toBe(200);
    expect(await waitRow(c)).toMatchObject({ phase: "waiting", origin: "hand", decisionId: d!.id });
    const [still] = await c.todos();
    expect(still!.id).toBe(todo!.id);
    expect((still!.context as { quiet?: { ready: boolean; freeMb: number } }).quiet).toMatchObject({ ready: false, freeMb: 1024 });
    // Nothing is ever sent for a hand-applied update.
    await headroom(c, 8192);
    await c.deployWait.step();
    expect(await readdir(path.join(c.dir, "inbox"))).toEqual([]);
    const [ready] = await c.todos();
    expect((ready!.context as { quiet?: { ready: boolean } }).quiet?.ready).toBe(true);
    expect((await c.db.select().from(notifications)).some((n) => n.title === "Ready: the machine is quiet")).toBe(true);
  });
});

// BOS-639: on 6–7 Nov the BOS-410 memory fix merged at 08:44, but its deploy card looked like every other
// one, and the live server stayed on the old code for 12 hours. A ticket marked "fixes live" now heads the
// card, pages the owner once and sorts first; an unmarked card is unchanged.
describe("a deploy card carrying the fix for a live problem (BOS-639)", () => {
  const HEADING = "Urgent: contains the fix for server freezes as memory climbs (BOS-410)";
  async function seed(c: Awaited<ReturnType<typeof setup>>, opts: { marked: boolean }) {
    const [co] = await c.db.select().from(companies).limit(1);
    await c.db.update(companies).set({ ticketPrefix: "BOS" }).where(eq(companies.id, co!.id));
    const [p] = await c.db.insert(projects).values({ companyId: co!.id, name: "Development" }).returning();
    // Urgent and high priority on both: the marker is never guessed from either.
    const [fix] = await c.db
      .insert(tickets)
      .values({ companyId: co!.id, projectId: p!.id, title: "Server memory fix", number: 410, urgent: true, risk: "high", ...(opts.marked ? { fixesLive: "server freezes as memory climbs." } : {}) })
      .returning();
    const [other] = await c.db.insert(tickets).values({ companyId: co!.id, projectId: p!.id, title: "Plan page titles are cut off", number: 200, urgent: true }).returning();
    const commits = [
      { sha: B, subject: `Merge "Server memory fix" (${fix!.id})` },
      { sha: C, subject: `Merge "Plan page titles are cut off" (${other!.id})` },
    ];
    // A hands-on card (steps for the owner) raised after the deploy card: the do-this-next order (BOS-551)
    // breaks the tie between two hands-on cards newest first, so without the marker it goes on top.
    const newer = async () =>
      (await c.db.insert(decisions).values({ companyId: co!.id, kind: "question", question: "A newer question", options: ["Done", "Not now"], recommendedOption: "Done", context: { type: "question", steps: ["Open Settings → Secrets and add the key"] }, createdAt: new Date(Date.now() + 60_000) }).returning())[0]!;
    return { co: co!, fix: fix!, commits, newer };
  }
  type Urgent = { heading: string; fixes: Array<{ ticketId: string; ref: string; symptom: string }>; repeat?: boolean };
  const urgentOf = (d: { context: unknown }) => (d.context as { urgent?: Urgent }).urgent;

  it("heads the card with the symptom, pages the owner once, and sorts it first", async () => {
    const c = (ctx = await setup());
    const s = await seed(c, { marked: true });
    await c.available({ commits: s.commits });
    await c.selfDeploy.sync();
    const [d] = await c.open();
    expect(d!.question.split("\n\n")[0]).toBe(`${HEADING}.`);
    expect(d!.question).toContain(`Deploy Boss Man ${A.slice(0, 8)} -> ${B.slice(0, 8)}?`);
    expect(urgentOf(d!)).toEqual({ heading: HEADING, fixes: [{ ticketId: s.fix.id, ref: "BOS-410", symptom: "server freezes as memory climbs." }] });
    // Boss Man still never deploys by itself: the owner approves.
    expect(await readdir(path.join(c.dir, "inbox"))).toEqual([]);
    expect(d!.options).toEqual(["Deploy", "Not now"]);

    const newer = await s.newer();
    await c.notes.syncDecisions();
    const sent = await c.db.select().from(notifications);
    expect(sent.find((n) => n.decisionId === d!.id)).toMatchObject({ requested: "page", level: "page", title: HEADING });
    expect(sent.find((n) => n.decisionId === newer.id)).toMatchObject({ level: "ask" });
    const queue = (await c.req("GET", "/api/decisions")).json() as Array<{ id: string }>;
    expect(queue.map((q) => q.id)).toEqual([d!.id, newer.id]);

    // Main moves on: the new card still leads with the fix and still sorts first, but the owner isn't paged again.
    await c.available({ tip: C, commits: [...s.commits, { sha: C, subject: "Tidy a comment" }] });
    await c.selfDeploy.sync();
    const [d2] = await c.open();
    expect(d2!.id).not.toBe(d!.id);
    expect(d2!.question.split("\n\n")[0]).toBe(`${HEADING}.`);
    expect(urgentOf(d2!)).toMatchObject({ heading: HEADING, repeat: true });
    await c.notes.syncDecisions();
    expect((await c.db.select().from(notifications)).find((n) => n.decisionId === d2!.id)).toMatchObject({ requested: "ask", title: HEADING });
    expect((await c.db.select().from(notifications)).filter((n) => n.requested === "page")).toHaveLength(1);
    expect(((await c.req("GET", "/api/decisions")).json() as Array<{ id: string }>)[0]!.id).toBe(d2!.id);
  });

  it("quiet hours still lower the page", async () => {
    const c = (ctx = await setup());
    const s = await seed(c, { marked: true });
    const hhmm = (ms: number) => new Date(ms).toISOString().slice(11, 16);
    await c.notes.setSettings({ ...(await c.notes.getSettings()), quietHours: { start: hhmm(Date.now() - 3_600_000), end: hhmm(Date.now() + 3_600_000), timeZone: "UTC" } });
    await c.available({ commits: s.commits });
    await c.selfDeploy.sync();
    await c.notes.syncDecisions();
    const [n] = await c.db.select().from(notifications);
    expect(n).toMatchObject({ requested: "page", demotedBy: "quiet hours", title: HEADING });
    expect(n!.level).not.toBe("page");
  });

  it("an unmarked card is unchanged: no heading, an ordinary ask, newest first", async () => {
    const c = (ctx = await setup());
    const s = await seed(c, { marked: false });
    await c.available({ commits: s.commits });
    await c.selfDeploy.sync();
    const [d] = await c.open();
    expect(d!.question).toMatch(/^Deploy Boss Man /);
    expect(d!.question).not.toContain("Urgent");
    expect(urgentOf(d!)).toBeUndefined();
    const newer = await s.newer();
    await c.notes.syncDecisions();
    expect((await c.db.select().from(notifications)).find((n) => n.decisionId === d!.id)).toMatchObject({ requested: "ask", level: "ask", title: "App Co needs a decision" });
    expect(((await c.req("GET", "/api/decisions")).json() as Array<{ id: string }>).map((q) => q.id)).toEqual([newer.id, d!.id]);
  });

  // BOS-1462: a live fix whose only step is the runner update used to get a silent, routine runner card.
  it("a runner card carries the heading and pages once when a fixes-live ticket only needs the runners rebuilt", async () => {
    const c = (ctx = await setup());
    const [co] = await c.db.select().from(companies).limit(1);
    await c.db.update(companies).set({ ticketPrefix: "BOS" }).where(eq(companies.id, co!.id));
    const [p] = await c.db.insert(projects).values({ companyId: co!.id, name: "Development" }).returning();
    const [fix] = await c.db
      .insert(tickets)
      .values({ companyId: co!.id, projectId: p!.id, title: "Runner fix", number: 410, systemState: "done", mergeCommit: B, ownerSetup: "Build and update runners", fixesLive: "server freezes as memory climbs." })
      .returning();
    // The server card carries no marked ticket itself; the fix is only in the runner image.
    await c.available({ runnerChanged: true, commits: [{ sha: B, subject: "Add rate limiting" }] });
    await c.selfDeploy.sync();
    const [d] = await c.open();
    await c.req("POST", `/api/decisions/${d!.id}/answer`, { answer: "Deploy" });
    await rm(path.join(c.dir, "inbox", "request.json"));
    await c.status({ id: d!.id, result: "deployed", message: "Deployed aaaaaaaa to bbbbbbbb." });
    await c.available({ deployed: B, tip: B });
    await c.selfDeploy.sync();
    const [runner] = await c.open();
    expect(runner).toMatchObject({ context: { type: "self_deploy", target: "runner", commit: B } });
    expect(runner!.question.split("\n\n")[0]).toBe(`${HEADING}.`);
    expect(urgentOf(runner!)).toEqual({ heading: HEADING, fixes: [{ ticketId: fix!.id, ref: "BOS-410", symptom: "server freezes as memory climbs." }] });
    await c.notes.syncDecisions();
    const sent = await c.db.select().from(notifications);
    expect(sent.find((n) => n.decisionId === runner!.id)).toMatchObject({ requested: "page", level: "page", title: HEADING });

    // A second runner card for the same fix (the owner said "Not now", then pressed the button) is a repeat: it
    // keeps the heading text but is routine again, so the owner is not paged twice for one fix.
    await c.req("POST", `/api/decisions/${runner!.id}/answer`, { answer: "Not now" });
    await c.req("POST", "/api/self-deploy/update-runners");
    const [again] = (await c.open()).filter((d) => (d.context as { target?: string }).target === "runner");
    expect(again!.id).not.toBe(runner!.id);
    expect(urgentOf(again!)).toMatchObject({ heading: HEADING, repeat: true });
    await c.notes.syncDecisions();
    const all = await c.db.select().from(notifications);
    expect(all.filter((n) => n.requested === "page")).toHaveLength(1);
    expect(all.find((n) => n.decisionId === again!.id)).toMatchObject({ requested: "ask", title: HEADING });
  });

  // BOS-1805 (18 Nov 14:59): a runner card for the live 84aa64cc was headed "Urgent: contains the fix for … (BOS-1762)"
  // because the heading was read from the host's offer (what the NEXT server deploy brings), and BOS-1762 had only just
  // reached main as 7704a0c6. The owner rebuilt the runners and nothing changed.
  it("a runner card is headed only by a fix its image contains, never by the server offer's range (BOS-1805)", async () => {
    const c = (ctx = await setup());
    const [co] = await c.db.select().from(companies).limit(1);
    await c.db.update(companies).set({ ticketPrefix: "BOS" }).where(eq(companies.id, co!.id));
    const [p] = await c.db.insert(projects).values({ companyId: co!.id, name: "Development" }).returning();
    const MERGE_FIX = "Merges keep re-testing every time main moves";
    // Merged as C (runner code), waiting to go live: not done, and no setup step but the runner update.
    const [fix] = await c.db
      .insert(tickets)
      .values({ companyId: co!.id, projectId: p!.id, title: "Merge gate fix", number: 1762, systemState: "blocked", mergeCommit: C, touchesRunner: true, mergedAt: new Date(), fixesLive: MERGE_FIX })
      .returning();
    const heading = `Urgent: contains the fix for ${MERGE_FIX} (BOS-1762)`;

    // The server runs A; the fix is in the offer A..C only. The runner card is for A, whose image lacks the fix.
    await c.available({ deployed: A, tip: C, commits: [{ sha: C, subject: `Merge "Merge gate fix" (${fix!.id})` }] });
    const r = await c.selfDeploy.updateRunners();
    const [card] = await c.db.select().from(decisions).where(eq(decisions.id, (r as { decisionId: string }).decisionId));
    expect(card!.context).toMatchObject({ target: "runner", commit: A });
    expect(card!.question).not.toContain("Urgent");
    expect((card!.context as { urgent?: unknown }).urgent).toBeUndefined();

    // Once the server runs C, the runner card for C builds the fix into the image: now it carries the heading.
    await c.req("POST", `/api/decisions/${card!.id}/answer`, { answer: "Not now" });
    await c.available({ deployed: C, tip: C, commits: [] });
    const r2 = await c.selfDeploy.updateRunners();
    const [card2] = await c.db.select().from(decisions).where(eq(decisions.id, (r2 as { decisionId: string }).decisionId));
    expect(card2!.context).toMatchObject({ target: "runner", commit: C });
    expect(card2!.question.split("\n\n")[0]).toBe(`${heading}.`);
  });
});

// BOS-1805 (18 Nov 14:37): the owner answered "Deploy" and the live commit never moved, with nobody told why.
describe("an approved server update that leaves the live commit unchanged (BOS-1805)", () => {
  it("tells the owner and wakes the CEO with the host's reason", async () => {
    const c = (ctx = await setup());
    const [co] = await c.db.select().from(companies).limit(1);
    const [ceo] = await c.db.select({ id: agents.id }).from(agents).where(and(eq(agents.companyId, co!.id), eq(agents.role, "ceo")));
    await c.available();
    await c.selfDeploy.sync();
    const [d] = await c.open();
    expect((await c.req("POST", `/api/decisions/${d!.id}/answer`, { answer: "Deploy" })).statusCode).toBe(200);
    await rm(path.join(c.dir, "inbox", "request.json"));
    await c.status({ id: d!.id, result: "rejected", message: "Refused: another deploy ran 3 minutes ago. Try again in 7 minute(s).", from_commit: A, to_commit: B });
    await c.selfDeploy.sync();
    await c.selfDeploy.sync();
    expect((await c.db.select().from(notifications)).find((n) => n.title === `Update refused: ${B.slice(0, 8)}`)?.body).toContain("Try again in 7 minute(s)");
    const told = (await c.db.select().from(wakes)).filter((w) => w.agentId === ceo!.id && w.reason === DEPLOY_UNCHANGED_REASON);
    expect(told).toHaveLength(1);
    expect(told[0]!.note).toContain(`card ${d!.id.slice(0, 8)}`);
    expect(told[0]!.note).toContain('the host reported "rejected": Refused: another deploy ran 3 minutes ago.');
  });

  it("a deploy that changed the live commit wakes nobody", async () => {
    const c = (ctx = await setup());
    await c.available();
    await c.selfDeploy.sync();
    const [d] = await c.open();
    await c.req("POST", `/api/decisions/${d!.id}/answer`, { answer: "Deploy" });
    await rm(path.join(c.dir, "inbox", "request.json"));
    await c.status({ id: d!.id, result: "deployed", message: "Deployed aaaaaaaa to bbbbbbbb." });
    await c.selfDeploy.sync();
    expect((await c.db.select().from(wakes)).filter((w) => w.reason === DEPLOY_UNCHANGED_REASON)).toHaveLength(0);
  });
});

describe("an approval when main moves on before the host runs it (BOS-753)", () => {
  const D = "d".repeat(40);
  const E = "e".repeat(40);
  async function merged(c: Awaited<ReturnType<typeof setup>>) {
    const [co] = await c.db.select().from(companies).limit(1);
    const [p] = await c.db.insert(projects).values({ companyId: co!.id, name: "Development" }).returning();
    const add = (title: string, mergeCommit: string, checkedCommit: string | null) =>
      c.db.insert(tickets).values({ companyId: co!.id, projectId: p!.id, title, mergeCommit, checkedCommit });
    return { add };
  }
  const checkedFile = (c: Awaited<ReturnType<typeof setup>>) => readFile(path.join(c.dir, "inbox", "checked"), "utf8");

  it("writes the merges that passed the merge gate beside the request, and keeps the list current while it waits", async () => {
    const c = (ctx = await setup());
    const m = await merged(c);
    await m.add("Checked merge", C, C);
    await m.add("Merged with no check", D, null); // e.g. a project with no merge check: never offered as checked
    await c.available();
    await c.selfDeploy.sync();
    const [d] = await c.open();
    expect((await c.req("POST", `/api/decisions/${d!.id}/answer`, { answer: "Deploy" })).statusCode).toBe(200);
    // The request still names the commit the owner approved; the list only lets the host go further along main.
    expect(JSON.parse(await readFile(path.join(c.dir, "inbox", "request.json"), "utf8"))).toMatchObject({ commit: B });
    expect(await checkedFile(c)).toBe(`${C}\n`);
    // A merge lands in the minute before the host's tick: the next pass adds it, so it can be the one that goes out.
    await m.add("Merged just after the press", E, E);
    await c.selfDeploy.sync();
    expect((await checkedFile(c)).split("\n").filter(Boolean).sort()).toEqual([C, E].sort());
  });

  it("tells the owner which commit went out and why, and takes the runner offer from what really went out", async () => {
    const c = (ctx = await setup());
    await c.available({ runnerChanged: false, commits: [{ sha: B, subject: "Add rate limiting" }] });
    await c.selfDeploy.sync();
    const [d] = await c.open();
    expect(d!.question).toContain("If more work merges before the host runs it, the newest version that has passed its checks goes out instead.");
    await c.req("POST", `/api/decisions/${d!.id}/answer`, { answer: "Deploy" });
    await rm(path.join(c.dir, "inbox", "request.json"));
    const message = `Deployed aaaaaaaa to cccccccc. You approved bbbbbbbb; main had moved on to cccccccc by the time the deployer ran, so the deployer took that newest checked version instead. It includes everything you approved.`;
    await c.status({ id: d!.id, result: "deployed", message, to_commit: C, requested_commit: B, runner_changed: "true" });
    await c.available({ deployed: C, tip: C });
    await c.selfDeploy.sync();
    const [told] = await c.db.select().from(notifications);
    expect(told).toMatchObject({ title: `Boss Man updated to ${C.slice(0, 8)}` });
    expect(told!.body).toContain(`You approved ${B.slice(0, 8)}`);
    expect(told!.body).toContain(`What changed, up to the approved ${B.slice(0, 8)} (the newer merges up to ${C.slice(0, 8)} went out too):`);
    // The Updates panel shows the host's message as the last deploy.
    expect((await c.req("GET", "/api/self-deploy")).json()).toMatchObject({ status: { result: "deployed", to_commit: C, requested_commit: B, message } });
    // The card's range had no runner change, but what went out did: the runner update is offered for it.
    const [runner] = await c.open();
    expect(runner).toMatchObject({ context: { type: "self_deploy", target: "runner", commit: C } });
  });

  it("offers no runner update when the card's range changed the runner but the host says what went out did not", async () => {
    const c = (ctx = await setup());
    await c.available({ runnerChanged: true });
    await c.selfDeploy.sync();
    const [d] = await c.open();
    await c.req("POST", `/api/decisions/${d!.id}/answer`, { answer: "Deploy" });
    await rm(path.join(c.dir, "inbox", "request.json"));
    await c.status({ id: d!.id, result: "deployed", to_commit: C, requested_commit: B, runner_changed: "false" });
    await c.available({ deployed: C, tip: C });
    await c.selfDeploy.sync();
    expect(await c.open()).toHaveLength(0);
  });

  // BOS-2561: "Try again" must not raise a second Deploy card for a version already approved and waiting or running.
  it("deployLatest refuses while an approved server update for the offered commit waits or runs, and raises a card otherwise", async () => {
    const c = (ctx = await setup());
    await c.available();
    await c.selfDeploy.sync();
    const [d] = await c.open();
    await c.req("POST", `/api/decisions/${d!.id}/answer`, { answer: "Deploy" });
    // Approved, request waiting in the inbox: no open card, and the button says why instead of raising one.
    const waiting = await c.selfDeploy.deployLatest();
    expect(waiting).toMatchObject({ error: expect.stringContaining("already approved and waiting") });
    expect(await c.open()).toHaveLength(0);
    // Running on the host.
    await rm(path.join(c.dir, "inbox", "request.json"));
    await c.status({ id: d!.id, result: "running", to_commit: B, started: new Date().toISOString(), ended: "" });
    expect(await c.selfDeploy.deployLatest()).toMatchObject({ error: expect.stringContaining("already approved and running") });
    expect(await c.open()).toHaveLength(0);
    // Nothing approved or running: a card is raised as before.
    await c.status({ id: d!.id, result: "failed", to_commit: B });
    expect(await c.selfDeploy.deployLatest()).toMatchObject({ decisionId: expect.any(String) });
  });

  it("deployLatest still raises a card when the waiting approved update is for an older commit than the offered tip", async () => {
    const c = (ctx = await setup());
    await c.available();
    await c.selfDeploy.sync();
    const [d] = await c.open();
    await c.req("POST", `/api/decisions/${d!.id}/answer`, { answer: "Deploy" });
    await c.available({ tip: C, commits: [{ sha: B, subject: "Add rate limiting" }, { sha: C, subject: "Newer work" }] });
    expect(await c.selfDeploy.deployLatest()).toMatchObject({ decisionId: expect.any(String) });
  });

  describe("the host deployer's report line", () => {
    const host = (c: Awaited<ReturnType<typeof setup>>, writtenAt: string) =>
      writeFile(path.join(c.dir, "outbox", "host.json"), JSON.stringify({ version: 1, name: "nas01", writtenAt, ownership: [] }));

    it("does not say it has not reported when it reported a minute ago, and asks it to look at main again", async () => {
      const c = (ctx = await setup());
      // Just after a deploy the host removes its offer; host.json is rewritten every tick.
      const fresh = new Date(Date.now() - 60_000).toISOString();
      await host(c, fresh);
      expect((await c.req("GET", "/api/self-deploy")).json()).toMatchObject({ available: null, deployer: { reportedAt: fresh, late: false } });
      const r = await c.selfDeploy.deployLatest();
      expect(r).toMatchObject({ error: expect.stringContaining("The host deployer is running (last report at") });
      expect((r as { error: string }).error).not.toContain("cron");
      expect(await readdir(path.join(c.dir, "inbox"))).toContain("check");
      expect(await c.selfDeploy.updateRunners()).toMatchObject({ error: expect.not.stringContaining("cron") });
    });

    it("says it is overdue, with when it last reported, once nothing has come for ten minutes", async () => {
      const c = (ctx = await setup());
      const stale = new Date(Date.now() - 11 * 60_000).toISOString();
      await host(c, stale);
      expect((await c.req("GET", "/api/self-deploy")).json()).toMatchObject({ deployer: { reportedAt: stale, late: true }, lateAfterMinutes: 10 });
      const r = await c.selfDeploy.deployLatest();
      expect((r as { error: string }).error).toContain(`The host deployer last reported at ${stale.slice(0, 10)} ${stale.slice(11, 16)} UTC, more than 10 minutes ago`);
      expect((r as { error: string }).error).toContain("Check that its cron job is running.");
    });

    it("is not overdue while a deploy holds the deployer's lock, and says it never reported when nothing ever came", async () => {
      const c = (ctx = await setup());
      await host(c, new Date(Date.now() - 30 * 60_000).toISOString());
      await c.status({ result: "running", started: new Date(Date.now() - 20 * 60_000).toISOString(), ended: "" });
      expect((await c.req("GET", "/api/self-deploy")).json()).toMatchObject({ deployer: { late: false } });
      await rm(path.join(c.dir, "outbox", "host.json"));
      await rm(path.join(c.dir, "outbox", "status.json"));
      expect((await c.req("GET", "/api/self-deploy")).json()).toMatchObject({ deployer: { reportedAt: null, late: true } });
      expect(await c.selfDeploy.deployLatest()).toEqual({ error: "The host deployer has not reported yet. Check that its cron job is running." });
    });
  });

  // BOS-990: the host reports the sha of its own deployer script; one owner card while it is behind or unknown.
  describe("deployer script version (BOS-990)", () => {
    const OLD = "1".repeat(64);
    const NEW = "2".repeat(64);
    const PATHS = { install: "/srv/bm", src: "/srv/bm/src", deployer: "/srv/bm/deployer" };
    // Each report also rewrites the offer file, so the poller sees a change and runs its pass (BOS-414).
    const report = async (c: Awaited<ReturnType<typeof setup>>, deployer: unknown) => {
      await writeFile(path.join(c.dir, "outbox", "host.json"), JSON.stringify({ version: 1, name: "nas01", writtenAt: "2026-10-20T12:00:00Z", ownership: [], paths: PATHS, ...(deployer ? { deployer } : {}) }));
      await c.available();
    };
    const cards = async (c: Awaited<ReturnType<typeof setup>>) => (await c.todos()).filter((d) => d.dedupeKey === "self-deploy:deployer-script");
    const ago = async (c: Awaited<ReturnType<typeof setup>>, ms: number) => {
      const value = { state: "behind", since: new Date(Date.now() - ms).toISOString() };
      await c.db.insert(settings).values({ key: "deployer_script_state", value }).onConflictDoUpdate({ target: settings.key, set: { value } });
      await c.available();
    };

    it("says current when the shas match, and raises nothing", async () => {
      const c = (ctx = await setup());
      await report(c, { scriptSha: NEW, repoSha: NEW });
      await c.selfDeploy.sync();
      expect(await c.selfDeploy.deployerScript()).toEqual({ state: "current" });
      expect(await cards(c)).toHaveLength(0);
    });

    it("an old deployer that reports no version is unknown and gets the card once", async () => {
      const c = (ctx = await setup());
      await report(c, undefined);
      await c.selfDeploy.sync();
      await c.selfDeploy.sync();
      expect((await c.selfDeploy.deployerScript()).state).toBe("unknown");
      const [card] = await cards(c);
      expect(await cards(c)).toHaveLength(1);
      expect(card!.question).toContain("Your host's deployer script is older than the running version");
      const steps = (card!.context as { steps: string[]; rollback: string }).steps.join("\n");
      expect(steps).toContain("cp -p /srv/bm/deployer/host-deployer.sh /srv/bm/deployer/host-deployer.sh.old && BOSSMAN_DEPLOYER=/srv/bm/deployer /srv/bm/src/scripts/install-deployer.sh");
      expect(steps).toContain('host="nas01" as="root"');
      expect((card!.context as { rollback: string }).rollback).toContain("cp -p /srv/bm/deployer/host-deployer.sh.old /srv/bm/deployer/host-deployer.sh");
    });

    // BOS-2336: the deployer-script card is checked when raised and when its steps are refreshed.
    const fixCards = async (c: Awaited<ReturnType<typeof setup>>) => (await c.db.select().from(decisions)).filter((d) => d.dedupeKey === "owner-todo-fix:self-deploy:deployer-script");
    // Its steps are a file copy, not a compose command, so R31 has nothing to refuse here (the proxy card above covers R31).
    it("holds a new deployer-script card on an R6 refusal, and the owner gets none", async () => {
      const c = (ctx = await setup());
      await report(c, undefined);
      setOwnerTodoFacts(async () => ({ serverHost: "other-box", hosts: [{ name: "other-box", ownership: [] }] }));
      try {
        await c.selfDeploy.sync();
      } finally {
        setOwnerTodoFacts(null);
      }
      expect(await cards(c)).toHaveLength(0);
      const fix = await fixCards(c);
      expect(fix).toHaveLength(1);
      expect(fix[0]!.tier).toBe("ceo");
      expect(fix[0]!.question).toContain(`but Boss Man runs on "other-box"`); // the R6 host fence
    });

    it("keeps the open deployer-script card's old steps when the refreshed ones are refused, and tells the CEO", async () => {
      const c = (ctx = await setup());
      await report(c, undefined);
      await c.selfDeploy.sync();
      const [first] = await cards(c);
      const oldSteps = (first!.context as { steps: string[] }).steps;
      // The host's folders change, so the steps are rewritten; the facts now say the server runs elsewhere (R6).
      await writeFile(path.join(c.dir, "outbox", "host.json"), JSON.stringify({ version: 1, name: "nas01", writtenAt: "2026-10-20T12:05:00Z", ownership: [], paths: { ...PATHS, deployer: "/srv/bm/deployer2" } }));
      await c.available();
      setOwnerTodoFacts(async () => ({ serverHost: "other-box", hosts: [{ name: "other-box", ownership: [] }] }));
      try {
        await c.selfDeploy.sync();
      } finally {
        setOwnerTodoFacts(null);
      }
      const [after] = await cards(c);
      expect((after!.context as { steps: string[] }).steps).toEqual(oldSteps);
      const fix = await fixCards(c);
      expect(fix).toHaveLength(1);
      expect(fix[0]!.question).toContain(`but Boss Man runs on "other-box"`); // the R6 host fence
    });

    it("no report at all raises nothing", async () => {
      const c = (ctx = await setup());
      await rm(path.join(c.dir, "outbox", "host.json"));
      await c.selfDeploy.sync();
      expect((await c.selfDeploy.deployerScript()).state).toBe("none");
      expect(await cards(c)).toHaveLength(0);
    });

    it("behind waits out the copy grace, then raises one card, and closes it when the shas match", async () => {
      const c = (ctx = await setup());
      await report(c, { scriptSha: OLD, repoSha: NEW });
      await c.selfDeploy.sync();
      const first = await c.selfDeploy.deployerScript();
      expect(first.state).toBe("behind");
      expect(first.since).toBeTruthy();
      expect(await cards(c)).toHaveLength(0); // an update's own copy step is given a few minutes
      await ago(c, 20 * 60_000);
      await c.selfDeploy.sync();
      await c.selfDeploy.sync();
      expect(await cards(c)).toHaveLength(1);
      await report(c, { scriptSha: NEW, repoSha: NEW });
      await c.selfDeploy.sync();
      expect(await cards(c)).toHaveLength(0);
      expect(await c.selfDeploy.deployerScript()).toEqual({ state: "current" });
      expect((await c.db.select().from(decisions).where(eq(decisions.dedupeKey, "self-deploy:deployer-script"))).length).toBe(0);
    });

    it("keeps the line (BOS-1057) when host.json is unreadable after a report was recorded", async () => {
      const c = (ctx = await setup());
      await report(c, { scriptSha: OLD, repoSha: NEW });
      await c.req("GET", "/api/host-facts"); // records the facts
      await writeFile(path.join(c.dir, "outbox", "host.json"), "{ half written");
      expect((await c.req("GET", "/api/host-facts")).json()).toMatchObject({ deployerScript: { state: "behind" } });
    });

    it("shows the line in Settings → This host's facts", async () => {
      const c = (ctx = await setup());
      await report(c, { scriptSha: OLD, repoSha: NEW });
      expect((await c.req("GET", "/api/host-facts")).json()).toMatchObject({ deployerScript: { state: "behind" }, facts: { "deployer.scriptSha": { value: OLD }, "deployer.repoSha": { value: NEW } } });
    });
  });
});

// BOS-1010: the runner-update card is only raised when it can be acted on (no server deploy approved, waiting, running
// or in its trial, and no host wait), and a later runner card withdraws every earlier one, by any path.
describe("the runner update card only when it can be acted on, and one at a time (BOS-1010)", () => {
  afterEach(() => vi.useRealTimers());
  const target = (d: { context: unknown }) => d.context as { target: string; commit: string };
  const runnerCards = async (c: Awaited<ReturnType<typeof setup>>) => (await c.open()).filter((d) => target(d).target === "runner");
  const serverCards = async (c: Awaited<ReturnType<typeof setup>>) => (await c.open()).filter((d) => target(d).target === "server");
  const inbox = (c: Awaited<ReturnType<typeof setup>>) => path.join(c.dir, "inbox", "request.json");
  const withdrawals = async (c: Awaited<ReturnType<typeof setup>>) => (await c.db.select().from(activity)).filter((a) => a.kind === "decision_withdrawn").map((a) => a.summary);
  /** host.json is the deployer's only sign of life, and its rewrite is what BOS-414's file fingerprint sees, so the next pass runs. */
  const hostTicks = (c: Awaited<ReturnType<typeof setup>>, at: string) => writeFile(path.join(c.dir, "outbox", "host.json"), JSON.stringify({ version: 1, name: "nas01", writtenAt: at, ownership: [] }));

  /** B runs, the trial is over, and an open runner card for B is on the queue (the state at 18:25 on 9 Nov). */
  async function cardOpenForB() {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-09T18:25:00Z"));
    const c = (ctx = await setup());
    await hostTicks(c, "2026-11-09T18:25:00Z");
    await c.available({ deployed: B, tip: B });
    expect((await c.req("POST", "/api/self-deploy/update-runners")).json().decisionId).toBeTruthy();
    expect(await runnerCards(c)).toHaveLength(1);
    return c;
  }

  it("closes an open runner card with a plain reason when a server update is approved, and offers the fresh one after its trial", async () => {
    const c = await cardOpenForB();
    const [first] = await runnerCards(c);
    // A merge lands that changes the runner: a server update is offered beside the runner card.
    await c.available({ deployed: B, tip: C, runnerChanged: true, commits: [{ sha: C, subject: "Tidy a comment" }] });
    await hostTicks(c, "2026-11-09T18:26:00Z");
    await c.selfDeploy.sync();
    const [server] = await serverCards(c);
    expect(server).toBeTruthy();
    expect((await c.req("POST", `/api/decisions/${server!.id}/answer`, { answer: "Deploy" })).statusCode).toBe(200);
    // BOS-1086: the pass sees the approved request waiting for the host, and the runner card is NOT closed: the runners
    // are built from the live version when the update starts, so the card stays valid (no close-and-re-raise churn).
    await hostTicks(c, "2026-11-09T18:27:00Z");
    await c.selfDeploy.sync();
    expect(await runnerCards(c)).toHaveLength(1);
    expect((await withdrawals(c)).join(" ")).not.toContain("A server update started");
    // The host runs it: the server update goes live at 18:28, in its 15-minute trial until 18:43.
    vi.setSystemTime(new Date("2026-11-09T18:28:03Z"));
    await rm(inbox(c));
    await c.status({ id: server!.id, result: "deployed", message: "Switched in.", from_commit: B, to_commit: C, started: "2026-11-09T18:27:50Z", ended: "2026-11-09T18:28:03Z" });
    await c.available({ deployed: C, tip: C, runnerChanged: true });
    await hostTicks(c, "2026-11-09T18:28:30Z");
    await c.selfDeploy.sync();
    expect(await runnerCards(c)).toHaveLength(1); // the old card for B stays; the trial holds the one for C
    // Four minutes on the host rewrites host.json: the runner card is offered once the trial is over, by itself.
    vi.setSystemTime(new Date("2026-11-09T18:47:00Z"));
    await hostTicks(c, "2026-11-09T18:47:00Z");
    // BOS-414's fingerprint is real file times; and the host removes its offer after a deploy, so this pass also sees
    // status.json gone.
    await rm(path.join(c.dir, "outbox", "status.json"));
    await c.selfDeploy.sync();
    const cards = await runnerCards(c);
    expect(cards).toHaveLength(1);
    // The fresh card names the version Boss Man runs now, never the old one.
    expect(target(cards[0]!)).toMatchObject({ commit: C });
  });

  it("raises no runner card while a server update is approved and waiting for the host", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-09T18:10:26Z"));
    const c = (ctx = await setup());
    await hostTicks(c, "2026-11-09T18:10:26Z");
    // A server update is offered and approved; it waits for the host's next tick.
    await c.available({ deployed: A, tip: B, runnerChanged: true });
    await c.selfDeploy.sync();
    const [server] = await serverCards(c);
    expect((await c.req("POST", `/api/decisions/${server!.id}/answer`, { answer: "Deploy" })).statusCode).toBe(200);
    // The trial of an earlier deploy has just ended while the request waits: no runner card may be raised (9 Nov 18:26).
    vi.setSystemTime(new Date("2026-11-09T18:25:00Z"));
    await hostTicks(c, "2026-11-09T18:25:00Z");
    await c.selfDeploy.sync();
    expect(await runnerCards(c)).toHaveLength(0);
  });

  it("raises no runner card while a server deploy is running", async () => {
    const c = await cardOpenForB();
    // A deploy is running (the host says so): the open card stays (BOS-1086) and nothing second is raised.
    await c.status({ id: "", result: "running", message: "Deploying…", target: "server", to_commit: C, started: "2026-11-09T18:26:00Z", ended: "" });
    await hostTicks(c, "2026-11-09T18:26:00Z");
    await c.selfDeploy.sync();
    expect(await runnerCards(c)).toHaveLength(1);
    // Pressing the button now is never a refusal: it is queued and says why it waits.
    const r = await c.req("POST", "/api/self-deploy/update-runners");
    expect(r.statusCode).toBe(200);
    expect(r.json().queued).toBe(true);
    expect(r.json().message).toContain("running now");
  });

  it("BOS-1469: a waiting request comes first, the refusal before it is only the previous attempt", async () => {
    const c = (ctx = await setup());
    await c.available({ deployed: B, tip: B });
    // The real last run, then a rate-limit refusal the host kept in its own file.
    await c.status({ id: randomUUID(), target: "runner", result: "deployed", message: "Image built.", to_commit: B, started: "2026-11-14T16:40:00Z", ended: "2026-11-14T16:50:00Z" });
    await writeFile(path.join(c.dir, "outbox", "refused.json"), JSON.stringify({ id: "", target: "runner", result: "rejected", message: "Rejected: only one runner deploy every 10 minutes. Try again in 2 minute(s).", from_commit: B, to_commit: B, started: "2026-11-14T16:57:00Z", ended: "2026-11-14T16:57:00Z", backup: "" }));
    let o = await c.selfDeploy.overview();
    expect(o.status?.result).toBe("rejected");
    expect(o.previousRun?.message).toBe("Image built.");
    expect(o.active).toBeNull();
    // Runner refusals get the "press again at" line too: 16:57 + 2 minutes, for the runner kind only.
    expect(o.deployWait).toEqual({ until: "2026-11-14T16:59:00.000Z", target: "runner" });
    // The press is accepted: a request now waits in the inbox. The refusal must not read as its answer.
    await writeFile(path.join(c.dir, "inbox", "request.json"), JSON.stringify({ id: randomUUID(), target: "runner", commit: B }));
    o = await c.selfDeploy.overview();
    expect(o.active).toMatchObject({ phase: "waiting", what: "Build and update runners" });
    expect(o.status?.message).not.toMatch(/Try again in/);
    expect(o.previousRun?.message).toBe("Image built.");
    expect(o.runnerImage).toEqual({ running: null, needed: B });
    expect(o.deployWait).toBeNull(); // a newer accepted request: no "try again" for the old refusal
  });

  it("BOS-1469: a refusal older than the real run (left over from before a restart) is not the newest word", async () => {
    const c = (ctx = await setup());
    await c.available({ deployed: B, tip: B });
    await c.status({ id: randomUUID(), target: "runner", result: "deployed", message: "Image built.", to_commit: B, started: "2026-11-14T17:00:00Z", ended: "2026-11-14T17:05:00Z" });
    await writeFile(path.join(c.dir, "outbox", "refused.json"), JSON.stringify({ id: "", target: "runner", result: "rejected", message: "Rejected: only one runner deploy every 10 minutes. Try again in 2 minute(s).", from_commit: B, to_commit: B, started: "2026-11-14T16:57:00Z", ended: "2026-11-14T16:57:00Z", backup: "" }));
    const o = await c.selfDeploy.overview();
    expect(o.status?.result).toBe("deployed");
    expect(o.previousRun).toBeNull();
    expect(o.deployWait).toBeNull();
  });

  it("BOS-1469: an approval inside the host's 10-minute limit is told so at once", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-14T17:00:00Z"));
    const c = (ctx = await setup());
    await c.status({ id: randomUUID(), target: "runner", result: "deployed", message: "Image built.", to_commit: B, started: "2026-11-14T16:55:00Z", ended: "2026-11-14T16:58:00Z" });
    await expect(c.selfDeploy.check({ type: "self_deploy", target: "runner", commit: B, fromCommit: B } as never)).rejects.toThrow(/one runner deploy every 10 minutes/);
    // A different kind of deploy has its own limit.
    await expect(c.selfDeploy.check({ type: "self_deploy", target: "server", commit: B, fromCommit: A } as never)).resolves.not.toThrow();
  });

  it("raises no runner card while the host's 'try again in N minutes' wait is on", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-09T18:30:00Z"));
    const c = (ctx = await setup());
    await c.status({ id: "", result: "rejected", message: "Try again in 5 minute(s).", target: "server", ended: "2026-11-09T18:29:00Z" });
    await c.available({ deployed: B, tip: B });
    const r = await c.req("POST", "/api/self-deploy/update-runners");
    expect(r.statusCode).toBe(200);
    expect(r.json().queued).toBe(true);
    expect(r.json().message).toMatch(/(?:wait|updated until)/i);
    // Once the wait has passed the queued update starts by itself (BOS-1086).
    vi.setSystemTime(new Date("2026-11-09T18:35:00Z"));
    await hostTicks(c, "2026-11-09T18:35:00Z");
    await c.selfDeploy.sync();
    expect(JSON.parse(await readFile(inbox(c), "utf8"))).toMatchObject({ target: "runner", commit: B });
  });

  it("a later pass that sees a newer server version raises the card for the live version, never two", async () => {
    const c = await cardOpenForB();
    // A runner card for B is open; then Boss Man moves to C by a deploy the card path did not see. The card for B is
    // withdrawn as the card for C is raised, so the owner never has two runner cards.
    await c.available({ deployed: C, tip: C });
    await hostTicks(c, "2026-11-09T18:26:00Z");
    await c.selfDeploy.sync();
    const cards = await runnerCards(c);
    expect(cards).toHaveLength(1);
  });

  it("a card raised for the live version withdraws an earlier open card (the BOS-947 replacement + BOS-1010)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-03T01:00:00Z"));
    const c = (ctx = await setup());
    await hostTicks(c, "2026-11-03T01:00:00Z");
    // A runner card for A, from what ran before the server update.
    await c.available({ deployed: A, tip: A });
    await c.req("POST", "/api/self-deploy/update-runners");
    const [early] = await runnerCards(c);
    expect(target(early!)).toMatchObject({ commit: A });
    // A server update to B is offered: the open runner card stays (BOS-1086), and, once B's trial is over, the fresh card
    // for B is raised by the trial-end path, names the live version and replaces it.
    await c.available({ deployed: A, tip: B, runnerChanged: true, commits: [{ sha: B, subject: "Add rate limiting" }] });
    await hostTicks(c, "2026-11-03T01:00:30Z");
    await c.selfDeploy.sync();
    expect(await runnerCards(c)).toHaveLength(1);
    vi.setSystemTime(new Date("2026-11-03T01:01:00Z"));
    await c.status({ id: "", result: "deployed", message: "Switched in.", from_commit: A, to_commit: B, runner_changed: "true", ended: "2026-11-03T01:01:00Z" });
    await c.available({ deployed: B, tip: B, runnerChanged: true });
    // The host takes its request from the inbox once it has run it, so the next pass sees nothing waiting.
    await rm(inbox(c), { force: true });
    await hostTicks(c, "2026-11-03T01:01:30Z");
    await c.selfDeploy.sync();
    // The trial holds the new runner card until it is over (01:16); the old one stays meanwhile.
    expect(await runnerCards(c)).toHaveLength(1);
    vi.setSystemTime(new Date("2026-11-03T01:20:00Z"));
    // The host rewrites a file, so BOS-414's fingerprint changes and the pass runs; the trial ended at 01:16.
    await hostTicks(c, "2026-11-03T01:20:00Z");
    await rm(path.join(c.dir, "outbox", "status.json"));
    await c.selfDeploy.sync();
    const cards = await runnerCards(c);
    expect(cards).toHaveLength(1);
    expect(target(cards[0]!)).toMatchObject({ commit: B });
    expect(cards[0]!.id).not.toBe(early!.id);
  });

  it("a retry after 'Not now' still leaves exactly one open runner card", async () => {
    const c = await cardOpenForB();
    const [first] = await runnerCards(c);
    expect((await c.req("POST", "/api/self-deploy/update-runners")).json()).toEqual({ decisionId: first!.id });
    // An answered card holds the plain key, so the button raises a keyed copy (the retry path): still only one open.
    await c.db.update(decisions).set({ status: "answered", answer: "Not now", dedupeKey: null, answeredAt: new Date() }).where(eq(decisions.id, first!.id));
    const r = await c.req("POST", "/api/self-deploy/update-runners");
    expect(r.json().decisionId).toBeTruthy();
    expect(await runnerCards(c)).toHaveLength(1);
  });

  it("a card the Settings button raises withdraws an earlier open automatic card, leaving one (round 4, Settings path)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-09T18:25:00Z"));
    const c = (ctx = await setup());
    await hostTicks(c, "2026-11-09T18:25:00Z");
    // An automatic card for B is open, and Boss Man has since moved to C: an automatic offer for C can't raise (it is C's
    // trial, or a stale quick moment), so plant the older automatic card directly and let the button raise for C.
    await c.available({ deployed: C, tip: C });
    await c.db.insert(decisions).values({ companyId: (await c.db.select().from(companies))[0]!.id, kind: "approval", question: "Update the runners to bbbbbbbb?", options: ["Update runners", "Not now"], recommendedOption: "Update runners", dedupeKey: `self-deploy:runner:${B}`, context: { type: "self_deploy", target: "runner", commit: B, fromCommit: A }, createdAt: new Date("2026-11-09T17:00:00Z") });
    expect(await runnerCards(c)).toHaveLength(1);
    // The button raises its own card for the live version (C); the earlier automatic card is withdrawn with the plain reason.
    const r = await c.req("POST", "/api/self-deploy/update-runners");
    expect(r.json().decisionId).toBeTruthy();
    const cards = await runnerCards(c);
    expect(cards).toHaveLength(1);
    expect(target(cards[0]!)).toMatchObject({ commit: C });
    expect((await withdrawals(c)).join(" ")).toContain(`Replaced by a newer runner update for ${C.slice(0, 8)}`);
  });

  it("raises the card by itself once the trial ends with nothing pending, and never pushes it to the phone", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-09T18:10:00Z"));
    const c = (ctx = await setup());
    await hostTicks(c, "2026-11-09T18:10:00Z");
    // Phone pushes are set for asks, and the phone is set up.
    await c.notes.setSettings({ ...(await c.notes.getSettings()), pushLevels: ["page", "ask"], ntfy: { url: "https://ntfy.example.ts.net", topic: "bossman", tokenSecretId: null } });
    const pushed: unknown[] = [];
    (c.notes as { push?: unknown }).push = vi.fn(async () => { pushed.push(1); });
    // A server update goes live with runner code changed: the trial runs to 18:25:30.
    await c.available({ runnerChanged: true });
    await c.selfDeploy.sync();
    const [server] = await serverCards(c);
    await c.req("POST", `/api/decisions/${server!.id}/answer`, { answer: "Deploy" });
    await rm(inbox(c));
    await c.status({ id: server!.id, result: "deployed", message: "Switched in.", from_commit: A, to_commit: B, ended: "2026-11-09T18:10:30Z" });
    await c.available({ deployed: B, tip: B, runnerChanged: true });
    await hostTicks(c, "2026-11-09T18:11:00Z");
    await c.selfDeploy.sync();
    // After the trial the card is raised by itself; the sweep records its note and the phone is never pushed it.
    vi.setSystemTime(new Date("2026-11-09T18:25:31Z"));
    await hostTicks(c, "2026-11-09T18:25:31Z");
    await c.selfDeploy.sync();
    const [card] = await runnerCards(c);
    expect(card).toBeTruthy();
    const before = pushed.length;
    await c.notes.syncDecisions();
    expect(pushed.length).toBe(before);
    // It is still in the feed, at level ask, and says it was not sent to the phone.
    const told = (await c.db.select().from(notifications)).find((n) => n.decisionId === card!.id);
    expect(told).toMatchObject({ requested: "ask", pushedAt: null });
  });

  it("a press during a race is never a silent refusal: it says why and when, and the card is closed", async () => {
    const c = await cardOpenForB();
    // A server update's request is already waiting for the host (approved just before the press): the button can't work.
    await writeFile(inbox(c), JSON.stringify({ id: randomUUID(), target: "server", commit: C, requestedAt: new Date().toISOString(), approvedBy: "owner" }));
    const r = await c.req("POST", "/api/self-deploy/update-runners");
    expect(r.statusCode).toBe(200);
    expect(r.json().queued).toBe(true);
    expect(r.json().message).toContain("waiting for the host");
    // The pass leaves the open runner card alone (BOS-1086): closing and re-raising it is what starved the update.
    await hostTicks(c, "2026-11-09T18:26:00Z");
    await c.selfDeploy.sync();
    expect(await runnerCards(c)).toHaveLength(1);
  });

  it("clears leftover duplicate runner cards already open when this ships, keeping the one for the live version", async () => {
    const c = await cardOpenForB();
    const [live] = await runnerCards(c);
    // A second, older duplicate for an earlier version (as a past release could leave beside it): planted directly, since
    // raising a card now always withdraws the others.
    await c.db.insert(decisions).values({ companyId: live!.companyId, kind: "approval", question: "Update the runners to aaaaaaaa?", options: ["Update runners", "Not now"], recommendedOption: "Update runners", dedupeKey: "self-deploy:runner:dup-test", context: { type: "self_deploy", target: "runner", commit: A, fromCommit: A }, createdAt: new Date("2026-11-09T17:00:00Z") });
    expect(await runnerCards(c)).toHaveLength(2);
    await hostTicks(c, "2026-11-09T18:26:00Z");
    await c.selfDeploy.sync();
    // Only the card for the live version (B) is left, and the duplicate was withdrawn with a plain reason.
    const cards = await runnerCards(c);
    expect(cards).toHaveLength(1);
    expect(target(cards[0]!)).toMatchObject({ commit: B });
    expect((await withdrawals(c)).join(" ")).toContain("Replaced by a newer runner update for");
  });
});

describe("runner updates queue instead of being refused (BOS-1086)", () => {
  afterEach(() => vi.useRealTimers());
  const target = (d: { context: unknown }) => d.context as { target: string; commit: string };
  const runnerCards = async (c: Awaited<ReturnType<typeof setup>>) => (await c.open()).filter((d) => target(d).target === "runner");
  const inbox = (c: Awaited<ReturnType<typeof setup>>) => path.join(c.dir, "inbox", "request.json");
  const hostTicks = (c: Awaited<ReturnType<typeof setup>>, at: string) => writeFile(path.join(c.dir, "outbox", "host.json"), JSON.stringify({ version: 1, name: "nas01", writtenAt: at, ownership: [] }));

  it("a newer server update card does not refuse the runner update (the 10 Nov complaint)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-10T17:00:00Z"));
    const c = (ctx = await setup());
    await hostTicks(c, "2026-11-10T17:00:00Z");
    // B runs, the trial is long over, and main has moved on to C: an open server card for C.
    await c.available({ deployed: B, tip: C });
    await c.selfDeploy.sync();
    expect((await c.open()).filter((d) => target(d).target === "server")).toHaveLength(1);
    const r = await c.req("POST", "/api/self-deploy/update-runners");
    expect(r.statusCode).toBe(200);
    expect(r.json().decisionId).toBeTruthy();
    // The next pass leaves that runner card open beside the server card: a deploy waiting never closes it.
    await hostTicks(c, "2026-11-10T17:01:00Z");
    await c.selfDeploy.sync();
    expect(await runnerCards(c)).toHaveLength(1);
  });

  it("a press during the trial is kept when something blocks at the trial's end, and the update starts once it clears", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-10T17:00:00Z"));
    const c = (ctx = await setup());
    await hostTicks(c, "2026-11-10T17:00:00Z");
    await c.status({ id: randomUUID(), target: "server", result: "deployed", from_commit: A, to_commit: B, ended: "2026-11-10T17:01:00Z" });
    await c.available({ deployed: B, tip: B });
    await c.selfDeploy.sync();
    // Pressed inside the trial (ends 17:16): queued with the time, not refused.
    const press = await c.req("POST", "/api/self-deploy/update-runners");
    expect(press.statusCode).toBe(200);
    expect(press.json().queued).toBe(true);
    expect(press.json().message).toContain("Runners will update at");
    // At the trial's end a server request is waiting for the host: the runner update must wait, not vanish.
    vi.setSystemTime(new Date("2026-11-10T17:16:30Z"));
    await writeFile(inbox(c), JSON.stringify({ id: randomUUID(), target: "server", commit: C, requestedAt: new Date().toISOString(), approvedBy: "owner" }));
    await hostTicks(c, "2026-11-10T17:16:30Z");
    await c.selfDeploy.sync();
    // The host took the server request; the runner update goes by itself.
    await rm(inbox(c));
    vi.setSystemTime(new Date("2026-11-10T17:17:30Z"));
    await hostTicks(c, "2026-11-10T17:17:30Z");
    await c.selfDeploy.sync();
    expect(JSON.parse(await readFile(inbox(c), "utf8"))).toMatchObject({ target: "runner", commit: B });
  });
});

describe("a queued runner update, its cancel and the deploys behind it (BOS-1086)", () => {
  afterEach(() => vi.useRealTimers());
  const inbox = (c: Awaited<ReturnType<typeof setup>>) => path.join(c.dir, "inbox", "request.json");
  const hostTicks = (c: Awaited<ReturnType<typeof setup>>, at: string) => writeFile(path.join(c.dir, "outbox", "host.json"), JSON.stringify({ version: 1, name: "nas01", writtenAt: at, ownership: [] }));
  /** B went live at 17:01 (trial to 17:16) and the owner pressed Build and update runners at once. */
  async function queuedInTrial() {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-10T17:00:00Z"));
    const c = (ctx = await setup());
    await hostTicks(c, "2026-11-10T17:00:00Z");
    await c.status({ id: randomUUID(), target: "server", result: "deployed", from_commit: A, to_commit: B, ended: "2026-11-10T17:01:00Z" });
    await c.available({ deployed: B, tip: B });
    await c.selfDeploy.sync();
    const press = await c.req("POST", "/api/self-deploy/update-runners");
    expect(press.json().queued).toBe(true);
    return c;
  }

  it("cancels the queued update when the server update is switched back, and says why", async () => {
    const c = await queuedInTrial();
    vi.setSystemTime(new Date("2026-11-10T17:05:00Z"));
    await c.status({ id: randomUUID(), target: "server", result: "rolled_back", message: "Switched back.", from_commit: B, to_commit: A, ended: "2026-11-10T17:05:00Z" });
    await c.available({ deployed: A, tip: B });
    await hostTicks(c, "2026-11-10T17:05:00Z");
    await c.selfDeploy.sync();
    const o = await c.selfDeploy.overview();
    expect(o.runnerQueue).toBeNull();
    expect(o.queueCancelled?.why).toContain("switched back");
    // Long after the old trial would have ended nothing is sent: the runners never update to a rolled-back version.
    vi.setSystemTime(new Date("2026-11-10T17:30:00Z"));
    await hostTicks(c, "2026-11-10T17:30:00Z");
    await c.selfDeploy.sync();
    await expect(readFile(inbox(c), "utf8")).rejects.toThrow();
  });

  it("lets the owner cancel the queued update", async () => {
    const c = await queuedInTrial();
    expect((await c.selfDeploy.overview()).runnerQueue).toMatchObject({ startsAt: expect.any(String) });
    expect((await c.req("POST", "/api/self-deploy/cancel-runner-queue")).json().cancelled).toBe(true);
    expect((await c.selfDeploy.overview()).runnerQueue).toBeNull();
    vi.setSystemTime(new Date("2026-11-10T17:30:00Z"));
    await hostTicks(c, "2026-11-10T17:30:00Z");
    await c.selfDeploy.sync();
    await expect(readFile(inbox(c), "utf8")).rejects.toThrow();
  });

  it("holds a deploy approved while the runner update is queued, then sends it once the runner update has run", async () => {
    const c = await queuedInTrial();
    // Main moves on to C; the owner approves the deploy inside the trial.
    await c.available({ deployed: B, tip: C, commits: [{ sha: C, subject: "Tidy" }] });
    await hostTicks(c, "2026-11-10T17:02:00Z");
    await c.selfDeploy.sync();
    const [server] = (await c.open()).filter((d) => (d.context as { target: string }).target === "server");
    expect((await c.req("POST", `/api/decisions/${server!.id}/answer`, { answer: "Deploy" })).statusCode).toBe(200);
    // It must not reach the host (it would restart the trial clock in front of the runner update).
    await expect(readFile(inbox(c), "utf8")).rejects.toThrow();
    expect((await c.selfDeploy.overview()).heldDeploy).toMatchObject({ id: server!.id, commit: C });
    // The trial ends: the runner update goes first.
    vi.setSystemTime(new Date("2026-11-10T17:16:30Z"));
    await hostTicks(c, "2026-11-10T17:16:30Z");
    await c.selfDeploy.sync();
    expect(JSON.parse(await readFile(inbox(c), "utf8"))).toMatchObject({ target: "runner" });
    // The host takes it and builds; the deploy still waits.
    await rm(inbox(c));
    await c.status({ id: randomUUID(), target: "runner", result: "running", message: "Building…", to_commit: B, started: "2026-11-10T17:17:00Z", ended: "" });
    await hostTicks(c, "2026-11-10T17:17:00Z");
    await c.selfDeploy.sync();
    await expect(readFile(inbox(c), "utf8")).rejects.toThrow();
    // The image is built (the drain takes over from here): the deploy goes by itself.
    await c.status({ id: randomUUID(), target: "runner", result: "deployed", message: "New runner image ready.", to_commit: B, started: "2026-11-10T17:17:00Z", ended: "2026-11-10T17:20:00Z" });
    await hostTicks(c, "2026-11-10T17:20:30Z");
    await c.selfDeploy.sync();
    expect(JSON.parse(await readFile(inbox(c), "utf8"))).toMatchObject({ id: server!.id, target: "server", commit: C });
    expect((await c.selfDeploy.overview()).heldDeploy).toBeNull();
  });
});

describe("the combined button: deploy, then update runners after the trial (BOS-1086)", () => {
  afterEach(() => vi.useRealTimers());
  const inbox = (c: Awaited<ReturnType<typeof setup>>) => path.join(c.dir, "inbox", "request.json");
  const hostTicks = (c: Awaited<ReturnType<typeof setup>>, at: string) => writeFile(path.join(c.dir, "outbox", "host.json"), JSON.stringify({ version: 1, name: "nas01", writtenAt: at, ownership: [] }));
  async function approved() {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-10T17:00:00Z"));
    const c = (ctx = await setup());
    await hostTicks(c, "2026-11-10T17:00:00Z");
    await c.available({ runnerChanged: true });
    await c.selfDeploy.sync();
    const [d] = await c.open();
    expect(d!.options).toEqual(["Deploy", "Deploy, then update runners after the trial", "Not now"]);
    expect((await c.req("POST", `/api/decisions/${d!.id}/answer`, { answer: "Deploy, then update runners after the trial" })).statusCode).toBe(200);
    expect(JSON.parse(await readFile(inbox(c), "utf8"))).toMatchObject({ target: "server", commit: B });
    await rm(inbox(c));
    return { c, d: d! };
  }

  it("queues the runner update when the deploy lands, and starts it by itself when the trial ends", async () => {
    const { c, d } = await approved();
    await c.status({ id: d.id, target: "server", result: "deployed", from_commit: A, to_commit: B, ended: "2026-11-10T17:01:00Z", runner_changed: "true" });
    await c.available({ deployed: B, tip: B });
    await c.selfDeploy.sync();
    expect((await c.selfDeploy.overview()).runnerQueue).toMatchObject({ startsAt: expect.any(String) });
    await expect(readFile(inbox(c), "utf8")).rejects.toThrow();
    vi.setSystemTime(new Date("2026-11-10T17:16:30Z"));
    await hostTicks(c, "2026-11-10T17:16:30Z");
    await c.selfDeploy.sync();
    expect(JSON.parse(await readFile(inbox(c), "utf8"))).toMatchObject({ target: "runner", commit: B });
  });

  it("is cancelled, with the reason, when the deploy is switched back", async () => {
    const { c, d } = await approved();
    await c.status({ id: d.id, target: "server", result: "rolled_back", message: "Switched back.", from_commit: B, to_commit: A, ended: "2026-11-10T17:02:00Z" });
    await c.available({ deployed: A, tip: B });
    await c.selfDeploy.sync();
    const o = await c.selfDeploy.overview();
    expect(o.runnerQueue).toBeNull();
    expect(o.queueCancelled?.why).toContain("switched back");
    vi.setSystemTime(new Date("2026-11-10T17:40:00Z"));
    await hostTicks(c, "2026-11-10T17:40:00Z");
    await c.selfDeploy.sync();
    await expect(readFile(inbox(c), "utf8")).rejects.toThrow();
  });
});
