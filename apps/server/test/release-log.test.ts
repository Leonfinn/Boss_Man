import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm as rmFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { and, eq, like } from "drizzle-orm";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { activity, agents, decisions, deployTargets, runners, settings, ticketMessages, tickets, wakes } from "../src/db/schema.js";
import { RELEASE_REASON, releaseLogService } from "../src/services/release-log.js";
import { RUNNER_NEED_UNKNOWN_REASON } from "../src/services/runner-update-need.js";

let ctx: Awaited<ReturnType<typeof setupApp>> | undefined;
afterEach(async () => {
  await ctx?.app.close();
  await ctx?.close();
  if (ctx?.dir) await rmFile(ctx.dir, { recursive: true, force: true });
  ctx = undefined;
});

const A = "1".repeat(40);
const B = "2".repeat(40);
const C = "3".repeat(40);

async function setupApp() {
  const dir = await mkdtemp(path.join(tmpdir(), "bm-releaselog-"));
  await mkdir(path.join(dir, "inbox"));
  await mkdir(path.join(dir, "outbox"));
  const { db, close } = await openPglite();
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false, deployerDir: dir });
  const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
  const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
  const req = (method: "GET" | "POST", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  return { ...built, db, close, dir, req };
}

/** A company with a Release Manager and one open project to put the log tickets on. */
async function withReleaseManager(c: Awaited<ReturnType<typeof setupApp>>, opts: { agent?: boolean } = {}) {
  const { company } = (await c.req("POST", "/api/companies", { name: "Release Co" })).json() as { company: { id: string } };
  const project = (await c.req("POST", `/api/companies/${company.id}/projects`, { name: "Releases" })).json() as { id: string };
  let rm: { id: string } | null = null;
  if (opts.agent !== false) {
    await c.db.insert(agents).values({ companyId: company.id, name: "Holly", role: "worker", agentKind: "claude", template: "release-manager", title: "Release Manager" });
    const [row] = await c.db.select({ id: agents.id }).from(agents).where(eq(agents.template, "release-manager"));
    rm = row!;
  }
  return { companyId: company.id, projectId: project.id, rm };
}

const statusFile = (c: Awaited<ReturnType<typeof setupApp>>) => path.join(c.dir, "outbox", "status.json");
const availableFile = (c: Awaited<ReturnType<typeof setupApp>>) => path.join(c.dir, "outbox", "available.json");

/** What the host deployer publishes after a deploy, a switch-back or a rollback. */
async function deployResult(c: Awaited<ReturnType<typeof setupApp>>, over: { result?: string; from?: string; to?: string; id?: string; ended?: string }) {
  const to = over.to ?? B;
  await writeFile(availableFile(c), JSON.stringify({ checkedAt: new Date().toISOString(), deployed: to, tip: to, commits: [], paths: [], infraPaths: [], runnerChanged: false }));
  await writeFile(
    statusFile(c),
    JSON.stringify({ id: over.id ?? randomUUID(), target: "server", result: over.result ?? "deployed", message: "Deployed.", from_commit: over.from ?? A, to_commit: to, started: "2026-10-31T12:01:00Z", ended: over.ended ?? new Date().toISOString(), backup: "" }),
  );
}

