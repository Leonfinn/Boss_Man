import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { activity, decisions, ticketDependencies, tickets } from "../src/db/schema.js";
import { CHECK_AGAIN, CHECK_SEND_BACK } from "../src/services/decisions.js";
import { issueRunToken } from "../src/mcp.js";

// Regression tests for the BOS-149 adversarial review, rounds 15/16 (BOS-186). All three pass with the fix.

let ctx: Awaited<ReturnType<typeof setup>> | undefined;
afterEach(async () => {
  ctx?.clients.forEach((c) => void c.close());
  await ctx?.app.close();
  await ctx?.close();
  ctx = undefined;
});

async function setup(opts: { repo?: boolean; hold?: boolean } = {}) {
  const held: Array<() => void> = [];
  const { db, close } = await openPglite();
  const built = await buildApp({
    db,
    master: { version: 1, key: randomBytes(32) },
    secureCookies: false,
    tickOnWake: false,
    limits: { quickBatchMs: 0 },
    workspaceRoot: "/ws",
  });
  await built.app.listen({ host: "127.0.0.1", port: 0 });
  const base = `127.0.0.1:${(built.app.server.address() as { port: number }).port}`;
  const s = await built.app.inject({
    method: "POST",
    url: "/api/setup",
    payload: { username: "leon", password: "correct horse battery" },
  });
  const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
  const req = (
    method: "GET" | "POST" | "PATCH",
    url: string,
    payload?: unknown,
  ) =>
    built.app.inject({
      method,
      url,
      headers: { cookie },
      ...(payload !== undefined ? { payload: payload as object } : {}),
    });
  const { company, ceo } = (
    await req("POST", "/api/companies", { name: "App Co" })
  ).json() as { company: { id: string }; ceo: { id: string } };
  const project = (
    await req("POST", `/api/companies/${company.id}/projects`, {
      name: "Customer app",
    })
  ).json() as { id: string };
  const worker = (
    await req("POST", `/api/companies/${company.id}/agents`, {
      name: "Engineer",
    })
  ).json() as { id: string };
  if (opts.repo) {
    await req("PATCH", `/api/projects/${project.id}`, {
      repoUrl: "https://github.com/Leonfinn/customer-app.git",
      verifyCommand: "pnpm test",
    });
    const reg = (
      await req("POST", `/api/companies/${company.id}/runner`)
    ).json() as { runnerId: string };
    built.runners.connect(reg.runnerId, (c) => {
      if (c.type === "workspace.diff")
        queueMicrotask(() =>
          built.runners.resolveReply({
            requestId: c.requestId,
            ok: true,
            data: {
              baseCommit: "a".repeat(40),
              head: "b".repeat(40),
              commits: [{ sha: "b".repeat(40), subject: "Add rate limiting" }],
              files: [{ path: "src/limit.ts", added: 1, removed: 0 }],
              diff: "+x",
              truncated: false,
            },
          }),
        );
      if (c.type === "workspace.verify") {
        const reply = () =>
          built.runners.resolveReply({
            requestId: c.requestId,
            ok: true,
            data: {
              ok: false,
              exitCode: 137,
              timedOut: false,
              output: "Killed",
              ms: 5000,
            },
          });
        if (opts.hold) held.push(reply);
        else queueMicrotask(reply);
      }
      return true;
    });
  }
  const clients: Client[] = [];
  const mcp = async (agentId: string) => {
    const token = await issueRunToken(db, {
      companyId: company.id,
      agentId,
      runId: randomUUID(),
    });
    const c = new Client({ name: "t", version: "0" });
    await c.connect(
      new StreamableHTTPClientTransport(new URL(`http://${base}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${token}` } },
      }),
    );
    clients.push(c);
    return c;
  };
  const ticket = async (title: string, body: Record<string, unknown> = {}) =>
    (
      await req("POST", `/api/projects/${project.id}/tickets`, {
        title,
        ...body,
      })
    ).json() as { id: string };
  return {
    ...built,
    db,
    close,
    req,
    company,
    ceo,
    worker,
    project,
    mcp,
    clients,
    ticket,
    held,
  };
}

const textOf = (r: unknown) =>
  (r as { content: Array<{ text: string }> }).content[0]?.text ?? "";
const isError = (r: unknown) => (r as { isError?: boolean }).isError === true;
const row = async (id: string) =>
  (await ctx!.db.select().from(decisions).where(eq(decisions.id, id)))[0]!;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
type C = Awaited<ReturnType<typeof setup>>;
const ceoCall = async (c: C, args: Record<string, unknown>) =>
  (await c.mcp(c.ceo.id)).callTool({ name: "decisions", arguments: args });
const mergeCard = (c: C, ticketId: string) =>
  c.db
    .insert(decisions)
    .values({
      companyId: c.company.id,
      kind: "question",
      question: "The merge check timed out",
      options: [CHECK_AGAIN, CHECK_SEND_BACK],
      recommendedOption: CHECK_AGAIN,
      tier: "owner",
      context: { type: "check_stuck", ticketId, command: "pnpm test", output: "timed out" },
    })
    .returning()
    .then((r) => r[0]!);
const openRows = (c: C) =>
  c.db.select().from(decisions).where(eq(decisions.status, "open"));

