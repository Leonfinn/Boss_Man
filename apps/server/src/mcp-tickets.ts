// The ticket tools, moved out of mcp.ts unchanged (BOS-298 step 15): create_ticket, update_ticket,
// assign_ticket, set_ticket_state, set_ticket_risk, schedule_check and clear_check. Registered from the
// same places and in the same order as before, so every kind of run sees the same tools.
import { and, asc, eq, gt, isNull, ne, or, sql } from "drizzle-orm";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { goLiveWaitWords, type GoLiveWait, acceptanceCriteriaSchema, BLOCKED_UNTIL_MAX_DAYS, BLOCKED_UNTIL_MAX_MS, BLOCKED_UNTIL_REASON_MAX, criteriaText, failedAfterMerge, isAfterMerge, isTaskSize, missingVerdicts, planFirstByDefault, RISK_TIERS, SIZE_SCALE, unreportedAfterMerge } from "@boss-man/shared";
import type { Db } from "./db/client.js";
import { agents, decisions as decisionsTable, engagements as engagementsTable, features, projects, runs as runsTable, ticketDependencies, tickets, workflowColumns } from "./db/schema.js";
import { record } from "./services/activity.js";
import { FIXES_LIVE_MAX, fixesLiveProblem, ownerSetupFixKey } from "./services/decisions.js";
import { HOST_TOKEN_HELP, type OwnerSetupFacts, ownerSetupFacts, ownerSetupWriteCheck } from "./services/owner-setup-check.js";
import { loadCompanyFacts } from "./services/company-facts.js";
import { splitSteps } from "./services/runner-image.js";
import { EngagementError } from "./services/engagements.js";
import { FOLLOW_UP_HELP, followUpsSchema, handOffRefusal, openFollowUps, resolveFollowUpAssignees } from "./services/hand-offs.js";
import { getHold, WRAP_UP } from "./services/maintenance.js";
import { NOTHING_CHANGED } from "./services/review.js";
import { reviewTicketWriteRefusal } from "./services/skill-proposals.js";
import { wipQueuedNote } from "./services/agent-wip.js";
import { moveTicket } from "./services/ticket-moves.js";
import { addTicketDependency } from "./services/ticket-links.js";
import { systemMoveTicket } from "./services/ticket-transition.js";
import { staleVersionMessage, startRefusal, WorkError } from "./services/work.js";
import { criteriaWarning, delegateTarget, findProject, fail, FINISHED_STAYS_IN_REVIEW, FIXES_LIVE_HELP, FIXES_MERGE_CHECK_HELP, managerIn, REF, STATES, waitsOnAdvice, text, thinTicketWarning, treeRefusal, type Scope } from "./mcp-common.js";
import type { McpHooks, Services } from "./mcp.js";

/** The state note after update_ticket replaces the criteria: the old note's verdicts belong to the old list, so none carries over. */
const CRITERIA_REPLACED_NOTE = "The CEO replaced this ticket's acceptance criteria. Report each one again.";

// A run that had no ticket now works on one: say so on the run (BOS-254). Never blocks the tool.
const runTicketNoter = (scope: Scope, hooks: McpHooks) => (ticketId: string) => (scope.agentId ? Promise.resolve(hooks.onRunTicket?.(ticketId, scope.runId)).catch(() => undefined) : undefined);

/** The words every ownerSetup field adds to its help (DR-052). */
const SETUP_HELP = `${HOST_TOKEN_HELP} Each step is checked like an owner card when you write it; a vague host step (".env" with no path, "restart the add-on" with no command or button path) is refused. lintOverride (CEO only) lets a wrong finding through with a reason.`;
const LINT_OVERRIDE = z.string().max(500).optional().describe("CEO only: the reason, for the owner, to let ownerSetup past a card-check finding you judge wrong. It can't let through a command that isn't copy-safe or a value Boss Man doesn't have.");

/**
 * DR-052 point 1: the card check on a ticket's owner setup steps, as they are written. Blank steps (none) pass.
 * Returns the refusal, or the CEO override to store with the steps (null when none was needed).
 */
async function checkSetupWrite(db: Db, hostFacts: Services["hostFacts"] | undefined, scope: Scope, ownerSetup: string | null | undefined, lintOverride: string | undefined) {
  const [me] = scope.agentId ? await db.select({ role: agents.role }).from(agents).where(eq(agents.id, scope.agentId)) : [];
  const steps = splitSteps(ownerSetup ?? "");
  return ownerSetupWriteCheck(steps, await setupFacts(db, hostFacts, scope.companyId, steps), { lintOverride, byCeo: me?.role === "ceo" });
}

/** Host facts (DR-052) and other companies' records (DR-057) for a write-time setup check. */
async function setupFacts(db: Db, hostFacts: Services["hostFacts"] | undefined, companyId: string, steps: string[]): Promise<OwnerSetupFacts> {
  if (!steps.length) return {};
  const company = await loadCompanyFacts(db, companyId, steps);
  return { ...(hostFacts ? await ownerSetupFacts(hostFacts) : {}), ...(company ? { company } : {}) };
}

/** Whether the caller is the CEO and Boss Man's card to fix this live ticket's setup steps is open (DR-052). */
async function openSetupFixFor(db: Db, scope: Scope, ticketId: string) {
  const [me] = scope.agentId ? await db.select({ role: agents.role }).from(agents).where(eq(agents.id, scope.agentId)) : [];
  if (me?.role !== "ceo") return false;
  const [card] = await db.select({ id: decisionsTable.id }).from(decisionsTable).where(and(eq(decisionsTable.companyId, scope.companyId), eq(decisionsTable.status, "open"), eq(decisionsTable.dedupeKey, ownerSetupFixKey(ticketId))));
  return !!card;
}