describe("release log: the Release Manager is woken when the live commit changes (BOS-284)", () => {
  it("wakes once for a deploy, with the old and new commit and how it went live, on a no-code ticket", async () => {
    const c = (ctx = await setupApp());
    const { companyId, projectId, rm } = await withReleaseManager(c);
    await c.releaseLog.note(companyId, A);
    await c.releaseLog.releaseManagerWakes("restarted"); // catching up from the first observation: nothing to do
    await deployResult(c, { from: A, to: B });
    expect(await c.selfDeploy.sync()).toBe(1);

    const logTickets = (await c.db.select().from(tickets)).filter((x) => x.title.startsWith("Release log:"));
    expect(logTickets).toHaveLength(1);
    expect(logTickets[0]).toMatchObject({ projectId, assigneeAgentId: rm!.id, noCode: true, systemState: "ready", title: `Release log: record ${B.slice(0, 8)}` });
    expect(logTickets[0]!.body).toContain(A);
    expect(logTickets[0]!.body).toContain(B);
    expect(logTickets[0]!.body).toContain("republish the website");
    const [w] = await c.db.select().from(wakes).where(eq(wakes.ticketId, logTickets[0]!.id));
    expect(w).toMatchObject({ agentId: rm!.id, reason: RELEASE_REASON, ticketId: logTickets[0]!.id });
    expect(w!.note).toContain(A.slice(0, 8));
    expect(w!.note).toContain(B.slice(0, 8));
    expect(w!.note).toContain("the host deployer");
    expect(w!.note).toContain("republish the website");

    // Another pass on the same status changes nothing: one ticket, one wake.
    await c.selfDeploy.sync();
    expect((await c.db.select().from(tickets)).filter((x) => x.title.startsWith("Release log:"))).toHaveLength(1);
    expect(await c.db.select().from(wakes)).toHaveLength(1);
  });

  it("wakes again for a rollback, naming the rollback", async () => {
    const c = (ctx = await setupApp());
    const { companyId, rm } = await withReleaseManager(c);
    await c.releaseLog.note(companyId, A);
    await deployResult(c, { from: A, to: B });
    await c.selfDeploy.sync();
    // The Release Manager finished the first ticket (BOS-1112): the rollback then opens a fresh one and wakes again.
    await c.db.update(tickets).set({ systemState: "done" }).where(like(tickets.title, "Release log:%"));
    await deployResult(c, { result: "rolled_back", from: B, to: A, ended: new Date(Date.now() + 60_000).toISOString(), id: randomUUID() });
    expect(await c.selfDeploy.sync()).toBe(1);
    const all = await c.db.select().from(wakes).where(eq(wakes.agentId, rm!.id));
    expect(all).toHaveLength(2);
    const rollback = all.find((w) => w.note?.includes("a rollback"));
    expect(rollback).toBeDefined();
    expect(rollback!.note).toContain(B.slice(0, 8));
    expect(rollback!.note).toContain(A.slice(0, 8));
  });

  it("does NOT wake for a restart on the same commit", async () => {
    const c = (ctx = await setupApp());
    const { companyId } = await withReleaseManager(c);
    await c.releaseLog.note(companyId, A);
    await c.releaseLog.note(companyId, A); // a restart, or a second observation of the same live commit
    expect(await c.releaseLog.releaseManagerWakes("restarted")).toBe(0);
    expect(await c.db.select().from(wakes)).toHaveLength(0);
    expect((await c.db.select().from(tickets)).filter((x) => x.title.startsWith("Release log:"))).toHaveLength(0);
  });

  it("wakes for a restart after a hand-apply, which the running server notices on its own commit", async () => {
    const c = (ctx = await setupApp());
    const { companyId } = await withReleaseManager(c);
    await c.releaseLog.note(companyId, A);
    // The process now runs B (a hand-apply, a switch-back or a rollback restarted it at B).
    await c.releaseLog.note(companyId, B);
    expect(await c.releaseLog.releaseManagerWakes("restarted")).toBe(1);
    const [w] = await c.db.select().from(wakes);
    expect(w!.note).toContain("restart after a hand-apply");
  });

  it("BOS-1477: a server update opens a release-log ticket only for the home company, not for one with no deploy target or one with a target", async () => {
    const c = (ctx = await setupApp());
    const home = await withReleaseManager(c); // oldest company: the one Boss Man's own server update deploys
    const mk = async (name: string) => {
      const { company } = (await c.req("POST", "/api/companies", { name })).json() as { company: { id: string } };
      await c.req("POST", `/api/companies/${company.id}/projects`, { name: "Releases" });
      await c.db.insert(agents).values({ companyId: company.id, name: `Rm ${name}`, role: "worker", agentKind: "claude", title: "Release Manager" });
      return company.id;
    };
    const none = await mk("No Target Co");
    const withTarget = await mk("Target Co");
    await c.db.insert(deployTargets).values({ companyId: withTarget, name: "site", kind: "ssh", endpoint: "deploy@example.com" });
    for (const id of [home.companyId, none, withTarget]) await c.releaseLog.note(id, A);
    await c.releaseLog.releaseManagerWakes("restarted");
    await deployResult(c, { from: A, to: B });
    await c.selfDeploy.sync();
    const logs = (await c.db.select().from(tickets)).filter((x) => x.title.startsWith("Release log:"));
    expect(logs.map((x) => x.companyId)).toEqual([home.companyId]);
  });

  it("does nothing when the company has no Release Manager", async () => {
    const c = (ctx = await setupApp());
    const { companyId } = await withReleaseManager(c, { agent: false });
    await c.releaseLog.note(companyId, A);
    await deployResult(c, { from: A, to: B });
    await c.selfDeploy.sync();
    expect(await c.db.select().from(wakes)).toHaveLength(0);
    expect((await c.db.select().from(tickets)).filter((x) => x.title.startsWith("Release log:"))).toHaveLength(0);
  });

  it("two deploys in a row with one ticket open give one ticket listing both commits (BOS-1112)", async () => {
    const c = (ctx = await setupApp());
    const { companyId } = await withReleaseManager(c);
    await c.releaseLog.note(companyId, A);
    await c.releaseLog.note(companyId, B);
    await c.releaseLog.releaseManagerWakes("restarted");
    await c.releaseLog.note(companyId, C);
    await c.releaseLog.releaseManagerWakes("restarted");
    const logTickets = (await c.db.select().from(tickets)).filter((x) => x.title.startsWith("Release log:"));
    expect(logTickets).toHaveLength(1);
    expect(logTickets[0]!.body).toContain(`New commit: ${B}`);
    expect(logTickets[0]!.body).toContain(`New commit: ${C}`);
    // BOS-1809: the second release says to republish the site too, not just the first.
    const [wakeToSecond] = await c.db.select().from(wakes).where(eq(wakes.ticketId, logTickets[0]!.id));
    expect(wakeToSecond!.note).toContain("republish the website");
    const said = (await c.db.select().from(ticketMessages).where(eq(ticketMessages.ticketId, logTickets[0]!.id))).map((x) => x.text).join("\n");
    expect(said).toContain("republish the website");
    // A repeat pass doesn't list the commit twice.
    await c.releaseLog.releaseManagerWakes("restarted");
    expect((await c.db.select().from(tickets).where(eq(tickets.id, logTickets[0]!.id)))[0]!.body!.split(`New commit: ${C}`)).toHaveLength(2);
  });

  it("once the ticket is closed, the next deploy opens a new one (BOS-1112)", async () => {
    const c = (ctx = await setupApp());
    const { companyId } = await withReleaseManager(c);
    await c.releaseLog.note(companyId, A);
    await c.releaseLog.note(companyId, B);
    await c.releaseLog.releaseManagerWakes("restarted");
    const [first] = (await c.db.select().from(tickets)).filter((x) => x.title.startsWith("Release log:"));
    await c.db.update(tickets).set({ systemState: "done" }).where(eq(tickets.id, first!.id));
    await c.releaseLog.note(companyId, C);
    await c.releaseLog.releaseManagerWakes("restarted");
    const logTickets = (await c.db.select().from(tickets)).filter((x) => x.title.startsWith("Release log:"));
    expect(logTickets.map((t) => t.title).sort()).toEqual([`Release log: record ${B.slice(0, 8)}`, `Release log: record ${C.slice(0, 8)}`].sort());
    expect(logTickets.find((t) => t.id !== first!.id)!.body).not.toContain(`New commit: ${B}`);
  });

  it("folds release-log tickets already open into the oldest one (BOS-1112)", async () => {
    const c = (ctx = await setupApp());
    const { companyId, projectId, rm } = await withReleaseManager(c);
    const D = "4".repeat(40);
    const mk = (sha: string) => c.work.createTicket(projectId, { title: `Release log: record ${sha.slice(0, 8)}`, body: `Old commit: ${A}\nNew commit: ${sha}`, assigneeAgentId: rm!.id, state: "ready", noCode: true, risk: "trivial" });
    const t1 = await mk(B);
    const t2 = await mk(C);
    await c.releaseLog.note(companyId, A);
    await c.releaseLog.note(companyId, D);
    await c.releaseLog.releaseManagerWakes("deployed");
    const rows = (await c.db.select().from(tickets)).filter((x) => x.title.startsWith("Release log:"));
    const open = rows.filter((x) => x.systemState !== "done");
    expect(open.map((x) => x.id)).toEqual([t1.id]);
    expect(open[0]!.body).toContain(`New commit: ${C}`);
    expect(open[0]!.body).toContain(`New commit: ${D}`);
    expect(rows.find((x) => x.id === t2.id)!.systemState).toBe("done");
    // Only the one ticket has a waiting wake.
    const waiting = await c.db.select().from(wakes).where(eq(wakes.reason, RELEASE_REASON));
    expect(waiting.map((w) => w.ticketId)).toEqual([t1.id]);
  });

  it("does not stack a second wake on a ticket whose first wake is still waiting", async () => {
    const c = (ctx = await setupApp());
    const { companyId, projectId, rm } = await withReleaseManager(c);
    const svc = releaseLogService(c.db, { createTicket: (pid, input) => c.work.createTicket(pid, input), notify: (agentId, input) => c.scheduler.notify(agentId, input) });
    await c.releaseLog.note(companyId, A);
    await c.releaseLog.note(companyId, B);
    const t = await c.work.createTicket(projectId, { title: `Release log: record ${B.slice(0, 8)}`, assigneeAgentId: rm!.id, state: "ready", noCode: true, risk: "trivial" });
    await c.scheduler.notify(rm!.id, { ticketId: t.id, reason: RELEASE_REASON, note: "already waiting" });
    await svc.releaseManagerWakes("deployed-bluegreen"); // the waiting wake is reused, never doubled
    expect(await c.db.select().from(wakes)).toHaveLength(1);
    expect(await c.db.select().from(tickets).where(eq(tickets.id, t.id))).toHaveLength(1);
  });

  it("is wired into the app: a change seen only in the deployer's report wakes the Release Manager", async () => {
    const c = (ctx = await setupApp());
    const { companyId, rm } = await withReleaseManager(c);
    await c.releaseLog.note(companyId, A);
    // A change the host applied by itself, with no status the server acted on yet.
    await writeFile(availableFile(c), JSON.stringify({ checkedAt: new Date().toISOString(), deployed: B, tip: B, commits: [], paths: [], infraPaths: [], runnerChanged: false }));
    await rmFile(statusFile(c), { force: true });
    await c.selfDeploy.sync();
    const [w] = await c.db.select().from(wakes).where(eq(wakes.agentId, rm!.id));
    expect(w).toBeDefined();
    expect(w!.note).toContain(B.slice(0, 8));
    // Nothing was raised for the owner: this isn't a deploy question.
    expect((await c.db.select().from(decisions)).filter((d) => (d.context as { type?: string }).type === "self_deploy")).toHaveLength(0);
  });

  it("keeps the record but never rewinds it", async () => {
    const c = (ctx = await setupApp());
    const { companyId } = await withReleaseManager(c);
    await c.releaseLog.note(companyId, A);
    await c.releaseLog.note(companyId, B);
    // An older process (built at A) restarts and says A: the record stays ahead.
    await c.releaseLog.note(companyId, A);
    expect(await c.releaseLog.releaseManagerWakes("restarted")).toBe(1);
    const [w] = await c.db.select().from(wakes);
    expect(w!.note).toContain(B.slice(0, 8));
    expect(w!.note).toContain(A.slice(0, 8));
  });
});

