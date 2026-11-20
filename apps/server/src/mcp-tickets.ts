// The ticket tools, moved out of mcp.ts unchanged (BOS-298 step 15): create_ticket, update_ticket,
// assign_ticket, set_ticket_state, set_ticket_risk, schedule_check and clear_check. Registered from the
// same places and in the same order as before, so every kind of run sees the same tools.
import { and, asc, eq, gt, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { addsUsabilityCriterion, WATCH_DEFAULT_DAYS, WATCH_MAX_DAYS, REAL_USE_ASK, USABILITY_ADDED_NOTE, withUsabilityCriterion, goLiveWaitWords, type GoLiveWait, acceptanceCriteriaSchema, criterionText, pageClauseRefusal, pageClauses, BLOCKED_UNTIL_MAX_DAYS, BLOCKED_UNTIL_MAX_MS, BLOCKED_UNTIL_REASON_MAX, criteriaText, failedAfterMerge, isAfterMerge, isTaskSize, readCriteria, missingVerdicts, planFirstByDefault, RISK_TIERS, SIZE_SCALE, unreportedAfterMerge } from "@boss-man/shared";
import type { Db } from "./db/client.js";
import { agents, decisions as decisionsTable, engagements as engagementsTable, features, projects, reviewRequests, runs as runsTable, ticketDependencies, ticketImages, tickets, workflowColumns } from "./db/schema.js";
import { record } from "./services/activity.js";
import { FIXES_LIVE_MAX, fixesLiveProblem } from "./services/decisions.js";
import { LINT_OVERRIDE_HELP, type LintOverrideInput, lintOverrideSchema, parseStoredOverride } from "./services/lint-override.js";
import { HOST_TOKEN_HELP, type OwnerSetupFacts, SETUP_LINE_MAX, ownerSetupFacts, ownerSetupShapeProblem, ownerSetupWriteCheck } from "./services/owner-setup-check.js";
import { loadCompanyFacts } from "./services/company-facts.js";
import { splitSteps } from "./services/runner-image.js";
import { EngagementError } from "./services/engagements.js";
import { FOLLOW_UP_HELP, followUpsSchema, handOffRefusal, openFollowUps, resolveFollowUpAssignees } from "./services/hand-offs.js";
import { getHold, WRAP_UP } from "./services/maintenance.js";
import { NOTHING_CHANGED, ReviewError } from "./services/review.js";
import { reviewTicketWriteRefusal } from "./services/skill-proposals.js";
import { wipQueuedNote } from "./services/agent-wip.js";
import { moveTicket } from "./services/ticket-moves.js";
import { ceoMoveNote, ceoPlanText, IN_PROGRESS_BLOCKED_WARNING, leavesPlan, planMoveWarning, REVIEW_BLOCKED_REFUSAL, unexpiredPlan, urgentBackwards } from "./services/ceo-plan.js";
import { conflictNote } from "./services/merge-line-conflicts.js";
import { checkTicketDoneRefusal } from "./services/after-merge-check-tickets.js";
import { CARD_CITE_REFUSAL, hostFactRefusal, pageShotRefusal, uncitedCardPasses } from "./services/host-fact-gate.js";
import { addTicketDependency, blockedHolds, openBlockers, openCardIds, openOwnerOnlyCard } from "./services/ticket-links.js";
import { noteBlockedPark, refusalForNamedAgent } from "./services/blocked-who-acts.js";
import { githubOnlyMarkWarning } from "./services/line-holder.js";
import { OWNER_WAIT_REFUSAL, WAIT_LINK_REFUSAL, ticketHasOpenCard, waitsForNote, waitsOnOwnerNote } from "./services/owner-todo.js";
import { systemMoveTicket } from "./services/ticket-transition.js";
import { SIGNED_OFF_HEAD_REFUSAL, signedOffHeadOutsideReview } from "./services/signoff.js";
import { SETUP_CARD_RAISED, staleVersionMessage, startRefusal, WorkError } from "./services/work.js";
import { criteriaWarning, delegateTarget, findProject, fail, FINISHED_STAYS_IN_REVIEW, FIXES_LIVE_HELP, FIXES_MERGE_CHECK_HELP, managerIn, planningIn, REF, stagingTexts, stagingWarning, STATES, waitsOnAdvice, text, thinTicketWarning, treeRefusal, unlinkedOrderWarning, type Scope } from "./mcp-common.js";
import type { McpHooks, Services } from "./mcp.js";
import { CHAT_REASON } from "./services/chat.js";
import { dueChatReport, setReportInChat } from "./services/chat-report-back.js";

/** The state note after update_ticket replaces the criteria: the old note's verdicts belong to the old list, so none carries over. */
const CRITERIA_REPLACED_NOTE = "The CEO replaced this ticket's acceptance criteria. Report each one again.";

// A run that had no ticket now works on one: say so on the run (BOS-254). Never blocks the tool.
const runTicketNoter = (scope: Scope, hooks: McpHooks) => (ticketId: string) => (scope.agentId ? Promise.resolve(hooks.onRunTicket?.(ticketId, scope.runId)).catch(() => undefined) : undefined);

/** The words every ownerSetup field adds to its help (DR-052). */
const SETUP_HELP = `${HOST_TOKEN_HELP} Each step is checked like an owner card when you write it; a vague host step (".env" with no path, "restart the add-on" with no command or button path) is refused. lintOverride (CEO only) lets a wrong finding through with a reason. With steps, also give ownerSetupWhy (what it changes for the owner) and ownerSetupIfSkipped (what happens if they skip it, or "nothing breaks"): the go-live card opens with them. No "If …", "Only if …", "Unless …" or "nothing to do" in a step: start a step that applies only sometimes with [when <fact>] (known facts: network guard allow line can go) and Boss Man keeps or drops it from its own record at go-live.`;
const LINT_OVERRIDE = lintOverrideSchema.optional().describe(`${LINT_OVERRIDE_HELP} The reason is for the owner, to let ownerSetup past a card-check finding you judge wrong. It can't let through a command that isn't copy-safe or a value Boss Man doesn't have. Rewriting the steps without it clears it.`);

/** BOS-1650: the two one-line fields the go-live card opens with. Required whenever a ticket has setup steps. */
const SETUP_WHY = z.string().max(SETUP_LINE_MAX).optional().describe("Required with ownerSetup: one line on what the setup changes for the owner (the go-live card opens with it).");
const SETUP_IF_SKIPPED = z.string().max(SETUP_LINE_MAX).optional().describe('Required with ownerSetup: one line on what happens if the owner skips it, or "nothing breaks" when that is true (the go-live card opens with it).');

/**
 * BOS-1650: the refusal when a ticket would have setup steps without a why or an if-skipped line, from what is
 * being written merged with what is stored; null when fine or when none of the three fields is being written.
 */
async function setupShapeFail(db: Db, ticketId: string | null, w: { ownerSetup?: string | null; why?: string; ifSkipped?: string }, always = false): Promise<string | null> {
  if (!always && w.ownerSetup === undefined && w.why === undefined && w.ifSkipped === undefined) return null;
  const [stored] = ticketId ? await db.select({ steps: tickets.ownerSetup, why: tickets.ownerSetupWhy, ifSkipped: tickets.ownerSetupIfSkipped }).from(tickets).where(eq(tickets.id, ticketId)) : [];
  const steps = splitSteps(w.ownerSetup !== undefined ? (w.ownerSetup ?? "") : (stored?.steps ?? ""));
  return ownerSetupShapeProblem(steps, w.why !== undefined ? w.why : stored?.why, w.ifSkipped !== undefined ? w.ifSkipped : stored?.ifSkipped);
}

/**
 * DR-052 point 1: the card check on a ticket's owner setup steps, as they are written. Blank steps (none) pass.
 * Returns the refusal, or the CEO override to store with the steps (null when none was needed).
 */
async function checkSetupWrite(db: Db, hostFacts: Services["hostFacts"] | undefined, scope: Scope, ownerSetup: string | null | undefined, lintOverride: LintOverrideInput | undefined) {
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

/**
 * BOS-2075: the reviewers whose approval let a ticket merge (the last round with an approval), so a correction of its
 * setup steps after merge reaches the people who passed the old ones. The caller is left out.
 */
async function approvingReviewers(db: Db, ticketId: string, except: string | null) {
  const rows = await db.select({ agentId: reviewRequests.reviewerAgentId, round: reviewRequests.round }).from(reviewRequests).where(and(eq(reviewRequests.ticketId, ticketId), eq(reviewRequests.status, "approved")));
  const last = Math.max(...rows.map((r) => r.round));
  return [...new Set(rows.filter((r) => r.round === last && r.agentId && r.agentId !== except).map((r) => r.agentId!))];
}

/** Where set_ticket_state sends a correction of a merged ticket's steps: update_ticket logs a reason and tells the reviewers. */
const MERGED_SETUP_VIA_UPDATE = 'This ticket is merged. Its setup steps can still be corrected until the owner\'s "Ready to use" card is raised, by its assignee or the CEO, with update_ticket ownerSetup and a reason: the steps are checked like an owner card again, the reason goes on the ticket, and the reviewers who approved are told. set_ticket_state can\'t change them now.';

/** assign_ticket, set_ticket_risk and create_ticket for a run. */
export function registerTicketAdmin(server: McpServer, db: Db, { work, engagements, feedback, hostFacts, review }: Pick<Services, "work" | "engagements" | "feedback"> & Partial<Pick<Services, "hostFacts">> & Pick<Services, "review">, scope: Scope, hooks: McpHooks = {}) {
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
        waitsOn: z.union([z.string().uuid(), z.array(z.string().uuid()).min(1).max(10)]).optional().describe("One ticket id, or a list of ids, this ticket waits on. If the text says it comes after BOS-n, link BOS-n here."),
        waitsOnUntil: z.enum(["merged", "done"]).optional().describe("With waitsOn: when each wait ends, the other ticket's merge on main (merged, the default) or its done state (done)."),
        acceptanceCriteria: acceptanceCriteriaSchema.optional().describe("What done looks like, as checks someone could run: a string each (checked before merge), or {text, after: \"merge\"} for a check only a live host can settle; up to 10. A feature's ticket, or one with ownerSetup, gets a built-in \"Usability gate\" criterion added (does it deliver its value in real use without the owner on hand: day 1, after routine updates and restarts, a week on); don't write your own."),
        noCode: z.boolean().optional().describe("true for research, wiki, docs or deploy-only work that changes nothing in the repository; such a ticket can reach review and be closed with an empty diff. Leave it off for anything that changes code."),
        ownerSetup: z.string().max(4000).optional().describe(`What the owner has to do once this change is live (a setting, a secret, a button), in plain words by button path, one step per line, e.g. Settings → Funding → Add funding source. Boss Man raises their card with these steps only when the change goes live, not at merge. Leave it off when there is nothing for them to do. ${SETUP_HELP}`),
        ownerSetupWhy: SETUP_WHY,
        ownerSetupIfSkipped: SETUP_IF_SKIPPED,
        lintOverride: LINT_OVERRIDE,
        fixesLive: z.string().max(FIXES_LIVE_MAX).optional().describe(FIXES_LIVE_HELP),
        checksCriterion: z
          .object({ ticket: z.string().uuid(), criterion: z.number().int().min(1).max(10) })
          .optional()
          .describe("Make this the check for one after-merge criterion of another ticket (its id, and the criterion's number in its list), when that criterion needs a later event. That ticket's assignee, the CEO or a manager may do it. That ticket then waits on this one until done; when this one is done, its pass or fail (fail if any of its own criteria failed, pass if all passed) is written on that criterion and that ticket's assignee is woken. Without acceptanceCriteria this ticket gets that criterion's text as its own."),
      },
    },
    async ({ title, body, project, size, engagementId, risk, planFirst, feature, parent, assignee, waitsOn: waitsOnGiven, waitsOnUntil, acceptanceCriteria: criteriaGiven, noCode, ownerSetup, ownerSetupWhy, ownerSetupIfSkipped, lintOverride, fixesLive, checksCriterion, ...rest }) => {
      // BOS-1794: a check split out of a merged ticket's after-merge criterion, linked so it reports back when it closes.
      let checked: { id: string; text: string } | null = null;
      if (checksCriterion) {
        const [target] = await db.select().from(tickets).where(and(eq(tickets.id, checksCriterion.ticket), eq(tickets.companyId, scope.companyId)));
        if (!target) return fail(`No ticket ${checksCriterion.ticket} in your company for checksCriterion.`);
        if (target.systemState === "done") return fail("That ticket is already done, so it has no criterion left to check.");
        if (target.assigneeAgentId !== scope.agentId && !(await isManager())) return fail("Only that ticket's assignee, the CEO or a manager can split a check out of its criterion.");
        if (parent && parent !== target.id) return fail("A check ticket can be a sub-task only of the ticket it checks: leave parent off, or set it to that ticket.");
        const c = readCriteria(target.acceptanceCriteria)[checksCriterion.criterion - 1];
        if (!c) return fail(`That ticket has no criterion ${checksCriterion.criterion}.`);
        if (!isAfterMerge(c)) return fail(`Criterion ${checksCriterion.criterion} of that ticket ("${criterionText(c)}") is checked before merge, in review; only an after-merge criterion can be split out to a check ticket.`);
        checked = { id: target.id, text: criterionText(c) };
      }
      const acceptanceCriteria = criteriaGiven?.length || !checked ? criteriaGiven : [checked.text];
      const waitsOn = [...new Set(typeof waitsOnGiven === "string" ? [waitsOnGiven] : (waitsOnGiven ?? []))];
      const badFix = fixesLive ? fixesLiveProblem(fixesLive) : null;
      if (badFix) return fail(badFix);
      const badPage = pageClauseRefusal(acceptanceCriteria ?? []);
      if (badPage) return fail(badPage);
      const setup = await checkSetupWrite(db, hostFacts, scope, ownerSetup, lintOverride);
      if (setup.error !== null) return fail(setup.error);
      const shapeFail = await setupShapeFail(db, null, { ownerSetup, why: ownerSetupWhy, ifSkipped: ownerSetupIfSkipped });
      if (shapeFail) return fail(shapeFail);
      if (scope.agentId && !isTaskSize(size)) return fail(`${size === undefined ? "A ticket you create needs a size" : `${size} is not a size`}: ${SIZE_SCALE}, relative to the tickets your team has finished. Call sizing_guide to see finished tickets of each size, pick the one yours is most like, then call create_ticket again with size.`);
      const out = await outsideTree(parent);
      if (out) return fail(`${out} Pass parent (a ticket in the tree) to add a sub-task.`);
      // Attaching a sub-task to an open skill-review task, or making a ticket wait on it, is a way
      // into the reviewer's tree: only the reviewer assigned to the review may do it (BOS-86, round 10).
      for (const linked of [parent, ...waitsOn]) {
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
      const blockers = waitsOn.length ? await db.select({ id: tickets.id, state: tickets.systemState, number: tickets.number }).from(tickets).where(and(inArray(tickets.id, waitsOn), eq(tickets.companyId, scope.companyId))) : [];
      for (const id of waitsOn) if (!blockers.some((b) => b.id === id)) return fail(`No task with the waitsOn id ${id} in your company.`);
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
      // BOS-1571: a feature's ticket, or one with owner setup steps, carries the usability gate without anyone remembering it.
      const gate = { featureId, ownerSetup, noCode };
      const gateAdded = addsUsabilityCriterion(acceptanceCriteria ?? [], gate);
      const criteria = withUsabilityCriterion(acceptanceCriteria ?? [], gate);
      const [t] = await db
        .insert(tickets)
        .values({ companyId: scope.companyId, projectId: p.id, title, body, engagementId: engagementId ?? null, createdByAgentId: scope.agentId, risk: risk ?? null, size: isTaskSize(size) ? size : null, planFirst: planFirst ?? (risk ? planFirstByDefault(risk) : false), featureId, parentTicketId: parentTask?.id ?? null, ...(checked ? { checksTicketId: checked.id, checksCriterion: checksCriterion!.criterion } : {}), ...(criteria.length ? { acceptanceCriteria: criteria } : {}), ...(noCode ? { noCode } : {}), ...(ownerSetup?.trim() ? { ownerSetup: ownerSetup.trim(), ownerSetupOverride: setup.override, ownerSetupWhy: ownerSetupWhy?.trim() || null, ownerSetupIfSkipped: ownerSetupIfSkipped?.trim() || null } : {}), ...(fixesLive?.trim() ? { fixesLive: fixesLive.trim() } : {}) })
        .returning({ id: tickets.id });
      // Held through moveTicket (DR-047 point 5, BOS-922): the column and the history line follow, not a blocked insert.
      if (parentTask) await work.waitOnSubtask(parentTask, t!.id, scope.agentId);
      // The checked ticket waits on its check until done (a sub-task link already does that), so it is held in Blocked and woken.
      if (checked && parentTask?.id !== checked.id) await work.addDependency(checked.id, { ticketId: t!.id, until: "done" }, scope.agentId);
      for (const id of waitsOn) await work.addDependency(t!.id, { ticketId: id, until: waitsOnUntil ?? "merged" }, scope.agentId);
      // Held only while something still blocks it: a blocker already merged (until merged) holds nothing (BOS-1458).
      if (waitsOn.length && (await openBlockers(db, t!.id)).some((b) => b.kind === "ticket")) await systemMoveTicket(db, { ticketId: t!.id, from: ["backlog"], to: "blocked", reason: "Boss Man: created waiting on another ticket", now: new Date() });
      await feedback.syncFeature(featureId);
      await record(db, { companyId: scope.companyId, agentId: scope.agentId, ticketId: t!.id, kind: "ticket_created", summary: `Created "${title}" in ${p.name}` });
      if (to) await work.updateTicket(t!.id, { assigneeAgentId: to.id, byAgentId: scope.agentId });
      // A code ticket nobody can pick up cleanly gets a nudge, but it is still created (BOS-595).
      const thin = noCode ? "" : thinTicketWarning(body, assignee);
      const checkNote = checked ? ` It is the check for criterion ${checksCriterion!.criterion} of ticket ${checked.id}, which now waits on it until done; when it is done, its pass or fail is recorded on that criterion and that ticket's assignee is woken.${to ? "" : " Ask your CEO to assign it."}` : "";
      return text(`Created ticket ${t!.id} in ${p.name}${assignee ? `, assigned to ${assignee}` : ""}.${checkNote}${gateAdded ? ` ${USABILITY_ADDED_NOTE}` : ""}${await wipQueuedNote(db, t!.id)}${criteriaWarning(acceptanceCriteria)}${await stagingWarning(db, scope.companyId, stagingTexts(acceptanceCriteria, body))}${thin}${unlinkedOrderWarning([title, body], new Set(blockers.flatMap((b) => (b.number === null ? [] : [b.number]))))}`);
    },
  );
}

