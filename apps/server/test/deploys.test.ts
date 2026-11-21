import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type { RunnerCommand } from "@boss-man/shared";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { activity, decisions, deploys, runners, secretAccessLog, wakes } from "../src/db/schema.js";
import { endpointProblem, liveTagOf } from "../src/services/deploys.js";

let ctx: Awaited<ReturnType<typeof setup>> | undefined;
afterEach(async () => {
  await ctx?.app.close();
  await ctx?.close();
  ctx = undefined;
});

async function setup() {
  const { db, close } = await openPglite();
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false, limits: { quickBatchMs: 0 }, workspaceRoot: "/ws" });
  const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
  const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
  const req = (method: "GET" | "POST" | "PATCH" | "DELETE", url: string, payload?: unknown, headers: Record<string, string> = { cookie }) =>
    built.app.inject({ method, url, headers, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const { company, ceo } = (await req("POST", "/api/companies", { name: "Homelab Co" })).json() as { company: { id: string }; ceo: { id: string } };
  const reg = (await req("POST", `/api/companies/${company.id}/runner`)).json() as { runnerId: string; token: string };
  const [runnerRow] = await db.select().from(runners).where(eq(runners.id, reg.runnerId));
  const sent: RunnerCommand[] = [];
  built.runners.connect(reg.runnerId, (c) => (sent.push(c), true));
  const secret = async (name: string, value: string) => (await req("POST", "/api/secrets", { name, kind: "generic", value })).json().secret.id as string;
  const envFor = async (runId?: string) => (await req("GET", `/api/runner/env${runId ? `?runId=${runId}` : ""}`, undefined, { authorization: `Bearer ${reg.token}` })).json().env as Record<string, string>;
  const target = async (body: Record<string, unknown>) => req("POST", `/api/companies/${company.id}/deploy-targets`, body);
  const actor = { companyId: company.id, agentId: ceo.id };
  const starts = () => sent.filter((c): c is Extract<RunnerCommand, { type: "run.start" }> => c.type === "run.start");
  let seq = 0;
  const endRun = (runId: string) => built.runners.ingest(runnerRow!, { seq: ++seq, at: new Date().toISOString(), event: { type: "run.ended", runId, stopReason: "end_turn", error: null } });
  return { ...built, db, close, req, company, ceo, secret, envFor, target, actor, starts, endRun };
}

describe("deploy targets (R14)", () => {
  it("refuses the raw Docker socket and credentials in the endpoint", async () => {
    const c = (ctx = await setup());
    const raw = await c.target({ name: "Docker", kind: "docker", endpoint: "unix:///var/run/docker.sock" });
    expect(raw.statusCode).toBe(422);
    expect(raw.json().message).toMatch(/socket proxy/);
    expect((await c.target({ name: "Git", kind: "git", endpoint: `https://bot:${"ghp_"}0123456789abcdefghijABCDEFGHIJ@github.com/x/y.git` /* joined: no key-shaped line for the secret scans (BOS-1932) */ })).statusCode).toBe(422);
    const ok = await c.target({ name: "Docker", kind: "docker", endpoint: "tcp://socket-proxy:2375", isProduction: true });
    expect(ok.statusCode).toBe(201);
  });

  it("leaves an activity line when a target is added, changed or removed, and none for a refused request (BOS-2100)", async () => {
    const c = (ctx = await setup());
    const lines = async () => (await c.db.select().from(activity).where(and(eq(activity.companyId, c.company.id), eq(activity.kind, "settings")))).map((a) => a.summary);
    const ok = await c.target({ name: "Production", kind: "ssh", endpoint: "deploy@nas.lan", isProduction: true, requiresApproval: true });
    expect(ok.statusCode).toBe(201);
    const id = ok.json().id as string;
    expect(await lines()).toEqual(["Owner added deploy target Production"]);

    // Refused: validation and unknown id write nothing.
    expect((await c.req("PATCH", `/api/deploy-targets/${id}`, { endpoint: "nas.lan" })).statusCode).toBe(422);
    expect((await c.req("PATCH", `/api/deploy-targets/${randomUUID()}`, { isProduction: false })).statusCode).toBe(404);
    expect((await c.req("DELETE", `/api/deploy-targets/${randomUUID()}`)).statusCode).toBe(404);
    expect(await lines()).toHaveLength(1);

    // A save that changes nothing writes nothing; each real change is named, without the values.
    expect((await c.req("PATCH", `/api/deploy-targets/${id}`, { isProduction: true })).statusCode).toBe(200);
    expect(await lines()).toHaveLength(1);
    expect((await c.req("PATCH", `/api/deploy-targets/${id}`, { requiresApproval: false, endpoint: "ops@nas.lan" })).statusCode).toBe(200);
    const all = await lines();
    expect(all).toHaveLength(2);
    expect(all.at(-1)).toBe("Owner changed deploy target Production: approval needed turned off, endpoint changed");
    expect(all.join(" ")).not.toContain("nas.lan");

    expect((await c.req("DELETE", `/api/deploy-targets/${id}`)).statusCode).toBe(204);
    expect((await lines()).at(-1)).toBe("Owner removed deploy target Production");
  });

  it("refuses to remove a target with a live deploy, and asks before erasing past deploys (BOS-2158)", async () => {
    const c = (ctx = await setup());
    const id = (await c.target({ name: "Production", kind: "ssh", endpoint: "deploy@nas.lan", isProduction: true })).json().id as string;
    const r = await c.deploys.request(c.actor, { target: "Production", ref: "v1.0.0" });
    expect(r.deploy.status).toBe("pending_approval");

    // Live: refused, even with force; nothing erased.
    expect((await c.req("DELETE", `/api/deploy-targets/${id}`)).statusCode).toBe(409);
    const forced = await c.req("DELETE", `/api/deploy-targets/${id}?force=1`);
    expect(forced.statusCode).toBe(409);
    expect(forced.json().error).toBe("live");
    expect(await c.db.select().from(deploys)).toHaveLength(1);

    // Finished: history needs the owner's confirmation.
    await c.db.update(deploys).set({ status: "succeeded" }).where(eq(deploys.id, r.deploy.id));
    const ask = await c.req("DELETE", `/api/deploy-targets/${id}`);
    expect(ask.statusCode).toBe(409);
    expect(ask.json().error).toBe("has_history");
    expect(await c.db.select().from(deploys)).toHaveLength(1);
    expect((await c.req("DELETE", `/api/deploy-targets/${id}?force=1`)).statusCode).toBe(204);
    expect(await c.db.select().from(deploys)).toHaveLength(0);
    // The approval card the deploy raised is closed with a reason, not left open pointing at nothing.
    const cards = await c.db.select().from(decisions).where(eq(decisions.kind, "approval"));
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ status: "withdrawn" });
    expect(JSON.stringify(cards[0]!.context)).toContain("deploy target was removed");
  });

  it("checks the endpoint shape for each kind", () => {
    expect(endpointProblem("ssh", "deploy@nas.lan")).toBeNull();
    expect(endpointProblem("ssh", "ssh://deploy@192.168.1.10:22")).toBeNull();
    expect(endpointProblem("git", "git@github.com:Leonfinn/homelab.git")).toBeNull();
    expect(endpointProblem("docker", "/var/run/docker.sock")).toMatch(/root on the host/);
    expect(endpointProblem("ssh", "nas.lan")).toMatch(/user@host/);
  });
});