/** A finished code ticket with its merge commit and setup steps, as the merge gate and its author left it. */
async function doneTicket(c: Awaited<ReturnType<typeof setupApp>>, projectId: string, over: { title: string; mergeCommit: string; ownerSetup?: string; at: Date }) {
  const t = await c.work.createTicket(projectId, { title: over.title, noCode: false, state: "done" });
  await c.db.update(tickets).set({ mergeCommit: over.mergeCommit, lastActivityAt: over.at, stateChangedAt: over.at, ...(over.ownerSetup ? { ownerSetup: over.ownerSetup } : {}) }).where(eq(tickets.id, t.id));
  return t;
}

const setupCards = (c: Awaited<ReturnType<typeof setupApp>>) =>
  c.db.select().from(decisions).then((all) => all.filter((d) => (d.context as { type?: string }).type === "owner_setup"));

describe("owner setup cards (DR-011)", () => {
  it("raises no card at merge: a merged ticket alone earns nothing until its commit is live", async () => {
    const c = (ctx = await setupApp());
    const { companyId, projectId } = await withReleaseManager(c);
    await doneTicket(c, projectId, { title: "Second Claude account", mergeCommit: A, ownerSetup: "Settings → Funding → Add funding source", at: new Date("2026-11-03T12:00:00Z") });
    await c.releaseLog.note(companyId, C); // live, but not this ticket's commit
    expect(await c.releaseLog.releaseManagerWakes("restarted")).toBeGreaterThanOrEqual(0);
    expect(await setupCards(c)).toHaveLength(0);
  });

  it("DR-061 Q5: a merged ticket that is still open is placed in merge order, so a later merge's card waits for its own deploy", async () => {
    const c = (ctx = await setupApp());
    const { companyId, projectId } = await withReleaseManager(c);
    // A merged first but its ticket is still open; B merged after it and is done with setup steps.
    const open = await c.work.createTicket(projectId, { title: "Merged, still open", noCode: false });
    await c.db.update(tickets).set({ mergeCommit: A, mergedAt: new Date("2026-11-03T11:00:00Z") }).where(eq(tickets.id, open.id));
    await doneTicket(c, projectId, { title: "Later merge", mergeCommit: B, ownerSetup: "Settings → Funding → Add funding source", at: new Date("2026-11-03T12:00:00Z") });
    await c.releaseLog.note(companyId, A); // the server runs A, which is before B
    await c.releaseLog.releaseManagerWakes("deployed");
    expect(await setupCards(c)).toHaveLength(0);
    await c.releaseLog.note(companyId, B);
    await c.releaseLog.releaseManagerWakes("deployed");
    expect(await setupCards(c)).toHaveLength(1);
  });

  it("raises one card when the live commit includes the merge, with the author's steps", async () => {
    const c = (ctx = await setupApp());
    const { companyId, projectId } = await withReleaseManager(c);
    await doneTicket(c, projectId, { title: "Second Claude account", mergeCommit: B, ownerSetup: "Settings → Funding → Add funding source\nThen sign in to the second plan in Settings → Funding", at: new Date("2026-11-03T12:00:00Z") });
    await c.releaseLog.note(companyId, A);
    await c.releaseLog.note(companyId, B); // the deployer says B is live (after the standby window: only a finished deploy is noted)
    await c.releaseLog.releaseManagerWakes("deployed");

    const cards = await setupCards(c);
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ kind: "question", tier: "owner", status: "open", dedupeKey: `owner-setup:${(await c.db.select().from(tickets).where(eq(tickets.ownerSetup, "Settings → Funding → Add funding source\nThen sign in to the second plan in Settings → Funding")))[0]!.id}` });
    expect(cards[0]!.question).toContain("Second Claude account");
    expect(cards[0]!.question).toContain("Add funding source");
    expect(cards[0]!.question).toContain("sign in to the second plan");
    expect((cards[0]!.context as { ticketId?: string }).ticketId).toBeDefined();
    // The ticket records which card it raised.
    const [t] = await c.db.select().from(tickets).where(eq(tickets.ownerSetup, "Settings → Funding → Add funding source\nThen sign in to the second plan in Settings → Funding"));
    expect(t!.ownerSetupDecisionId).toBe(cards[0]!.id);
  });

  it("doesn't raise a second card on a repeat go-live pass", async () => {
    const c = (ctx = await setupApp());
    const { companyId, projectId } = await withReleaseManager(c);
    await doneTicket(c, projectId, { title: "Second Claude account", mergeCommit: B, ownerSetup: "Settings → Funding → Add funding source", at: new Date("2026-11-03T12:00:00Z") });
    await c.releaseLog.note(companyId, A);
    await c.releaseLog.note(companyId, B);
    await c.releaseLog.releaseManagerWakes("deployed");
    await c.releaseLog.note(companyId, C); // another deploy, still including B
    await c.releaseLog.releaseManagerWakes("deployed");
    expect(await setupCards(c)).toHaveLength(1);
  });

  it("withdraws the card on a switch-back and raises it again on the next go-live", async () => {
    const c = (ctx = await setupApp());
    const { companyId, projectId } = await withReleaseManager(c);
    await doneTicket(c, projectId, { title: "Older change", mergeCommit: B, ownerSetup: "Settings → Funding → Add funding source", at: new Date("2026-11-03T12:00:00Z") });
    await doneTicket(c, projectId, { title: "Newer change", mergeCommit: C, at: new Date("2026-11-03T13:00:00Z") });
    await c.releaseLog.note(companyId, A);
    await c.releaseLog.note(companyId, C);
    await c.releaseLog.releaseManagerWakes("deployed");
    expect(await setupCards(c)).toHaveLength(1);

    // Switched back to B: C is no longer running, but B's card is still right.
    await deployResult(c, { result: "rolled_back", from: C, to: B, ended: new Date(Date.now() + 60_000).toISOString(), id: randomUUID() });
    await c.selfDeploy.sync();
    expect(await setupCards(c)).toHaveLength(1);

    // Switched back to before B: its card goes, freed to come back later.
    await deployResult(c, { result: "rolled_back", from: B, to: A, ended: new Date(Date.now() + 120_000).toISOString(), id: randomUUID() });
    await c.selfDeploy.sync();
    const after = await setupCards(c);
    expect(after).toHaveLength(1);
    expect(after[0]!.status).toBe("withdrawn");
    expect(after[0]!.dedupeKey).toBeNull();
    // BOS-740: it doesn't vanish from Decisions; the same closed-card notice says why it closed and what's left.
    const notice = (after[0]!.context as { closedNotice?: { why: string; text: string } }).closedNotice;
    expect(notice).toMatchObject({ why: "switched-back" });
    expect(notice!.text).toContain("its setup steps no longer apply");
    expect(notice!.text).toContain("nothing left to press");
    const [t] = await c.db.select().from(tickets).where(eq(tickets.mergeCommit, B));
    expect(t!.ownerSetupDecisionId).toBeNull();

    // Live again: a fresh card.
    await c.releaseLog.note(companyId, B);
    await c.releaseLog.releaseManagerWakes("deployed");
    const again = await setupCards(c);
    expect(again).toHaveLength(2);
    expect(again.filter((d) => d.status === "open")).toHaveLength(1);
  });

  it("leaves a ticket alone when it has no setup steps", async () => {
    const c = (ctx = await setupApp());
    const { companyId, projectId } = await withReleaseManager(c);
    await doneTicket(c, projectId, { title: "Nothing to do", mergeCommit: B, at: new Date("2026-11-03T12:00:00Z") });
    await c.releaseLog.note(companyId, A);
    await c.releaseLog.note(companyId, B);
    await c.releaseLog.releaseManagerWakes("deployed");
    expect(await setupCards(c)).toHaveLength(0);
  });

  it("refuses a card whose command isn't copy-safe: no owner card, and the CEO is asked to fix it instead (DR-052)", async () => {
    const c = (ctx = await setupApp());
    const { companyId, projectId } = await withReleaseManager(c);
    const t = await doneTicket(c, projectId, { title: "Run a command", mergeCommit: B, ownerSetup: "Run this:\n```sh\nmkdir <your-folder>\n```", at: new Date("2026-11-03T12:00:00Z") });
    await c.releaseLog.note(companyId, A);
    await c.releaseLog.note(companyId, B);
    await c.releaseLog.releaseManagerWakes("deployed");
    expect(await setupCards(c)).toHaveLength(0);
    const [fix] = await c.db.select().from(decisions).where(eq(decisions.dedupeKey, `owner-setup-fix:${t.id}`));
    expect(fix).toMatchObject({ tier: "ceo", status: "open" });
  });
});

