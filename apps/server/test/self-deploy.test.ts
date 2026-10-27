import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { decisions, notifications } from "../src/db/schema.js";

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

async function setup(opts: { deployer?: boolean } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "bm-deployer-"));
  await mkdir(path.join(dir, "inbox"));
  await mkdir(path.join(dir, "outbox"));
  const { db, close } = await openPglite();
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false, deployerDir: opts.deployer === false ? undefined : dir });
  const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
  const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
  const req = (method: "GET" | "POST", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  await req("POST", "/api/companies", { name: "App Co" });
  const outbox = (name: string, body: unknown) => writeFile(path.join(dir, "outbox", name), JSON.stringify(body));
  const available = (over: Record<string, unknown> = {}) =>
    outbox("available.json", { version: 1, checkedAt: "2026-10-20T12:00:00Z", deployed: A, tip: B, commits: [{ sha: B, subject: "Add rate limiting" }], paths: ["apps/server/src/x.ts"], infraPaths: [], runnerChanged: false, ...over });
  const status = (over: Record<string, unknown>) =>
    outbox("status.json", { id: "", target: "server", result: "deployed", message: "Deployed.", from_commit: A, to_commit: B, started: "2026-10-20T12:01:00Z", ended: "2026-10-20T12:03:00Z", backup: "", ...over });
  const open = async () => (await db.select().from(decisions).where(eq(decisions.status, "open"))).filter((d) => (d.context as { type: string }).type === "self_deploy");
  const todos = async () => (await db.select().from(decisions).where(eq(decisions.status, "open"))).filter((d) => (d.context as { type: string }).type === "owner_todo");
  return { ...built, db, close, dir, req, available, status, open, todos };
}

describe("self-deploy (docs/09-self-deploy.md)", () => {
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
    expect(d!.question).toContain("Add rate limiting");
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
    await c.available({ infraPaths: ["docker-compose.yml"], paths: ["docker-compose.yml"] });
    await c.selfDeploy.sync();
    const [d] = await c.open();
    expect(d).toMatchObject({ options: ["Approve", "Not now"], context: { infra: true } });
    expect(d!.question).toContain("scripts/deploy.sh");
    expect((await c.req("POST", `/api/decisions/${d!.id}/answer`, { answer: "Approve" })).statusCode).toBe(200);
    // Nothing goes to the host: the change can only be applied by hand.
    expect(await readdir(path.join(c.dir, "inbox"))).toEqual([]);
    // The approval clears, and an owner to-do takes its place on the queue.
    expect((await c.db.select().from(decisions).where(eq(decisions.id, d!.id)))[0]!.status).toBe("answered");
    const [todo] = await c.todos();
    expect(todo).toMatchObject({ kind: "question", tier: "owner", options: ["Done, it's applied", "A step failed"], recommendedOption: "Done, it's applied" });
    expect(todo!.context).toMatchObject({ type: "owner_todo", ofDecisionId: d!.id, target: "server", commit: B });
    expect((todo!.context as { steps: string[] }).steps.length).toBeGreaterThan(1);
    expect(todo!.context).toMatchObject({ check: expect.any(String), rollback: expect.any(String) });
    expect(todo!.question).toContain("waiting for you to apply it by hand");
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

  it("clears the owner to-do once the live commit changes, without the owner doing anything", async () => {
    const c = (ctx = await setup());
    await c.available({ infraPaths: ["docker-compose.yml"], paths: ["docker-compose.yml"] });
    await c.selfDeploy.sync();
    const [d] = await c.open();
    await c.req("POST", `/api/decisions/${d!.id}/answer`, { answer: "Approve" });
    expect(await c.todos()).toHaveLength(1);
    // The host reports the approved commit is what runs now: the to-do clears itself.
    await c.available({ deployed: B, tip: B, infraPaths: ["docker-compose.yml"], paths: ["docker-compose.yml"] });
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
    // The change is not applied, so the card stays open for another try.
    const [after] = await c.todos();
    expect(after).toMatchObject({ id: todo!.id, status: "open", answer: null });
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
});