export function registerScheduleCheck(server: McpServer, db: Db, { work, review }: Pick<Services, "work" | "review">, scope: Scope, hooks: McpHooks) {
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
      // BOS-1879: polling a signed-off head outside review only makes the ticket look active.
      const [asked] = await db.select().from(tickets).where(and(eq(tickets.id, ticketId), eq(tickets.companyId, scope.companyId)));
      if (asked && (await signedOffHeadOutsideReview(db, asked, (id) => review.diff(id, scope.companyId).then((d) => d.head || null)))) return fail(SIGNED_OFF_HEAD_REFUSAL);
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
export function registerTicketMoves(server: McpServer, db: Db, { review, work, feedback, hostFacts, checkRequests }: Pick<Services, "review" | "work" | "feedback" | "skillProposals"> & Partial<Pick<Services, "hostFacts" | "checkRequests">>, scope: Scope, hooks: McpHooks, chat: boolean) {
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
        "For CEOs and managers (a product manager may use only featureId, to attach any ticket to a feature or take it out): reorganise one of your company's tickets. Move it to another project (project: name or id; its sub-tasks go with it; not while it is in progress or in review), put it under a feature (featureId, or null to take it out), make it a sub-task of a task (parentTicketId, or null to take it out; it joins the parent's feature and the parent waits on it), fix its title or description, or set who it is assigned to (assignee: an agent's name, or null to leave it unassigned; the new assignee is woken), or mark it as not needing code (noCode true for research, wiki, docs or deploy-only work, so it can reach review with an empty diff; false to clear it), or mark it urgent (urgent true: it always passes the subscription quota hold; false to clear it), or add or clear the owner's setup steps (ownerSetup: what they do once this is live, in plain words by button path; null to clear; the ticket's own assignee may also send ownerSetup alone; after merge only the assignee or the CEO may correct them, until the owner's card is raised at go-live), or mark that it fixes a live problem (fixesLive: one sentence naming the symptom; null to clear), or mark it as the fix for a broken merge check (fixesMergeCheck true: other approved work waits on it in review instead of being checked and sent back; false to clear), or change its size (1, 2, 3, 5 or 8; null to clear it; compare with sizing_guide first), or (CEO only) set a plan with a deadline (ceoPlan and ceoPlanDeadline: the looks-stuck alert stays quiet until the deadline plus a grace, then one card says it passed; ceoPlan null clears it), or (CEO only, on its own) mark a merged ticket live (markLive: the commit sha or a short note), when your company puts its own work live rather than through the Boss Man server update. Give at least one change and a reason up to 240 characters; the reason is kept on the ticket. Pass expected_version so it is refused if the ticket changed since you read it. To close a duplicate, use set_ticket_state done with outcome cancelled.",
      inputSchema: {
        ticketId: z.string().uuid(),
        project: z.string().min(1).optional(),
        featureId: z.string().uuid().nullable().optional(),
        parentTicketId: z.string().uuid().nullable().optional(),
        title: z.string().trim().min(1).max(200).optional(),
        body: z.string().max(10_000).optional(),
        assignee: z.string().min(1).nullable().optional(),
        noCode: z.boolean().optional(),
        ownerSetup: z.string().max(4000).nullable().optional().describe(`What the owner has to do once this change is live, in plain words by button path, one step per line. Null or an empty string clears it. The ticket's own assignee may send it alone (with ownerSetupWhy and ownerSetupIfSkipped). Once the ticket is merged, only its assignee or the CEO may correct it, and only until Boss Man raises the owner's "Ready to use" card from it at go-live: the steps are checked like an owner card again, your reason goes on the ticket, and the reviewers who approved are told. After that card is raised it is frozen; only the owner changes it on the ticket page. ${SETUP_HELP}`),
        ownerSetupWhy: SETUP_WHY,
        ownerSetupIfSkipped: SETUP_IF_SKIPPED,
        lintOverride: LINT_OVERRIDE,
        urgent: z.boolean().optional(),
        fixesLive: z.string().max(FIXES_LIVE_MAX).nullable().optional().describe(`${FIXES_LIVE_HELP} Null or an empty string clears it.`),
        size: z.number().nullable().optional(),
        fixesMergeCheck: z.boolean().optional().describe(FIXES_MERGE_CHECK_HELP),
        ceoPlan: z.string().trim().min(1).max(2000).nullable().optional().describe("The CEO's plan for this ticket, in plain words. Needs ceoPlanDeadline. While the plan stands the \"looks stuck\" alert stays quiet; after the deadline plus a short grace one card says the deadline passed. Null clears the plan. Only the CEO sets it."),
        ceoPlanDeadline: z.string().datetime({ offset: true }).nullable().optional().describe("When the plan should be done (ISO 8601 with a time zone, in the future, within 30 days). Required with ceoPlan."),
        waitsOn: z.object({
          add: z.array(z.string().min(1).max(40)).max(10).optional().describe("Tickets (BOS-12 or id) this ticket should wait on."),
          addCards: z.array(z.string().uuid()).max(10).optional().describe("Ids of open question cards (decisions) this ticket waits on, for a wait that the owner's answer settles. When the card is answered, this ticket is released and its assignee woken with the answer, so use this rather than raising a second card or only writing the wait in a note (BOS-1591)."),
          remove: z.array(z.string().min(1).max(40)).max(10).optional().describe("Tickets (BOS-12 or id) this ticket should stop waiting on."),
          until: z.enum(["merged", "done"]).optional().describe("When the wait on the tickets in add ends: their merge on main (merged, the default) or their done state (done)."),
        }).optional().describe("Add or remove \"waits on\" links on this ticket. When the point in until is reached (merge commit on main, or done), this ticket's assignee is woken. On approved work in review, the link also holds the merge: it waits as \"Passed, held\" with its approvals kept and merges by itself once the linked ticket is merged and live. Besides the CEO and managers, the ticket's own assignee may use this on their own ticket."),
        acceptanceCriteria: acceptanceCriteriaSchema.optional().describe("Replaces the ticket's tracked acceptance criteria, in the shape create_ticket takes (a string, or {text, after: \"merge\"}); up to 10, empty clears them. Every criterion goes back to not reported (the old pass/fail verdicts in the state note are dropped), and the change and your reason are kept in the ticket history. If the ticket is in review, reviews are not re-requested: tell the assignee and reviewers."),
        markLive: z.string().max(300).optional().describe("CEO only, on its own: say a merged ticket is live, for a company that puts its own work live (not through the Boss Man server update). Give the evidence: the commit sha that went live, or a short note of how it went live. Its go-live wait ends and the assignee is woken to report the after-merge checks."),
        reportInChat: z.boolean().optional().describe("CEO only, on its own: true marks the ticket as asked for in chat, so when it closes or hands out follow-ups your chat is woken to report back to the owner there (and Boss Man posts a line if you don't); false clears the mark. Boss Man sets it by itself on a ticket a chat run creates or changes (R52)."),
        reason: z.string().trim().min(1).max(240),
        expected_version: z.number().int().optional(),
      },
    },
    async ({ ticketId, project, featureId, parentTicketId, title, body, assignee, noCode, ownerSetup, ownerSetupWhy, ownerSetupIfSkipped, lintOverride, urgent, fixesLive, size, fixesMergeCheck, acceptanceCriteria, waitsOn, ceoPlan, ceoPlanDeadline, markLive, reportInChat, reason, expected_version }) => {
      // R52: the CEO sets or clears "report back in chat" on one ticket, as its own call.
      if (reportInChat !== undefined) {
        const [me] = scope.agentId ? await db.select({ role: agents.role, name: agents.name }).from(agents).where(and(eq(agents.id, scope.agentId), eq(agents.companyId, scope.companyId))) : [];
        if (me?.role !== "ceo" || !scope.agentId) return fail("Only the CEO sets or clears report-back-in-chat on a ticket.");
        if (!(await setReportInChat(db, scope.companyId, ticketId, reportInChat, scope.agentId))) return fail("No ticket with that ID in your company.");
        await record(db, { companyId: scope.companyId, agentId: scope.agentId, ticketId, kind: "reorganised", summary: `${me.name} ${reportInChat ? "marked it to be reported back in chat" : "cleared its report back in chat"}: ${reason}` });
        return text(reportInChat ? "Marked: when this ticket closes or hands out follow-ups, your chat is woken to report it to the owner." : "Cleared: this ticket is no longer reported back in chat.");
      }
      const badPage = acceptanceCriteria ? pageClauseRefusal(acceptanceCriteria) : null;
      if (badPage) return fail(badPage);
      const manager = await isManager();
      const otherChange = project !== undefined || featureId !== undefined || parentTicketId !== undefined || title !== undefined || body !== undefined || assignee !== undefined || noCode !== undefined || ownerSetup !== undefined || urgent !== undefined || fixesLive !== undefined || size !== undefined || acceptanceCriteria !== undefined || ceoPlan !== undefined || ceoPlanDeadline !== undefined || fixesMergeCheck !== undefined;
      // BOS-1345: marking a merge live is its own call, CEO only: it ends the go-live wait of a company that puts its own work live.
      if (markLive !== undefined) {
        const [me] = scope.agentId ? await db.select({ role: agents.role, name: agents.name }).from(agents).where(and(eq(agents.id, scope.agentId), eq(agents.companyId, scope.companyId))) : [];
        if (me?.role !== "ceo") return fail("Only the CEO marks a merged ticket live.");
        if (otherChange || waitsOn !== undefined) return fail("markLive goes on its own: mark the ticket live in one call, then make any other change in another.");
        const [cur] = await db.select({ version: tickets.version }).from(tickets).where(and(eq(tickets.id, ticketId), eq(tickets.companyId, scope.companyId)));
        if (!cur) return fail("No ticket with that ID in your company.");
        if (expected_version !== undefined && cur.version !== expected_version) return fail(await staleVersionMessage(db, scope.companyId, ticketId, expected_version));
        try {
          const r = await review.markLive(ticketId, scope.companyId, { evidence: markLive, by: me.name });
          await record(db, { companyId: scope.companyId, agentId: scope.agentId, ticketId, kind: "reorganised", summary: `${me.name} marked it live: ${reason}` });
          return text(`Marked live. ${r.woken ? "The wait for go-live ended and the assignee was woken to report the after-merge checks." : r.wasWaiting ? "The wait for go-live ended; the assignee had nothing left to report." : "It wasn't waiting for go-live; the evidence is recorded on the ticket."}`);
        } catch (err) {
          if (err instanceof ReviewError) return fail(err.message);
          throw err;
        }
      }
      // A ticket's own assignee may order their own ticket (BOS-989): waitsOn alone, nothing else.
      // A product manager may attach a task to a feature or detach it (BOS-1359): featureId alone, on any ticket; nothing else.
      const featureOnly = !manager && featureId !== undefined && (await planningIn(db, scope)) && project === undefined && parentTicketId === undefined && title === undefined && body === undefined && assignee === undefined && noCode === undefined && ownerSetup === undefined && urgent === undefined && fixesLive === undefined && size === undefined && acceptanceCriteria === undefined && ceoPlan === undefined && ceoPlanDeadline === undefined && fixesMergeCheck === undefined && waitsOn === undefined;
      // BOS-2075: the assignee may also correct their own ticket's setup steps (with their why and if-skipped lines) alone,
      // the way to fix a merged ticket's steps before the owner's card is raised; work.ts decides whether they're frozen.
      const setupOnly = !manager && ownerSetup !== undefined && project === undefined && featureId === undefined && parentTicketId === undefined && title === undefined && body === undefined && assignee === undefined && noCode === undefined && urgent === undefined && fixesLive === undefined && size === undefined && acceptanceCriteria === undefined && ceoPlan === undefined && ceoPlanDeadline === undefined && fixesMergeCheck === undefined && waitsOn === undefined;
      if (!manager && !featureOnly && !setupOnly && (otherChange || waitsOn === undefined || !scope.agentId)) return fail("Only your company's CEO or a manager can reorganise tickets. Your own ticket's assignee can change its waitsOn, or its ownerSetup alone. A product manager can attach a ticket to a feature or detach it (featureId alone).");
      if (setupOnly && !scope.agentId) return fail("Only an agent's run can change a ticket's setup steps here.");
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
      if (waitsOn !== undefined && !waitsOn.add?.length && !waitsOn.remove?.length && !waitsOn.addCards?.length) return fail("waitsOn needs add, addCards or remove: tickets (BOS-12 or id) or open card ids.");
      for (const cardId of waitsOn?.addCards ?? []) {
        const [card] = await db.select({ status: decisionsTable.status, kind: decisionsTable.kind }).from(decisionsTable).where(and(eq(decisionsTable.id, cardId), eq(decisionsTable.companyId, scope.companyId)));
        if (!card) return fail(`waitsOn addCards: no card ${cardId} in your company.`);
        if (card.status !== "open") return fail(`waitsOn addCards: card ${cardId} is already answered or closed, so there is nothing to wait for. Read its answer (decisions read) and act on it.`);
        if (card.kind !== "question") return fail(`waitsOn addCards: card ${cardId} is not a question card; only a question the owner answers can release a ticket.`);
      }
      if (waitsOn?.until && !waitsOn.add?.length) return fail("waitsOn until goes with add.");
      const [t] = await db.select({ version: tickets.version, state: tickets.systemState, assignee: tickets.assigneeAgentId, mergeCommit: tickets.mergeCommit, ownerSetup: tickets.ownerSetup }).from(tickets).where(and(eq(tickets.id, ticketId), eq(tickets.companyId, scope.companyId)));
      if (!t) return fail("No ticket with that ID in your company.");
      if (!manager && !featureOnly && t.assignee !== scope.agentId) return fail(setupOnly ? "Only your company's CEO or a manager, or the ticket's own assignee, can change its setup steps." : "Only your company's CEO or a manager, or the ticket's own assignee, can change what a ticket waits on.");
      // BOS-2075: a merged ticket's steps changed before the owner's card (work.ts refuses it once the card is raised).
      const setupCorrected = ownerSetup !== undefined && !!t.mergeCommit && (ownerSetup?.trim() || null) !== (t.ownerSetup?.trim() || null);
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
      // BOS-1650: why and if-skipped travel with the steps here (a ticket with neither alone: set_ticket_state).
      if (ownerSetup === undefined && (ownerSetupWhy !== undefined || ownerSetupIfSkipped !== undefined)) return fail("ownerSetupWhy and ownerSetupIfSkipped go with ownerSetup here (send the steps again with them), or use set_ticket_state to change only those.");
      const shapeFail = await setupShapeFail(db, ticketId, { ownerSetup, why: ownerSetupWhy, ifSkipped: ownerSetupIfSkipped });
      if (shapeFail) return fail(shapeFail);
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
        const u =noFieldWrite ?{ version: t.version } : await work.updateTicket(ticketId, { byAgentId: scope.agentId, expectedVersion: expected_version, ...(assigneeId !== undefined ? { assigneeAgentId: assigneeId } : {}), ...(p ? { projectId: p.id } : {}), ...(featureId !== undefined ? { featureId } : {}), ...(parentTicketId !== undefined ? { parentTicketId } : {}), ...(title !== undefined ? { title } : {}), ...(body !== undefined ? { body } : {}), ...(noCode !== undefined ? { noCode } : {}), ...(ownerSetup !== undefined ? { ownerSetup, ownerSetupOverride: setup?.error === null ? setup.override : null, ...(ownerSetupWhy !== undefined ? { ownerSetupWhy } : {}), ...(ownerSetupIfSkipped !== undefined ? { ownerSetupIfSkipped } : {}) } : {}), ...(urgent !== undefined ? { urgent } : {}), ...(fixesLive !== undefined ? { fixesLive } : {}), ...(size !== undefined ? { size } : {}), ...(acceptanceCriteria !== undefined ? { acceptanceCriteria, stateNote: CRITERIA_REPLACED_NOTE } : {}) });
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
        for (const cardId of waitsOn?.addCards ?? []) {
          const [has] = await db.select({ id: ticketDependencies.id }).from(ticketDependencies).where(and(eq(ticketDependencies.blockedTicketId, ticketId), eq(ticketDependencies.blockerDecisionId, cardId))).limit(1);
          if (!has) await addTicketDependency(db, { companyId: scope.companyId, blockedTicketId: ticketId, blockerDecisionId: cardId, actor: { type: "agent", agentId: scope.agentId ?? null }, hold: true });
          waitsLines.push(`waits on card ${cardId}`);
        }
        const [me] = scope.agentId ? await db.select({ name: agents.name }).from(agents).where(eq(agents.id, scope.agentId)) : [];
        await record(db, { companyId: scope.companyId, agentId: scope.agentId, ticketId, kind: "reorganised", summary: `${me?.name ?? "An agent"} reorganised it${!planGiven ? "" : ceoPlan ? ` (plan set, due ${ceoPlanDeadline})` : " (plan cleared)"}${noCode === undefined ? "" : noCode ? " (marked no code)" : " (no longer marked no code)"}${urgent === undefined ? "" : urgent ? " (marked urgent)" : " (no longer urgent)"}${fixesLive === undefined ? "" : fixesLive?.trim() ? ` (fixes live: ${fixesLive.trim()})` : " (no longer marked fixes live)"}${fixesMergeCheck === undefined ? "" : fixesMergeCheck ? " (marked as fixing the merge check: approved work in the project waits on it in Passed, held)" : " (no longer marked as fixing the merge check)"}${size === undefined ? "" : size === null ? " (size cleared)" : ` (size ${size})`}${ownerSetup === undefined ? "" : setupCorrected ? ` (owner setup steps corrected after merge, before the owner's card; they passed the card check again${ownerSetup?.trim() ? "" : " and are now cleared"})` : ownerSetup?.trim() ? " (owner setup steps changed)" : " (owner setup steps cleared)"}${acceptanceCriteria === undefined ? "" : ` (acceptance criteria replaced: ${acceptanceCriteria.length ? acceptanceCriteria.map((c, i) => `${i + 1}. ${criteriaText([c])}`).join(" ") : "none now"})`}${waitsLines.length ? ` (${waitsLines.join("; ")})` : ""}: ${reason}` });
        await noteRunTicket(ticketId);
        // BOS-2075: the reviewers who passed the old steps hear of the correction, so one who thinks it wrong can say so before go-live.
        const told = setupCorrected ? await approvingReviewers(db, ticketId, scope.agentId) : [];
        for (const reviewerId of told) {
          await Promise.resolve(hooks.wake?.(reviewerId, { reason: "setup steps corrected", ticketId, causedByRunId: scope.runId, note: `${me?.name ?? "An agent"} corrected the owner's setup steps on a ticket you approved, after it merged and before the owner's card went out. Reason: ${reason}\nNew steps:\n${ownerSetup?.trim() || "(none: cleared)"}\nOld steps:\n${t.ownerSetup?.trim() || "(none)"}\nIf the new steps are wrong, say so on the ticket (ticket_reply) and tell the CEO; nothing else is needed.` })).catch(() => undefined);
        }
        // Marking it urgent (BOS-1411, warning 2): a real conflict with a ticket ahead in the merge line is said here,
        // where the order gets chosen. Read-only; nothing is linked, and the merge is not held.
        const urgentNote = urgent === true ? await conflictWarning(review, ticketId).catch(() => "") : "";
        // R40: marking a main-CI ticket says what the mark will and won't hold. Advice only.
        const markNote = fixesMergeCheck === true ? await githubOnlyMarkWarning(db, ticketId).catch(() => "") : "";
        // The new title or body says "after BOS-n" with no link to it (BOS-1375): advice only, read after the links above are written.
        const orderWarn = title !== undefined || body !== undefined ? unlinkedOrderWarning([title, body], new Set((await db.select({ number: tickets.number }).from(ticketDependencies).innerJoin(tickets, eq(tickets.id, ticketDependencies.blockerTicketId)).where(eq(ticketDependencies.blockedTicketId, ticketId))).flatMap((r) => (r.number === null ? [] : [r.number])))) : "";
        return text(`Ticket ${ticketId} updated (version ${u.version}).${setupCorrected ? ` The merged ticket's setup steps are corrected; the owner's card will be raised from them at go-live. ${told.length ? `The ${told.length === 1 ? "reviewer" : `${told.length} reviewers`} who approved ${told.length === 1 ? "was" : "were"} told.` : "No approving reviewer to tell."}` : ""}${waitsLines.length ? ` ${waitsLines.join("; ")}.` : waitsOn ? " No waitsOn link changed." : ""}${acceptanceCriteria !== undefined ? ` Its acceptance criteria are replaced and none is reported yet.${t.state === "review" ? " It is in review: reviews were NOT re-requested, so tell the assignee and reviewers the criteria changed." : ""}${criteriaWarning(acceptanceCriteria)}` : ""}${acceptanceCriteria !== undefined || body !== undefined ? await stagingWarning(db, scope.companyId, stagingTexts(acceptanceCriteria, body)) : ""}${orderWarn}${urgentNote}${markNote}`);
      } catch (err) {
        if (err instanceof WorkError) return fail(err.message);
        throw err;
      }
    },
  );

  server.registerTool(
    "set_ticket_state",
    {
      description: `Move one of your company's tickets to a new state. Call it with state "review" when your work is ready to check, or "done" when it is finished (a no-code ticket assigned to you can be closed by you); ending your turn does not move the ticket. Moving to review, done or blocked needs a summary (up to 240 characters): what you did, or what you are waiting on. Blocked is for a ticket that has not finished its own work and waits on something, and does not count toward the in-progress limits; a ticket whose work is finished and reviewed never goes to Blocked to wait for another ticket's merge (a move from review to Blocked for that reason is refused; it waits in review). Blocked is accepted for a waits-on ticket, an open card (plan cards too), a blocked_until date, or a merged ticket with after-merge checks not yet reported; anything else is refused. If you are waiting on the owner (to run something, answer or sign off), call raise_decision with blocksTicketId first, and only after you have tried every way to do it yourself. Naming the owner in the summary does not reach them. It is kept on the ticket for whoever reads it next, so write it in plain words with no file paths unless essential. If the ticket has acceptance criteria to check before merge, the summary must say pass or fail for each; a criterion marked checked after merge is reported once the work is live, and the ticket cannot be marked done until it is. Pass expected_version (the ticket's version as you last saw it) so the move is refused if the ticket has changed since. When blocking on something with a known time (e.g. a scheduled deployment), pass blocked_until (a future date and time within 30 days, ISO 8601 with a time zone) and optionally blocked_reason (one line, up to 240 characters): the Scrum Master watchdog then stays quiet until that time plus a grace period. Without blocked_until the normal blocked limit applies. ${FINISHED_STAYS_IN_REVIEW} Moving it back to review on code its reviews already passed keeps those approvals and the owner's sign-off; no new review round is opened. When you hand work on to someone else, pass followUps on review or done so it lands on their queue (${FOLLOW_UP_HELP}) A move to done is refused when the summary or your last reply hands work on ("the CEO will", "for X to", "hand to", "next: someone") and neither followUps nor noFollowUpReason is given.`,
      inputSchema: { ticketId: z.string().uuid(), state: z.enum(STATES), outcome: z.enum(["completed", "cancelled"]).optional(), expected_version: z.number().int().optional(), summary: z.string().max(240).optional(), blocked_until: z.string().datetime({ offset: true }).optional(), blocked_reason: z.string().max(BLOCKED_UNTIL_REASON_MAX).optional(), watching_for: z.string().max(200).optional().describe("With state blocked, on a ticket that is merged with after-merge checks still unreported: one line saying what you are watching for (e.g. a week of real use with no new stuck alerts). The board card shows it."), watch_until: z.string().datetime({ offset: true }).optional().describe(`With watching_for: when the watch ends (ISO 8601 with a time zone, at most ${WATCH_MAX_DAYS} days ahead). Left out, it is ${WATCH_DEFAULT_DAYS} days from go-live. Nothing alerts before this date; after it Boss Man alerts you once, then the CEO.`), ownerSetup: z.string().max(4000).optional().describe(`The owner's steps, for a ticket whose change needs them to do something once it is live (a setting, a secret, a button): plain words by button path, one step per line, e.g. Settings → Funding → Add funding source. Boss Man raises their card with these steps when the change goes live, not at merge. Pass an empty string to clear it. Only the ticket's own assignee, CEO or a manager may set it, and not here once the ticket is merged (until the owner's card is raised at go-live, the assignee or the CEO corrects them with update_ticket ownerSetup and a reason; after that only the owner changes them on the ticket page). ${SETUP_HELP}`), ownerSetupWhy: SETUP_WHY, ownerSetupIfSkipped: SETUP_IF_SKIPPED, lintOverride: LINT_OVERRIDE, fixesLive: z.string().max(FIXES_LIVE_MAX).optional().describe(`${FIXES_LIVE_HELP} An empty string clears it. Only the ticket's own assignee, CEO or a manager may set it here; a reviewer adds it with the review tool.`), followUps: followUpsSchema.optional().describe(`With state review or done. ${FOLLOW_UP_HELP}`), noFollowUpReason: z.string().max(240).optional().describe("With state done: why nothing is handed on although the summary or last reply sounds like it does.") },
    },
    async ({ ticketId, state, outcome, expected_version, summary, blocked_until, blocked_reason, watching_for, watch_until, ownerSetup,ownerSetupWhy, ownerSetupIfSkipped, lintOverride, fixesLive, followUps, noFollowUpReason }) => {
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
          .select({ repoUrl: projects.repoUrl, mergeCommit: tickets.mergeCommit, noCode: tickets.noCode, assignee: tickets.assigneeAgentId, systemState: tickets.systemState })
          .from(tickets)
          .innerJoin(projects, eq(projects.id, tickets.projectId))
          .where(and(eq(tickets.id, ticketId), eq(tickets.companyId, scope.companyId)));
        // BOS-1837: a ticket that is already done and merged only gets its note replaced (the branch now equals main,
        // so the "no changes of its own" check would wrongly refuse the assignee). Moves that need a diff keep it.
        const doneNoteOnly = t?.systemState === "done" && !!t.mergeCommit;
        // A ticket whose branch is already merged but stayed in review (e.g. waiting on the owner's yes) can be closed by a manager.
        const merged = !!t?.mergeCommit && (await managerIn(db, scope));
        // A no-code ticket never has a branch to merge, so its own assignee closes it once the work is
        // done (BOS-304): the CEO no longer has to move each research, wiki or docs task by hand.
        const ownNoCode = !!t?.noCode && !!scope.agentId && t.assignee === scope.agentId;
        // A ticket whose change shipped on another ticket has nothing of its own to merge; the CEO or a manager may close it.
        if (t?.repoUrl && outcome !== "cancelled" && !merged && !ownNoCode && !doneNoteOnly) {
          // No code at all means nothing to merge for anyone; otherwise only "nothing changed" can skip review.
          // A manager may still close either, as before, whatever the branch holds.
          const nothingOwn = !!t?.noCode || (await review.needsChanges(ticketId, scope.companyId).catch(() => false));
          if (!nothingOwn) return fail('This project has a repo: move the ticket to "review" instead. It becomes done when its branch is approved, checked and merged.');
          if (!(await managerIn(db, scope))) return fail("This ticket has no changes of its own, so it can't be merged. If its change shipped on another ticket, ask your CEO or manager to close it (set_ticket_state done, naming that ticket in the summary).");
        }
      }
      if ((blocked_until || blocked_reason) && state !== "blocked") return fail("blocked_until and blocked_reason only go with state blocked.");
      if ((watching_for || watch_until) && state !== "blocked") return fail("watching_for and watch_until only go with state blocked.");
      if (watch_until && !watching_for?.trim()) return fail("watch_until goes with watching_for: say in one line what you are watching for.");
      if (watching_for && /[\r\n]/.test(watching_for.trim())) return fail("watching_for must be one line.");
      const watchUntil = watch_until ? new Date(watch_until) : null;
      if (watchUntil && watchUntil.getTime() <= Date.now()) return fail("watch_until must be in the future.");
      if (watchUntil && watchUntil.getTime() > Date.now() + WATCH_MAX_DAYS * 24 * 60 * 60 * 1000) return fail(`watch_until can be at most ${WATCH_MAX_DAYS} days ahead. For a longer wait, report what you can and open a follow-up ticket for the rest.`);
      if (blocked_reason && !blocked_until) return fail("blocked_reason goes with blocked_until: give the date and time you are waiting for.");      if (blocked_reason && /[\r\n]/.test(blocked_reason.trim())) return fail("blocked_reason must be one line.");
      const until = blocked_until ? new Date(blocked_until) : null;
      if (until && until.getTime() <= Date.now()) return fail("blocked_until must be in the future.");
      if (state === "in_progress") {
        // A run can't start a ticket that still waits on unfinished work, or a Backlog ticket nobody
        // handed it (BOS-254). The owner, the CEO and managers override.
        const [current] = await db.select({ systemState: tickets.systemState, createdAt: tickets.createdAt, lastActivityAt: tickets.lastActivityAt }).from(tickets).where(and(eq(tickets.id, ticketId), eq(tickets.companyId, scope.companyId)));
        if (current && current.systemState !== "in_progress") {
          const blockers = await openBlockers(db, ticketId);
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
        .select({ criteria: tickets.acceptanceCriteria, current: tickets.stateNote, prev: tickets.systemState, ceoPlan: tickets.ceoPlan, ceoPlanDeadline: tickets.ceoPlanDeadline, urgent: tickets.urgent, title: tickets.title, assigneeId: tickets.assigneeAgentId, featureId: tickets.featureId, ownerSetup: tickets.ownerSetup, noCode: tickets.noCode, checksTicketId: tickets.checksTicketId, checksCriterion: tickets.checksCriterion })
        .from(tickets)
        .where(and(eq(tickets.id, ticketId), eq(tickets.companyId, scope.companyId)));
      if (!withCriteria) return fail("No ticket with that ID in your company.");
      if (watching_for?.trim()) {
        const [m] = await db.select({ mergeCommit: tickets.mergeCommit }).from(tickets).where(eq(tickets.id, ticketId));
        if (!m?.mergeCommit) return fail("A watch is for a merged ticket whose after-merge checks wait for a later event. This ticket has not merged.");
      }
      // BOS-1879: a head the owner signed off may only sit in review, where the gate merges it.
      if ((state === "in_progress" || state === "blocked") && withCriteria.prev !== state) {
        const [full] = await db.select().from(tickets).where(eq(tickets.id, ticketId));
        if (full && (await signedOffHeadOutsideReview(db, { ...full, systemState: state }, (id) => review.diff(id, scope.companyId).then((d) => d.head || null)))) return fail(SIGNED_OFF_HEAD_REFUSAL);
      }
      // BOS-1571 backstop: a gated ticket made by a path that didn't add the usability criterion (or before it existed)
      // gets it on the move to review, so its author reports it like any other; it is stored with the move.
      const gateAdded = state === "review" && withCriteria.prev !== "review" && addsUsabilityCriterion(withCriteria.criteria, { featureId: withCriteria.featureId, ownerSetup: ownerSetup ?? withCriteria.ownerSetup, noCode: withCriteria.noCode });
      if (gateAdded) withCriteria.criteria = withUsabilityCriterion(withCriteria.criteria, { featureId: withCriteria.featureId, ownerSetup: ownerSetup ?? withCriteria.ownerSetup, noCode: withCriteria.noCode });
      // A merged ticket's setup steps are the ones review saw (BOS-443): a correction before go-live goes through update_ticket (BOS-2075).
      if (ownerSetup !== undefined) {
        const [mergedNow] = await db.select({ mergeCommit: tickets.mergeCommit, ownerSetup: tickets.ownerSetup, ownerSetupDecisionId: tickets.ownerSetupDecisionId }).from(tickets).where(eq(tickets.id, ticketId));
        const next = ownerSetup.trim() || null;
        if (mergedNow?.mergeCommit && next !== (mergedNow.ownerSetup?.trim() || null)) return fail(mergedNow.ownerSetupDecisionId ? SETUP_CARD_RAISED : MERGED_SETUP_VIA_UPDATE);
      }
      if (lintOverride !== undefined && ownerSetup === undefined) return fail("lintOverride goes with ownerSetup.");
      // Same state again (DR-010): only the note changes. No enter-state hooks, no new review round.
      const sameState = withCriteria.prev === state;
      // BOS-1755: the owner's own question on this ticket is unanswered, so closing it as completed would lose their answer.
      if (state === "done" && !sameState && outcome !== "cancelled") {
        const card = await openOwnerOnlyCard(db, ticketId);
        if (card) return fail(`Card ${card} is the owner's question about this ticket and is still open. Keep the ticket in review (it waits there as "Passed, held") and it closes once the owner answers.`);
      }
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
      // BOS-1650: steps need their why and if-skipped lines, from what is written now merged with what is stored; the
      // stored ones are checked again on the move to review, so a ticket written before this can't slip through.
      const shapeFail = await setupShapeFail(db, ticketId, { ownerSetup, why: ownerSetupWhy, ifSkipped: ownerSetupIfSkipped }, state === "review" && !sameState);
      if (shapeFail) return fail(`${shapeFail}\nSet them with set_ticket_state ownerSetupWhy and ownerSetupIfSkipped${state === "review" ? ", then move to review again" : ""}.`);
      if (!setup && state === "review" && !sameState) {
        const [stored] = await db.select({ ownerSetup: tickets.ownerSetup, override: tickets.ownerSetupOverride }).from(tickets).where(eq(tickets.id, ticketId));
        const steps = splitSteps(stored?.ownerSetup ?? "");
        const again = steps.length ? ownerSetupWriteCheck(steps, await setupFacts(db, hostFacts, scope.companyId, steps), { lintOverride: parseStoredOverride(stored?.override), byCeo: true, strict: false }) : null;
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
        if (w?.wait) return fail(`This ticket's merge isn't live yet (${goLiveWaitWords(w.wait as GoLiveWait)}), so its after-merge checks can't be made. ${w.wait === "own" ? "Your company puts its own work live: once it is, the CEO marks it with update_ticket markLive and you are woken" : "Boss Man wakes you when it is live"}; then report them and close the ticket.`);
        // BOS-1586: a criterion with a fact clause is settled by the host's newest report taken after go-live, not by a "pass".
        // A cancel (the CEO's way out) and a repeated move are not held to it.
        if (!sameState && (outcome ?? "completed") === "completed") {
          const [live] = await db.select({ liveAt: tickets.liveAt, liveMarkedAt: tickets.liveMarkedAt, mergedAt: tickets.mergedAt }).from(tickets).where(eq(tickets.id, ticketId));
          if (hostFacts && withCriteria.criteria.some((c) => isAfterMerge(c))) {
            const refusal = hostFactRefusal(withCriteria.criteria, await hostFacts.sync(), live?.liveAt ?? live?.liveMarkedAt ?? live?.mergedAt ?? null, reported ?? "");
            if (refusal) return fail(refusal);
          }
          // R37: a pass on a page-clause criterion must cite a screenshot attached since go-live and quote the page's words.
          if (withCriteria.criteria.some((c) => isAfterMerge(c) && pageClauses(criterionText(c)).length)) {
            const shots = await db.select({ id: ticketImages.id, createdAt: ticketImages.createdAt }).from(ticketImages).where(eq(ticketImages.ticketId, ticketId));
            const refusal = pageShotRefusal(withCriteria.criteria, shots, live?.liveAt ?? live?.liveMarkedAt ?? live?.mergedAt ?? null, reported ?? "");
            if (refusal) return fail(refusal);
          }
          // BOS-1867: a check ticket's result reaches its parent only through numbered verdicts on its own criteria.
          if (withCriteria.checksTicketId && withCriteria.checksCriterion) {
            const refusal = checkTicketDoneRefusal(withCriteria.criteria, reported, withCriteria.checksCriterion);
            if (refusal) return fail(refusal);
          }
          const uncited = uncitedCardPasses(withCriteria.criteria, `${withCriteria.current ?? ""}\n${note ?? ""}`, await openCardIds(db, ticketId));
          if (uncited.length) return fail(CARD_CITE_REFUSAL(uncited));
        }
      }
      const missing = state === "review" ? missingVerdicts(withCriteria.criteria, note, "before") : state === "done" ? unreportedAfterMerge(withCriteria.criteria, reported) : [];
      if (missing.length)
        return fail(
          state === "done"
            ? `This ticket's work is merged, and its after-merge acceptance criteria aren't reported yet. Not reported: ${missing.map((m) => `"${m}"`).join(", ")}. Say whether each one passes or fails, then move it again. If one can only be checked by the owner, put a card in front of them (raise_decision with blocksTicketId set to this ticket, and criterion set to that check's number): their answer records the check's pass or fail, so you can close it once they have. A fail still closes this ticket: Boss Man opens the follow-up for it, assigned to this ticket's assignee.`
            : `This ticket has acceptance criteria to report before it merges, and the summary must give pass or fail for each of them. Not reported: ${missing.map((m) => `"${m}"`).join(", ")}. Say whether each one passes or fails, then move it again. Numbered verdicts in criteria order work too and are shorter, e.g. "1 pass; 2 pass; 3 fail: reason".${withCriteria.criteria.some(isAfterMerge) ? " The after-merge criteria don't need a verdict at review." : ""}${gateAdded ? ` The last one, "Usability gate", is built in for feature tickets and tickets with owner setup steps (criterion ${withCriteria.criteria.length}): ${REAL_USE_ASK}` : ""}`,
        );
      // A code ticket with nothing changed in the repository can't be reviewed; research and wiki
      // tickets are marked "no code" and are not held to this.
      if (state === "review" && (await review.needsChanges(ticketId, scope.companyId).catch(() => false))) return fail(NOTHING_CHANGED);
      // BOS-1664: a branch that changes CI or image files needs GitHub's own jobs green (or marked not applicable) first.
      if (state === "review" && !sameState && checkRequests) {
        const ciHold = await checkRequests.reviewRefusal(scope.companyId, ticketId).catch(() => null);
        if (ciHold) return fail(ciHold);
      }
      // A ticket waiting on the owner has to show in their Your review lane, which it only does through an open decision.
      const blockedNow = state === "blocked" ? await blockedHolds(db, ticketId, { blockedUntil: until ?? null }) : [];
      if (state === "blocked" && !blockedNow.length) {
        return fail(BLOCKED_REFUSAL);
      }
      // R36 (BOS-1679): a note that names a colleague needs a link to their ticket; a date only wakes this ticket's own agent.
      if (state === "blocked") {
        const named = await refusalForNamedAgent(db, { companyId: scope.companyId, agentId: scope.agentId, text: `${summary ?? ""}\n${blocked_reason ?? ""}`, holds: blockedNow });
        if (named) return fail(named);
      }
      // BOS-1576: a note that says the ticket waits on the owner needs a card in their queue, in any state.
      if (state !== "done" && waitsOnOwnerNote(summary) && !(await ticketHasOpenCard(db, ticketId))) return fail(OWNER_WAIT_REFUSAL);
      // BOS-1591 (R21): a ticket parked in Backlog, Ready or Blocked for something needs a link to what settles it (a ticket, a card, an engagement or a date).
      if ((state === "backlog" || state === "ready" || state === "blocked") && waitsForNote(summary) && !(await blockedHolds(db, ticketId, { blockedUntil: until ?? null })).length) return fail(WAIT_LINK_REFUSAL);
      // BOS-1509: finished, reviewed work whose only wait is another ticket's merge stays in review ("Passed, held").
      let waitsOnMergeOnly = false;
      if (state === "blocked" && !sameState && !until && (withCriteria.prev === "review" || withCriteria.prev === "in_progress")) {
        const open = await openBlockers(db, ticketId);
        waitsOnMergeOnly = open.length > 0 && open.every((b) => b.kind === "ticket") && (await blockedHolds(db, ticketId)).every((h) => h.kind === "blocker");
        if (waitsOnMergeOnly && withCriteria.prev === "review") return fail(REVIEW_BLOCKED_REFUSAL);
      }
      // The move itself is moveTicket's (DR-047): the column, the WIP limit, the field rules, the history line,
      // the merge line's "left" event, and the done, review and feature steps after a real change. This tool
      // only says whom to wake: the chain depth of this run goes with each wake.
      const at = new Date();
      // BOS-1906: with no passing quick check on the head, Boss Man queues it and the ticket waits in review as "Being checked":
      // no review round opens and no reviewer is woken until it passes.
      const beingChecked = state === "review" && !sameState && checkRequests ? await checkRequests.holdForReview({ companyId: scope.companyId, agentId: scope.agentId, ticketId }) : { held: false as const };
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
          fields: { ...(watching_for?.trim() ? { watchingFor: watching_for.trim(), watchUntil } : {}), ...(beingChecked.held ? { checkHoldAt: at } : {}), ...(gateAdded ? { acceptanceCriteria: withCriteria.criteria } : {}), ...(summary?.trim() ? { stateNote: summary.trim(), stateNoteAt: at, stateNoteStaleAt: null, lastPostAt: at } : {}), ...(ownerSetup !== undefined ? { ownerSetup: ownerSetup.trim() || null, ownerSetupOverride: setup?.error === null && ownerSetup.trim() ? setup.override : null } : {}), ...(ownerSetupWhy !== undefined ? { ownerSetupWhy: ownerSetupWhy.trim() || null } : {}), ...(ownerSetupIfSkipped !== undefined ? { ownerSetupIfSkipped: ownerSetupIfSkipped.trim() || null } : {}), ...(fixesLive !== undefined ? { fixesLive: fixesLive.trim() || null } : {}) },
          hooks: {
            onDone: () => hooks.onTicketDone?.(ticketId, scope.runId),
            onReview: beingChecked.held ? undefined : () => hooks.onTicketReview?.(ticketId, scope.agentId, scope.runId),
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
      // R36 (BOS-1679): the third date-only park in a row, with no link between, wakes the CEO once with the ticket and its note.
      if (state === "blocked") {
        const parks = await noteBlockedPark(db, { companyId: scope.companyId, ticketId, agentId: scope.agentId, holds: await blockedHolds(db, ticketId, { blockedUntil: until ?? null }), at }).catch(() => null);
        if (parks && hooks.wake) {
          const [ceo] = await db.select({ id: agents.id }).from(agents).where(and(eq(agents.companyId, scope.companyId), eq(agents.role, "ceo")));
          if (ceo && ceo.id !== scope.agentId) {
            await Promise.resolve(hooks.wake(ceo.id, { reason: "parked by date again and again", ticketId, causedByRunId: scope.runId, note: `"${withCriteria.title}" has been parked by date ${parks} times in a row with no link to what settles it. Its note: ${summary?.trim() ?? "(none)"}. Whoever it waits on may not know. Find who acts, link their ticket (update_ticket waitsOn) or open one for them.` })).catch(() => undefined);
          }
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
        // R52: a ticket asked for in chat that hands out follow-ups is reported back in that chat (done does it too, in onTicketDone).
        if (opened?.length) {
          const owed = await dueChatReport(db, ticketId, new Date(), scope.runId).catch(() => null);
          if (owed) await Promise.resolve(hooks.wake?.(owed.agentId, { reason: CHAT_REASON, note: "", priority: 4, causedByRunId: scope.runId })).catch(() => undefined);
        }
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
      // BOS-1958: still in review, so no new round opens; the reviewers who asked for changes and haven't seen the new code are asked again.
      const reAsked = state === "review" && sameState ? await review.reAskChangesRequested(ticketId, scope.companyId, scope.runId).catch(() => []) : [];
      // BOS-1509: the CEO's plan and urgent tickets. The move stands; the mover is told, and so is the CEO, once per move.
      let planNote = "";
      if (!sameState) {
        const now = new Date();
        const [me] = scope.agentId ? await db.select({ role: agents.role, name: agents.name }).from(agents).where(eq(agents.id, scope.agentId)) : [];
        const byCeo = me?.role === "ceo";
        const planned = unexpiredPlan(withCriteria, now) && leavesPlan(withCriteria.prev, state);
        const backwards = withCriteria.urgent && urgentBackwards(withCriteria.prev, state);
        if ((planned || backwards) && !byCeo && hooks.wake) {
          const [ceo] = await db.select({ id: agents.id }).from(agents).where(and(eq(agents.companyId, scope.companyId), eq(agents.role, "ceo")));
          if (ceo && ceo.id !== scope.agentId) {
            const plan = planned ? ceoPlanText(withCriteria, now, 1000) : null;
            await Promise.resolve(hooks.wake(ceo.id, { reason: "ticket moved off plan", ticketId, causedByRunId: scope.runId, note: ceoMoveNote({ title: withCriteria.title, ref: null, from: withCriteria.prev, to: state, mover: me?.name ?? "An agent", summary: summary?.trim() || null, plan, urgent: !!backwards }) })).catch(() => undefined);
          }
        }
        if (planned) planNote = planMoveWarning(ceoPlanText(withCriteria, now, 1000)!, withCriteria.prev, state, !byCeo);
        if (state === "blocked" && withCriteria.prev === "in_progress" && waitsOnMergeOnly && (await db.select({ id: reviewRequests.id }).from(reviewRequests).where(eq(reviewRequests.ticketId, ticketId)).limit(1)).length) planNote += `\n\n${IN_PROGRESS_BLOCKED_WARNING}`;
      }
      return text(`Ticket ${ticketId} is now ${state}.${moved.urgentOver ? " It started over your WIP limit because it is urgent." : ""}${beingChecked.held ? ` Boss Man queued its quick check (${beingChecked.where}), so it waits in Review as "Being checked" and no reviewer is woken until the check passes. A pass opens the reviews by itself; you are woken only if it fails. End your turn; don't call request_check or poll.` : ""}${sameState ? (reAsked.length ? ` It was already in review, so the note changed and no new round opened. ${reAsked.join(" and ")} asked for changes on earlier code and ${reAsked.length > 1 ? "were" : "was"} asked to review again; reviewers who approved were not asked.` : " It was already there, so only the note changed and no reviews were re-requested (no reviewer who asked for changes needed to look again).") : ""}${followUp}${planNote}${warn}${setupHint}${signoffHint}${(await getHold(db)) ? ` ${WRAP_UP}` : ""}${waitsOnAdvice(summary)}`);
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
  return `\n\nHeads up (BOS-219): a migration number is already taken on the default branch: ${m.why.join("; ")}. The merge gate renumbers it (to ${String(m.next).padStart(4, "0")} or later) and keeps the SQL unchanged; don't rename it by hand. The merge will send it back only if the gate refuses.${m.others.length ? ` Other numbers taken: ${m.others.join("; ")}.` : ""}`;
}

/** The merge-line conflict warning for a mark-urgent (BOS-1411, warning 2): the same line the sign-off card gets. Empty when there is none. */
async function conflictWarning(review: Services["review"], ticketId: string): Promise<string> {
  const conflicts = await review.mergeLineClashes(ticketId);
  const note = conflictNote(conflicts);
  return note ? `\n\n${note}` : "";
}

/** What Blocked accepts (BOS-1171); the refusal names every kind. Blocked tickets never count toward the in-progress limits. */
export const BLOCKED_REFUSAL =
  "Blocked is for a ticket that only waits. It is accepted when the ticket: (1) waits on another ticket, a decision or an engagement (update_ticket waitsOn, or create_ticket with parent set to this ticket); (2) has an open card on it, a plan card included (raise_decision with blocksTicketId, or a plan waiting for approval); (3) waits for a known time: pass blocked_until (a future ISO 8601 time within 30 days) with blocked_reason; or (4) is merged and still has after-merge checks to report: it sits in the Merged, watching lane with no date, link or card needed, counts toward no limit, and for a check that needs a later event you pass watching_for (one line) and watch_until (default 14 days from go-live). A date only wakes you: if a colleague has to act, link their ticket (you can add waitsOn to your own ticket; ask the CEO to open one for them if none exists), and a note that names them is refused without it. Parked by date 3 times in a row wakes the CEO. If you need the owner, call raise_decision with blocksTicketId first: a note in the summary does not reach them. Once blocked you can still use schedule_check to re-check later.";


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