/** assign_ticket, set_ticket_risk and create_ticket for a run. */
export function registerTicketAdmin(server: McpServer, db: Db, { work, engagements, feedback, hostFacts }: Pick<Services, "work" | "engagements" | "feedback"> & Partial<Pick<Services, "hostFacts">>, scope: Scope) {
  const resolveProject = (project?: string) => findProject(db, scope, project);
  const outsideTree = (ticketId: string | undefined) => treeRefusal(db, scope, ticketId);
  const isManager = () => managerIn(db, scope);

  server.registerTool(
    "assign_ticket",
    {
      description:
        "For CEOs and managers: hand one of your company's tickets to a colleague by name (ticketId, agent, note up to 240 characters saying why and what you expect). The colleague is woken to work on it and reads your note on the ticket. Pass expected_version (the ticket's version as you last saw it) so the move is refused if the ticket has changed since. In a project with a repo, a ticket becomes done by review and merge; the CEO or a manager can also set done on one with no changes of its own, when its change shipped on another ticket (name that ticket in the summary).",
      inputSchema: { ticketId: z.string().uuid(), agent: z.string().min(1), note: z.string().min(1).max(240), expected_version: z.number().int().optional() },
    },
    async ({ ticketId, agent, note, expected_version }) => {
      const out = await outsideTree(ticketId);
      if (out) return fail(out);
      const reviewWrite = await reviewTicketWriteRefusal(db, scope.companyId, ticketId, scope.agentId);
      if (reviewWrite) return fail(reviewWrite);
      const to = await delegateTarget(db, scope, agent);
      if ("error" in to) return fail(to.error);
      const [t] = await db.select({ version: tickets.version, state: tickets.systemState, assignee: tickets.assigneeAgentId }).from(tickets).where(and(eq(tickets.id, ticketId), eq(tickets.companyId, scope.companyId)));
      if (!t) return fail("No ticket with that ID in your company.");
      // An early answer only: updateTicket checks the version again inside the write (BOS-897).
      if (expected_version !== undefined && t.version !== expected_version) return fail(await staleVersionMessage(db, scope.companyId, ticketId, expected_version));
      if (t.assignee === to.id) return fail(`That ticket is already assigned to ${agent}.`);
      try {
        const u = await work.updateTicket(ticketId, { assigneeAgentId: to.id, stateNote: note.trim(), byAgentId: scope.agentId, expectedVersion: expected_version });
        return text(`Ticket ${ticketId} is now assigned to ${agent} (version ${u.version}); they are woken with your note.${await wipQueuedNote(db, ticketId)}`);
      } catch (err) {
        if (err instanceof WorkError) return fail(err.message);
        throw err;
      }
    },
  );

  server.registerTool(
    "set_ticket_risk",
    {
      description:
        "For CEOs and managers: rate the risk of one of your company's tickets (ticketId, risk: trivial, low, medium, high or critical, reason up to 240 characters). Rate unrated tickets when you review them. You can raise a rating but not lower one that is set; only the owner can. High and critical work is reviewed by the owner and planned first. The owner sees your rating and reason on the ticket.",
      inputSchema: { ticketId: z.string().uuid(), risk: z.enum(RISK_TIERS), reason: z.string().min(1).max(240) },
    },
    async ({ ticketId, risk, reason }) => {
      if (!(await isManager())) return fail("Only your company's CEO or a manager can rate a ticket's risk.");
      const [t] = await db.select({ risk: tickets.risk }).from(tickets).where(and(eq(tickets.id, ticketId), eq(tickets.companyId, scope.companyId)));
      if (!t) return fail("No ticket with that ID in your company.");
      if (t.risk && RISK_TIERS.indexOf(risk) < RISK_TIERS.indexOf(t.risk)) return fail(`Nothing changed: it is already rated ${t.risk}, and only the owner can lower a rating. Keep ${t.risk} or raise it.`);
      if (t.risk === risk) return text(`Ticket ${ticketId} is already rated ${risk}.`);
      try {
        // updateTicket also sets planFirst for tasks that haven't started.
        const u = await work.updateTicket(ticketId, { risk });
        const [me] = scope.agentId ? await db.select({ name: agents.name }).from(agents).where(eq(agents.id, scope.agentId)) : [];
        await record(db, { companyId: scope.companyId, agentId: scope.agentId, ticketId, kind: "risk", summary: `${me?.name ?? "An agent"} rated it ${risk}: ${reason.trim()}` });
        return text(`Ticket ${ticketId} is now rated ${risk} (version ${u.version}).`);
      } catch (err) {
        if (err instanceof WorkError) return fail(err.message);
        throw err;
      }
    },
  );

  server.registerTool(
    "create_ticket",
    {
      description:
        "Create a ticket in your company's backlog. Use it to record work you or your team should do. CEOs and managers can pass assignee (an agent's name) to hand it straight to that colleague, who is woken to work on it. Give the project by name when your company has more than one. Pass engagementId when the ticket does work another company engaged you for. Pass feature (a feature's id or exact title) when the task delivers a feature request. Pass waitsOn (a task's id) to make this task wait until that one is merged (or done, with waitsOnUntil done), such as a QA task waiting on its build task: it starts, and its assignee is woken, when that point is reached. You can add or remove a wait later with update_ticket waitsOn. Set noCode to true for research, wiki, docs or deploy-only work that changes nothing in the repository; a ticket without it can't go to review until the repository has changed. Pass parent (a task's id) to make this a sub-task: use one when you need help from a colleague (say, a developer needing infra input) without handing over your own task. The parent waits on it and is woken when it is done; a sub-task can't have sub-tasks, and it joins the parent's feature and project. Rate its risk: trivial, low, medium (the default), high or critical; high and critical work is reviewed by the owner, gets the project's deeper check and goes to staging before production. High and critical tickets are planned and approved before anything changes unless you set planFirst to false; set it to true for other work that needs that. Size is required: 1, 2, 3, 5 or 8, relative to the tickets your team has finished. Size by comparison with the reference tickets sizing_guide gives you (\"like BOS-42, which was a 3\"), not by guessing hours. Developers don't change a size once it is set.",
      inputSchema: {
        title: z.string().min(1).max(200),
        body: z.string().max(10_000).optional(),
        project: z.string().optional(),
        // Checked in the handler so the refusal can name the scale and point at sizing_guide.
        size: z.number().optional().describe("Required. 1, 2, 3, 5 or 8. Call sizing_guide first and compare."),
        engagementId: z.string().uuid().optional(),
        risk: z.enum(RISK_TIERS).optional(),
        planFirst: z.boolean().optional(),
        featureId: z.string().uuid().optional(),
        feature: z.string().optional(),
        parent: z.string().uuid().optional(),
        assignee: z.string().optional(),
        waitsOn: z.string().uuid().optional(),
        waitsOnUntil: z.enum(["merged", "done"]).optional().describe("With waitsOn: when the wait ends, the other ticket's merge on main (merged, the default) or its done state (done)."),
        acceptanceCriteria: acceptanceCriteriaSchema.optional(),
        noCode: z.boolean().optional().describe("true for research, wiki, docs or deploy-only work that changes nothing in the repository; such a ticket can reach review and be closed with an empty diff. Leave it off for anything that changes code."),
        ownerSetup: z.string().max(4000).optional().describe(`What the owner has to do once this change is live (a setting, a secret, a button), in plain words by button path, one step per line, e.g. Settings → Funding → Add funding source. Boss Man raises their card with these steps only when the change goes live, not at merge. Leave it off when there is nothing for them to do. ${SETUP_HELP}`),
        lintOverride: LINT_OVERRIDE,
        fixesLive: z.string().max(FIXES_LIVE_MAX).optional().describe(FIXES_LIVE_HELP),
      },
    },
    async ({ title, body, project, size, engagementId, risk, planFirst, feature, parent, assignee, waitsOn, waitsOnUntil, acceptanceCriteria, noCode, ownerSetup, lintOverride, fixesLive, ...rest }) => {
      const badFix = fixesLive ? fixesLiveProblem(fixesLive) : null;
      if (badFix) return fail(badFix);
      const setup = await checkSetupWrite(db, hostFacts, scope, ownerSetup, lintOverride);
      if (setup.error !== null) return fail(setup.error);
      if (scope.agentId && !isTaskSize(size)) return fail(`${size === undefined ? "A ticket you create needs a size" : `${size} is not a size`}: ${SIZE_SCALE}, relative to the tickets your team has finished. Call sizing_guide to see finished tickets of each size, pick the one yours is most like, then call create_ticket again with size.`);
      const out = await outsideTree(parent);
      if (out) return fail(`${out} Pass parent (a ticket in the tree) to add a sub-task.`);
      // Attaching a sub-task to an open skill-review task, or making a ticket wait on it, is a way
      // into the reviewer's tree: only the reviewer assigned to the review may do it (BOS-86, round 10).
      for (const linked of [parent, waitsOn]) {
        if (!linked) continue;
        const reviewWrite = await reviewTicketWriteRefusal(db, scope.companyId, linked, scope.agentId);
        if (reviewWrite) return fail(reviewWrite);
      }
      const to = assignee ? await delegateTarget(db, scope, assignee) : null;
      if (to && "error" in to) return fail(to.error);
      let parentTask: Awaited<ReturnType<typeof work.parentOf>> | null = null;
      if (parent) {
        try {
          parentTask = await work.parentOf(parent, scope.companyId);
        } catch (err) {
          if (err instanceof WorkError) return fail(err.message);
          throw err;
        }
      }
      let featureId: string | null = parentTask ? parentTask.featureId : (rest.featureId ?? null);
      if (feature && !parentTask) {
        const fs = await db.select({ id: features.id }).from(features).where(and(eq(features.companyId, scope.companyId), or(sql`${features.id}::text = ${feature}`, sql`lower(${features.title}) = lower(${feature})`)));
        if (fs.length !== 1) return fail(fs.length ? `More than one feature is called "${feature}"; pass its id.` : `No feature "${feature}" in your company. The features tool lists them.`);
        featureId = fs[0]!.id;
      }
      if (featureId && !parentTask) {
        const [f] = await db.select({ id: features.id }).from(features).where(and(eq(features.id, featureId), eq(features.companyId, scope.companyId)));
        if (!f) return fail("No feature with that id in your company.");
      }
      const p = parentTask ? (await db.select().from(projects).where(eq(projects.id, parentTask.projectId)))[0] : await resolveProject(project);
      if (!p) {
        const names = (await db.select({ name: projects.name }).from(projects).where(and(eq(projects.companyId, scope.companyId), isNull(projects.archivedAt)))).map((r) => r.name);
        return fail(names.length ? `Name the project: one of ${names.join(", ")}.` : "Your company has no projects yet; ask your CEO to create one.");
      }
      if (engagementId) {
        try {
          await engagements.linkTicket(engagementId, scope.companyId);
        } catch (err) {
          if (err instanceof EngagementError) return fail(err.message);
          throw err;
        }
      }
      const [blocker] = waitsOn ? await db.select({ state: tickets.systemState }).from(tickets).where(and(eq(tickets.id, waitsOn), eq(tickets.companyId, scope.companyId))) : [];
      if (waitsOn && !blocker) return fail("No task with that waitsOn id in your company.");
      // Safe to repeat (R42): a resumed run that calls this again gets the same open ticket back.
      if (scope.agentId) {
        const [same] = await db
          .select({ id: tickets.id })
          .from(tickets)
          .where(
            and(
              eq(tickets.projectId, p.id),
              eq(tickets.createdByAgentId, scope.agentId),
              sql`lower(${tickets.title}) = lower(${title})`,
              ne(tickets.systemState, "done"),
              gt(tickets.createdAt, new Date(Date.now() - 24 * 3_600_000)),
            ),
          );
        if (same) return text(`Ticket ${same.id} already exists in ${p.name}; no new ticket was created.`);
      }
      const [t] = await db
        .insert(tickets)
        .values({ companyId: scope.companyId, projectId: p.id, title, body, engagementId: engagementId ?? null, createdByAgentId: scope.agentId, risk: risk ?? null, size: isTaskSize(size) ? size : null, planFirst: planFirst ?? (risk ? planFirstByDefault(risk) : false), featureId, parentTicketId: parentTask?.id ?? null, ...(acceptanceCriteria?.length ? { acceptanceCriteria } : {}), ...(noCode ? { noCode } : {}), ...(ownerSetup?.trim() ? { ownerSetup: ownerSetup.trim(), ownerSetupOverride: setup.override } : {}), ...(fixesLive?.trim() ? { fixesLive: fixesLive.trim() } : {}) })
        .returning({ id: tickets.id });
      // Held through moveTicket (DR-047 point 5, BOS-922): the column and the history line follow, not a blocked insert.
      if (blocker && blocker.state !== "done") await systemMoveTicket(db, { ticketId: t!.id, from: ["backlog"], to: "blocked", reason: "Boss Man: created waiting on another ticket", now: new Date() });
      if (parentTask) await work.waitOnSubtask(parentTask, t!.id, scope.agentId);
      if (waitsOn) await work.addDependency(t!.id, { ticketId: waitsOn, until: waitsOnUntil ?? "merged" }, scope.agentId);
      await feedback.syncFeature(featureId);
      await record(db, { companyId: scope.companyId, agentId: scope.agentId, ticketId: t!.id, kind: "ticket_created", summary: `Created "${title}" in ${p.name}` });
      if (to) await work.updateTicket(t!.id, { assigneeAgentId: to.id, byAgentId: scope.agentId });
      // A code ticket nobody can pick up cleanly gets a nudge, but it is still created (BOS-595).
      const thin = noCode ? "" : thinTicketWarning(body, assignee);
      return text(`Created ticket ${t!.id} in ${p.name}${assignee ? `, assigned to ${assignee}` : ""}.${await wipQueuedNote(db, t!.id)}${criteriaWarning(acceptanceCriteria)}${thin}`);
    },
  );
}

