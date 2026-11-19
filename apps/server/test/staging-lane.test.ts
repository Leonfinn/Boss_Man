// BOS-1472: the host deployer's staging lane as the server sees it. The host's files are made up in a temp folder
// (what scripts/host-deployer.sh writes); the runner only answers "what commit is this ref".
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { deploys, deployTargets, projects, runners, wakes } from "../src/db/schema.js";
import { sameRepo } from "../src/services/deploys.js";

const SHA = "a".repeat(40);
const DEPLOYER = mkdtempSync(path.join(tmpdir(), "bm-staging-lane-"));
mkdirSync(path.join(DEPLOYER, "inbox"), { recursive: true });
mkdirSync(path.join(DEPLOYER, "outbox"), { recursive: true });
const out = (f: string) => path.join(DEPLOYER, "outbox", f);
const inbox = (f: string) => path.join(DEPLOYER, "inbox", f);
/** What the host writes: the lane on or off, and the repository its staging checkout follows. */
const lane = (on: boolean) => writeFileSync(out("staging-lane.json"), JSON.stringify({ configured: String(on), origin: "git@example.com:acme/bossman.git" }));
/** What the host writes after a staging deploy: flat strings, one check_/why_ pair per smoke check. */
const hostStatus = (id: string, extra: Record<string, string> = {}) =>
  writeFileSync(
    out("staging-status.json"),
    JSON.stringify({ id, target: "staging", result: "deployed", message: `Staging runs ${SHA.slice(0, 8)}.`, to_commit: SHA, started: "2026-11-17T10:00:00Z", ended: "2026-11-17T10:05:00Z", at: "2026-11-17T10:05:00Z", smoke: "passed", check_address: "pass", why_address: "answers", check_signin: "skipped", why_signin: "not set up", check_runner: "pass", why_runner: "runner connected, image abc123", runner_image: "abc123", ...extra }),
  );

let ctx: Awaited<ReturnType<typeof setup>> | undefined;
afterEach(async () => {
  await ctx?.app.close();
  await ctx?.close();
  ctx = undefined;
  for (const f of [inbox("staging-request.json")]) rmSync(f, { force: true });
  for (const f of ["staging-lane.json", "staging-status.json"]) rmSync(out(f), { force: true });
});

async function setup() {
  const { db, close } = await openPglite();
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false, limits: { quickBatchMs: 0 }, workspaceRoot: "/ws", deployerDir: DEPLOYER });
  const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
  const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
  const req = (method: "GET" | "POST", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const { company, ceo } = (await req("POST", "/api/companies", { name: "Boss Man Co" })).json() as { company: { id: string }; ceo: { id: string } };
  const project = (await req("POST", `/api/companies/${company.id}/projects`, { name: "bossman" })).json() as { id: string };
  await db.update(projects).set({ repoUrl: "https://example.com/acme/bossman.git", defaultBranch: "main" }).where(eq(projects.id, project.id));
  const reg = (await req("POST", `/api/companies/${company.id}/runner`)).json() as { runnerId: string };
  built.runners.connect(
    reg.runnerId,
    (c) => {
      if (c.type === "workspace.resolve") built.runners.resolveReply({ requestId: c.requestId, ok: true, data: { commit: SHA, onBase: true, branches: ["main"] } });
      return true;
    },
    ["deploy-tag"],
  );
  void runners;
  return { ...built, db, close, req, company, ceo, project, actor: { companyId: company.id, agentId: ceo.id } };
}

