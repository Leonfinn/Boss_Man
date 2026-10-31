// BOS-243 rule 1: every code path that writes a decision card is classified for phone Approve. Only an
// agent's own plain raise_decision with an approveSummary is eligible. The guard at the bottom fails when a
// writer is added or removed anywhere in src/, so a new one has to be classified here first.
import { randomBytes, randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { decisions, runners, ticketDependencies } from "../src/db/schema.js";
import { raiseMergeStuck, raiseOwnerTodo } from "../src/services/decisions.js";
// decisions.ts keeps its permission option private.
const ALLOW = "Allow once";
import { phoneApprovable } from "../src/services/phone-approve.js";

let ctx: { close: () => Promise<void> } | undefined;
afterEach(async () => {
  await ctx?.close();
  ctx = undefined;
});

async function setup() {
  const { db, close } = await openPglite();
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false });
  ctx = { close: async () => (await built.app.close(), await close()) };
  const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
  const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
  const req = (method: "GET" | "POST", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const { company, ceo } = (await req("POST", "/api/companies", { name: "App Co" })).json();
  const worker = (await req("POST", `/api/companies/${company.id}/agents`, { name: "Engineer" })).json();
  const project = (await req("POST", `/api/companies/${company.id}/projects`, { name: "Web" })).json();
  const ticket = (await req("POST", `/api/projects/${project.id}/tickets`, { title: "Website" })).json();
  return { ...built, db, req, company, ceo, worker, ticket };
}

type Row = typeof decisions.$inferSelect;
/** Eligible as written, and whether it would still be refused even if it carried an approveSummary. */
async function classify(db: Awaited<ReturnType<typeof setup>>["db"], id: string) {
  const [d] = await db.select().from(decisions).where(eq(decisions.id, id));
  const blocker = (await db.select().from(ticketDependencies).where(eq(ticketDependencies.blockerDecisionId, id))).length > 0;
  const withSummary: Row = { ...d!, context: { ...(d!.context as object), approveSummary: "Do the recommended thing" } };
  return { eligible: phoneApprovable(d!, blocker), evenWithSummary: phoneApprovable(withSummary, blocker) };
}

describe("rule 1: every writer of a decision card is classified", () => {
  it("raise_decision: eligible only as a plain question with a summary", async () => {
    const c = await setup();
    const base = { companyId: c.company.id, agentId: c.worker.id, options: ["Yes", "No"], recommended: "Yes", triedFirst: "Tried it myself first." };
    const cases: Array<[string, Partial<Parameters<typeof c.decisions.raise>[0]>, boolean]> = [
      ["plain with summary", { approveSummary: "Do it" }, true],
      ["plain without summary", {}, false],
      ["blocks a ticket", { approveSummary: "Do it", blocksTicketId: c.ticket.id }, false],
      ["steps", { approveSummary: "Do it", steps: ["Click"] }, false],
      ["ownerMustDo", { approveSummary: "Do it", ownerMustDo: true, steps: ["Click"] }, false],
      ["stillNeeded", { approveSummary: "Do it", stillNeeded: "The price changed." }, false],
      ["no agent (Boss Man's own notices in app.ts)", { approveSummary: "Do it", agentId: null }, false],
    ];
    for (const [name, extra, eligible] of cases) {
      const d = await c.decisions.raise({ ...base, question: name, ...extra });
      expect([name, (await classify(c.db, d.id)).eligible]).toEqual([name, eligible]);
    }
  });

  it("the Scrum Master's raise_decision always blocks its ticket", async () => {
    const c = await setup();
    const d = await c.decisions.raise({ companyId: c.company.id, agentId: c.worker.id, question: "SM ask", options: ["Yes", "No"], recommended: "Yes", blocksTicketId: c.ticket.id, approveSummary: "Do it" });
    expect(await classify(c.db, d.id)).toEqual({ eligible: false, evenWithSummary: false });
  });

  it("owner to-dos, merge-stuck cards, CEO reissues, undelivered permissions and alerts never are, even with a summary", async () => {
    const c = await setup();
    const todo = await raiseOwnerTodo(c.db, { companyId: c.company.id, question: "Apply it", key: `todo:${randomUUID()}`, steps: ["Do it"], ofDecisionId: randomUUID(), raisedByAgentId: c.worker.id });
    expect((await c.db.select().from(decisions).where(eq(decisions.id, todo!.id)))[0]!.context).toMatchObject({ ownerMustDo: true });
    const [stuck] = await raiseMergeStuck(c.db, { id: c.ticket.id, title: "Website", companyId: c.company.id }, "timed out");

    const orig = await c.decisions.raise({ companyId: c.company.id, agentId: c.worker.id, question: "Unclear?", options: ["Yes", "No"], recommended: "Yes", approveSummary: "Do it" });
    await c.req("POST", `/api/decisions/${orig.id}/ask-advice`, {});
    const re = await c.decisions.advise({ id: orig.id, companyId: c.company.id, agentId: c.ceo.id, outcome: "reissue", question: "Clearer?", options: ["Yes", "No"], recommended: "Yes", triedFirst: "The CEO looked into it." });

    // A permission answered while its runner is offline leaves a "couldn't reach the runner" notice.
    const [runner] = await c.db.insert(runners).values({ companyId: c.company.id, tokenHash: randomUUID() }).returning();
    const [perm] = await c.db.insert(decisions).values({ companyId: c.company.id, kind: "permission", question: "Run rm?", options: [ALLOW, "Deny"], recommendedOption: ALLOW, raisedByAgentId: c.worker.id, context: { type: "permission", runnerId: runner!.id, runId: randomUUID(), requestId: "q1" } }).returning();
    await c.decisions.answer(perm!.id, ALLOW);
    const [undelivered] = await c.db.select().from(decisions).where(eq(decisions.dedupeKey, `undelivered:${perm!.id}`));

    const alert = await c.alerts.raise({ companyId: c.company.id, question: "Something is stuck", raisedByAgentId: c.worker.id } as Parameters<typeof c.alerts.raise>[0]);

    for (const [name, id] of [
      ["owner to-do", todo!.id],
      ["merge stuck", stuck!.id],
      ["CEO reissue (carries advice)", re!.id],
      ["the original after reissue", orig.id],
      ["undelivered permission notice", undelivered!.id],
      ["permission", perm!.id],
      ["alert ladder", (alert as { id: string }).id],
    ] as const) {
      expect([name, await classify(c.db, id)]).toEqual([name, { eligible: false, evenWithSummary: false }]);
    }
  });
});