export function registerScheduleCheck(server: McpServer, { work }: Pick<Services, "work">, scope: Scope, hooks: McpHooks) {
  const noteRunTicket = runTicketNoter(scope, hooks);
  server.registerTool(
    "schedule_check",
    {
      description:
        "Use this when you are waiting on CI, a deploy, a review or an outside service, instead of ending your turn without a plan. It wakes you on this ticket later to re-check (ticketId, note saying what to re-check, and either inMinutes 5 to 1440 or at as an ISO time; maxChecks 1 to 20, default 5). Only the ticket's assignee can use it, while the ticket is in progress, in review or blocked (a ticket that only waits belongs in Blocked: it does not count toward the in-progress limits). Calling it again replaces the earlier check; when you are woken and still need to wait, call it again. After maxChecks checks the owner is told and you are not woken again.",
      inputSchema: { ticketId: z.string().uuid(), note: z.string().min(1).max(500), inMinutes: z.number().int().min(5).max(1440).optional(), at: z.string().optional(), maxChecks: z.number().int().min(1).max(20).optional() },
    },
    async ({ ticketId, note, inMinutes, at, maxChecks }) => {
      if (!scope.agentId) return fail("Only an agent can schedule a check.");
      if ((inMinutes === undefined) === (at === undefined)) return fail("Give exactly one of inMinutes or at.");
      const when = inMinutes !== undefined ? new Date(Date.now() + inMinutes * 60_000) : new Date(at!);
      try {
        const u = await work.setMonitor(ticketId, { at: when, note, maxChecks, by: { agentId: scope.agentId, companyId: scope.companyId } });
        await noteRunTicket(ticketId);
        return text(`You will be woken on ticket ${ticketId} at ${u.monitorAt!.toISOString()} to re-check (check ${u.monitorAttempts + 1} of ${u.monitorMax}).`);
      } catch (err) {
        if (err instanceof WorkError) return fail(err.message);
        throw err;
      }
    },
  );
}

export function registerClearCheck(server: McpServer, { work }: Pick<Services, "work">, scope: Scope) {
  server.registerTool(
    "clear_check",
    {
      description: "Cancel the check you scheduled on a ticket with schedule_check, for when what you were waiting on has resolved. Only the ticket's assignee can use it.",
      inputSchema: { ticketId: z.string().uuid() },
    },
    async ({ ticketId }) => {
      if (!scope.agentId) return fail("Only an agent can clear a check.");
      try {
        await work.clearMonitor(ticketId, { agentId: scope.agentId, companyId: scope.companyId });
        return text(`No check is scheduled on ticket ${ticketId}.`);
      } catch (err) {
        if (err instanceof WorkError) return fail(err.message);
        throw err;
      }
    },
  );
}

/**
 * Moving and reorganising tickets, in ticket runs and the owner chat. In chat only the CEO and
 * managers may: the owner asks them there to close or tidy work, and workers move their own
 * tickets from the ticket's run.
 */
