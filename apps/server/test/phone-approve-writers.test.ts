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
    // raise() keeps ordering links only to open cards in the same company (BOS-625), so link to a real one.
    const other = await c.decisions.raise({ ...base, question: "The card to do first" });
    const cases: Array<[string, Partial<Parameters<typeof c.decisions.raise>[0]>, boolean]> = [
      ["plain with summary", { approveSummary: "Do it" }, true],
      ["plain without summary", {}, false],
      ["blocks a ticket", { approveSummary: "Do it", blocksTicketId: c.ticket.id }, false],
      ["steps", { approveSummary: "Do it", steps: ["Click"] }, false],
      ["ownerMustDo", { approveSummary: "Do it", ownerMustDo: true, steps: ["Click"] }, false],
      ["stillNeeded", { approveSummary: "Do it", stillNeeded: "The price changed." }, false],
      ["sets up an add-on (BOS-522, closes itself)", { approveSummary: "Do it", setsUp: "ntfy" }, false],
      ["a plan (BOS-531 submit_plan)", { approveSummary: "Do it", plan: "Step 1" }, false],
      // BOS-551 ordering: "do after" another card must not be skipped by a lock-screen tap; "do before"
      // and "resets on restart" only order other cards around this one.
      ["do after another card (BOS-551)", { approveSummary: "Do it", doAfter: [{ decisionId: other.id, label: "Update first" }] }, false],
      ["do before another card (BOS-551)", { approveSummary: "Do it", doBefore: [{ decisionId: other.id, label: "Then this" }] }, true],
      ["resets on restart (BOS-551)", { approveSummary: "Do it", resetsOnRestart: true }, true],
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
  "src/app.ts": { counts: { raise: 20 }, why: "alerts.raise (tier ceo, ladder; the landing-turn-late alert hook (BOS-2359, no raising agent, one option); the daily-backup stale-alert hook (BOS-2176, no raising agent, one option);the cost sanity check's cost_out_of_band alert hook, BOS-1866, no raising agent, one option;the GitHub watcher's one-card-per-failure alert hook, BOS-1393; incl. the second-refusal account_limit card (BOS-1438), the owner-replies hook, BOS-425, the watchdog's alertCeo hook, the server-health hook, the OpenCode VACUUM alert, BOS-595's feature_no_ticket card, the runner watch's runner-offline alert and the deploy-tag alert hook, DR-033, the merge-failure repeat alert, BOS-1461, one option) and decisionsSvc.raise with agentId null (import checklist; the sign-off merge-failed card moved to startLanding)" },
  "src/services/daily-backup.ts": { counts: { raise: 1 }, why: "deps.raise is app.ts's alerts.raise: the daily-backup stale alert (BOS-2176), no raising agent, one option" },
  "src/services/server-health.ts": { counts: { raise: 1 }, why: "deps.raise is app.ts's alerts.raise: alert kinds server_memory / server_freezes, ladder key, no raising agent" },
  "src/mcp.ts": { counts: { raise: 2 }, why: "raise_decision: the one eligible path, when plain and with an approveSummary; submit_plan (BOS-531: blocksTicketId and plan, never eligible)" },
  "src/services/watchdog.ts": { counts: { raise: 1 }, why: "the Scrum Master's raise_decision always blocks its ticket (ticketId, blocker)" },
  "src/services/agents.ts": { counts: { insert: 6 }, why: "kind approval: hire, model_change, instructions, team_plan, rename, standing_rules (CEO rules change)" },
  "src/services/alert-ladder.ts": { counts: { insert: 1 }, why: "tier ceo with a ladder key" },
  "src/services/ci-identity-card.ts": { counts: { todo: 1 }, why: "the second-account token card (BOS-2285): an owner to-do (type owner_todo, steps, ownerMustDo, no raising agent), once per company" },
  "src/services/decisions.ts": {
    counts: { insert: 14, question: 10, todo: 2 },
    why: "owner hand-back (kind question, tier ceo, no raising agent: a CEO card, closes with ticket or reply), merge-stuck (check_stuck, no agent), owner to-do (owner_todo, ownerMustDo), owner setup (type owner_setup, ticketId, no agent, one option), owner setup fix (DR-052: tier ceo, no agent, one option), lesson_replace x2 (tier ceo), permission/plan rows (kind permission/approval), raise() (eligible case), skill (kind skill), CEO reissue (advice), undelivered permission (no agent)",
  },
  "src/services/deploy-wait.ts": { counts: { insert: 1 }, why: "kind approval: deploy_wait (the 30-minute card: keep waiting, update now, cancel; no raising agent, no approveSummary)" },
  "src/services/deploys.ts": { counts: { insert: 1 }, why: "kind approval: deploy" },
  "src/services/disk.ts": { counts: { insert: 2, question: 2 }, why: "no raising agent, one option (disk cap card and low host disk card, BOS-2182)" },
  "src/services/engagements.ts": { counts: { insert: 1 }, why: "kind engagement" },
  "src/services/feature-portal.ts": { counts: { insert: 1, question: 1 }, why: "type feature_portal_hold (BOS-1358): no raising agent, one card per held-off feature, owner-only answer (Keep off the portal / Publish)" },
  "src/services/fence-default.ts": { counts: { insert: 3, question: 3 }, why: "types fence_default (BOS-940), fence_unavailable (BOS-373) and guard_unavailable (BOS-938): no raising agent, owner-only answer" },
  "src/services/goal-check.ts": { counts: { insert: 1 }, why: "kind approval: goal_check" },
  "src/services/loop-guards.ts": { counts: { insert: 3, question: 2 }, why: "no raising agent, one option (repeated-failure and account-outage notices)" },
  "src/services/maintenance.ts": { counts: { insert: 1 }, why: "kind approval: maintenance" },
  "src/services/policy-rules.ts": { counts: { insert: 1, question: 1 }, why: "type rule_proposal" },
  "src/services/retro.ts": { counts: { insert: 3, question: 1 }, why: "type lesson (and approvals: workflow_change, workflow_check)" },
  "src/services/review-rounds.ts": { counts: { insert: 1, question: 1 }, why: "lesson (tier ceo; submit, moved from review.ts, BOS-1904)" },
  "src/services/review-common.ts": { counts: { insert: 1, question: 1 }, why: "check_stuck (no agent; raiseCheckStuck, moved from review.ts, BOS-1901)" },
  "src/services/review-ctx.ts": { counts: { insert: 1, question: 1 }, why: "carried (type carried, ticketId, blocker, one option; refuseCarried, moved from review.ts, BOS-1901)" },
  "src/services/signoff.ts": { counts: { insert: 1 }, why: "kind approval: risk_review (moved here from review.ts)" },
  "src/services/runners.ts": { counts: { insert: 1 }, why: "kind budget" },
  "src/services/scheduler.ts": { counts: { insert: 4, question: 1 }, why: "kind budget: budget_limit, project_cap, ticket_cap; unblocked-but-unassigned notice (no raising agent, one option)" },
  "src/services/self-deploy.ts": { counts: { insert: 1, todo: 2 }, why: "kind approval: self_deploy; the changed database/proxy settings card (BOS-487) and the deployer-script-behind card (BOS-990) are owner to-dos (type owner_todo, steps, ownerMustDo)" },
  "src/services/sweeps.ts": { counts: { insert: 2, question: 1 }, why: "stale_blocker kind (tier ceo); released-unblocked catch-up notice (tier ceo, no raising agent). The gave-up and CEO-plan deadline-passed cards now go through the alert ladder (BOS-1015: tier ceo, ladder key)" },
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
