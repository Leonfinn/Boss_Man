// DR-033 end to end: a deploy target with a deploy tag, a real bare git remote, and the runner's real
// workspace code answering the server's commands. A successful deploy of a main commit moves the tag;
// anything else leaves it alone and says why; agents can't set the tag; no branch on the remote moves.
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { Workspaces } from "@boss-man/runner";
import type { RunnerCommand } from "@boss-man/shared";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { activity, decisions, deploys, projects, runners, runs as runsTable, secretAccessLog } from "../src/db/schema.js";

const ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: ENV }).trim();

/** main at A with live-deployed at A, then main moves to B; an unmerged branch "feature" at F. */
function origin() {
  const bare = mkdtempSync(path.join(tmpdir(), "bm-srvtag-origin-"));
  git(bare, "init", "-q", "--bare", "-b", "main");
  const seed = mkdtempSync(path.join(tmpdir(), "bm-srvtag-seed-"));
  git(seed, "clone", "-q", bare, ".");
  const commit = (text: string) => {
    writeFileSync(path.join(seed, "app.txt"), text);
    git(seed, "add", ".");
    git(seed, "commit", "-qm", text);
    return git(seed, "rev-parse", "HEAD");
  };
  const A = commit("a");
  git(seed, "push", "-q", "origin", "HEAD:main");
  git(seed, "push", "-q", "origin", `${A}:refs/tags/live-deployed`);
  const B = commit("b");
  git(seed, "push", "-q", "origin", "HEAD:main");
  git(seed, "checkout", "-q", "-b", "feature");
  const F = commit("f");
  git(seed, "push", "-q", "origin", "HEAD:feature");
  const heads = () => git(bare, "for-each-ref", "--format=%(refname) %(objectname)", "refs/heads/");
  const tagAt = () => git(bare, "rev-parse", "refs/tags/live-deployed");
  return { url: bare, A, B, F, heads, tagAt };
}

let ctx: Awaited<ReturnType<typeof setup>> | undefined;
afterEach(async () => {
  await ctx?.app.close();
  await ctx?.close();
  ctx = undefined;
});

