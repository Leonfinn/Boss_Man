import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { buildApp } from "../src/app.js";
import { selfDeployService } from "../src/services/self-deploy.js";
import { signedInOwner } from "./helpers/owner-session.js";
import { openPglite } from "../src/db/client.js";
import { commandProblem, lintOwnerSteps, parseStep, sh, step } from "../src/services/steps.js";
import { companies, decisions, notifications, projects, settings, tickets, wakes } from "../src/db/schema.js";

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
  await writeFile(path.join(dir, "outbox", "host.json"), JSON.stringify({ version: 1, name: "nas01", writtenAt: "2026-10-20T12:00:00Z", ownership: [] }));
  // The app uses a counting handle on the same database, so a test can prove a pass made no queries (BOS-414).
  const made: string[] = [];
  const logQuery = { logQuery: (sql: string) => made.push(sql) };
  const { db, close } = await openPglite(undefined, logQuery);
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false, deployerDir: opts.deployer === false ? undefined : dir });
  const cookie = await signedInOwner(db);
  const req = (method: "GET" | "POST", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
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
  it("tells the owner a refused runner update is only a note, in plain words (BOS-364)", async () => {
    const c = (ctx = await setup());
    await c.status({ id: randomUUID(), target: "runner", result: "rejected", message: "The runners were not updated. Nothing is broken and nothing needs doing now.", to_commit: B, ended: "2026-10-20T12:03:00Z" });
    await c.selfDeploy.sync();
    expect((await c.db.select().from(notifications))[0]).toMatchObject({ level: "note", title: expect.stringContaining("Runner update not started") });
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
    expect(files).toEqual(["request.json"]);
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
    // The runner card can list the commits too, when the host has reported them.
    expect((runner!.context as { update: { total: number; otherCommits: string[] } }).update).toMatchObject({ total: 1, otherCommits: ["Add rate limiting"] });
    expect((await c.req("POST", `/api/decisions/${runner!.id}/answer`, { answer: "Update runners" })).statusCode).toBe(200);
    expect(JSON.parse(await readFile(path.join(c.dir, "inbox", "request.json"), "utf8"))).toMatchObject({ target: "runner", commit: B });
    expect((await c.req("GET", "/api/self-deploy")).json()).toMatchObject({ enabled: true, pending: true, status: { result: "deployed" } });
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
    expect(todo).toMatchObject({ kind: "question", tier: "owner", options: ["Done, it's applied", "A step failed"], recommendedOption: "Done, it's applied" });
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
    expect(todo!.context).toMatchObject({ check: expect.stringContaining("Server: Role reads leader") });
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
      expect(text).not.toContain("/mnt/NVME_Apps");
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
      expect(text).not.toContain("/mnt/NVME_Apps");
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
      "cp -v /srv/bm/src/scripts/host-deployer.sh /srv/bm/deployer/host-deployer.sh && chown root:root /srv/bm/deployer/host-deployer.sh && chmod 750 /srv/bm/deployer/host-deployer.sh",
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
      const r = await c.req("POST", `/api/decisions/${early.id}/answer`, { answer: "Update runners" });
      expect(r.statusCode).toBeGreaterThanOrEqual(400);
      expect(r.json().message ?? r.body).toContain("trial");
      // After the trial (900 s soak + 120 s margin), still on B: the runner card appears by itself.
      vi.setSystemTime(new Date("2026-11-03T01:18:01Z"));
      await c.selfDeploy.sync();
      expect((await c.open()).filter((d) => target(d).target === "runner" && target(d).commit === B)).toHaveLength(1);
    });

    const runnerCards = async (c: Awaited<ReturnType<typeof setup>>, commit: string) => (await c.open()).filter((d) => target(d).target === "runner" && target(d).commit === commit);

    it("takes the window from the host's status file, not from the server's own environment (BOS-401)", async () => {
      vi.stubEnv("BOSSMAN_SOAK_SECONDS", "9999");
      try {
        const { c } = await deployedInTrial({ soak_seconds: "60" });
        // 60 s window + 120 s margin from 01:01:00 = 01:04:00; the env value would hold it for hours.
        vi.setSystemTime(new Date("2026-11-03T01:03:30Z"));
        await c.selfDeploy.sync();
        expect(await runnerCards(c, B)).toHaveLength(0);
        vi.setSystemTime(new Date("2026-11-03T01:04:30Z"));
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
      // After 300 s + 120 s the hold is over and the button works again.
      vi.setSystemTime(new Date("2026-11-03T01:08:30Z"));
      await c.selfDeploy.sync();
      expect((await c.req("POST", "/api/self-deploy/update-runners")).json().decisionId).toBeTruthy();
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
      // The hold ends at 120 s soak + 120 s margin, not at the old 900 s + 120 s.
      vi.setSystemTime(new Date("2026-11-03T01:05:01Z"));
      await c.selfDeploy.sync();
      expect((await c.open()).filter((d) => target(d).target === "runner" && target(d).commit === B)).toHaveLength(1);
    });

    it("falls back to 15 minutes when an older host reports no trial length", async () => {
      const { c } = await deployedInTrial();
      expect((await c.req("POST", "/api/self-deploy/update-runners")).json().message).toContain("15-minute trial");
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
});