describe("deploys (R15)", () => {
  it("gives a target's secrets only to the run carrying out an approved deploy, and only until it reports", async () => {
    const c = (ctx = await setup());
    const staging = (await c.target({ name: "Staging", kind: "docker", endpoint: "tcp://socket-proxy:2375" })).json();
    await c.req("POST", `/api/secrets/${await c.secret("company token", "company-wide-value")}/grants`, { companyId: c.company.id, envName: "COMPANY_TOKEN" });
    await c.req("POST", `/api/secrets/${await c.secret("staging deploy key", "staging-deploy-value")}/grants`, { companyId: c.company.id, envName: "STAGING_KEY", deployTargetId: staging.id });

    // Not production: approved straight away, and the agent is woken to carry it out.
    const r = await c.deploys.request(c.actor, { target: "staging", ref: "v1.4.0" });
    expect(r.deploy.status).toBe("approved");
    expect(await c.db.select().from(wakes)).toEqual([expect.objectContaining({ agentId: c.ceo.id, deployId: r.deploy.id, reason: "deploy approved" })]);

    await c.scheduler.tick();
    const run = c.starts()[0]!;
    expect(run.prompt).toContain("ship v1.4.0 to Staging");
    expect((await c.db.select().from(deploys))[0]).toMatchObject({ status: "running", runId: run.runId });

    expect(await c.envFor(run.runId)).toEqual({ COMPANY_TOKEN: "company-wide-value", STAGING_KEY: "staging-deploy-value" });
    expect(await c.envFor()).toEqual({ COMPANY_TOKEN: "company-wide-value" });
    const log = await c.db.select().from(secretAccessLog);
    expect(log.filter((l) => l.purpose === "deploy")).toHaveLength(1);

    // Another run of the same company can't report it.
    await expect(c.deploys.report({ companyId: c.company.id, runId: "00000000-0000-4000-8000-000000000000" }, { deployId: r.deploy.id, outcome: "succeeded" })).rejects.toThrow(/Only the run/);
    await c.deploys.report({ companyId: c.company.id, runId: run.runId }, { deployId: r.deploy.id, outcome: "succeeded", notes: "Health check 200" });
    expect(await c.envFor(run.runId)).toEqual({ COMPANY_TOKEN: "company-wide-value" });
  });

  it("sends production deploys to the owner, and tells the agent if rejected", async () => {
    const c = (ctx = await setup());
    await c.target({ name: "Production", kind: "ssh", endpoint: "deploy@nas.lan", isProduction: true });
    const r = await c.deploys.request(c.actor, { target: "Production", ref: "v1.4.0", notes: "Migration included" });
    expect(r.deploy.status).toBe("pending_approval");
    const [approval] = await c.db.select().from(decisions);
    expect(approval).toMatchObject({ kind: "approval", question: "CEO wants to deploy v1.4.0 to Production (production). Notes: Migration included", recommendedOption: "Approve" });
    expect(await c.db.select().from(wakes)).toHaveLength(0);

    await c.req("POST", `/api/decisions/${approval!.id}/answer`, { answer: "Reject" });
    expect((await c.db.select().from(deploys))[0]!.status).toBe("rejected");
    expect(await c.db.select().from(wakes)).toEqual([expect.objectContaining({ reason: "deploy rejected", deployId: null })]);

    const again = await c.deploys.request(c.actor, { target: "Production", ref: "v1.4.1" });
    const [second] = (await c.db.select().from(decisions)).filter((d) => d.status === "open");
    await c.req("POST", `/api/decisions/${second!.id}/answer`, { answer: "Approve" });
    expect((await c.db.select().from(deploys).where(eq(deploys.id, again.deploy.id)))[0]!.status).toBe("approved");
  });

  it("fails a deploy whose run ends without reporting, which ends its secrets", async () => {
    const c = (ctx = await setup());
    await c.target({ name: "Staging", kind: "docker", endpoint: "tcp://socket-proxy:2375" });
    const r = await c.deploys.request(c.actor, { target: "Staging", ref: "v2" });
    await c.scheduler.tick();
    const run = c.starts()[0]!;
    await c.endRun(run.runId);
    await new Promise((res) => setTimeout(res, 50));
    expect((await c.db.select().from(deploys).where(eq(deploys.id, r.deploy.id)))[0]).toMatchObject({ status: "failed", outcome: "The run ended without reporting a result." });
  });

  it("refuses unknown targets and credentials in the request", async () => {
    const c = (ctx = await setup());
    await expect(c.deploys.request(c.actor, { target: "Prod", ref: "v1" })).rejects.toThrow(/no deploy targets/);
    await c.target({ name: "Staging", kind: "docker", endpoint: "tcp://socket-proxy:2375" });
    await expect(c.deploys.request(c.actor, { target: "Prod", ref: "v1" })).rejects.toThrow(/Targets: Staging/);
    await expect(c.deploys.request(c.actor, { target: "Staging", ref: "v1", notes: "key AKIAIOSFODNN7EXAMPLE" })).rejects.toThrow(/AWS access key/);
  });
});