/**
 * Every place in src/ that writes a decision card, and why it can't be phone-approved. Counts are per
 * file and per pattern; a change means a writer was added or removed and must be classified here.
 * Beyond the reason given, none of them stores an approveSummary (checked below), which rule 1 needs.
 */
const WRITERS: Record<string, { counts: Record<string, number>; why: string }> = {
  "src/app.ts": { counts: { raise: 8 }, why: "alerts.raise (tier ceo, ladder) and decisionsSvc.raise with agentId null (merge failed, import checklist)" },
  "src/mcp.ts": { counts: { raise: 1 }, why: "raise_decision: the one eligible path, when plain and with an approveSummary" },
  "src/services/watchdog.ts": { counts: { raise: 1 }, why: "the Scrum Master's raise_decision always blocks its ticket (ticketId, blocker)" },
  "src/services/agents.ts": { counts: { insert: 4 }, why: "kind approval: hire, model_change, instructions, team_plan" },
  "src/services/alert-ladder.ts": { counts: { insert: 1 }, why: "tier ceo with a ladder key" },
  "src/services/decisions.ts": {
    counts: { insert: 11, question: 7, todo: 2 },
    why: "merge-stuck (check_stuck, no agent), owner to-do (owner_todo, ownerMustDo), lesson_replace x2 (tier ceo), permission/plan rows (kind permission/approval), raise() (eligible case), skill (kind skill), CEO reissue (advice), undelivered permission (no agent)",
  },
  "src/services/deploys.ts": { counts: { insert: 1 }, why: "kind approval: deploy" },
  "src/services/disk.ts": { counts: { insert: 1, question: 1 }, why: "no raising agent, one option" },
  "src/services/engagements.ts": { counts: { insert: 1 }, why: "kind engagement" },
  "src/services/goal-check.ts": { counts: { insert: 1 }, why: "kind approval: goal_check" },
  "src/services/loop-guards.ts": { counts: { insert: 2, question: 1 }, why: "no raising agent, one option" },
  "src/services/maintenance.ts": { counts: { insert: 1 }, why: "kind approval: maintenance" },
  "src/services/policy-rules.ts": { counts: { insert: 1, question: 1 }, why: "type rule_proposal" },
  "src/services/retro.ts": { counts: { insert: 3, question: 1 }, why: "type lesson (and approvals: workflow_change, workflow_check)" },
  "src/services/review.ts": { counts: { insert: 3, question: 2 }, why: "check_stuck (no agent), lesson (tier ceo), risk_review (kind approval)" },
  "src/services/runners.ts": { counts: { insert: 1 }, why: "kind budget" },
  "src/services/scheduler.ts": { counts: { insert: 3 }, why: "kind budget: budget_limit, project_cap, ticket_cap" },
  "src/services/self-deploy.ts": { counts: { insert: 1 }, why: "kind approval: self_deploy" },
  "src/services/sweeps.ts": { counts: { insert: 2, question: 3 }, why: "stale_blocker kind; missed-nudge and review-stall go through alerts (tier ceo, ladder); gave-up notice has no agent and one option" },
};
const PATTERNS: Record<string, RegExp> = { insert: /insert\(decisions\w*\)/g, question: /kind: "question"/g, raise: /\.raise\(/g, todo: /raiseOwnerTodo\(/g };

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? sources(join(dir, e.name)) : e.name.endsWith(".ts") ? [join(dir, e.name)] : []));
}

describe("rule 1: the writers guard", () => {
  it("fails when a decision writer is added or removed without being classified", () => {
    const found: Record<string, Record<string, number>> = {};
    for (const f of sources("src")) {
      const text = readFileSync(f, "utf8");
      const counts: Record<string, number> = {};
      for (const [k, p] of Object.entries(PATTERNS)) {
        const n = text.match(p)?.length ?? 0;
        if (n) counts[k] = n;
      }
      if (Object.keys(counts).length) found[f.replace(/\\/g, "/")] = counts;
    }
    expect(found).toEqual(Object.fromEntries(Object.entries(WRITERS).map(([f, w]) => [f, w.counts])));
  });

  it("only raise() ever stores an approveSummary", () => {
    const holders = sources("src").filter((f) => readFileSync(f, "utf8").includes("approveSummary")).map((f) => f.replace(/\\/g, "/")).sort();
    expect(holders).toEqual(["src/mcp.ts", "src/services/decisions.ts", "src/services/phone-approve.ts"]);
    const text = readFileSync("src/services/decisions.ts", "utf8");
    const start = text.indexOf("    async raise(input:");
    const end = text.indexOf("\n    },\n", start);
    const outside = (text.slice(0, start) + text.slice(end)).match(/approveSummary/g) ?? [];
    // The only mention outside raise() is the context type's field.
    expect(outside).toHaveLength(1);
  });
});