async function setup(opts: { connect?: boolean } = {}) {
  const o = origin();
  const { db, close } = await openPglite();
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false, limits: { quickBatchMs: 0 }, workspaceRoot: "/ws" });
  const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
  const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
  const req = (method: "GET" | "POST" | "PATCH" | "DELETE", url: string, payload?: unknown, headers: Record<string, string> = { cookie }) =>
    built.app.inject({ method, url, headers, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const { company, ceo } = (await req("POST", `/api/companies`, { name: "Holiday Co" })).json() as { company: { id: string }; ceo: { id: string } };
  const project = (await req("POST", `/api/companies/${company.id}/projects`, { name: "holidayhours" })).json() as { id: string };
  await db.update(projects).set({ repoUrl: o.url, defaultBranch: "main" }).where(eq(projects.id, project.id));
  const reg = (await req("POST", `/api/companies/${company.id}/runner`)).json() as { runnerId: string; token: string };
  const [runnerRow] = await db.select().from(runners).where(eq(runners.id, reg.runnerId));
  // The runner: the real workspace code, answering the server's requests the way session-manager.ts does.
  const ws = new Workspaces(mkdtempSync(path.join(tmpdir(), "bm-srvtag-ws-")));
  const sent: RunnerCommand[] = [];
  const envPurpose = async (purpose: string) => req("GET", `/api/runner/env?purpose=${purpose}`, undefined, { authorization: `Bearer ${reg.token}` });
  const answer = (c: RunnerCommand) => {
    sent.push(c);
    if (c.type !== "workspace.resolve" && c.type !== "workspace.tag") return true;
    void (async () => {
      try {
        await envPurpose(c.type === "workspace.tag" ? "deploy_tag" : "merge");
        const data = c.type === "workspace.tag" ? await ws.tag(c) : await ws.resolve(c);
        built.runners.resolveReply({ requestId: c.requestId, ok: true, data });
      } catch (err) {
        built.runners.resolveReply({ requestId: c.requestId, ok: false, error: (err as Error).message });
      }
    })();
    return true;
  };
  if (opts.connect !== false) built.runners.connect(reg.runnerId, answer, ["deploy-tag"]);
  const target = (body: Record<string, unknown>) => req("POST", `/api/companies/${company.id}/deploy-targets`, body);
  const actor = { companyId: company.id, agentId: ceo.id };
  const starts = () => sent.filter((c): c is Extract<RunnerCommand, { type: "run.start" }> => c.type === "run.start");
  // The company's git token, which the daemon fetches for the tag push (logged as deploy_tag).
  const secretId = (await req("POST", "/api/secrets", { name: "git token", kind: "generic", value: "not-a-real-token" })).json().secret.id as string;
  await req("POST", `/api/secrets/${secretId}/grants`, { companyId: company.id, envName: "GIT_TOKEN" });
  /** Request, approve if needed, start the run and report: the whole deploy as an agent does it. */
  const deploy = async (targetName: string, ref: string, outcome: "succeeded" | "failed") => {
    const r = await built.deploys.request(actor, { target: targetName, ref });
    if (r.deploy.status === "pending_approval") {
      const [card] = (await db.select().from(decisions)).filter((d) => d.status === "open" && (d.context as { deployId?: string }).deployId === r.deploy.id);
      await req("POST", `/api/decisions/${card!.id}/answer`, { answer: "Approve" });
    }
    await built.scheduler.tick();
    const run = starts().at(-1)!;
    await built.deploys.report({ companyId: company.id, runId: run.runId }, { deployId: r.deploy.id, outcome });
    await built.deploys.waitForTag(r.deploy.id, r.deploy.targetId);
    // The run ends, so the agent is free for the next deploy (set directly: this test is about the deploy, not the run's end).
    await db.update(runsTable).set({ endedAt: new Date(), outcome: "end_turn" }).where(eq(runsTable.id, run.runId));
    const [row] = await db.select().from(deploys).where(eq(deploys.id, r.deploy.id));
    return row!;
  };
  return { ...built, db, close, req, o, company, ceo, project, reg, runnerRow, target, actor, deploy, sent, answer };
}

const liveTag = (c: { project: { id: string } }, name = "live-deployed") => ({ projectId: c.project.id, name });

describe("a deploy target's tag (DR-033)", () => {
  it("moves the remote tag from A to B after a successful deploy of main's B, records it, and moves no branch", async () => {
    const c = (ctx = await setup());
    const heads = c.o.heads();
    expect((await c.target({ name: "Production", kind: "ssh", endpoint: "deploy@nas.lan", isProduction: true, liveTag: liveTag(c) })).statusCode).toBe(201);
    const d = await c.deploy("Production", "main", "succeeded");
    expect(d).toMatchObject({ status: "succeeded", commit: c.o.B, tagName: "live-deployed", tagFrom: c.o.A, tagTo: c.o.B, tagResult: "moved" });
    expect(d.tagAt).toBeInstanceOf(Date);
    expect(c.o.tagAt()).toBe(c.o.B);
    expect(c.o.heads()).toBe(heads);
    // The ticket feed line and the secret access log purpose.
    const feed = await c.db.select().from(activity).where(eq(activity.kind, "deploy_tag"));
    expect(feed.map((f) => f.summary)).toEqual([`Moved live-deployed ${c.o.A.slice(0, 7)} → ${c.o.B.slice(0, 7)} after deploy ${d.id}`]);
    expect((await c.db.select().from(secretAccessLog)).some((l) => l.purpose === "deploy_tag")).toBe(true);
  });

  it("names the resolved commit on the owner's approval card", async () => {
    const c = (ctx = await setup());
    await c.target({ name: "Production", kind: "ssh", endpoint: "deploy@nas.lan", isProduction: true, liveTag: liveTag(c) });
    await c.deploys.request(c.actor, { target: "Production", ref: "main" });
    const [card] = await c.db.select().from(decisions);
    expect(card!.question).toContain(`deploy main (ships ${c.o.B.slice(0, 7)}) to Production (production)`);
    expect(card!.question).toContain(`moves the tag live-deployed to ${c.o.B.slice(0, 7)}`);
    expect(card!.context).toMatchObject({ type: "deploy", commit: c.o.B });
  });

  it("leaves the tag alone for an unmerged commit, a failed deploy and a target without a tag, saying why", async () => {
    const c = (ctx = await setup());
    const heads = c.o.heads();
    await c.target({ name: "Staging", kind: "docker", endpoint: "tcp://socket-proxy:2375", liveTag: liveTag(c) });
    await c.target({ name: "Plain", kind: "docker", endpoint: "tcp://socket-proxy:2376" });

    const unmerged = await c.deploy("Staging", "feature", "succeeded");
    expect(unmerged).toMatchObject({ status: "succeeded", commit: c.o.F, tagResult: `skipped: ${c.o.F.slice(0, 7)} isn't on main`, tagTo: null });

    const failed = await c.deploy("Staging", "main", "failed");
    expect(failed).toMatchObject({ status: "failed", commit: c.o.B, tagResult: "skipped: the deploy failed" });

    const plain = await c.deploy("Plain", "main", "succeeded");
    // No tag and no ticket, so no project to read the commit in: the deploy goes on as before.
    expect(plain).toMatchObject({ status: "succeeded", commit: null, tagName: null, tagResult: null });

    const image = await c.deploy("Staging", "registry.lan/app:1.2", "succeeded");
    expect(image).toMatchObject({ status: "succeeded", commit: null });
    expect(image.tagResult).toMatch(/^skipped: /);

    expect(c.o.tagAt()).toBe(c.o.A);
    expect(c.o.heads()).toBe(heads);
  });

  it("keeps the deploy succeeded when the host refuses the tag, and alerts the CEO with the host's text", async () => {
    const c = (ctx = await setup());
    writeFileSync(path.join(c.o.url, "hooks", "update"), "#!/bin/sh\necho 'tag live-deployed is protected' >&2\nexit 1\n", { mode: 0o755 });
    await c.target({ name: "Staging", kind: "docker", endpoint: "tcp://socket-proxy:2375", liveTag: liveTag(c) });
    const d = await c.deploy("Staging", "main", "succeeded");
    expect(d.status).toBe("succeeded");
    expect(d.tagResult).toMatch(/^failed: .*tag live-deployed is protected/s);
    expect(c.o.tagAt()).toBe(c.o.A);
    const alerts = (await c.db.select().from(decisions)).filter((x) => x.question.includes("couldn't move the tag live-deployed"));
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.question).toContain("tag live-deployed is protected");
    expect((await c.db.select().from(activity).where(eq(activity.kind, "deploy_tag")))[0]!.summary).toMatch(/^Tag live-deployed not moved after deploy/);
  });

  it("alerts the CEO when the runner is offline for the wait, then moves the tag once it is back", async () => {
    const c = (ctx = await setup());
    await c.target({ name: "Staging", kind: "docker", endpoint: "tcp://socket-proxy:2375", liveTag: liveTag(c) });
    // A deploys service with short waits, sharing the app's runners and alert ladder.
    const { deploysService } = await import("../src/services/deploys.js");
    const raised: string[] = [];
    let connected = true;
    const hub = {
      isConnected: (id: string) => connected && c.runners.isConnected(id),
      waitConnected: async (id: string, ms: number) => {
        for (const until = Date.now() + ms; Date.now() < until; ) {
          if (connected && c.runners.isConnected(id)) return true;
          await new Promise((r) => setTimeout(r, 5));
        }
        return connected && c.runners.isConnected(id);
      },
      can: c.runners.can,
      request: c.runners.request,
    };
    const svc = deploysService(c.db, { runners: hub, alert: async (i) => {
        raised.push(i.question);
        connected = true; // the runner comes back only once the alert has gone out: no clock race on a loaded machine
      },
      tagRunnerAlertMs: 10,
      tagRunnerGiveUpMs: 2_000,
    });
    const r = await svc.request(c.actor, { target: "Staging", ref: "main" });
    await c.db.update(deploys).set({ status: "running" }).where(eq(deploys.id, r.deploy.id));
    connected = false;
    await svc.report({ companyId: c.company.id }, { deployId: r.deploy.id, outcome: "succeeded" });
    await svc.waitForTag(r.deploy.id, r.deploy.targetId);
    expect(raised).toHaveLength(1);
    expect(raised[0]).toMatch(/hasn't been moved .* runner has been offline for 30 minutes/);
    const [row] = await c.db.select().from(deploys).where(eq(deploys.id, r.deploy.id));
    expect(row).toMatchObject({ status: "succeeded", tagResult: "moved", tagTo: c.o.B });
  });

  it("picks up a tag move a restart cut off", async () => {
    const c = (ctx = await setup());
    const t = (await c.target({ name: "Staging", kind: "docker", endpoint: "tcp://socket-proxy:2375", liveTag: liveTag(c) })).json() as { id: string };
    const [row] = await c.db
      .insert(deploys)
      .values({ companyId: c.company.id, targetId: t.id, ref: "main", status: "succeeded", commit: c.o.B, tagName: "live-deployed", tagResult: "pending", finishedAt: new Date() })
      .returning();
    expect(await c.deploys.resumeTags()).toBe(1);
    await c.deploys.waitForTag(row!.id, t.id);
    expect((await c.db.select().from(deploys).where(eq(deploys.id, row!.id)))[0]).toMatchObject({ tagResult: "moved", tagFrom: c.o.A, tagTo: c.o.B });
    expect(c.o.tagAt()).toBe(c.o.B);
  });
});

describe("the deploy tag setting (DR-033)", () => {
  it("refuses a name git refuses, one with '/', and one that is a branch on the remote", async () => {
    const c = (ctx = await setup());
    const base = { name: "Production", kind: "ssh", endpoint: "deploy@nas.lan" };
    for (const name of ["bad name", "a..b", "x.lock", "-f", "release/live", "main", "feature"]) {
      const r = await c.target({ ...base, liveTag: liveTag(c, name) });
      expect(r.statusCode, name).toBe(422);
    }
    expect((await c.target({ ...base, liveTag: liveTag(c, "feature") })).json().message).toMatch(/also a branch/);
    expect((await c.req("GET", `/api/companies/${c.company.id}/deploy-targets`)).json()).toEqual([]);
    const ok = (await c.target({ ...base, liveTag: liveTag(c) })).json() as { id: string; rules: unknown };
    expect(ok.rules).toEqual({ requiresApproval: false, liveTag: liveTag(c) });
    // Editing to a branch name is refused too, and null turns it off.
    expect((await c.req("PATCH", `/api/deploy-targets/${ok.id}`, { liveTag: liveTag(c, "feature") })).statusCode).toBe(422);
    expect((await c.req("PATCH", `/api/deploy-targets/${ok.id}`, { liveTag: null })).json().rules).toEqual({ requiresApproval: false });
  });

  it("can't be saved while the runner is away, since the branch check runs there", async () => {
    const c = (ctx = await setup({ connect: false }));
    const r = await c.target({ name: "Production", kind: "ssh", endpoint: "deploy@nas.lan", liveTag: liveTag(c) });
    expect(r.statusCode).toBe(409);
    expect(r.json().message).toMatch(/isn't connected/);
  });

  it("is owner-only: no session or runner token can set it, and the agents' deploy tool has no way to", async () => {
    const c = (ctx = await setup());
    const t = (await c.target({ name: "Production", kind: "ssh", endpoint: "deploy@nas.lan" })).json() as { id: string };
    expect((await c.req("PATCH", `/api/deploy-targets/${t.id}`, { liveTag: liveTag(c) }, {})).statusCode).toBe(401);
    expect((await c.req("PATCH", `/api/deploy-targets/${t.id}`, { liveTag: liveTag(c) }, { authorization: `Bearer ${c.reg.token}` })).statusCode).toBe(401);
    expect((await c.req("POST", `/api/companies/${c.company.id}/deploy-targets`, { name: "X", kind: "ssh", endpoint: "deploy@nas.lan", liveTag: liveTag(c) }, {})).statusCode).toBe(401);
    const mcp = await import("node:fs").then((fs) => fs.readFileSync(path.join(import.meta.dirname, "..", "src", "mcp.ts"), "utf8"));
    expect(mcp).not.toMatch(/deploys\.(createTarget|updateTarget)/);
  });

  it("deploy targets returns each target's last successful deploy: its commit, time and tag result", async () => {
    const c = (ctx = await setup());
    await c.target({ name: "Staging", kind: "docker", endpoint: "tcp://socket-proxy:2375", liveTag: liveTag(c) });
    const d = await c.deploy("Staging", "main", "succeeded");
    await c.deploy("Staging", "feature", "failed");
    const [t] = (await c.req("GET", `/api/companies/${c.company.id}/deploy-targets`)).json() as Array<{ lastDeploy: Record<string, unknown> }>;
    expect(t!.lastDeploy).toMatchObject({ id: d.id, commit: c.o.B, tagName: "live-deployed", tagResult: "moved" });
    expect(t!.lastDeploy.at).toBeTruthy();
  });
});
