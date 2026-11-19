// The workflow retro agent's tools and the Scrum Master's watchdog tools, moved out of mcp.ts unchanged
// (BOS-298 step 15). Registered in the same places and order as before, so each run sees the same tools.
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WatchdogError } from "./services/watchdog.js";
import { FindingsShape, ProposeShape, RetroError } from "./services/retro.js";
import { fail, text, type Scope } from "./mcp-common.js";
import type { Services } from "./mcp.js";

/** The workflow retro agent's tools (docs/19 parts 2 and 3): the company's configured retro agent only, and checked again on every call. */
export function registerRetro(server: McpServer, retro: Services["retro"], scope: Scope) {
  const guarded = (run: () => Promise<string>) => async () => {
    if (!scope.agentId || !(await retro.isRetroAgent(scope.companyId, scope.agentId))) return fail("Only the agent that runs this company's workflow retro can use this.");
    try {
      return text(await run());
    } catch (err) {
      if (err instanceof RetroError) return fail(err.message);
      if (err instanceof z.ZodError) return fail(err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
      throw err;
    }
  };
  const agentId = () => scope.agentId!;
  server.registerTool(
    "workflow_scorecard",
    { description: "Workflow retro only. The numbers for the retro's period against the one before (per role, handoffs, features waiting on their last tasks), digests of up to 10 of the worst tickets, and the workflow changes already proposed or applied. Start here.", inputSchema: {} },
    guarded(() => retro.scorecardText(scope.companyId)),
  );
  server.registerTool(
    "save_retro",
    {
      description: "Workflow retro only. Save what the retro found, once: findings ranked by how often they recur. Each has a failure label, the handoff where it went wrong (from and to roles, if it fits), the tickets it was seen on (references like HOL-12 or ids), how many tickets in all, and a note of up to 240 characters. Blame handoffs and patterns, never one agent on one ticket.",
      inputSchema: FindingsShape,
    },
    async (input) => guarded(async () => `Saved ${(await retro.save(scope.companyId, agentId(), input)).saved} findings.`)(),
  );
  server.registerTool(
    "propose_workflow_change",
    {
      description:
        "Workflow retro only. Propose one small change; at most 3 per retro, and only one live change per kind and target. It becomes a decision with Apply and Skip; nothing changes until it is answered. Needs evidence (at least 2 tickets), a metric it should move, and what you expect. lever and what target and change hold: playbook (CEO approves the nomination) target = a role, change = {name, description, body}, a skill for that role's agents; Apply sends it to the add-a-skill flow, where the Security Reviewer checks it and the owner decides before any agent gets it. lesson (CEO approves) target = a project name, change = {lesson}, one line for the project's brief. instructions (owner approves) target = an agent name, change = {instructions}, the whole new text. review_policy (owner) target = a risk tier, change = any of {planApprover, reviewer, ownerSignoff}. watchdog (owner) target = watchdog, change = any of the numeric watchdog limits; it is replayed over 14 days first. model (owner) target = an agent name, change = {model}. thinking (owner) target = an agent name, change = {thinking}. metric is one of firstPassRate, meanRework, medianCycleMs, costPerDoneMicros, watchdogFlags (scope: a role or an agent name; defaults to the target), medianWaitMs or bounceRate (scope: from and to roles, optional kind), tailLagMs (whole company).",
      inputSchema: ProposeShape,
    },
    async (input) =>
      guarded(async () => {
        const r = await retro.propose(scope.companyId, agentId(), input);
        return `Proposed as change ${r.changeId}. It is waiting for ${r.approver === "ceo" ? "the CEO" : "the owner"} (decision ${r.decisionId}); nothing changes until it is answered.`;
      })(),
  );
}

/** The Scrum Master's watchdog actions (BOS-58). Each needs a one-line reason, is logged and can be undone. */
export function registerWatchdog(server: McpServer, watchdog: Services["watchdog"], alerts: Services["alerts"], scope: Scope) {
  server.registerTool(
    "watchdog",
    {
      description:
        "Your only way to act on the problems the watchdog hands you. Every action needs reason: one line saying why. list: the open flags. nudge (ticketId): ask the assignee to pick it up or say why it's stuck. assign (ticketId, to): an unassigned ticket only, to the obvious colleague by name, or \"ceo\" if none is obvious. rewake (ticketId): wake the assignee again after their run crashed or ended without moving the ticket. chase_review (ticketId): wake the pending reviewers. snooze (flagId, hours up to 48): the flag is fine for now; a third snooze in a row is refused and the ticket goes to the CEO. escalate (ticketId): hand it to the CEO. raise_decision (ticketId, question, options, recommended, triedFirst, ownerMustDo, steps, and proof when the steps have host commands, checked like raise_decision's; write real values, since a {{host.…}} placeholder is not filled here and is refused): when only the owner can unblock it. Boss Man's own alerts come to you first: alerts lists yours. For a plain alert resolve_alert (alertId, optional rewake: true to wake the dropped agent again with a fresh chain) once you've dealt with it. Stalled-run alerts are also yours, even while the watchdog is switched off: resolve_alert with answer \"Keep waiting\" or \"Cancel run\" (add nudge: true to ask the agent why it is quiet), or pass_alert (alertId) when it needs the CEO. A review that keeps being woken without a verdict goes straight to the CEO, not you. Act only on the problems the watchdog handed you, each action at most once per problem until it is handed to you again. The owner can undo any of your actions. You can't do the work, change risk or priority, or close or cancel tickets. Actions are capped per hour; past the cap the watchdog pauses for an hour, the CEO is alerted, the owner is paged, and it resumes by itself.",
      inputSchema: {
        action: z.enum(["list", "nudge", "assign", "rewake", "chase_review", "snooze", "escalate", "raise_decision", "alerts", "resolve_alert", "pass_alert"]),
        alertId: z.string().uuid().optional(),
        rewake: z.boolean().optional(),
        answer: z.string().min(1).max(200).optional(),
        nudge: z.boolean().optional(),
        reason: z.string().max(400).optional(),
        ticketId: z.string().uuid().optional(),
        flagId: z.string().uuid().optional(),
        to: z.string().min(1).max(100).optional(),
        hours: z.number().positive().max(48).optional(),
        question: z.string().min(1).max(1000).optional(),
        options: z.array(z.string().min(1).max(200)).min(2).max(6).optional(),
        recommended: z.string().optional(),
        triedFirst: z.string().max(1000).optional(),
        ownerMustDo: z.boolean().optional(),
        steps: z.array(z.string().min(1).max(500)).max(12).optional(),
        stillNeeded: z.string().max(500).optional(),
        proof: z.string().max(300).optional(),
        // BOS-1660: with steps, the card opens with why and how long; Boss Man writes "Where" from the steps.
        why: z.string().max(240).optional().describe("With steps: one sentence on what the owner gets, or what breaks if they skip this."),
        minutes: z.number().int().min(1).max(480).optional().describe("With steps: a whole number of minutes the steps take the owner."),
      },
    },
    async (input) => {
      if (!scope.agentId) return fail("Only the Scrum Master's run can use the watchdog.");
      const { companyId, agentId, runId } = { companyId: scope.companyId, agentId: scope.agentId, runId: scope.runId };
      const need = <K extends keyof typeof input>(...keys: K[]) => {
        const missing = keys.filter((k) => input[k] === undefined);
        if (missing.length) throw new WatchdogError(422, `${input.action} needs ${missing.join(", ")}.`);
      };
      const reason = input.reason ?? "";
      const done = (a: { id: string }) => text(`Done and logged as action ${a.id}.`);
      try {
        switch (input.action) {
          case "list": {
            // Only flags the actions below accept: the owner's waits, escalated and already-actioned ones are left out.
            const open = await watchdog.actionableFlags(companyId, 50);
            return text(open.length ? JSON.stringify(open.map((f) => ({ flagId: f.id, ticketId: f.ticketId, title: f.ticketTitle, rule: f.rule, openedAt: f.openedAt, snoozedUntil: f.snoozedUntil, snoozeCount: f.snoozeCount, escalatedAt: f.escalatedAt, detail: f.detail }))) : "No open flags.");
          }
          case "nudge":
            need("ticketId");
            return done(await watchdog.nudge(companyId, agentId, runId, { ticketId: input.ticketId!, reason }));
          case "assign":
            need("ticketId", "to");
            return done(await watchdog.assign(companyId, agentId, runId, { ticketId: input.ticketId!, to: input.to!, reason }));
          case "rewake":
            need("ticketId");
            return done(await watchdog.rewake(companyId, agentId, runId, { ticketId: input.ticketId!, reason }));
          case "chase_review":
            need("ticketId");
            return done(await watchdog.chaseReview(companyId, agentId, runId, { ticketId: input.ticketId!, reason }));
          case "snooze":
            need("flagId", "hours");
            return done(await watchdog.snooze(companyId, agentId, runId, { flagId: input.flagId!, hours: input.hours!, reason }));
          case "escalate":
            need("ticketId");
            return done(await watchdog.escalate(companyId, agentId, runId, { ticketId: input.ticketId!, reason }));
          case "raise_decision":
            need("ticketId", "question", "options", "recommended", "triedFirst");
            return done(await watchdog.raiseDecision(companyId, agentId, runId, { ticketId: input.ticketId!, question: input.question!, options: input.options!, recommended: input.recommended!, triedFirst: input.triedFirst!, ownerMustDo: input.ownerMustDo, steps: input.steps, why: input.why, minutes: input.minutes, reason, stillNeeded: input.stillNeeded, proof: input.proof }));
          case "alerts": {
            const mine = await alerts.mine(companyId, agentId);
            return text(mine.length ? JSON.stringify(mine) : "No alerts are waiting for you.");
          }
          case "resolve_alert":
            need("alertId");
            await alerts.resolve(companyId, agentId, { alertId: input.alertId!, reason, rewake: input.rewake, answer: input.answer, nudge: input.nudge, runId });
            return text(`Settled and logged${input.rewake ? ", and the agent was woken again" : ""}.`);
          case "pass_alert": {
            need("alertId");
            const r = await alerts.pass(companyId, agentId, { alertId: input.alertId!, reason });
            return text(`Passed on: it's with ${r.to === "ceo" ? "the CEO" : "the owner"} now.`);
          }
        }
      } catch (err) {
        if (err instanceof WatchdogError) return fail(err.message);
        throw err;
      }
    },
  );
}
