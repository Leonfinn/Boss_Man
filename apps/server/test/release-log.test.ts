import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm as rmFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { agents, decisions, tickets, wakes } from "../src/db/schema.js";
import { RELEASE_REASON, releaseLogService } from "../src/services/release-log.js";

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
    const [w] = await c.db.select().from(wakes).where(eq(wakes.ticketId, logTickets[0]!.id));
    expect(w).toMatchObject({ agentId: rm!.id, reason: RELEASE_REASON, ticketId: logTickets[0]!.id });
    expect(w!.note).toContain(A.slice(0, 8));
    expect(w!.note).toContain(B.slice(0, 8));
    expect(w!.note).toContain("the host deployer");

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

  it("does nothing when the company has no Release Manager", async () => {
    const c = (ctx = await setupApp());
    const { companyId } = await withReleaseManager(c, { agent: false });
    await c.releaseLog.note(companyId, A);
    await deployResult(c, { from: A, to: B });
    await c.selfDeploy.sync();
    expect(await c.db.select().from(wakes)).toHaveLength(0);
    expect((await c.db.select().from(tickets)).filter((x) => x.title.startsWith("Release log:"))).toHaveLength(0);
  });

  it("opens one ticket per change, and reuses an open one for the same commit", async () => {
    const c = (ctx = await setupApp());
    const { companyId } = await withReleaseManager(c);
    await c.releaseLog.note(companyId, A);
    await c.releaseLog.note(companyId, B);
    await c.releaseLog.releaseManagerWakes("restarted");
    await c.releaseLog.note(companyId, C);
    await c.releaseLog.releaseManagerWakes("restarted");
    const logTickets = (await c.db.select().from(tickets)).filter((x) => x.title.startsWith("Release log:"));
    expect(logTickets.map((t) => t.title)).toEqual([`Release log: record ${B.slice(0, 8)}`, `Release log: record ${C.slice(0, 8)}`]);
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
  await c.db.update(tickets).set({ mergeCommit: over.mergeCommit, lastActivityAt: over.at, ...(over.ownerSetup ? { ownerSetup: over.ownerSetup } : {}) }).where(eq(tickets.id, t.id));
  return t;
}

const setupCards = (c: Awaited<ReturnType<typeof setupApp>>) =>
  c.db.select().from(decisions).then((all) => all.filter((d) => (d.context as { type?: string }).type === "owner_setup"));

describe("owner setup cards (DR-011)", () => {
  it("raises no card at merge: a merged ticket alone earns nothing until its commit is live", async () => {
    const c = (ctx = await setupApp());
    const { companyId, projectId } = await withReleaseManager(c);
    await doneTicket(c, projectId, { title: "Second Claude account", mergeCommit: A, ownerSetup: "Settings → Funding → Add account", at: new Date("2026-11-03T12:00:00Z") });
    await c.releaseLog.note(companyId, C); // live, but not this ticket's commit
    expect(await c.releaseLog.releaseManagerWakes("restarted")).toBeGreaterThanOrEqual(0);
    expect(await setupCards(c)).toHaveLength(0);
  });

  it("raises one card when the live commit includes the merge, with the author's steps", async () => {
    const c = (ctx = await setupApp());
    const { companyId, projectId } = await withReleaseManager(c);
    await doneTicket(c, projectId, { title: "Second Claude account", mergeCommit: B, ownerSetup: "Settings → Funding → Add account\nThen sign in to the second plan", at: new Date("2026-11-03T12:00:00Z") });
    await c.releaseLog.note(companyId, A);
    await c.releaseLog.note(companyId, B); // the deployer says B is live (after the standby window: only a finished deploy is noted)
    await c.releaseLog.releaseManagerWakes("deployed");

    const cards = await setupCards(c);
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ kind: "question", tier: "owner", status: "open", dedupeKey: `owner-setup:${(await c.db.select().from(tickets).where(eq(tickets.ownerSetup, "Settings → Funding → Add account\nThen sign in to the second plan")))[0]!.id}` });
    expect(cards[0]!.question).toContain("Second Claude account");
    expect(cards[0]!.question).toContain("Add account");
    expect(cards[0]!.question).toContain("sign in to the second plan");
    expect((cards[0]!.context as { ticketId?: string }).ticketId).toBeDefined();
    // The ticket records which card it raised.
    const [t] = await c.db.select().from(tickets).where(eq(tickets.ownerSetup, "Settings → Funding → Add account\nThen sign in to the second plan"));
    expect(t!.ownerSetupDecisionId).toBe(cards[0]!.id);
  });

  it("doesn't raise a second card on a repeat go-live pass", async () => {
    const c = (ctx = await setupApp());
    const { companyId, projectId } = await withReleaseManager(c);
    await doneTicket(c, projectId, { title: "Second Claude account", mergeCommit: B, ownerSetup: "Settings → Funding → Add account", at: new Date("2026-11-03T12:00:00Z") });
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
    await doneTicket(c, projectId, { title: "Older change", mergeCommit: B, ownerSetup: "Settings → Funding → Add account", at: new Date("2026-11-03T12:00:00Z") });
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

  it("refuses a card whose command isn't copy-safe, and logs why instead of showing it", async () => {
    const c = (ctx = await setupApp());
    const { companyId, projectId } = await withReleaseManager(c);
    await doneTicket(c, projectId, { title: "Run a command", mergeCommit: B, ownerSetup: "Run this:\n```sh\nmkdir <your-folder>\n```", at: new Date("2026-11-03T12:00:00Z") });
    await c.releaseLog.note(companyId, A);
    await c.releaseLog.note(companyId, B);
    await c.releaseLog.releaseManagerWakes("deployed");
    expect(await setupCards(c)).toHaveLength(0);
  });
});

describe("one setup card per go-live: identical steps grouped (BOS-741, DR-039 follow-up 2)", () => {
  const openCards = (c: Awaited<ReturnType<typeof setupApp>>) => setupCards(c).then((all) => all.filter((d) => d.status === "open"));

  it("three tickets with identical setup steps in one go-live raise one card listing all three, and one Done clears it", async () => {
    const c = (ctx = await setupApp());
    const { companyId, projectId } = await withReleaseManager(c);
    const steps = "Settings → Funding → Add account";
    const a = await doneTicket(c, projectId, { title: "Add the second Claude account", mergeCommit: "1".repeat(40), ownerSetup: steps, at: new Date("2026-11-03T12:00:00Z") });
    // The same step written with different spacing still groups: it normalises.
    const b = await doneTicket(c, projectId, { title: "Add the third Claude account", mergeCommit: "2".repeat(40), ownerSetup: "Settings  →  Funding → Add account", at: new Date("2026-11-03T12:05:00Z") });
    const d = await doneTicket(c, projectId, { title: "Add the fourth Claude account", mergeCommit: "3".repeat(40), ownerSetup: steps, at: new Date("2026-11-03T12:10:00Z") });
    await c.releaseLog.note(companyId, A);
    await c.releaseLog.note(companyId, C); // the last merge is the live commit
    await c.releaseLog.releaseManagerWakes("deployed");

    const cards = await openCards(c);
    expect(cards).toHaveLength(1);
    expect(cards[0]!.question).toContain(a.title);
    expect(cards[0]!.question).toContain(b.title);
    expect(cards[0]!.question).toContain(d.title);
    expect(cards[0]!.question).toContain("Add account");
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

  it("a runner-update-only setup step raises no separate card, and its ticket is named on the runner-update card", async () => {
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
    expect(runnerCard!.question).toContain(t.title);
    expect(runnerCard!.question).toMatch(/runner update above/);
    // Named once, not stacked on a repeat pass.
    await c.releaseLog.note(companyId, A);
    await c.releaseLog.note(companyId, C);
    await c.releaseLog.releaseManagerWakes("deployed");
    const [again] = await c.db.select().from(decisions).where(eq(decisions.dedupeKey, `self-deploy:runner:${C}`));
    expect(again!.question.match(new RegExp(t.title, "g"))).toHaveLength(1);
  });

  it("steps that differ still get their own card", async () => {
    const c = (ctx = await setupApp());
    const { companyId, projectId } = await withReleaseManager(c);
    await doneTicket(c, projectId, { title: "Add the second account", mergeCommit: B, ownerSetup: "Settings → Funding → Add account", at: new Date("2026-11-03T12:00:00Z") });
    await doneTicket(c, projectId, { title: "Turn on the second storage bucket", mergeCommit: C, ownerSetup: "Settings → Storage → Turn on the second bucket", at: new Date("2026-11-03T12:05:00Z") });
    await c.releaseLog.note(companyId, A);
    await c.releaseLog.note(companyId, C);
    await c.releaseLog.releaseManagerWakes("deployed");
    const cards = await openCards(c);
    expect(cards).toHaveLength(2);
    expect(cards.map((x) => x.question).join("\n")).toContain("Add account");
    expect(cards.map((x) => x.question).join("\n")).toContain("second bucket");
  });

  it("a ticket whose steps are only the runner update plus its own keeps a card for its own step", async () => {
    const c = (ctx = await setupApp());
    const { companyId, projectId } = await withReleaseManager(c);
    await c.db.insert(decisions).values({ companyId, kind: "approval", question: `Update the runners to ${C.slice(0, 8)}?`, options: ["Update runners", "Not now"], recommendedOption: "Update runners", dedupeKey: `self-deploy:runner:${C}`, context: { type: "self_deploy", target: "runner", commit: C, fromCommit: B } });
    await doneTicket(c, projectId, { title: "Add the second account", mergeCommit: C, ownerSetup: "Build and update runners\nSettings → Funding → Add account", at: new Date("2026-11-03T12:00:00Z") });
    await c.releaseLog.note(companyId, A);
    await c.releaseLog.note(companyId, C);
    await c.releaseLog.releaseManagerWakes("deployed");
    const cards = await openCards(c);
    expect(cards).toHaveLength(1);
    expect(cards[0]!.question).toContain("Add account");
    // The runner-only step is taken out of that card (the runner card covers it).
    expect(cards[0]!.question).not.toContain("Build and update runners");
  });
});