describe("BOS-149 round 15/16 regressions (BOS-186)", () => {
  it("1: withdrawing one of two identical question cards does not free the ticket while the other is open", async () => {
    const c = (ctx = await setup());
    const t = await c.ticket("Held by a question", {
      assigneeAgentId: c.worker.id,
    });
    const raise = () =>
      c.decisions.raise({
        companyId: c.company.id,
        agentId: c.worker.id,
        question: "Which provider should we use?",
        options: ["A", "B"],
        recommended: "A",
        blocksTicketId: t.id,
        triedFirst: "Read the docs.",
      });
    const a = await raise();
    // An identical open card on the same ticket (inserted directly: raise would dedupe it).
    const [b] = await c.db
      .insert(decisions)
      .values({
        companyId: c.company.id,
        raisedByAgentId: c.worker.id,
        kind: "question",
        question: a.question,
        options: ["A", "B"],
        recommendedOption: "A",
        tier: "owner",
        context: a.context as object,
      })
      .returning();
    const deps = () =>
      c.db
        .select()
        .from(ticketDependencies)
        .where(eq(ticketDependencies.blockedTicketId, t.id));
    expect((await deps()).length).toBeGreaterThan(0);
    const r = await ceoCall(c, {
      action: "withdraw",
      id: a.id,
      note: "This is a duplicate of the other identical card.",
      replacedBy: "none",
    });
    expect(isError(r), textOf(r)).toBe(false);
    expect((await row(a.id)).status).toBe("withdrawn");
    expect((await row(b!.id)).status).toBe("open");
    // The ticket must still be held: the surviving card is unanswered.
    const [now] = await c.db.select().from(tickets).where(eq(tickets.id, t.id));
    expect(now!.systemState).not.toBe("ready");
    expect((await deps()).length).toBeGreaterThan(0);
  });

  it("2: a refused 'Run the check again' is reported as refused, leaves the card open and raises no replacement", async () => {
    const c = (ctx = await setup());
    const t = await c.ticket("Needs sign-off");
    await c.work.updateTicket(t.id, { state: "review", overLimit: true });
    await c.db.insert(decisions).values({
      companyId: c.company.id,
      kind: "approval",
      question: "Sign off the release",
      options: ["Approve and merge", "Send it back"],
      recommendedOption: "Approve and merge",
      tier: "owner",
      context: { type: "risk_review", ticketId: t.id, reviewer: "the owner" },
    });
    const merge = await mergeCard(c, t.id);
    const before = (await openRows(c)).map((d) => d.id).sort();
    const r = await ceoCall(c, {
      action: "answer",
      id: merge.id,
      answer: CHECK_AGAIN,
      note: "Running the check again, it was killed.",
    });
    await wait(500);
    expect(textOf(r)).not.toMatch(/^Answered/);
    expect(isError(r), textOf(r)).toBe(true);
    expect((await row(merge.id)).status).toBe("open");
    expect((await openRows(c)).map((d) => d.id).sort()).toEqual(before);
  });

  // The CEO's settled-by record must not survive a retry that couldn't start (BOS-188).
  it("4: a reopened merge card drops the CEO's settled-by record when the owner answers", async () => {
    const c = (ctx = await setup());
    const t = await c.ticket("Needs sign-off", { assigneeAgentId: c.worker.id });
    await c.work.updateTicket(t.id, { state: "review", overLimit: true });
    await c.db.insert(decisions).values({
      companyId: c.company.id,
      kind: "approval",
      question: "Sign off the release",
      options: ["Approve and merge", "Send it back"],
      recommendedOption: "Approve and merge",
      tier: "owner",
      context: { type: "risk_review", ticketId: t.id, reviewer: "the owner" },
    });
    const merge = await mergeCard(c, t.id);
    // The open sign-off makes the landing refuse, so the CEO's answer leaves the card open again.
    const refused = await ceoCall(c, {
      action: "answer",
      id: merge.id,
      answer: CHECK_AGAIN,
      note: "Running the check again.",
    });
    expect(isError(refused), textOf(refused)).toBe(true);
    const reopened = await row(merge.id);
    expect(reopened.status).toBe("open");
    expect(reopened.context).not.toHaveProperty("settled");

    // The owner answers the reopened card from the UI.
    expect(await c.decisions.answer(merge.id, CHECK_SEND_BACK)).not.toBeNull();
    const after = await row(merge.id);
    expect(after.status).toBe("answered");
    expect(after.answer).toBe(CHECK_SEND_BACK);
    expect(after.context).not.toHaveProperty("settled");
    const logged = (
      await c.db
        .select()
        .from(activity)
        .where(and(eq(activity.kind, "decision_answered"), eq(activity.companyId, c.company.id)))
    )[0]!;
    expect(logged.summary).toContain("Owner answered");
    expect(logged.summary).not.toMatch(/settled/i);
  });

  // The CEO pages the queue with offset, so the oldest stale cards stay reachable.
  it("3: the CEO can reach the oldest card in a queue of more than 20", async () => {
    const c = (ctx = await setup());
    const done = await c.ticket("Finished long ago");
    await c.work.updateTicket(done.id, { state: "done", overLimit: true, outcome: "completed" });
    const oldest = await c.decisions.raise({
      companyId: c.company.id,
      agentId: c.worker.id,
      question: "Old stale question",
      options: ["A", "B"],
      recommended: "A",
      blocksTicketId: done.id,
      triedFirst: "Looked.",
    });
    await c.db
      .update(decisions)
      .set({ createdAt: new Date(Date.now() - 10 * 86_400_000) })
      .where(eq(decisions.id, oldest.id));
    for (let i = 0; i < 25; i++) {
      const t = await c.ticket(`Live ${i}`);
      await c.decisions.raise({
        companyId: c.company.id,
        agentId: c.worker.id,
        question: `Fresh question ${i}`,
        options: ["A", "B"],
        recommended: "A",
        blocksTicketId: t.id,
        triedFirst: "Looked.",
      });
    }
    const first = textOf(await ceoCall(c, { action: "list" }));
    const next = textOf(await ceoCall(c, { action: "list", offset: 20 }));
    expect(first.includes(oldest.id) || next.includes(oldest.id)).toBe(true);
  });
});