/** The host deployer's report (host.json), with made-up values; `env` is left out for an older deployer. */
async function hostReport(c: Awaited<ReturnType<typeof setupApp>>, o: { env?: boolean } = {}) {
  const record = {
    version: 1,
    name: "example-host",
    writtenAt: new Date().toISOString(),
    ownership: [],
    paths: { install: "/opt/example", src: "/opt/example/src", deployer: "/opt/example/deployer" },
    compose: { files: ["docker-compose.yml"], bluegreen: false, liveColour: "" },
    ...(o.env === false ? {} : { env: { file: "/opt/example/src/.env" } }),
  };
  await writeFile(path.join(c.dir, "outbox", "host.json"), JSON.stringify(record));
}

describe("go-live setup cards get the host facts and the full card check (DR-052)", () => {
  const live = async (c: Awaited<ReturnType<typeof setupApp>>, companyId: string) => {
    await c.releaseLog.note(companyId, A);
    await c.releaseLog.note(companyId, B);
    await c.releaseLog.releaseManagerWakes("deployed");
  };
  const fixCard = async (c: Awaited<ReturnType<typeof setupApp>>, ticketId: string) => (await c.db.select().from(decisions).where(like(decisions.dedupeKey, `owner-setup-fix:${ticketId}`)))[0];

  it("a step with {{host.env.file}} shows the reported path on the owner's card, and a compose token the command", async () => {
    const c = (ctx = await setupApp());
    await hostReport(c);
    const { companyId, projectId } = await withReleaseManager(c);
    await doneTicket(c, projectId, { title: "Newer ntfy", mergeCommit: B, ownerSetup: "Remove the NTFY_IMAGE line from {{host.env.file}} (http://192.168.1.50/admin)\nRestart the notifications add-on: `{{host.compose.cmd}} up -d ntfy` (http://192.168.1.50/admin)", at: new Date("2026-11-03T12:00:00Z") });
    await live(c, companyId);
    const [card] = await setupCards(c);
    expect(card!.question).toContain("1. Remove the NTFY_IMAGE line from /opt/example/src/.env");
    expect(card!.question).toContain("2. Restart the notifications add-on: `cd /opt/example/src && docker compose -f docker-compose.yml up -d ntfy`");
    expect(card!.question).not.toContain("{{");
    expect(card!.question).not.toContain("doesn't know this server's folders");
    expect((card!.context as { steps: string[] }).steps[0]).toBe("Remove the NTFY_IMAGE line from /opt/example/src/.env (http://192.168.1.50/admin)");
    expect(card!.question).toMatch(/Where: Steps 1, 2: Boss Man, in your browser/);
  });

  it("vague steps raise a CEO card and no owner card, nothing is logged as a silent refusal, and once fixed the owner's card goes out on the next pass", async () => {
    const c = (ctx = await setupApp());
    await hostReport(c);
    const { companyId, projectId } = await withReleaseManager(c);
    const t = await doneTicket(c, projectId, { title: "Checks at once", mergeCommit: B, ownerSetup: "Delete BOSSMAN_CHECK_SLOTS from .env\nRestart the notifications add-on", at: new Date("2026-11-03T12:00:00Z") });
    await live(c, companyId);
    expect(await setupCards(c)).toHaveLength(0);
    const fix = await fixCard(c, t.id);
    expect(fix).toMatchObject({ tier: "ceo", status: "open", kind: "question" });
    expect(fix!.question).toMatch(/is live, but the setup steps can't go to the owner as written/);
    expect(fix!.question).toMatch(/Step 1: names \.env without saying where it is/);
    expect(fix!.question).toMatch(/Step 2: says "Restart the notifications add-on"/);
    expect(fix!.question).toContain("{{host.env.file}}");
    expect((await c.db.select().from(activity)).filter((a) => a.kind === "owner_setup_refused")).toEqual([]);
    // A second pass on the same commit doesn't stack another card.
    await c.releaseLog.releaseManagerWakes("deployed");
    expect((await c.db.select().from(decisions).where(like(decisions.dedupeKey, "owner-setup-fix:%")))).toHaveLength(1);
    // The steps are fixed; the live commit doesn't change, and the next pass raises the owner's card and closes the CEO's.
    await c.db.update(tickets).set({ ownerSetup: "Delete the BOSSMAN_CHECK_SLOTS line from {{host.env.file}}: `sed -i '/^BOSSMAN_CHECK_SLOTS=/d' {{host.env.file}}`. This prints nothing. (http://192.168.1.50/admin)" }).where(eq(tickets.id, t.id));
    await c.releaseLog.releaseManagerWakes("deployed");
    const [card] = await setupCards(c);
    expect(card).toMatchObject({ status: "open", tier: "owner" });
    expect(card!.question).toContain("sed -i '/^BOSSMAN_CHECK_SLOTS=/d' /opt/example/src/.env");
    // The CEO's card closed itself (its key is freed, so a later failure could raise a new one).
    expect((await c.db.select().from(decisions).where(eq(decisions.id, fix!.id)))[0]).toMatchObject({ status: "answered", dedupeKey: null });
    expect((await c.db.select().from(tickets).where(eq(tickets.id, t.id)))[0]!.ownerSetupDecisionId).toBe(card!.id);
  });

  it("with no deployer report, a token in the words becomes the label and the card says Boss Man doesn't know this server's folders yet", async () => {
    const c = (ctx = await setupApp());
    const { companyId, projectId } = await withReleaseManager(c);
    await doneTicket(c, projectId, { title: "Newer ntfy", mergeCommit: B, ownerSetup: "Remove the NTFY_IMAGE line from {{host.env.file}}", at: new Date("2026-11-03T12:00:00Z") });
    await live(c, companyId);
    const [card] = await setupCards(c);
    expect(card!.question).toContain("1. Remove the NTFY_IMAGE line from the .env file the stack starts with (Settings → Server and runner → This server shows it)");
    expect(card!.question).toContain("Boss Man doesn't know this server's folders yet");
  });

  it("an older deployer that doesn't report env.file gets the label, never a path built from the src folder", async () => {
    const c = (ctx = await setupApp());
    await hostReport(c, { env: false });
    const { companyId, projectId } = await withReleaseManager(c);
    await doneTicket(c, projectId, { title: "Newer ntfy", mergeCommit: B, ownerSetup: "Remove the NTFY_IMAGE line from {{host.env.file}}", at: new Date("2026-11-03T12:00:00Z") });
    await live(c, companyId);
    const [card] = await setupCards(c);
    expect(card!.question).toContain("the .env file the stack starts with (Settings → Server and runner → This server shows it)");
    expect(card!.question).not.toContain("/opt/example/src/.env");
  });

  it("the CEO's lintOverride stored with the steps lets a soft finding through, and the owner reads why", async () => {
    const c = (ctx = await setupApp());
    const { companyId, projectId } = await withReleaseManager(c);
    const t = await doneTicket(c, projectId, { title: "Notifications", mergeCommit: B, ownerSetup: "Restart the notifications add-on at http://192.168.1.50/admin", at: new Date("2026-11-03T12:00:00Z") });
    await c.db.update(tickets).set({ ownerSetupOverride: "The add-on restarts by itself after the update." }).where(eq(tickets.id, t.id));
    await live(c, companyId);
    const [card] = await setupCards(c);
    expect(card!.question).toMatch(/The CEO let these steps past Boss Man's card check:\nStep 1 \(R\d+\): The add-on restarts by itself after the update\./);
    expect(await fixCard(c, t.id)).toBeUndefined();
  });

  it("R35: a stored override that names only one of two refused steps leaves the other refused: the CEO gets the fix card, the owner none", async () => {
    const c = (ctx = await setupApp());
    await hostReport(c);
    const { companyId, projectId } = await withReleaseManager(c);
    const t = await doneTicket(c, projectId, { title: "Two vague steps", mergeCommit: B, ownerSetup: "Delete BOSSMAN_CHECK_SLOTS from .env\nRestart the notifications add-on", at: new Date("2026-11-03T12:00:00Z") });
    await c.db.update(tickets).set({ ownerSetupOverride: JSON.stringify([{ steps: [2], reason: "The add-on restarts by itself after the update." }]) }).where(eq(tickets.id, t.id));
    await live(c, companyId);
    expect(await setupCards(c)).toHaveLength(0);
    expect(await fixCard(c, t.id)).toMatchObject({ tier: "ceo", status: "open" });
    // A plain reason (the old form) can't cover two refused steps either.
    await c.db.update(tickets).set({ ownerSetupOverride: "The add-on restarts by itself after the update." }).where(eq(tickets.id, t.id));
    await c.releaseLog.releaseManagerWakes("deployed");
    expect(await setupCards(c)).toHaveLength(0);
  });
});

describe("one setup card per go-live: identical steps grouped (BOS-741, DR-039 follow-up 2)", () => {
  const openCards = (c: Awaited<ReturnType<typeof setupApp>>) => setupCards(c).then((all) => all.filter((d) => d.status === "open"));

  it("three tickets with identical setup steps in one go-live raise one card listing all three, and one Done clears it", async () => {
    const c = (ctx = await setupApp());
    const { companyId, projectId } = await withReleaseManager(c);
    const steps = "Settings → Funding → Add funding source";
    const a = await doneTicket(c, projectId, { title: "Add the second Claude account", mergeCommit: "1".repeat(40), ownerSetup: steps, at: new Date("2026-11-03T12:00:00Z") });
    // The same step written with different spacing still groups: it normalises.
    const b = await doneTicket(c, projectId, { title: "Add the third Claude account", mergeCommit: "2".repeat(40), ownerSetup: "Settings  →  Funding → Add funding source", at: new Date("2026-11-03T12:05:00Z") });
    const d = await doneTicket(c, projectId, { title: "Add the fourth Claude account", mergeCommit: "3".repeat(40), ownerSetup: steps, at: new Date("2026-11-03T12:10:00Z") });
    await c.releaseLog.note(companyId, A);
    await c.releaseLog.note(companyId, C); // the last merge is the live commit
    await c.releaseLog.releaseManagerWakes("deployed");

    const cards = await openCards(c);
    expect(cards).toHaveLength(1);
    expect(cards[0]!.question).toContain(a.title);
    expect(cards[0]!.question).toContain(b.title);
    expect(cards[0]!.question).toContain(d.title);
    expect(cards[0]!.question).toContain("Add funding source");
    // Every ticket records the one card.
    for (const t of [a, b, d]) expect((await (await c.db.select().from(tickets).where(eq(tickets.id, t.id)))[0]!).ownerSetupDecisionId).toBe(cards[0]!.id);

    // One Done clears it, and none of them raises a fresh card on the next pass.
    expect((await c.req("POST", `/api/decisions/${cards[0]!.id}/answer`, { answer: "Done, it's applied" })).statusCode).toBe(200);
    expect(await openCards(c)).toHaveLength(0);
    expect((await setupCards(c)).filter((x) => x.status === "open")).toHaveLength(0);
    await c.releaseLog.note(companyId, B);
    await c.releaseLog.releaseManagerWakes("deployed");
    expect(await openCards(c)).toHaveLength(0);
  });

  it("a runner-update-only setup step raises no separate card, and the go-live pass leaves the runner-update card alone (DR-042 point 5: it is named when that card is raised)", async () => {
    const c = (ctx = await setupApp());
    const { companyId, projectId } = await withReleaseManager(c);
    // Boss Man's own runner-update card for the live commit, as self-deploy raises it.
    await c.db.insert(decisions).values({ companyId, kind: "approval", question: `Update the runners to ${C.slice(0, 8)}?`, options: ["Update runners", "Not now"], recommendedOption: "Update runners", dedupeKey: `self-deploy:runner:${C}`, context: { type: "self_deploy", target: "runner", commit: C, fromCommit: B } });
    const t = await doneTicket(c, projectId, {
      title: "The runner needs the new tooling",
      mergeCommit: C,
      ownerSetup: "Build and update runners",
      at: new Date("2026-11-03T12:00:00Z"),
    });
    await c.releaseLog.note(companyId, A);
    await c.releaseLog.note(companyId, C);
    await c.releaseLog.releaseManagerWakes("deployed");

    expect(await openCards(c)).toHaveLength(0);
    const [runnerCard] = await c.db.select().from(decisions).where(eq(decisions.dedupeKey, `self-deploy:runner:${C}`));
    expect(runnerCard!.question).not.toContain(t.title);
    expect(runnerCard!.question).toBe(`Update the runners to ${C.slice(0, 8)}?`);
  });

  it("steps that differ still get their own card", async () => {
    const c = (ctx = await setupApp());
    const { companyId, projectId } = await withReleaseManager(c);
    await doneTicket(c, projectId, { title: "Add the second account", mergeCommit: B, ownerSetup: "Settings → Funding → Add funding source", at: new Date("2026-11-03T12:00:00Z") });
    await doneTicket(c, projectId, { title: "Turn on the second storage bucket", mergeCommit: C, ownerSetup: "Turn on the second bucket at http://192.168.1.50/console", at: new Date("2026-11-03T12:05:00Z") });
    await c.releaseLog.note(companyId, A);
    await c.releaseLog.note(companyId, C);
    await c.releaseLog.releaseManagerWakes("deployed");
    const cards = await openCards(c);
    expect(cards).toHaveLength(2);
    expect(cards.map((x) => x.question).join("\n")).toContain("Add funding source");
    expect(cards.map((x) => x.question).join("\n")).toContain("second bucket");
  });

  it("a ticket whose steps are only the runner update plus its own keeps a card for its own step", async () => {
    const c = (ctx = await setupApp());
    const { companyId, projectId } = await withReleaseManager(c);
    await c.db.insert(decisions).values({ companyId, kind: "approval", question: `Update the runners to ${C.slice(0, 8)}?`, options: ["Update runners", "Not now"], recommendedOption: "Update runners", dedupeKey: `self-deploy:runner:${C}`, context: { type: "self_deploy", target: "runner", commit: C, fromCommit: B } });
    await doneTicket(c, projectId, { title: "Add the second account", mergeCommit: C, ownerSetup: "Build and update runners\nSettings → Funding → Add funding source", at: new Date("2026-11-03T12:00:00Z") });
    await c.releaseLog.note(companyId, A);
    await c.releaseLog.note(companyId, C);
    await c.releaseLog.releaseManagerWakes("deployed");
    const cards = await openCards(c);
    expect(cards).toHaveLength(1);
    expect(cards[0]!.question).toContain("Add funding source");
    // The runner-only step is taken out of that card (the runner card covers it).
    expect(cards[0]!.question).not.toContain("Build and update runners");
  });

  it("a later deploy with the earlier grouped tickets still live still raises a card for a new differing ticket", async () => {
    const c = (ctx = await setupApp());
    const { companyId, projectId } = await withReleaseManager(c);
    const steps = "Settings → Funding → Add funding source";
    await doneTicket(c, projectId, { title: "Add the second account", mergeCommit: B, ownerSetup: steps, at: new Date("2026-11-03T12:00:00Z") });
    await doneTicket(c, projectId, { title: "Add the third account", mergeCommit: C, ownerSetup: steps, at: new Date("2026-11-03T12:05:00Z") });
    await c.releaseLog.note(companyId, A);
    await c.releaseLog.note(companyId, C);
    await c.releaseLog.releaseManagerWakes("deployed");
    expect(await openCards(c)).toHaveLength(1);

    // A further deploy brings a ticket with different steps live while both grouped tickets are still
    // live: its card is raised, and the grouped card isn't stacked on. The old code read an empty group
    // here and threw, aborting the whole pass so this new card never went up.
    const D = "4".repeat(40);
    await doneTicket(c, projectId, { title: "Turn on the second bucket", mergeCommit: D, ownerSetup: "Turn on the second bucket at http://192.168.1.50/console", at: new Date("2026-11-03T12:10:00Z") });
    await c.releaseLog.note(companyId, D);
    await c.releaseLog.releaseManagerWakes("deployed");
    const cards = await openCards(c);
    expect(cards).toHaveLength(2);
    expect(cards.map((x) => x.question).join("\n")).toContain("second bucket");
  }, 20_000);

  it("switching back past one ticket of a shared card takes the card back for all and clears every pointer", async () => {
    const c = (ctx = await setupApp());
    const { companyId, projectId } = await withReleaseManager(c);
    const steps = "Settings → Funding → Add funding source";
    const a = await doneTicket(c, projectId, { title: "Add the second account", mergeCommit: B, ownerSetup: steps, at: new Date("2026-11-03T12:00:00Z") });
    const b = await doneTicket(c, projectId, { title: "Add the third account", mergeCommit: C, ownerSetup: steps, at: new Date("2026-11-03T12:05:00Z") });
    await c.releaseLog.note(companyId, A);
    await c.releaseLog.note(companyId, C);
    await c.releaseLog.releaseManagerWakes("deployed");
    const [shared] = await openCards(c);
    expect(shared).toBeDefined();

    // Switched back to before the newer (non-first) ticket's merge: the shared card covers both, so it is
    // taken back, and BOTH tickets stop pointing at it. The old code found no card on the non-first key,
    // so the newer ticket kept a stale pointer and never got a card again.
    const before = await c.releaseLog.releaseManagerWakes("restarted");
    expect(before).toBeGreaterThanOrEqual(0);
    await c.releaseLog.note(companyId, B);
    await c.releaseLog.releaseManagerWakes("switched-back");
    for (const t of [a, b]) expect((await c.db.select().from(tickets).where(eq(tickets.id, t.id)))[0]!.ownerSetupDecisionId).toBeNull();
    const gone = await setupCards(c);
    expect(gone.filter((x) => x.status === "open")).toHaveLength(0);

    // C goes live again: both get a card again, as a shared pair.
    await c.releaseLog.note(companyId, C);
    await c.releaseLog.releaseManagerWakes("deployed");
    const again = await openCards(c);
    expect(again).toHaveLength(1);
    expect(again[0]!.question).toContain(a.title);
    expect(again[0]!.question).toContain(b.title);
  }, 20_000);
});

describe("runner-update asks close themselves when the live runner image already has the change (BOS-764)", () => {
  const runnerCard = (companyId: string, commit: string, key = `self-deploy:runner:${commit}`) => ({ companyId, kind: "approval" as const, question: `Update the runners to ${commit.slice(0, 8)}?`, options: ["Update runners", "Not now"], recommendedOption: "Update runners", dedupeKey: key, context: { type: "self_deploy", target: "runner", commit, fromCommit: A } });
  const withImage = (c: Awaited<ReturnType<typeof setupApp>>, companyId: string, imageCommit: string | null) => c.db.insert(runners).values({ companyId, tokenHash: "x", imageCommit });
  /** Three merged tickets A < B < C, the merge order the image's commit is placed in. */
  async function merged(c: Awaited<ReturnType<typeof setupApp>>, projectId: string) {
    const t = [];
    for (const [i, sha] of [A, B, C].entries()) t.push(await doneTicket(c, projectId, { title: `Ticket ${i}`, mergeCommit: sha, at: new Date(`2026-11-08T1${i}:00:00Z`) }));
    return t;
  }
  const states = async (c: Awaited<ReturnType<typeof setupApp>>) => Object.fromEntries((await c.db.select().from(decisions)).map((d) => [d.question.slice(0, 40), d.status]));

  const available = (c: Awaited<ReturnType<typeof setupApp>>, deployed: string) => writeFile(availableFile(c), JSON.stringify({ version: 1, checkedAt: new Date().toISOString(), deployed, tip: deployed, commits: [], paths: [], infraPaths: [], runnerChanged: false }));
  const dueNow = (c: Awaited<ReturnType<typeof setupApp>>, value: object) => c.db.insert(settings).values({ key: "self_deploy_runner_due", value: { commit: C, fromCommit: A, after: new Date(Date.now() - 1000).toISOString(), ...value } });
  const lastServer = (c: Awaited<ReturnType<typeof setupApp>>) => c.db.insert(settings).values({ key: "self_deploy_last_server", value: { result: "deployed", from: A, to: C, ended: new Date().toISOString() } });

  // BOS-1648: the panel, the automatic card and the button all read the one answer (runner-update-need.ts).
  describe("one answer to 'is a runner update needed?' (BOS-1648)", () => {
    /** Image built from A; B and C merged since, C touching the runner or not. */
    async function since(c: Awaited<ReturnType<typeof setupApp>>, cTouchesRunner: boolean) {
      const { companyId, projectId } = await withReleaseManager(c);
      await withImage(c, companyId, A);
      const [, b, t] = await merged(c, projectId);
      await c.db.update(tickets).set({ touchesRunner: false }).where(eq(tickets.id, b!.id));
      await c.db.update(tickets).set({ touchesRunner: cTouchesRunner }).where(eq(tickets.id, t!.id));
      await c.releaseLog.note(companyId, C);
      await available(c, C);
      return { companyId, b: b!, t: t! };
    }

    it("server-only changes since the image: no automatic card, an open one closes with the reason, the panel says up to date", async () => {
      const c = (ctx = await setupApp());
      const { companyId } = await since(c, false);
      await c.db.insert(decisions).values(runnerCard(companyId, B));
      await dueNow(c, { offer: true, needs: C });
      await lastServer(c);
      await c.selfDeploy.sync();
      const all = await c.db.select().from(decisions);
      expect(all.filter((d) => d.status === "open")).toEqual([]);
      expect((all[0]!.context as { withdrawn: { note: string } }).withdrawn.note).toMatch(/^Runners are up to date: the changes since they were built \(.*\) are server-only\. So there is nothing to build\./);
      expect((await c.db.select().from(settings).where(eq(settings.key, "self_deploy_runner_due")))).toEqual([]);
      const o = await c.selfDeploy.overview();
      expect(o.runnerUpdate).toMatchObject({ state: "not_needed" });
      expect(o.runnerUpdate!.words).not.toMatch(/\bmay\b/);
    });

    it("a change to what the runners are built from: the automatic card is raised and the panel says needed, naming it", async () => {
      const c = (ctx = await setupApp());
      await since(c, true);
      await dueNow(c, { offer: true, needs: C });
      await lastServer(c);
      await c.selfDeploy.sync();
      expect((await c.db.select().from(decisions)).filter((d) => d.dedupeKey === `self-deploy:runner:${C}` && d.status === "open")).toHaveLength(1);
      const o = await c.selfDeploy.overview();
      expect(o.runnerUpdate!.state).toBe("needed");
      expect(o.runnerUpdate!.words).toMatch(/^Runner update needed: /);
    });

    it("can't tell (the live commit is no recorded merge): the panel says why, the button's card says it too, and the CEO is woken once", async () => {
      const c = (ctx = await setupApp());
      const { companyId } = await since(c, false);
      const X = "9".repeat(40);
      await c.releaseLog.note(companyId, X);
      await available(c, X);
      const [ceo] = await c.db.select({ id: agents.id }).from(agents).where(and(eq(agents.companyId, companyId), eq(agents.role, "ceo")));
      const o = await c.selfDeploy.overview();
      expect(o.runnerUpdate!.state).toBe("unknown");
      expect(o.runnerUpdate!.words).toContain("isn't a merge Boss Man recorded");
      // Reading the panel never queues a run (a read with a side effect broke the run caps in fair-share.test.ts);
      // the background sync wakes the CEO, once however often it runs.
      const ceoWakes = async () => (await c.db.select().from(wakes)).filter((w) => w.agentId === ceo!.id && w.reason === RUNNER_NEED_UNKNOWN_REASON);
      expect(await ceoWakes()).toHaveLength(0);
      await c.selfDeploy.sync();
      await c.selfDeploy.sync();
      expect(await ceoWakes()).toHaveLength(1);
      const r = await c.selfDeploy.updateRunners();
      expect("decisionId" in r).toBe(true);
      const [card] = await c.db.select().from(decisions).where(eq(decisions.id, (r as { decisionId: string }).decisionId));
      expect(card!.question).toContain("Boss Man can't tell whether a runner update is needed, because");
    });
  });

  it("the runner card names the live runner-only tickets in its context's tickets list, never from its text; the go-live pass adds nothing to it", async () => {
    const c = (ctx = await setupApp());
    const { companyId, projectId } = await withReleaseManager(c);
    await withImage(c, companyId, A);
    const t = await doneTicket(c, projectId, { title: "Needs new tooling", mergeCommit: B, ownerSetup: "Build and update runners", at: new Date("2026-11-08T12:00:00Z") });
    await doneTicket(c, projectId, { title: "Also set up a bucket", mergeCommit: A, ownerSetup: "Build and update runners\nAdd the bucket in your storage provider's console", at: new Date("2026-11-08T11:00:00Z") });
    await doneTicket(c, projectId, { title: "Newest merge", mergeCommit: C, at: new Date("2026-11-08T13:00:00Z") });
    // The go-live pass no longer touches the runner card.
    await c.releaseLog.note(companyId, A);
    await c.releaseLog.note(companyId, C);
    await c.releaseLog.releaseManagerWakes("deployed");
    await dueNow(c, { offer: true, needs: C });
    await lastServer(c);
    await available(c, C);
    await c.selfDeploy.sync();
    const card = (await c.db.select().from(decisions)).find((d) => d.dedupeKey === `self-deploy:runner:${C}`)!;
    expect((card.context as { tickets?: { ticketId: string; title: string }[] }).tickets).toEqual([{ ticketId: t.id, title: "Needs new tooling" }]);
    expect(card.question.match(/It also carries/g)).toHaveLength(1);
    expect(card.question).toContain('"Needs new tooling"');
    expect(card.question).not.toContain("Also set up a bucket");
  });

  it("a runner-only ticket the image already has is not named", async () => {
    const c = (ctx = await setupApp());
    const { companyId, projectId } = await withReleaseManager(c);
    await withImage(c, companyId, B);
    await doneTicket(c, projectId, { title: "Needs new tooling", mergeCommit: B, ownerSetup: "Build and update runners", at: new Date("2026-11-08T12:00:00Z") });
    await doneTicket(c, projectId, { title: "Newest merge", mergeCommit: C, at: new Date("2026-11-08T13:00:00Z") });
    const { runnerOnlyTickets } = await import("../src/services/runner-image.js");
    expect(await runnerOnlyTickets(c.db, companyId, C)).toEqual([]);
    await c.db.update(runners).set({ imageCommit: null });
    expect((await runnerOnlyTickets(c.db, companyId, C)).map((x) => x.title)).toEqual(["Needs new tooling"]);
  });

  it("with no runner change, a runner-only ticket the runners lack sets the offer by itself; once they have it, no card", async () => {
    const c = (ctx = await setupApp());
    const { companyId, projectId } = await withReleaseManager(c);
    await withImage(c, companyId, A);
    await doneTicket(c, projectId, { title: "Image base", mergeCommit: A, at: new Date("2026-11-08T11:00:00Z") });
    await doneTicket(c, projectId, { title: "Needs new tooling", mergeCommit: B, ownerSetup: "Build and update runners", at: new Date("2026-11-08T12:00:00Z") });
    await doneTicket(c, projectId, { title: "Newest merge", mergeCommit: C, at: new Date("2026-11-08T13:00:00Z") });
    await deployResult(c, { from: A, to: C });
    await c.selfDeploy.sync();
    const [due] = await c.db.select().from(settings).where(eq(settings.key, "self_deploy_runner_due"));
    expect((due!.value as { offer: boolean; needs: string }).offer).toBe(true);
    expect((due!.value as { needs: string }).needs).toBe(B);
  });

  it("the button's card uses the plain key when no card for that commit is open, and is not closed once the image has the commit", async () => {
    const c = (ctx = await setupApp());
    const { companyId, projectId } = await withReleaseManager(c);
    await merged(c, projectId);
    await withImage(c, companyId, C);
    await available(c, C);
    const r = await c.selfDeploy.updateRunners();
    expect("decisionId" in r).toBe(true);
    const [card] = await c.db.select().from(decisions);
    expect(card!.dedupeKey).toBe(`self-deploy:runner:${C}`);
    expect((card!.context as { requested?: boolean }).requested).toBe(true);
    // Brains' fix 1: the runners already run this commit, and the card says so, in the one answer's words (BOS-1648).
    expect(card!.question).toContain(`Runners are up to date: they were built from the version the server runs (${C.slice(0, 8)}). Nothing to do, unless you know of a fault in the runners.`);
    await c.selfDeploy.sync();
    expect((await c.db.select().from(decisions))[0]!.status).toBe("open");
    // Same commit again with the card still open: the same card.
    const again = await c.selfDeploy.updateRunners();
    expect("decisionId" in again && again.decisionId).toBe(card!.id);
  });

  it("a rebuild from a commit that has the change withdraws the open runner card, with a note", async () => {
    const c = (ctx = await setupApp());
    const { companyId, projectId } = await withReleaseManager(c);
    await merged(c, projectId);
    await c.db.insert(decisions).values(runnerCard(companyId, B));
    await withImage(c, companyId, C);
    await writeFile(availableFile(c), JSON.stringify({ version: 1, checkedAt: new Date().toISOString(), deployed: C, tip: C, commits: [], paths: [], infraPaths: [], runnerChanged: false }));
    await c.selfDeploy.sync();
    const [card] = await c.db.select().from(decisions).where(eq(decisions.dedupeKey, `self-deploy:runner:${B}`));
    expect(card).toBeUndefined(); // key freed
    const all = await c.db.select().from(decisions);
    expect(all).toHaveLength(1);
    expect(all[0]!.status).toBe("withdrawn");
    expect((all[0]!.context as { withdrawn: { note: string } }).withdrawn.note).toContain("already rebuilt");
  });

  it("self-closing goes through the shared withdraw path: a card the owner opened leaves the closed notice (Brains' fix 2)", async () => {
    const c = (ctx = await setupApp());
    const { companyId, projectId } = await withReleaseManager(c);
    await merged(c, projectId);
    await c.db.insert(decisions).values({ ...runnerCard(companyId, B), context: { type: "self_deploy", target: "runner", commit: B, fromCommit: A, ownerOpenedAt: new Date().toISOString() } });
    await withImage(c, companyId, C);
    await available(c, C);
    await c.selfDeploy.sync();
    const [d] = await c.db.select().from(decisions);
    expect(d!.status).toBe("withdrawn");
    const x = d!.context as { withdrawn: { note: string }; closedNotice?: { text: string } };
    expect(x.withdrawn.note).toContain("already rebuilt");
    expect(x.closedNotice?.text).toContain("already rebuilt");
  });

  it("keeps the card when the image is older than the commit, when no image commit is recorded, and for the owner's own button", async () => {
    const c = (ctx = await setupApp());
    const { companyId, projectId } = await withReleaseManager(c);
    await merged(c, projectId);
    await c.db.insert(decisions).values(runnerCard(companyId, C));
    await c.db.insert(decisions).values(runnerCard(companyId, A, `self-deploy:runner:${A}:abc123`));
    await withImage(c, companyId, B); // older than C; the image has A, but A's card is the owner's own button ask
    await writeFile(availableFile(c), JSON.stringify({ version: 1, checkedAt: new Date().toISOString(), deployed: C, tip: C, commits: [], paths: [], infraPaths: [], runnerChanged: false }));
    await c.selfDeploy.sync();
    expect(Object.values(await states(c))).toEqual(["open", "open"]);
    // No recorded commit (an image built before BOS-764): nothing is closed.
    await c.db.update(runners).set({ imageCommit: null });
    await c.selfDeploy.sync();
    expect(Object.values(await states(c))).toEqual(["open", "open"]);
  });

  it("keeps the card open when the image's own ticket gets later activity after a newer merge (merge order doesn't move)", async () => {
    const c = (ctx = await setupApp());
    const { companyId, projectId } = await withReleaseManager(c);
    const [a] = await merged(c, projectId);
    await c.db.insert(decisions).values(runnerCard(companyId, C));
    await withImage(c, companyId, A);
    // A note on A's done ticket after C merged: lastActivityAt moves, the merge order must not.
    await c.db.update(tickets).set({ lastActivityAt: new Date("2026-11-08T20:00:00Z") }).where(eq(tickets.id, a!.id));
    await writeFile(availableFile(c), JSON.stringify({ version: 1, checkedAt: new Date().toISOString(), deployed: C, tip: C, commits: [], paths: [], infraPaths: [], runnerChanged: false }));
    await c.selfDeploy.sync();
    expect(Object.values(await states(c))).toEqual(["open"]);
  });

  it("drops a held runner offer whose runner change the image already has", async () => {
    const c = (ctx = await setupApp());
    const { companyId, projectId } = await withReleaseManager(c);
    await merged(c, projectId);
    await withImage(c, companyId, B);
    await c.db.insert(settings).values({ key: "self_deploy_runner_due", value: { commit: C, fromCommit: A, after: new Date(Date.now() - 1000).toISOString(), offer: true, needs: A } });
    await c.db.insert(settings).values({ key: "self_deploy_last_server", value: { result: "deployed", from: A, to: C, ended: new Date().toISOString() } });
    await writeFile(availableFile(c), JSON.stringify({ version: 1, checkedAt: new Date().toISOString(), deployed: C, tip: C, commits: [], paths: [], infraPaths: [], runnerChanged: false }));
    await c.selfDeploy.sync();
    expect(await c.db.select().from(decisions)).toHaveLength(0);
    expect(await c.db.select().from(settings).where(eq(settings.key, "self_deploy_runner_due"))).toHaveLength(0);
  });
});
