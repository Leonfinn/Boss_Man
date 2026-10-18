import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import WebSocket from "ws";
import { Journal, RunnerConnection } from "@boss-man/runner";
import type { RunnerCommand } from "@boss-man/shared";
import { randomBytes } from "node:crypto";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { costEvents, runnerEvents, runs } from "../src/db/schema.js";

const HEARTBEAT = 100;

async function waitFor<T>(fn: () => Promise<T>, ok: (v: T) => boolean, ms = 5000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (ok(v)) return v;
    if (Date.now() > end) throw new Error(`timed out; last value ${JSON.stringify(v)}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

let ctx: Awaited<ReturnType<typeof setup>>;

async function setup() {
  const { db, close } = await openPglite();
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, heartbeatMs: HEARTBEAT });
  const app = built.app;
  await app.listen({ host: "127.0.0.1", port: 0 });
  const port = (app.server.address() as { port: number }).port;
  const setupRes = await app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
  const cookie = `bm_session=${setupRes.cookies.find((c) => c.name === "bm_session")!.value}`;
  const companyId = (await app.inject({ method: "POST", url: "/api/companies", headers: { cookie }, payload: { name: "App Co" } })).json().company.id as string;
  const fundingId = (await app.inject({ method: "POST", url: "/api/funding-sources", headers: { cookie }, payload: { name: "API credit", kind: "api_credit", provider: "anthropic", monthlyGrantUsd: 200, cycleAnchor: new Date(Date.now() - 86_400_000).toISOString() } })).json().id as string;
  const reg = (await app.inject({ method: "POST", url: `/api/companies/${companyId}/runner`, headers: { cookie } })).json() as { runnerId: string; token: string };
  return { app, db, close, built, url: `ws://127.0.0.1:${port}/api/runner/connect`, companyId, fundingId, reg };
}

beforeEach(async () => {
  ctx = await setup();
});
afterEach(async () => {
  await ctx.app.close();
  await ctx.close();
});

function runner(commands: RunnerCommand[] = [], journalPath = path.join(mkdtempSync(path.join(tmpdir(), "bm-runner-")), "j.jsonl")) {
  const journal = new Journal(journalPath);
  const conn = new RunnerConnection({ url: ctx.url, token: ctx.reg.token, journal, runnerVersion: "test", heartbeatMs: HEARTBEAT, onCommand: (c) => commands.push(c) });
  return { conn, journal, journalPath };
}

describe("runner protocol (R31)", () => {
  it("refuses an unknown token before upgrading", async () => {
    const ws = new WebSocket(ctx.url, { headers: { authorization: "Bearer nope" } });
    const status = await new Promise<number>((resolve) => ws.on("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0)));
    expect(status).toBe(401);
  });

  it("delivers every event exactly once across a dropped connection", async () => {
    const { conn, journal } = runner();
    conn.start();
    await waitFor(async () => conn.isLive, Boolean);

    const runId = randomUUID();
    conn.emit({ type: "run.started", runId, agentId: null, acpSessionId: "s-1", model: "claude-sonnet-5-5" });
    conn.emit({ type: "run.cost", runId, fundingSourceId: ctx.fundingId, costMicrosDelta: 20_000, model: "claude-sonnet-5-5" });
    await waitFor(() => ctx.db.select().from(runnerEvents), (r) => r.length === 2);

    // A network fault; these two are journaled while offline.
    conn.breakConnection();
    conn.emit({ type: "run.cost", runId, fundingSourceId: ctx.fundingId, costMicrosDelta: 13_000, model: "claude-sonnet-5-5" });
    conn.emit({ type: "run.ended", runId, stopReason: "end_turn", error: null });

    await waitFor(() => ctx.db.select().from(runnerEvents), (r) => r.length === 4);
    await waitFor(async () => journal.pending().length, (n) => n === 0);

    const seqs = (await ctx.db.select().from(runnerEvents)).map((r) => r.seq).sort((a, b) => a - b);
    expect(seqs).toEqual([1, 2, 3, 4]);
    const costs = await ctx.db.select().from(costEvents).where(eq(costEvents.runId, runId));
    expect(costs.reduce((s, c) => s + c.costMicros, 0)).toBe(33_000);
    const [run] = await ctx.db.select().from(runs).where(eq(runs.id, runId));
    expect(run).toMatchObject({ companyId: ctx.companyId, outcome: "end_turn" });
    conn.stop();
  });

  it("replays from the journal after a runner restart without duplicating", async () => {
    const first = runner();
    first.conn.start();
    await waitFor(async () => first.conn.isLive, Boolean);
    first.conn.emit({ type: "runner.log", level: "info", message: "one" });
    await waitFor(() => ctx.db.select().from(runnerEvents), (r) => r.length === 1);
    first.conn.stop();

    // Offline: the process writes events, then restarts with the same journal file.
    const offline = new Journal(first.journalPath);
    offline.append({ type: "runner.log", level: "info", message: "two" });
    offline.append({ type: "runner.log", level: "info", message: "three" });

    const second = runner([], first.journalPath);
    second.conn.start();
    await waitFor(() => ctx.db.select().from(runnerEvents), (r) => r.length === 3);
    expect((await ctx.db.select().from(runnerEvents)).map((r) => r.seq).sort()).toEqual([1, 2, 3]);
    second.conn.stop();
  });

  it("takes events from a recreated runner whose journal starts again at 1", async () => {
    const first = runner();
    first.conn.start();
    await waitFor(async () => first.conn.isLive, Boolean);
    for (const message of ["one", "two", "three"]) first.conn.emit({ type: "runner.log", level: "info", message });
    await waitFor(() => ctx.db.select().from(runnerEvents), (r) => r.length === 3);
    first.conn.stop();

    // A new container with empty runner data: its first event is written before it connects.
    const fresh = runner();
    const runId = randomUUID();
    fresh.journal.append({ type: "run.ended", runId, stopReason: null, error: "The runner restarted while this run was going.", interrupted: true });
    fresh.conn.start();
    await waitFor(() => ctx.db.select().from(runnerEvents), (r) => r.length === 4);
    fresh.conn.emit({ type: "runner.log", level: "info", message: "after" });
    await waitFor(() => ctx.db.select().from(runnerEvents), (r) => r.length === 5);
    const rows = (await ctx.db.select().from(runnerEvents)).sort((a, b) => a.seq - b.seq);
    expect(rows.map((r) => [r.seq, r.type])).toEqual([
      [1, "runner.log"],
      [2, "runner.log"],
      [3, "runner.log"],
      [4, "run.ended"],
      [5, "runner.log"],
    ]);
    fresh.conn.stop();
  });

  it("delivers commands to the connected runner", async () => {
    const commands: RunnerCommand[] = [];
    const { conn } = runner(commands);
    conn.start();
    await waitFor(async () => ctx.built.runners.isConnected(ctx.reg.runnerId), Boolean);
    const runId = randomUUID();
    expect(ctx.built.runners.send(ctx.reg.runnerId, { type: "run.cancel", runId })).toBe(true);
    await waitFor(async () => commands.length, (n) => n === 1);
    expect(commands[0]).toEqual({ type: "run.cancel", runId });
    conn.stop();
  });

  it("answers request commands with a direct reply, not a journalled event", async () => {
    const journal = new Journal(path.join(mkdtempSync(path.join(tmpdir(), "bm-runner-")), "j.jsonl"));
    const conn: RunnerConnection = new RunnerConnection({
      url: ctx.url,
      token: ctx.reg.token,
      journal,
      runnerVersion: "test",
      heartbeatMs: HEARTBEAT,
      onCommand: (c) => {
        if (c.type === "workspace.diff") conn.reply(c.requestId, c.ticketId === "00000000-0000-4000-8000-000000000001" ? { ok: true, data: { files: [] } } : { ok: false, error: "no such workspace" });
      },
    });
    conn.start();
    await waitFor(async () => ctx.built.runners.isConnected(ctx.reg.runnerId), Boolean);
    const projectId = randomUUID();
    const ok = await ctx.built.runners.request(ctx.reg.runnerId, (requestId) => ({ type: "workspace.diff", requestId, projectId, ticketId: "00000000-0000-4000-8000-000000000001" }));
    expect(ok).toEqual({ files: [] });
    await expect(ctx.built.runners.request(ctx.reg.runnerId, (requestId) => ({ type: "workspace.diff", requestId, projectId, ticketId: randomUUID() }))).rejects.toThrow("no such workspace");
    expect(journal.lastSeq).toBe(0);
    conn.stop();
  });

  it("reconnects after the server goes quiet for three heartbeats", async () => {
    const { conn } = runner();
    conn.start();
    await waitFor(async () => conn.isLive, Boolean);
    // Freeze the server's side by pausing its socket: no pings or acks arrive.
    const sockets = [...(ctx.app.websocketServer?.clients ?? [])];
    expect(sockets).toHaveLength(1);
    sockets[0]!.pause();
    await waitFor(async () => conn.isLive, (live) => !live, 3000);
    await waitFor(async () => conn.isLive, Boolean, 5000);
    conn.stop();
  });
});

describe("runner env endpoint", () => {
  it("returns the company's granted secrets to its runner only, and logs the access", async () => {
    const setupCookie = await ctx.app.inject({ method: "POST", url: "/api/login", payload: { username: "leon", password: "correct horse battery" } });
    const cookie = `bm_session=${setupCookie.cookies.find((c) => c.name === "bm_session")!.value}`;
    const secret = (await ctx.app.inject({ method: "POST", url: "/api/secrets", headers: { cookie }, payload: { name: "token", kind: "claude_oauth_token", value: "sk-ant-oat01-abcdefghijklmnop" } })).json().secret.id;
    await ctx.app.inject({ method: "POST", url: `/api/secrets/${secret}/grants`, headers: { cookie }, payload: { companyId: ctx.companyId, envName: "CLAUDE_CODE_OAUTH_TOKEN" } });

    const runId = randomUUID();
    const ok = await ctx.app.inject({ method: "GET", url: `/api/runner/env?runId=${runId}`, headers: { authorization: `Bearer ${ctx.reg.token}` } });
    expect(ok.json()).toEqual({ env: { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-abcdefghijklmnop" } });
    expect(ok.headers["cache-control"]).toBe("no-store");
    const denied = await ctx.app.inject({ method: "GET", url: "/api/runner/env", headers: { authorization: "Bearer wrong" } });
    expect(denied.statusCode).toBe(401);
    const { secretAccessLog } = await import("../src/db/schema.js");
    const logRows = await ctx.db.select().from(secretAccessLog);
    expect(logRows).toEqual([expect.objectContaining({ companyId: ctx.companyId, runId, purpose: "run" })]);
  });
});