describe("liveTagOf (DR-033)", () => {
  const live = { projectId: "11111111-1111-4111-8111-111111111111", name: "live-deployed" };

  it("returns a target's well-formed deploy tag", () => {
    expect(liveTagOf({ rules: { liveTag: live } })).toEqual(live);
    // A copy, not the stored object: the caller can't change the target's rules through it.
    expect(liveTagOf({ rules: { liveTag: live } })).not.toBe(live);
    // Unknown keys the stored rules may carry are dropped.
    expect(liveTagOf({ rules: { liveTag: { ...live, extra: true } } })).toEqual(live);
  });

  it("returns null for empty or unknown rules, or a malformed tag", () => {
    expect(liveTagOf({ rules: null })).toBeNull();
    expect(liveTagOf({ rules: {} })).toBeNull();
    expect(liveTagOf({ rules: { requiresApproval: true } })).toBeNull();
    expect(liveTagOf({ rules: { liveTag: null } })).toBeNull();
    expect(liveTagOf({ rules: { liveTag: "live-deployed" } })).toBeNull();
    expect(liveTagOf({ rules: { liveTag: { name: live.name } } })).toBeNull();
    expect(liveTagOf({ rules: { liveTag: { projectId: live.projectId } } })).toBeNull();
    expect(liveTagOf({ rules: { liveTag: { projectId: live.projectId, name: "" } } })).toBeNull();
    expect(liveTagOf({ rules: { liveTag: { projectId: 42, name: live.name } } })).toBeNull();
    expect(liveTagOf({ rules: { liveTag: { projectId: live.projectId, name: 7 } } })).toBeNull();
  });
});