describe("the staging lane (BOS-1472)", () => {
  it("offers a staging target only while the host's lane is on", async () => {
    const c = (ctx = await setup());
    await c.deploys.syncStaging();
    expect(await c.deploys.listTargets(c.company.id)).toEqual([]);
    await expect(c.deploys.request(c.actor, { target: "staging", ref: "main" })).rejects.toThrow(/No deploy target|no deploy targets/i);

    lane(true);
    await c.deploys.syncStaging();
    const targets = await c.deploys.listTargets(c.company.id);
    expect(targets).toEqual([expect.objectContaining({ name: "staging", isProduction: false, rules: { hostStaging: true } })]);
    await c.deploys.syncStaging(); // safe to repeat
    expect(await c.deploys.listTargets(c.company.id)).toHaveLength(1);
  });

  it("offers the target only to the company whose project is the repository staging follows, never to a fork's company", async () => {
    const c = (ctx = await setup());
    lane(true);
    const other = (await c.req("POST", "/api/companies", { name: "Fork Co" })).json() as { company: { id: string }; ceo: { id: string } };
    const forked = (await c.req("POST", `/api/companies/${other.company.id}/projects`, { name: "bossman-fork" })).json() as { id: string };
    await c.db.update(projects).set({ repoUrl: "https://example.com/someone-else/bossman.git", defaultBranch: "main" }).where(eq(projects.id, forked.id));
    await c.deploys.syncStaging();
    expect(await c.deploys.listTargets(c.company.id)).toHaveLength(1); // https and ssh forms of the same repository match
    expect(await c.deploys.listTargets(other.company.id)).toEqual([]);
    // A target it already had (an earlier build offered it to everyone) is taken away, so it can't be asked for.
    await c.db.insert(deployTargets).values({ companyId: other.company.id, name: "staging", kind: "docker", endpoint: "host-deployer:staging", rules: { hostStaging: true } });
    await c.deploys.syncStaging();
    expect(await c.deploys.listTargets(other.company.id)).toEqual([]);
    await expect(c.deploys.request({ companyId: other.company.id, agentId: other.ceo.id }, { target: "staging", ref: "main" })).rejects.toThrow(/No deploy target|no deploy targets/i);
    expect(existsSync(inbox("staging-request.json"))).toBe(false);
    // And the matching rule itself.
    expect(sameRepo("git@Example.com:acme/Bossman.git", "https://token@example.com/acme/bossman")).toBe(true);
    expect(sameRepo("https://example.com/someone-else/bossman.git", "https://example.com/acme/bossman.git")).toBe(false);
    expect(sameRepo(null, null)).toBe(false);
  });

  it("writes the host's request with no approval, wakes nobody yet, and refuses a second while one is out", async () => {
    const c = (ctx = await setup());
    lane(true);
    await c.deploys.syncStaging();
    const r = await c.deploys.request(c.actor, { target: "staging", ref: "main" });
    expect(r.deploy).toMatchObject({ status: "running", commit: SHA, runId: null });
    expect(await c.db.select().from(wakes)).toEqual([]);
    const body = JSON.parse(readFileSync(inbox("staging-request.json"), "utf8")) as Record<string, string>;
    expect(body).toMatchObject({ id: r.deploy.id, target: "staging", commit: SHA });
    expect(Object.keys(body).sort()).toEqual(["approvedBy", "commit", "id", "requestedAt", "target"]);
    expect(body.approvedBy).toBe("agent-request"); // never the owner's id: nobody approved it
    await expect(c.deploys.request(c.actor, { target: "staging", ref: "main" })).rejects.toThrow(/already queued or running/);
  });

  it("records a passing result, shows each check to agents, and wakes the requester", async () => {
    const c = (ctx = await setup());
    lane(true);
    await c.deploys.syncStaging();
    const r = await c.deploys.request(c.actor, { target: "staging", ref: "main" });
    rmSync(inbox("staging-request.json")); // the host took it
    hostStatus("00000000-0000-0000-0000-000000000000"); // an older answer, for another request: ignored
    await c.deploys.syncStaging();
    expect((await c.db.select().from(deploys).where(eq(deploys.id, r.deploy.id)))[0]!.status).toBe("running");

    hostStatus(r.deploy.id);
    await c.deploys.syncStaging();
    const [row] = await c.db.select().from(deploys).where(eq(deploys.id, r.deploy.id));
    expect(row).toMatchObject({ status: "succeeded" });
    expect(row!.outcome).toContain("Smoke checks: passed");
    expect(row!.outcome).toContain("signin skipped (not set up)");
    expect(await c.db.select().from(wakes)).toEqual([expect.objectContaining({ agentId: c.ceo.id, reason: "staging deploy finished", deployId: r.deploy.id })]);

    const block = await c.selfDeploy.stagingBlock();
    expect(block).toMatchObject({ configured: true, pending: false, last: { commit: SHA, runnerImage: "abc123", smoke: "passed" } });
    expect(block.last!.checks).toEqual(expect.arrayContaining([{ name: "address", result: "pass", why: "answers" }]));
    // The same block is what server_status gives agents.
    expect((await c.selfDeploy.overview()).staging).toEqual(block);
    // And the one staging deploy is over, so another can be asked for.
    await expect(c.deploys.request(c.actor, { target: "staging", ref: "main" })).resolves.toBeTruthy();
  });

  it("fails the deploy when a smoke check fails or the host refuses, and says which", async () => {
    const c = (ctx = await setup());
    lane(true);
    await c.deploys.syncStaging();
    const a = await c.deploys.request(c.actor, { target: "staging", ref: "main" });
    rmSync(inbox("staging-request.json"));
    hostStatus(a.deploy.id, { smoke: "failed", failed_checks: "board", check_board: "fail", why_board: "GET / gave HTTP 500" });
    await c.deploys.syncStaging();
    const [failedSmoke] = await c.db.select().from(deploys).where(eq(deploys.id, a.deploy.id));
    expect(failedSmoke).toMatchObject({ status: "failed" });
    expect(failedSmoke!.outcome).toContain("board fail (GET / gave HTTP 500)");

    const b = await c.deploys.request(c.actor, { target: "staging", ref: "main" });
    rmSync(inbox("staging-request.json"));
    writeFileSync(out("staging-status.json"), JSON.stringify({ id: b.deploy.id, target: "staging", result: "rejected", message: "Rejected: abc is not on main.", to_commit: SHA, started: "x", ended: "y", at: "y" }));
    await c.deploys.syncStaging();
    const [refused] = await c.db.select().from(deploys).where(eq(deploys.id, b.deploy.id));
    expect(refused).toMatchObject({ status: "failed", outcome: "Rejected: abc is not on main." });
  });

  it("refuses with a plain reason when the lane is off, and fails a request the host never answers", async () => {
    const c = (ctx = await setup());
    lane(true);
    await c.deploys.syncStaging();
    lane(false);
    await expect(c.deploys.request(c.actor, { target: "staging", ref: "main" })).rejects.toThrow(/isn't set up on this host/);
    lane(true);
    const r = await c.deploys.request(c.actor, { target: "staging", ref: "main" });
    rmSync(inbox("staging-request.json"));
    await c.db.update(deploys).set({ createdAt: new Date(Date.now() - 4 * 3600_000) }).where(eq(deploys.id, r.deploy.id));
    await c.deploys.syncStaging();
    expect((await c.db.select().from(deploys).where(eq(deploys.id, r.deploy.id)))[0]).toMatchObject({ status: "failed", outcome: expect.stringContaining("never answered") });
  });

  it("fails a deploy whose host status stayed 'running' long after the host's own limit, so a restart can't wedge the lane", async () => {
    const c = (ctx = await setup());
    lane(true);
    await c.deploys.syncStaging();
    const r = await c.deploys.request(c.actor, { target: "staging", ref: "main" });
    rmSync(inbox("staging-request.json"));
    // Fresh "running": left alone.
    hostStatus(r.deploy.id, { result: "running", message: "Running", ended: "", at: new Date().toISOString() });
    await c.deploys.syncStaging();
    expect((await c.db.select().from(deploys).where(eq(deploys.id, r.deploy.id)))[0]!.status).toBe("running");
    // Two hours old: cut off.
    hostStatus(r.deploy.id, { result: "running", message: "Running", ended: "", at: new Date(Date.now() - 2 * 3600_000).toISOString() });
    await c.deploys.syncStaging();
    expect((await c.db.select().from(deploys).where(eq(deploys.id, r.deploy.id)))[0]).toMatchObject({ status: "failed", outcome: expect.stringContaining("cut off") });
    // And the lane takes a new request again.
    const again = await c.deploys.request(c.actor, { target: "staging", ref: "main" });
    expect(again.deploy.status).toBe("running");
  });

  it("the Settings button writes a request for main's newest commit, owner only", async () => {
    const c = (ctx = await setup());
    expect((await c.req("POST", "/api/self-deploy/deploy-staging")).statusCode).toBe(409); // lane off
    lane(true);
    expect((await c.req("POST", "/api/self-deploy/deploy-staging")).json().message).toMatch(/hasn't reported main/); // no available.json yet
    writeFileSync(out("available.json"), JSON.stringify({ version: 1, checkedAt: new Date().toISOString(), deployed: "b".repeat(40), tip: SHA, behind: 1, commits: [], infraPaths: [], runnerChanged: false }));
    const ok = await c.req("POST", "/api/self-deploy/deploy-staging");
    expect(ok.statusCode, ok.body).toBe(200);
    expect(JSON.parse(readFileSync(inbox("staging-request.json"), "utf8"))).toMatchObject({ target: "staging", commit: SHA });
    expect((await c.req("POST", "/api/self-deploy/deploy-staging")).json().message).toMatch(/already queued/);
    rmSync(out("available.json"), { force: true });
    expect(existsSync(inbox("staging-request.json"))).toBe(true);
    const anon = await c.app.inject({ method: "POST", url: "/api/self-deploy/deploy-staging" });
    expect(anon.statusCode).toBe(401);
  });
});
