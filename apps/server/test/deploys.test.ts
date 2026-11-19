import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { RunnerCommand } from "@boss-man/shared";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { decisions, deploys, runners, secretAccessLog, wakes } from "../src/db/schema.js";
import { endpointProblem } from "../src/services/deploys.js";

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