export function registerTicketMoves(server: McpServer, db: Db, { review, work, feedback, hostFacts }: Pick<Services, "review" | "work" | "feedback" | "skillProposals"> & Partial<Pick<Services, "hostFacts">>, scope: Scope, hooks: McpHooks, chat: boolean) {
  const isManager = () => managerIn(db, scope);
  const resolveProject = (project?: string) => findProject(db, scope, project);
  const outsideTree = (ticketId: string | undefined) => treeRefusal(db, scope, ticketId);
  // In chat a worker may only start or pause its own ticket (BOS-1300): in_progress and blocked, so "the wait is over" can restart
  // a Blocked ticket. moveRefusal below still limits it to tickets assigned to it, and the WIP limit applies in moveTicket.
  const chatRefusal = async (state?: string) =>
    chat && !(await isManager()) && state !== "in_progress" && state !== "blocked"
      ? "In chat only your CEO or a manager can move tickets, except that you can start your own ticket (in_progress) or block it. Offer the owner to create a ticket for the work, or nudge your CEO."
      : null;
  const noteRunTicket = runTicketNoter(scope, hooks);

  server.registerTool(
    "update_ticket",
    {
      description:
        "For CEOs and managers: reorganise one of your company's tickets. Move it to another project (project: name or id; its sub-tasks go with it; not while it is in progress or in review), put it under a feature (featureId, or null to take it out), make it a sub-task of a task (parentTicketId, or null to take it out; it joins the parent's feature and the parent waits on it), fix its title or description, or set who it is assigned to (assignee: an agent's name, or null to leave it unassigned; the new assignee is woken), or mark it as not needing code (noCode true for research, wiki, docs or deploy-only work, so it can reach review with an empty diff; false to clear it), or mark it urgent (urgent true: it always passes the subscription quota hold; false to clear it), or add or clear the owner's setup steps (ownerSetup: what they do once this is live, in plain words by button path; null to clear; once the ticket is merged these are frozen and only the owner can change them on the ticket page), or mark that it fixes a live problem (fixesLive: one sentence naming the symptom; null to clear), or mark it as the fix for a broken merge check (fixesMergeCheck true: other approved work waits on it in review instead of being checked and sent back; false to clear), or change its size (1, 2, 3, 5 or 8; null to clear it; compare with sizing_guide first), or (CEO only) set a plan with a deadline (ceoPlan and ceoPlanDeadline: the looks-stuck alert stays quiet until the deadline plus a grace, then one card says it passed; ceoPlan null clears it). Give at least one change and a reason up to 240 characters; the reason is kept on the ticket. Pass expected_version so it is refused if the ticket changed since you read it. To close a duplicate, use set_ticket_state done with outcome cancelled.",
      inputSchema: {
        ticketId: z.string().uuid(),
        project: z.string().min(1).optional(),
        featureId: z.string().uuid().nullable().optional(),
        parentTicketId: z.string().uuid().nullable().optional(),
        title: z.string().trim().min(1).max(200).optional(),
        body: z.string().max(10_000).optional(),
        assignee: z.string().min(1).nullable().optional(),
        noCode: z.boolean().optional(),
        ownerSetup: z.string().max(4000).nullable().optional().describe(`What the owner has to do once this change is live, in plain words by button path, one step per line. Null or an empty string clears it. Once the ticket is merged it is frozen against agents; only the owner changes it on the ticket page, except that the CEO may fix it while Boss Man's "setup steps can't go to the owner" card for it is open. ${SETUP_HELP}`),
        lintOverride: LINT_OVERRIDE,
        urgent: z.boolean().optional(),
        fixesLive: z.string().max(FIXES_LIVE_MAX).nullable().optional().describe(`${FIXES_LIVE_HELP} Null or an empty string clears it.`),
        size: z.number().nullable().optional(),
        fixesMergeCheck: z.boolean().optional().describe(FIXES_MERGE_CHECK_HELP),
        ceoPlan: z.string().trim().min(1).max(2000).nullable().optional().describe("The CEO's plan for this ticket, in plain words. Needs ceoPlanDeadline. While the plan stands the \"looks stuck\" alert stays quiet; after the deadline plus a short grace one card says the deadline passed. Null clears the plan. Only the CEO sets it."),
        ceoPlanDeadline: z.string().datetime({ offset: true }).nullable().optional().describe("When the plan should be done (ISO 8601 with a time zone, in the future, within 30 days). Required with ceoPlan."),
        waitsOn: z.object({
          add: z.array(z.string().min(1).max(40)).max(10).optional().describe("Tickets (BOS-12 or id) this ticket should wait on."),
          remove: z.array(z.string().min(1).max(40)).max(10).optional().describe("Tickets (BOS-12 or id) this ticket should stop waiting on."),
          until: z.enum(["merged", "done"]).optional().describe("When the wait on the tickets in add ends: their merge on main (merged, the default) or their done state (done)."),
        }).optional().describe("Add or remove \"waits on\" links on this ticket. When the point in until is reached (merge commit on main, or done), this ticket's assignee is woken. On approved work in review, the link also holds the merge: it waits as \"Passed, held\" with its approvals kept and merges by itself once the linked ticket is merged and live. Besides the CEO and managers, the ticket's own assignee may use this on their own ticket."),
        acceptanceCriteria: acceptanceCriteriaSchema.optional().describe("Replaces the ticket's tracked acceptance criteria, in the shape create_ticket takes (a string, or {text, after: \"merge\"}); up to 10, empty clears them. Every criterion goes back to not reported (the old pass/fail verdicts in the state note are dropped), and the change and your reason are kept in the ticket history. If the ticket is in review, reviews are not re-requested: tell the assignee and reviewers."),
        reason: z.string().trim().min(1).max(240),
        expected_version: z.number().int().optional(),
      },
    },
    async ({ ticketId, project, featureId, parentTicketId, title, body, assignee, noCode, ownerSetup, lintOverride, urgent, fixesLive, size, fixesMergeCheck, acceptanceCriteria, waitsOn, ceoPlan, ceoPlanDeadline, reason, expected_version }) => {
      const manager = await isManager();
      const otherChange = project !== undefined || featureId !== undefined || parentTicketId !== undefined || title !== undefined || body !== undefined || assignee !== undefined || noCode !== undefined || ownerSetup !== undefined || urgent !== undefined || fixesLive !== undefined || size !== undefined || acceptanceCriteria !== undefined || ceoPlan !== undefined || ceoPlanDeadline !== undefined || fixesMergeCheck !== undefined;
      // A ticket's own assignee may order their own ticket (BOS-989): waitsOn alone, nothing else.
      if (!manager && (otherChange || waitsOn === undefined || !scope.agentId)) return fail("Only your company's CEO or a manager can reorganise tickets. Your own ticket's assignee can change its waitsOn.");
      const planGiven = ceoPlan !== undefined || ceoPlanDeadline !== undefined;
      if (planGiven) {
        const [me] = scope.agentId ? await db.select({ role: agents.role }).from(agents).where(eq(agents.id, scope.agentId)) : [];
        if (me?.role !== "ceo") return fail("Only the CEO sets a plan with a deadline on a ticket.");
        if (ceoPlan) {
          if (!ceoPlanDeadline) return fail("A plan needs ceoPlanDeadline: when it should be done.");
          const at = new Date(ceoPlanDeadline).getTime();
          if (at <= Date.now()) return fail("ceoPlanDeadline must be in the future.");
          if (at > Date.now() + 30 * 86_400_000) return fail("ceoPlanDeadline must be within 30 days.");
        } else if (ceoPlanDeadline) return fail("ceoPlanDeadline goes with ceoPlan. To clear a plan, pass ceoPlan null.");
      }
      if (size !== undefined && size !== null && !isTaskSize(size)) return fail(`${size} is not a size: ${SIZE_SCALE}, or null to clear it.`);
      const out = await outsideTree(ticketId);
      if (out) return fail(out);
      const reviewWrite = await reviewTicketWriteRefusal(db, scope.companyId, ticketId, scope.agentId);
      if (reviewWrite) return fail(reviewWrite);
      if (project === undefined && featureId === undefined && parentTicketId === undefined && title === undefined && body === undefined && assignee === undefined && noCode === undefined && ownerSetup === undefined && urgent === undefined && fixesLive === undefined && size === undefined && acceptanceCriteria === undefined && waitsOn === undefined && fixesMergeCheck === undefined && !planGiven) return fail("Nothing to change: give project, featureId, parentTicketId, title, body, assignee, noCode, ownerSetup, urgent, fixesLive, size, fixesMergeCheck, acceptanceCriteria, waitsOn or ceoPlan.");
      if (waitsOn !== undefined && !waitsOn.add?.length && !waitsOn.remove?.length) return fail("waitsOn needs add or remove: tickets (BOS-12 or id).");
      if (waitsOn?.until && !waitsOn.add?.length) return fail("waitsOn until goes with add.");
      const [t] = await db.select({ version: tickets.version, state: tickets.systemState, assignee: tickets.assigneeAgentId }).from(tickets).where(and(eq(tickets.id, ticketId), eq(tickets.companyId, scope.companyId)));
      if (!t) return fail("No ticket with that ID in your company.");
      if (!manager && t.assignee !== scope.agentId) return fail("Only your company's CEO or a manager, or the ticket's own assignee, can change what a ticket waits on.");
      // Each named ticket in waitsOn resolves to an id in this company before anything is written.
      const waitIds = { add: [] as string[], remove: [] as string[] };
      for (const [list, key] of [[waitsOn?.add, "add"], [waitsOn?.remove, "remove"]] as const) {
        for (const given of list ?? []) {
          const byRef = REF.exec(given.trim());
          const found = byRef ? (await db.select({ id: tickets.id }).from(tickets).where(and(eq(tickets.companyId, scope.companyId), eq(tickets.number, Number(byRef[1])))))[0]?.id : z.string().uuid().safeParse(given.trim()).success ? (await db.select({ id: tickets.id }).from(tickets).where(and(eq(tickets.companyId, scope.companyId), eq(tickets.id, given.trim()))))[0]?.id : undefined;
          if (!found) return fail(`waitsOn: no ticket ${given} in your company. Use a reference like BOS-12 or an id.`);
          waitIds[key].push(found);
        }
      }
      if (expected_version !== undefined && t.version !== expected_version) return fail(await staleVersionMessage(db, scope.companyId, ticketId, expected_version));
      if (lintOverride !== undefined && ownerSetup === undefined) return fail("lintOverride goes with ownerSetup.");
      const setup = ownerSetup !== undefined ? await checkSetupWrite(db, hostFacts, scope, ownerSetup, lintOverride) : null;
      if (setup && setup.error !== null) return fail(setup.error);
      // DR-052: a merged ticket's steps are frozen against agents, except the CEO fixing them while Boss Man's card
      // says they can't go to the owner; that card is what lets them be changed after review.
      const setupFix = setup ? await openSetupFixFor(db, scope, ticketId) : false;
      const p = project !== undefined ? await resolveProject(project) : null;
      if (project !== undefined && !p) return fail(`No open project called ${project} in your company.`);
      let assigneeId: string | null | undefined;
      if (assignee) {
        const team_ = await db.select({ id: agents.id, name: agents.name, paused: agents.paused }).from(agents).where(and(eq(agents.companyId, scope.companyId), isNull(agents.retiredAt), sql`${agents.duty} is distinct from 'assistant'`));
        const a = team_.find((x) => x.name.toLowerCase() === assignee.trim().toLowerCase());
        if (!a) return fail(`No active agent called ${assignee} in your company. Valid names: ${team_.map((x) => x.name).join(", ")}.`);
        if (a.paused) return fail(`${a.name} is paused, so they would not pick it up. Pick someone else.`);
        assigneeId = a.id;
      } else if (assignee === null) assigneeId = null;
      try {
        const fieldsGiven = project !== undefined || featureId !== undefined || parentTicketId !== undefined || title !== undefined || body !== undefined || assignee !== undefined || noCode !== undefined || ownerSetup !== undefined || urgent !== undefined || fixesLive !== undefined || size !== undefined || acceptanceCriteria !== undefined;
        const onlyPlan = planGiven && waitsOn === undefined && fixesMergeCheck === undefined && !fieldsGiven;
        const onlyMark = fixesMergeCheck !== undefined && !fieldsGiven && !planGiven && waitsOn === undefined;
        const noFieldWrite = onlyPlan || onlyMark || (waitsOn !== undefined && !otherChange);
        const u =noFieldWrite ?{ version: t.version } : await work.updateTicket(ticketId, { byAgentId: scope.agentId, expectedVersion: expected_version, ...(assigneeId !== undefined ? { assigneeAgentId: assigneeId } : {}), ...(p ? { projectId: p.id } : {}), ...(featureId !== undefined ? { featureId } : {}), ...(parentTicketId !== undefined ? { parentTicketId } : {}), ...(title !== undefined ? { title } : {}), ...(body !== undefined ? { body } : {}), ...(noCode !== undefined ? { noCode } : {}), ...(ownerSetup !== undefined ? { ownerSetup, ownerSetupOverride: setup?.error === null ? setup.override : null, ...(setupFix ? { setupFix } : {}) } : {}), ...(urgent !== undefined ? { urgent } : {}), ...(fixesLive !== undefined ? { fixesLive } : {}), ...(size !== undefined ? { size } : {}), ...(acceptanceCriteria !== undefined ? { acceptanceCriteria, stateNote: CRITERIA_REPLACED_NOTE } : {}) });
        // A new plan starts its own clock: the "deadline passed" card comes once per plan (BOS-612).
        if (planGiven) {
          // A plan-only call has no updateTicket write, so its own write carries the version check (BOS-897).
          const planned = await db.update(tickets).set({ ceoPlan: ceoPlan ?? null, ceoPlanDeadline: ceoPlan && ceoPlanDeadline ? new Date(ceoPlanDeadline) : null, ceoPlanAlertedAt: null }).where(and(eq(tickets.id, ticketId), onlyPlan && expected_version !== undefined ? eq(tickets.version, expected_version) : undefined)).returning({ id: tickets.id });
          if (!planned.length) return fail(await staleVersionMessage(db, scope.companyId, ticketId, expected_version!));
        }
        // The merge-check mark (BOS-1173): alone, its own write carries the version check, as a plan's does.
        if (fixesMergeCheck !== undefined) {
          const marked = await db.update(tickets).set({ fixesMergeCheck }).where(and(eq(tickets.id, ticketId), onlyMark && expected_version !== undefined ? eq(tickets.version, expected_version) : undefined)).returning({ id: tickets.id });
          if (!marked.length) return fail(await staleVersionMessage(db, scope.companyId, ticketId, expected_version!));
        }
        // The ordering links go in once the ticket's own fields were written, so a stale version refuses the whole call.
        const waitsLines: string[] = [];
        for (const id of waitIds.remove) if (await work.removeDependency(ticketId, id, scope.agentId)) waitsLines.push(`no longer waits on ${id}`);
        for (const id of waitIds.add) {
          const dep = await work.addDependency(ticketId, { ticketId: id, until: waitsOn?.until ?? "merged" }, scope.agentId);
          waitsLines.push(`waits on ${id} until ${dep.until}`);
        }
        const [me] = scope.agentId ? await db.select({ name: agents.name }).from(agents).where(eq(agents.id, scope.agentId)) : [];
        await record(db, { companyId: scope.companyId, agentId: scope.agentId, ticketId, kind: "reorganised", summary: `${me?.name ?? "An agent"} reorganised it${!planGiven ? "" : ceoPlan ? ` (plan set, due ${ceoPlanDeadline})` : " (plan cleared)"}${noCode === undefined ? "" : noCode ? " (marked no code)" : " (no longer marked no code)"}${urgent === undefined ? "" : urgent ? " (marked urgent)" : " (no longer urgent)"}${fixesLive === undefined ? "" : fixesLive?.trim() ? ` (fixes live: ${fixesLive.trim()})` : " (no longer marked fixes live)"}${fixesMergeCheck === undefined ? "" : fixesMergeCheck ? " (marked as fixing the merge check: approved work in the project waits on it in Passed, held)" : " (no longer marked as fixing the merge check)"}${size === undefined ? "" : size === null ? " (size cleared)" : ` (size ${size})`}${ownerSetup === undefined ? "" : ownerSetup?.trim() ? " (owner setup steps changed)" : " (owner setup steps cleared)"}${acceptanceCriteria === undefined ? "" : ` (acceptance criteria replaced: ${acceptanceCriteria.length ? acceptanceCriteria.map((c, i) => `${i + 1}. ${criteriaText([c])}`).join(" ") : "none now"})`}${waitsLines.length ? ` (${waitsLines.join("; ")})` : ""}: ${reason}` });
        await noteRunTicket(ticketId);
        return text(`Ticket ${ticketId} updated (version ${u.version}).${waitsLines.length ? ` ${waitsLines.join("; ")}.` : waitsOn ? " No waitsOn link changed." : ""}${acceptanceCriteria !== undefined ? ` Its acceptance criteria are replaced and none is reported yet.${t.state === "review" ? " It is in review: reviews were NOT re-requested, so tell the assignee and reviewers the criteria changed." : ""}${criteriaWarning(acceptanceCriteria)}` : ""}`);
      } catch (err) {
        if (err instanceof WorkError) return fail(err.message);
        throw err;
      }
    },
  );

  server.registerTool(
    "set_ticket_state",
    {
      description: `Move one of your company's tickets to a new state. Call it with state "review" when your work is ready to check, or "done" when it is finished (a no-code ticket assigned to you can be closed by you); ending your turn does not move the ticket. Moving to review, done or blocked needs a summary (up to 240 characters): what you did, or what you are waiting on. Blocked is for every kind of wait on unfinished work and does not count toward the in-progress limits: it is accepted for a waits-on ticket, an open card (plan cards too), a blocked_until date, or a merged ticket with after-merge checks not yet reported; anything else is refused. If you are waiting on the owner (to run something, answer or sign off), call raise_decision with blocksTicketId first, and only after you have tried every way to do it yourself. Naming the owner in the summary does not reach them. It is kept on the ticket for whoever reads it next, so write it in plain words with no file paths unless essential. If the ticket has acceptance criteria to check before merge, the summary must say pass or fail for each; a criterion marked checked after merge is reported once the work is live, and the ticket cannot be marked done until it is. Pass expected_version (the ticket's version as you last saw it) so the move is refused if the ticket has changed since. When blocking on something with a known time (e.g. a scheduled deployment), pass blocked_until (a future date and time within 30 days, ISO 8601 with a time zone) and optionally blocked_reason (one line, up to 240 characters): the Scrum Master watchdog then stays quiet until that time plus a grace period. Without blocked_until the normal blocked limit applies. ${FINISHED_STAYS_IN_REVIEW} Moving it back to review on code its reviews already passed keeps those approvals and the owner's sign-off; no new review round is opened. When you hand work on to someone else, pass followUps on review or done so it lands on their queue (${FOLLOW_UP_HELP}) A move to done is refused when the summary or your last reply hands work on ("the CEO will", "for X to", "hand to", "next: someone") and neither followUps nor noFollowUpReason is given.`,
      inputSchema: { ticketId: z.string().uuid(), state: z.enum(STATES), outcome: z.enum(["completed", "cancelled"]).optional(), expected_version: z.number().int().optional(), summary: z.string().max(240).optional(), blocked_until: z.string().datetime({ offset: true }).optional(), blocked_reason: z.string().max(BLOCKED_UNTIL_REASON_MAX).optional(), ownerSetup: z.string().max(4000).optional().describe(`The owner's steps, for a ticket whose change needs them to do something once it is live (a setting, a secret, a button): plain words by button path, one step per line, e.g. Settings → Funding → Add funding source. Boss Man raises their card with these steps when the change goes live, not at merge. Pass an empty string to clear it. Only the ticket's own assignee, CEO or a manager may set it, and not once the ticket is merged (the steps freeze at merge; only the owner changes them on the ticket page). ${SETUP_HELP}`), lintOverride: LINT_OVERRIDE, fixesLive: z.string().max(FIXES_LIVE_MAX).optional().describe(`${FIXES_LIVE_HELP} An empty string clears it. Only the ticket's own assignee, CEO or a manager may set it here; a reviewer adds it with the review tool.`), followUps: followUpsSchema.optional().describe(`With state review or done. ${FOLLOW_UP_HELP}`), noFollowUpReason: z.string().max(240).optional().describe("With state done: why nothing is handed on although the summary or last reply sounds like it does.") },
    },
    async ({ ticketId, state, outcome, expected_version, summary, blocked_until, blocked_reason, ownerSetup, lintOverride, fixesLive, followUps, noFollowUpReason }) => {
      if (followUps?.length && state !== "review" && state !== "done") return fail("followUps goes with state review or done.");
      const followUpManager = followUps?.length ? await managerIn(db, scope) : false;
      const followUpWho = followUps?.length ? await resolveFollowUpAssignees(db, scope.companyId, followUps, followUpManager) : null;
      if (followUpWho && "error" in followUpWho) return fail(followUpWho.error);
      const badFix = fixesLive ? fixesLiveProblem(fixesLive) : null;
      if (badFix) return fail(badFix);
      const no = await chatRefusal(state);
      if (no) return fail(no);
      // The state note is read by the reviewer as trusted text: on an open review ticket only the
      // reviewer assigned to it may write one (BOS-86, round 9).
      const reviewWrite = await reviewTicketWriteRefusal(db, scope.companyId, ticketId, scope.agentId);
      if (reviewWrite) return fail(reviewWrite);
      const notMine = await moveRefusal(db, scope, ticketId, state === "done" && outcome === "cancelled");
      if (notMine) return fail(notMine);
      // In a project with a repo, a ticket is done when its branch is merged after review (R46, R47).
      if (state === "done") {
        const [t] = await db
          .select({ repoUrl: projects.repoUrl, mergeCommit: tickets.mergeCommit, noCode: tickets.noCode, assignee: tickets.assigneeAgentId })
          .from(tickets)
          .innerJoin(projects, eq(projects.id, tickets.projectId))
          .where(and(eq(tickets.id, ticketId), eq(tickets.companyId, scope.companyId)));
        // A ticket whose branch is already merged but stayed in review (e.g. waiting on the owner's yes) can be closed by a manager.
        const merged = !!t?.mergeCommit && (await managerIn(db, scope));
        // A no-code ticket never has a branch to merge, so its own assignee closes it once the work is
        // done (BOS-304): the CEO no longer has to move each research, wiki or docs task by hand.
        const ownNoCode = !!t?.noCode && !!scope.agentId && t.assignee === scope.agentId;
        // A ticket whose change shipped on another ticket has nothing of its own to merge; the CEO or a manager may close it.
        if (t?.repoUrl && outcome !== "cancelled" && !merged && !ownNoCode) {
          // No code at all means nothing to merge for anyone; otherwise only "nothing changed" can skip review.
          // A manager may still close either, as before, whatever the branch holds.
          const nothingOwn = !!t?.noCode || (await review.needsChanges(ticketId, scope.companyId).catch(() => false));
          if (!nothingOwn) return fail('This project has a repo: move the ticket to "review" instead. It becomes done when its branch is approved, checked and merged.');
          if (!(await managerIn(db, scope))) return fail("This ticket has no changes of its own, so it can't be merged. If its change shipped on another ticket, ask your CEO or manager to close it (set_ticket_state done, naming that ticket in the summary).");
        }
      }
      if ((blocked_until || blocked_reason) && state !== "blocked") return fail("blocked_until and blocked_reason only go with state blocked.");
      if (blocked_reason && !blocked_until) return fail("blocked_reason goes with blocked_until: give the date and time you are waiting for.");      if (blocked_reason && /[\r\n]/.test(blocked_reason.trim())) return fail("blocked_reason must be one line.");
      const until = blocked_until ? new Date(blocked_until) : null;
      if (until && until.getTime() <= Date.now()) return fail("blocked_until must be in the future.");
      if (state === "in_progress") {
        // A run can't start a ticket that still waits on unfinished work, or a Backlog ticket nobody
        // handed it (BOS-254). The owner, the CEO and managers override.
        const [current] = await db.select({ systemState: tickets.systemState, createdAt: tickets.createdAt, lastActivityAt: tickets.lastActivityAt }).from(tickets).where(and(eq(tickets.id, ticketId), eq(tickets.companyId, scope.companyId)));
        if (current && current.systemState !== "in_progress") {
          const blockers = await db
            .select({ ticketState: tickets.systemState, ticketTitle: tickets.title, engagementStatus: engagementsTable.status })
            .from(ticketDependencies)
            .leftJoin(tickets, eq(tickets.id, ticketDependencies.blockerTicketId))
            .leftJoin(engagementsTable, eq(engagementsTable.id, ticketDependencies.blockerEngagementId))
            .where(eq(ticketDependencies.blockedTicketId, ticketId));
          const [me] = scope.agentId ? await db.select({ role: agents.role }).from(agents).where(eq(agents.id, scope.agentId)) : [];
          const refusal = startRefusal(current, blockers, { agentId: scope.agentId, role: me?.role ?? null });
          if (refusal) return fail(refusal);
        }
      }
      if (until && until.getTime() > Date.now() + BLOCKED_UNTIL_MAX_MS) return fail(`blocked_until can be at most ${BLOCKED_UNTIL_MAX_DAYS} days ahead. For a longer wait, block without a time and raise a decision for the owner.`);
      if ((state === "review" || state === "done" || state === "blocked") && !summary?.trim()) return fail(`Moving a ticket to ${state} needs a summary (up to 240 characters): what you did, or what you are waiting on. Call set_ticket_state again with summary.`);
      // With criteria on the ticket, moving to review is only allowed once the state note reports
      // pass or fail for each of them; the refusal names the ones it can't find.
      const [withCriteria] = await db
        .select({ criteria: tickets.acceptanceCriteria, current: tickets.stateNote, prev: tickets.systemState })
        .from(tickets)
        .where(and(eq(tickets.id, ticketId), eq(tickets.companyId, scope.companyId)));
      if (!withCriteria) return fail("No ticket with that ID in your company.");
      // A merged ticket's setup steps are the ones review saw: only the owner changes them (BOS-443).
      if (ownerSetup !== undefined) {
        const [mergedNow] = await db.select({ mergeCommit: tickets.mergeCommit, ownerSetup: tickets.ownerSetup }).from(tickets).where(eq(tickets.id, ticketId));
        const next = ownerSetup.trim() || null;
        if (mergedNow?.mergeCommit && next !== (mergedNow.ownerSetup?.trim() || null)) return fail('This ticket is merged, so its setup steps are frozen: they are the ones review saw, and Boss Man raises the owner\'s "Ready to use" card from them when it goes live. An agent can\'t change them now. If they are wrong, ask the owner to fix them on the ticket page, or open a follow-up ticket with the right steps.');
      }
      if (lintOverride !== undefined && ownerSetup === undefined) return fail("lintOverride goes with ownerSetup.");
      // Same state again (DR-010): only the note changes. No enter-state hooks, no new review round.
      const sameState = withCriteria.prev === state;
      // BOS-1361: closing with "X will do the rest" and nothing on X's queue loses the work.
      if (state === "done" && !sameState && outcome !== "cancelled") {
        const handOff = await handOffRefusal(db, ticketId, summary, { followUps, noFollowUpReason });
        if (handOff) return fail(handOff);
      }
      // DR-052 point 1: setup steps are checked like an owner card when they are written, and the stored ones again
      // on the move to review (host facts may have changed, or they were written before this check existed). A CEO
      // override given with the steps still covers them.
      const setup = ownerSetup !== undefined ? await checkSetupWrite(db, hostFacts, scope, ownerSetup, lintOverride) : null;
      if (setup && setup.error !== null) return fail(setup.error);
      if (!setup && state === "review" && !sameState) {
        const [stored] = await db.select({ ownerSetup: tickets.ownerSetup, override: tickets.ownerSetupOverride }).from(tickets).where(eq(tickets.id, ticketId));
        const steps = splitSteps(stored?.ownerSetup ?? "");
        const again = steps.length ? ownerSetupWriteCheck(steps, await setupFacts(db, hostFacts, scope.companyId, steps), { lintOverride: stored?.override ?? undefined, byCeo: true }) : null;
        if (again && again.error !== null) return fail(`${again.error}\nFix them with set_ticket_state ownerSetup, then move to review again.`);
      }
      const note = summary ?? withCriteria.current;
      // The done gate also reads the state note already on the ticket: the owner's answer on a linked card
      // records its pass or fail there (DR-024 #5), so a short closing summary mustn't hide it.
      const reported = state === "done" ? `${withCriteria.current ?? ""}\n${note ?? ""}` : note;
      // A review only needs the before-merge criteria reported: an after-merge one can only be settled
      // once the work is live, so it must not bounce rounds of review (DR-024 #5). Once the work has
      // merged, the ticket can't be done until those after-merge criteria are reported pass or fail.
      if (state === "done") {
        // BOS-1021: the live checks can't be made before the merge is running; closing now would hide that.
        const [w] = await db.select({ wait: tickets.goLiveWait }).from(tickets).where(eq(tickets.id, ticketId));
        if (w?.wait) return fail(`This ticket's merge isn't live yet (${goLiveWaitWords(w.wait as GoLiveWait)}), so its after-merge checks can't be made. Boss Man wakes you when it is live; then report them and close the ticket.`);
      }
      const missing = state === "review" ? missingVerdicts(withCriteria.criteria, note, "before") : state === "done" ? unreportedAfterMerge(withCriteria.criteria, reported) : [];
      if (missing.length)
        return fail(
          state === "done"
            ? `This ticket's work is merged, and its after-merge acceptance criteria aren't reported yet. Not reported: ${missing.map((m) => `"${m}"`).join(", ")}. Say whether each one passes or fails, then move it again. If one can only be checked by the owner, put a card in front of them (raise_decision with blocksTicketId set to this ticket, and criterion set to that check's number): their answer records the check's pass or fail, so you can close it once they have. A fail still closes this ticket: Boss Man opens the follow-up for it, assigned to this ticket's assignee.`
            : `This ticket has acceptance criteria to report before it merges, and the summary must give pass or fail for each of them. Not reported: ${missing.map((m) => `"${m}"`).join(", ")}. Say whether each one passes or fails, then move it again. Numbered verdicts in criteria order work too and are shorter, e.g. "1 pass; 2 pass; 3 fail: reason".${withCriteria.criteria.some(isAfterMerge) ? " The after-merge criteria don't need a verdict at review." : ""}`,
        );
      // A code ticket with nothing changed in the repository can't be reviewed; research and wiki
      // tickets are marked "no code" and are not held to this.
      if (state === "review" && (await review.needsChanges(ticketId, scope.companyId).catch(() => false))) return fail(NOTHING_CHANGED);
      // A ticket waiting on the owner has to show in their Your review lane, which it only does through an open decision.
      if (state === "blocked" && !until && !(await hasOpenBlocker(db, ticketId)) && !(await hasOpenCard(db, ticketId)) && !(await mergedAwaitingChecks(db, ticketId))) {
        return fail(BLOCKED_REFUSAL);
      }
      // The move itself is moveTicket's (DR-047): the column, the WIP limit, the field rules, the history line,
      // the merge line's "left" event, and the done, review and feature steps after a real change. This tool
      // only says whom to wake: the chain depth of this run goes with each wake.
      const at = new Date();
      let moved: Awaited<ReturnType<typeof moveTicket>>;
      try {
        moved = await moveTicket(db, ticketId, state, {
          by: scope.agentId,
          companyId: scope.companyId,
          expectedVersion: expected_version,
          outcome,
          note: summary,
          blockedUntil: state === "blocked" ? until : undefined,
          blockedUntilReason: blocked_reason?.trim() || null,
          fields: { ...(summary?.trim() ? { stateNote: summary.trim(), stateNoteAt: at, stateNoteStaleAt: null, lastPostAt: at } : {}), ...(ownerSetup !== undefined ? { ownerSetup: ownerSetup.trim() || null, ownerSetupOverride: setup?.error === null && ownerSetup.trim() ? setup.override : null } : {}), ...(fixesLive !== undefined ? { fixesLive: fixesLive.trim() || null } : {}) },
          hooks: {
            onDone: () => hooks.onTicketDone?.(ticketId, scope.runId),
            onReview: () => hooks.onTicketReview?.(ticketId, scope.agentId, scope.runId),
            onFeature: (fid) => feedback.syncFeature(fid),
          },
          now: at,
        });
      } catch (e) {
        if (e instanceof WorkError) return fail(e.message);
        throw e;
      }
      // BOS-1209: Blocked on an open card needs a hold row, or answering the card has nothing to release.
      if (state === "blocked" && !sameState && !until) {
        for (const cardId of await openCardIds(db, ticketId)) {
          const [has] = await db.select({ id: ticketDependencies.id }).from(ticketDependencies).where(and(eq(ticketDependencies.blockedTicketId, ticketId), eq(ticketDependencies.blockerDecisionId, cardId))).limit(1);
          if (!has) await addTicketDependency(db, { companyId: scope.companyId, blockedTicketId: ticketId, blockerDecisionId: cardId, actor: { type: "agent", agentId: scope.agentId ?? null }, now: () => at }).catch(() => undefined);
        }
      }
      // A state note is a post: the run's silence is measured from it (BOS-314).
      if (summary?.trim() && scope.agentId) await db.update(runsTable).set({ lastPostAt: at }).where(eq(runsTable.id, scope.runId));
      await noteRunTicket(ticketId);
      // A live check that failed doesn't hold the merged ticket open: Boss Man opens a filled-in, owned
      // follow-up for it (DR-009 #5, BOS-575), so nobody files a bare title by hand. A cancel makes none.
      const failedLive = state === "done" && !sameState && (outcome ?? "completed") === "completed" ? failedAfterMerge(withCriteria.criteria, reported) : [];
      let followUp = "";
      if (failedLive.length) {
        const f = await review.followUpFailedChecks(ticketId, failedLive, reported ?? "", scope.agentId).catch(() => null);
        followUp = f
          ? `\n\nAn after-merge check failed, so Boss Man opened the follow-up ${f.ref} (#/tickets/${f.id}) "${f.title}", assigned to ${f.assignee ?? "the CEO"}, and told the CEO. Don't create another one.`
          : `\n\nAn after-merge check failed, but Boss Man couldn't open its follow-up ticket. Create it with create_ticket: a description of what failed, a risk and an assignee, and this ticket's link.`;
      }
      // Only on a real state change: repeating a move must not open the same follow-ups again.
      if (followUps?.length && sameState) followUp += "\n\nThe ticket was already in that state, so no follow-ups were opened.";
      if (followUps?.length && !sameState && followUpWho && "ids" in followUpWho) {
        const opened = await openFollowUps(db, work, ticketId, followUps, followUpWho.ids, scope.agentId, { isManager: followUpManager, suggested: followUpWho.suggested }).catch(() => null);
        followUp += opened
          ? `\n\nBoss Man opened ${opened.length === 1 ? "the follow-up" : "the follow-ups"}: ${opened.map((o) => `${o.ref} (#/tickets/${o.id}) "${o.title}" for ${o.assignee}`).join("; ")}. Don't create them again.`
          : `\n\nThe move worked, but Boss Man couldn't open the follow-ups. Create them with create_ticket.`;
      }
      // The check that counts is at the merge, but telling the agent now saves it waiting hours to
      // find out its migration number is taken (BOS-219). It never holds the move up.
      const warn = state === "review" && !sameState ? await migrationWarning(review, ticketId, scope.companyId) : "";
      // A reminder, not a refusal (DR-011 point 2): a code ticket with nothing written for the owner may well
      // have nothing for them to do, and the developer is the only one who knows.
      const [setupNow] = state === "review" && !sameState ? await db.select({ ownerSetup: tickets.ownerSetup }).from(tickets).where(eq(tickets.id, ticketId)) : [];
      const setupHint = state === "review" && !sameState && !setupNow?.ownerSetup?.trim() ? "\n\nIf the owner has to do anything once this is live (a setting, a secret, a button), add the steps in plain words by button path with set_ticket_state ownerSetup." : "";
      // BOS-734: a head that moves after the owner's sign-off card is raised can void it.
      const signoffHint = state === "review" && !sameState ? "\n\nWhile this waits on review or the owner's sign-off, don't merge main into the branch unless the merge gate says it clashes. Boss Man carries a sign-off over only when main was merged in automatically with no clashes and no new code; a hand-fixed merge or a new commit means the owner must sign off again." : "";
      if (moved.held) return text(`Ticket ${ticketId} did not start: ${moved.held} It is in Ready, assigned to you. Finish or hand over one of your in-progress tickets first, and it starts by itself.`);
      return text(`Ticket ${ticketId} is now ${state}.${moved.urgentOver ? " It started over your WIP limit because it is urgent." : ""}${sameState ? " It was already there, so only the note changed and no reviews were re-requested." : ""}${followUp}${warn}${setupHint}${signoffHint}${(await getHold(db)) ? ` ${WRAP_UP}` : ""}${waitsOnAdvice(summary)}`);
    },
  );
}

/**
 * A short note for the agent, when one of the ticket's new migration numbers is already on the
 * default branch (BOS-219). Only a clash with the default branch is worth saying at review time:
 * a clash with another open branch is not, because that branch hasn't merged and the agent can't
 * know whether it ever will (DR-037). Telling agents to rename against open branches caused about
 * 35 renumber commits and gaps on main, so that advice is gone.
 */
async function migrationWarning(review: Services["review"], ticketId: string, companyId: string): Promise<string> {
  const m = await review.migrations(ticketId, companyId).catch(() => null);
  if (!m?.needed) return "";
  return `\n\nHeads up (BOS-219): a migration number is already taken on the default branch: ${m.why.join("; ")}. Rename it to ${String(m.next).padStart(4, "0")} (and any others it moved) before this merges, set its journal entry's "when" later than the newest one already on the default branch, run the checks, and move the ticket back to review. The merge will send it back if it still clashes.${m.others.length ? ` Other numbers taken: ${m.others.join("; ")}.` : ""}`;
}

/** What Blocked accepts (BOS-1171); the refusal names every kind. Blocked tickets never count toward the in-progress limits. */
export const BLOCKED_REFUSAL =
  "Blocked is for a ticket that only waits. It is accepted when the ticket: (1) waits on another ticket, a decision or an engagement (update_ticket waitsOn, or create_ticket with parent set to this ticket); (2) has an open card on it, a plan card included (raise_decision with blocksTicketId, or a plan waiting for approval); (3) waits for a known time: pass blocked_until (a future ISO 8601 time within 30 days) with blocked_reason; or (4) is merged and has after-merge acceptance criteria not yet reported. If you need the owner, call raise_decision with blocksTicketId first: a note in the summary does not reach them. Once blocked you can still use schedule_check to re-check later.";

/** True when an open card names this ticket (a plan card, a permission card or a question), linked or not. */
export async function hasOpenCard(db: Db, ticketId: string) {
  return (await openCardIds(db, ticketId)).length > 0;
}

/** The open cards that name this ticket: the one definition of "an open card holds it" for accepting Blocked and for releasing it. */
export async function openCardIds(db: Db, ticketId: string): Promise<string[]> {
  const rows = await db
    .select({ id: decisionsTable.id })
    .from(decisionsTable)
    .where(and(eq(decisionsTable.status, "open"), sql`${decisionsTable.context}->>'ticketId' = ${ticketId}`));
  return rows.map((r) => r.id);
}

/** True when the ticket has merged and still has after-merge criteria without a reported pass or fail. */
export async function mergedAwaitingChecks(db: Db, ticketId: string) {
  const [t] = await db.select({ mergeCommit: tickets.mergeCommit, criteria: tickets.acceptanceCriteria, note: tickets.stateNote }).from(tickets).where(eq(tickets.id, ticketId));
  return !!t?.mergeCommit && unreportedAfterMerge(t.criteria, t.note).length > 0;
}

/** True when something open holds the ticket: an unanswered decision, an unfinished blocker ticket or an engagement. */
async function hasOpenBlocker(db: Db, ticketId: string) {
  const deps = await db.select().from(ticketDependencies).where(eq(ticketDependencies.blockedTicketId, ticketId));
  for (const d of deps) {
    if (d.blockerEngagementId) {
      const [x] = await db.select({ s: engagementsTable.status }).from(engagementsTable).where(eq(engagementsTable.id, d.blockerEngagementId));
      if (x && x.s !== "signed_off") return true;
    }
    if (d.blockerDecisionId) {
      const [x] = await db.select({ s: decisionsTable.status }).from(decisionsTable).where(eq(decisionsTable.id, d.blockerDecisionId));
      if (x?.s === "open") return true;
    }
    if (d.blockerTicketId) {
      const [x] = await db.select({ s: tickets.systemState }).from(tickets).where(eq(tickets.id, d.blockerTicketId));
      if (x && x.s !== "done") return true;
    }
  }
  return false;
}

/**
 * A worker moves only its own tickets (BOS-73): assigned to it, a sub-task of one assigned to it, or one it
 * created that nobody holds yet. Cancelling skips review and merge, so only the CEO or a manager may.
 */
async function moveRefusal(db: Db, scope: Scope, ticketId: string, cancelling: boolean): Promise<string | null> {
  if (await managerIn(db, scope)) return null;
  if (cancelling) return "Only your CEO or a manager can cancel a ticket. If it should be dropped, nudge them with the reason.";
  const [t] = await db.select({ assignee: tickets.assigneeAgentId, createdBy: tickets.createdByAgentId, parentId: tickets.parentTicketId }).from(tickets).where(and(eq(tickets.id, ticketId), eq(tickets.companyId, scope.companyId)));
  if (!t) return "No ticket with that ID in your company.";
  const me = scope.agentId;
  if (me && (t.assignee === me || (!t.assignee && t.createdBy === me))) return null;
  const [parent] = me && t.parentId ? await db.select({ assignee: tickets.assigneeAgentId }).from(tickets).where(eq(tickets.id, t.parentId)) : [];
  if (me && parent?.assignee === me) return null;
  return "That ticket isn't yours: you can move only tickets assigned to you and sub-tasks of them. If it needs to move, tell its assignee or your CEO (ticket_reply on it, or nudge them).";
}
