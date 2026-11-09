// Boss Man's MCP server: the one way agents act on Boss Man (R11). Every call carries a
// per-run bearer token that pins it to one company and agent, so an agent can only see and
// change its own company's work. The tool set is kept small (R36); descriptions say when
// to use each tool so Claude Code's tool search finds them.
import { checkRequestService, CheckRequestError } from "./services/check-request.js";
import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { and, asc, desc, eq, gt, ilike, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { goLiveWaitWords, type GoLiveWait, FEATURE_STATUSES, HORIZONS, IMPORTANCE, planFirstByDefault, portalVerdict, RISK_TIERS, BLOCKED_UNTIL_MAX_DAYS, BLOCKED_UNTIL_MAX_MS, BLOCKED_UNTIL_REASON_MAX, stateNoteLine, untrusted, isTaskSize, SIZE_SCALE, type TaskSize } from "@boss-man/shared";
import { hashToken } from "./auth.js";
import type { Db } from "./db/client.js";
import { agents, companies, decisions as decisionsTable, engagements as engagementsTable, features, keyResults, objectives, projects, runs as runsTable, runTokens, ticketDependencies, ticketImages, tickets, wakes, workflowColumns } from "./db/schema.js";
import { record } from "./services/activity.js";
import { goLiveLine, goLiveWaitOf, liveClaimWarning } from "./services/go-live-wait.js";
import { buildBrief } from "./services/brief.js";
import { imageMarkdown, TicketImageError, type ticketImagesService } from "./services/ticket-images.js";
import { readZip, ZipReadError } from "./services/attachment-zip.js";
import { AnswerError, APPROVE_PLAN, KEEP_PLANNING, checkAsk, FIXES_LIVE_MAX, fixesLiveProblem, type DroppedOrderLink, type decisionsService } from "./services/decisions.js";
import type { SelfDeployFacts } from "./services/steps.js";
import type { hostFactsService } from "./services/host-facts.js";
import type { deviceProfilesService } from "./services/device-profiles.js";
import { recentOwnerAnswer, quotedAnswer } from "./services/stale-requests.js";
import { EngagementError, type EngagementAction, type engagementsService } from "./services/engagements.js";
import { DeployError, liveTagOf, type deploysService } from "./services/deploys.js";
import { RunError, type runsService } from "./services/runs.js";
import { holdView } from "./services/review-holds.js";
import { NOTHING_CHANGED, ReviewError, type reviewService } from "./services/review.js";
import type { notificationsService } from "./services/notifications.js";
import type { chaptersService } from "./services/chapters.js";
import { staleVersionMessage, startRefusal, WorkError, type workService } from "./services/work.js";
import { FeedbackError, type feedbackService } from "./services/feedback.js";
import { acceptanceCriteriaSchema, afterMergeLint, criteriaForCard, criterionOverlap, criteriaText, criterionText, failedAfterMerge, isAfterMerge, missingVerdicts, readCriteria, unreportedAfterMerge, type Criterion } from "@boss-man/shared";
import { TicketChatError, type ticketChatService } from "./services/ticket-chat.js";
import { findSection, HISTORY_PAGE_MAX, missingPageNote, splitSections, WikiError, type wikiService } from "./services/wiki.js";
import { conversationLines } from "./services/ticket-chat.js";
import type { skillsService } from "./services/skills.js";
import { reviewTicketWriteRefusal, type skillProposalsService } from "./services/skill-proposals.js";
import { AgentError, type agentsService } from "./services/agents.js";
import { restoreSignoffCard, signoffHistory, signoffLine, signoffState } from "./services/signoff.js";
import type { paService } from "./services/pa.js";
import { SCRUM_MASTER_DUTY, type watchdogService } from "./services/watchdog.js";
import type { alertLadder } from "./services/alert-ladder.js";
import type { retroService } from "./services/retro.js";
import { sizingGuideText } from "./services/sizing.js";
import { getHold, WRAP_UP } from "./services/maintenance.js";
import { cleanSummary, SUMMARY_MAX } from "./services/phone-approve.js";
import { getStandingRules, STANDING_RULES_MAX, StandingRulesError } from "./services/standing-rules.js";
import type { serverStatusService } from "./services/server-status.js";
import { ADDONS, type AddonFacts } from "./services/addons.js";
import { CAP, criteriaWarning, criterionLines, cut, fail, findProject, FIXES_LIVE_HELP, managerIn, REF, refsOf, STATES, text, thinTicketWarning, TREE_REASON, TREE_ROOT_LINE, treeRefusal, withNote, type Scope } from "./mcp-common.js";
import { registerClearCheck, registerScheduleCheck, registerTicketAdmin, registerTicketMoves } from "./mcp-tickets.js";
import { registerAgentAdminTools } from "./mcp-agent-admin.js";
import { buildPaServer } from "./mcp-pa.js";
import { registerRetro, registerWatchdog } from "./mcp-watchdog.js";
import { traceCalls } from "./mcp-trace.js";
import { registerBoard, registerListMyWork, registerNotes, registerRequestNote, registerRoadmap } from "./mcp-board.js";
import { registerDecisionTools } from "./mcp-decisions.js";

export { TREE_REASON, TREE_ROOT_LINE };

export async function issueRunToken(db: Db, scope: Scope, ttlHours = 12): Promise<string> {
  const token = `bm_run_${randomBytes(32).toString("base64url")}`;
  await db.insert(runTokens).values({ tokenHash: hashToken(token), runId: scope.runId, companyId: scope.companyId, agentId: scope.agentId, expiresAt: new Date(Date.now() + ttlHours * 3_600_000) });
  return token;
}

/** A reply that asks the owner to do something: an imperative aimed at them, not a plain status report. */
const OWNER_ASK = /\b(please|you(?:'ll| will)? (?:need|have|must|should)|could you|would you|can you|when you(?:'ve| have)? |reply here|tell me (?:here|once|when)|let me know|confirm (?:that|once|when)|run (?:this|it|the|scripts)|apply (?:it|this|the|them)|do this|try again|revert|roll back)\b/i;

/**
 * After a ticket reply, say when the owner has to act but nothing on their queue asks them to (BOS-122):
 * the owner doesn't watch tickets, so a reply alone doesn't reach them. Returns null when no hint applies.
 */
async function ownerActionHint(db: Db, scope: Scope, ticketId: string, body: string): Promise<{ uncovered: boolean; message: string } | null> {
  if (!OWNER_ASK.test(body)) return null;
  // An open decision covers it when it blocks this ticket, or this agent already asked about it.
  const covering = await db
    .select({ id: decisionsTable.id })
    .from(decisionsTable)
    .leftJoin(ticketDependencies, eq(ticketDependencies.blockerDecisionId, decisionsTable.id))
    .where(and(eq(decisionsTable.companyId, scope.companyId), eq(decisionsTable.status, "open"), or(eq(ticketDependencies.blockedTicketId, ticketId), scope.agentId ? eq(decisionsTable.raisedByAgentId, scope.agentId) : sql`false`)))
    .limit(1);
  if (covering.length) return null;
  // A ticket owed the owner's sign-off whose card is missing: Boss Man raises the card itself rather than leave
  // the warning in the agent's run (BOS-503). Agents can't see decision state, so they couldn't act on it.
  const [t] = await db.select().from(tickets).where(and(eq(tickets.id, ticketId), eq(tickets.companyId, scope.companyId)));
  const restored = t ? await restoreSignoffCard(db, t, "an agent's reply asked the owner to review it") : null;
  if (restored) return { uncovered: false, message: `This ticket passed every review and waits on the owner's sign-off, but its card was missing, so Boss Man raised it (card ${restored}). It is in the owner's Decisions and the board's Your review lane; you don't need to raise one.` };
  return { uncovered: true, message: "This reply asks the owner to do something, but no open decision covers it — the owner doesn't watch tickets, so this won't reach their queue or the Your review lane. Call raise_decision with blocksTicketId set to this ticket, with what you tried first and the steps they need. The reply is still posted." };
}
/** What the CEO is told when a reply asking the owner to act is held (BOS-901). */
const CEO_ASK_HELD = "Not posted. This reply asks the owner to do something, but no open decision covers it, and the owner doesn't watch tickets, so the ask would be lost. Call raise_decision with blocksTicketId set to this ticket (what you tried first, and the steps they need), then send the reply again. If the reply only reports status and asks nothing of the owner, send it again with notAnAsk set to true and it will post.";
export { cut };
const OUTLINE_OVER = 8000;

/**
 * What a raiser is told when it puts a card in front of the owner for a merged ticket's live check (BOS-963).
 * The answer records against the after-merge criterion the card names (by number or text via `criterion`)
 * or, failing that, one named in its own question or options; a card worded its own way settles nothing and
 * the ticket can never close on it, so say so now, not after three answers. Empty when the ticket is
 * unmerged, has no after-merge checks left, or the card settles one.
 */
async function afterMergeCardNote(db: Db, ticketId: string, question: string, options: readonly string[], criterionIndexes?: number[]): Promise<string> {
  const [t] = await db.select({ criteria: tickets.acceptanceCriteria, note: tickets.stateNote, merged: tickets.mergeCommit }).from(tickets).where(eq(tickets.id, ticketId));
  if (!t?.merged) return "";
  const criteria = readCriteria(t.criteria);
  const waiting = unreportedAfterMerge(criteria, t.note);
  if (!waiting.length) return "";
  if (criterionIndexes?.length) return "";
  if (criteriaForCard(criteria, question, options).length) return "";
  const said = `${question}\n${options.join("\n")}`;
  const closest = waiting.flatMap((text) => criteria.flatMap((c) => (criterionText(c) === text ? [{ text, hit: criterionOverlap(text, said) }] : []))).sort((a, b) => b.hit - a.hit)[0];
  const named = closest ? ` The closest is "${closest.text}" (${closest.hit ? `${closest.hit} of its words` : "none of its words"} in this card).` : "";
  const list = waiting.map((w) => `"${w}"`).join(", ");
  return `Heads up: this ticket is merged and still has after-merge checks unreported (${list}), and this card names none of them in its question or options, so the owner's answer won't record one and the ticket can't close on it.${named} Raise the card with criterion set to the check's number or its exact text, or ask about it in the criterion's own words, and withdraw this one if it was meant to settle the check.`;
}

export type McpHooks = {
  onTicketDone?: (ticketId: string, causedByRunId: string) => Promise<unknown>;
  onTicketReview?: (ticketId: string, byAgentId: string | null, causedByRunId: string) => Promise<unknown>;
  nudge?: (input: { runId: string; fromAgentId: string; to: string; ticketId?: string | null; why: string }) => Promise<{ ok: true; delivered: string } | { ok: false; error: string }>;
  /** Wakes an agent, e.g. the CEO for a note request. */
  wake?: (agentId: string, input: { reason: string; note: string }) => Promise<unknown>;
  /** A run with no ticket touched one: record it as the run's ticket so the Runs list shows it (BOS-254). */
  onRunTicket?: (ticketId: string, runId: string) => Promise<unknown>;
};

/** The ticket row for an agent, with its state note shown with its age (R85). */
/** The first 8 characters of a ticket's id, as the web app and wiki show it (BOS-435). */
const ID_PREFIX = /^[0-9a-f]{8}$/i;

export type Services = {
  decisions: ReturnType<typeof decisionsService>;
  engagements: ReturnType<typeof engagementsService>;
  deploys: ReturnType<typeof deploysService>;
  runs: ReturnType<typeof runsService>;
  review: ReturnType<typeof reviewService>;
  notes: ReturnType<typeof notificationsService>;
  chapters: ReturnType<typeof chaptersService>;
  work: ReturnType<typeof workService>;
  feedback: ReturnType<typeof feedbackService>;
  ticketChat: ReturnType<typeof ticketChatService>;
  wiki: ReturnType<typeof wikiService>;
  skills: ReturnType<typeof skillsService>;
  skillProposals: ReturnType<typeof skillProposalsService>;
  agents: ReturnType<typeof agentsService>;
  pa: ReturnType<typeof paService>;
  images: ReturnType<typeof ticketImagesService>;
  watchdog: ReturnType<typeof watchdogService>;
  alerts: ReturnType<typeof alertLadder>;
  retro: ReturnType<typeof retroService>;
  serverStatus: ReturnType<typeof serverStatusService>;
  /** request_check (DR-003, BOS-316); absent where the queue is not wired. */
  checkRequests?: ReturnType<typeof checkRequestService>;
  /** What each host recorded about itself (BOS-427), for the owner-card lint's R6. */
  hostFacts: ReturnType<typeof hostFactsService>;
  /** The owner's measured screens (BOS-641), so a layout ticket is checked at the real device. */
  deviceProfiles: ReturnType<typeof deviceProfilesService>;
  /** Add-on facts for server_status and the card lint's R9 (addons.ts, DR-023). Absent: R9 is not checked. */
  addons?: () => Promise<AddonFacts>;
  /** Facts for the card lint's R15 (DR-036): whether Boss Man raises its own update card, and its commit. Absent: R15 is not checked. */
  selfDeployCards?: () => Promise<SelfDeployFacts>;
};

/**
 * The Scrum Master's tools (BOS-58): reads, ticket_reply, and the watchdog tool with its few
 * actions. Nothing that changes a ticket's state, risk, priority or work is ever registered, so
 * the Scrum Master can't close, cancel or re-rate a ticket however it is asked to.
 */
const SCRUM_MASTER_TOOLS: ReadonlySet<string> = new Set(["tickets", "wiki", "whats_new", "list_my_work", "board", "ticket_reply", "open_attachment", "watchdog"]);

/** Registers only the named tools on this server; the wiki among them is read-only. */
function restrictTo(server: McpServer, only: ReadonlySet<string>) {
  const register = server.registerTool.bind(server);
  server.registerTool = ((name: string, config: never, cb: (input: { action?: string }, extra: never) => Promise<unknown>) => {
    if (!only.has(name)) return undefined;
    if (name !== "wiki") return register(name, config, cb as never);
    return register(name, config, (async (input: { action?: string }, extra: never) => (input.action === "list" || input.action === "read" ? cb(input, extra) : fail("You can only read the wiki."))) as never);
  }) as never;
}

function buildServer(db: Db, services: Services, scope: Scope, hooks: McpHooks, only?: ReadonlySet<string>, retroAgent = false, withServerStatus = true) {
  const server = new McpServer({ name: "bossman", version: "0.1.0" });
  if (only) restrictTo(server, only);
  if (only === SCRUM_MASTER_TOOLS) {
    registerBoard(server, db, scope);
    registerWatchdog(server, services.watchdog, services.alerts, scope);
  }
  if (retroAgent) registerRetro(server, services.retro, scope);
  registerRunTools(server, db, services, scope, hooks, undefined, withServerStatus);
  registerRoadmap(server, db, services.work, scope);
  registerTicketMoves(server, db, { review: services.review, work: services.work, feedback: services.feedback, skillProposals: services.skillProposals }, scope, hooks, false);
  registerSharedTools(server, db, { notes: services.notes, wiki: services.wiki, skills: services.skills, skillProposals: services.skillProposals, review: services.review, agents: services.agents }, scope);
  registerViewImage(server, services.images, scope);
  registerNotes(server, db, scope, false, { ticketChat: services.ticketChat });
  registerRequestNote(server, db, scope, hooks);
  registerListMyWork(server, db, scope);
  return server;
}

/**
 * The tools a ticket run has beyond the shared reads and the board (which both a run and the
 * owner chat register): handing out and moving tickets, decisions, engagements, deploys, runs,
 * notifications, review and the rest. Both buildServer and buildChatServer call it, so the CEO
 * has the same set in its chat as in its runs (BOS-224). Chat skips create_ticket and nudge,
 * which it has its own version of, and only the CEO's chat registers these tools at all.
 */
function registerRunTools(server: McpServer, db: Db, { decisions, engagements, deploys, runs, review, notes, chapters, work, feedback, ticketChat, wiki, skills, skillProposals, agents: team, pa, images, watchdog, alerts, retro, serverStatus, hostFacts, deviceProfiles, addons, selfDeployCards, checkRequests }: Services, scope: Scope, hooks: McpHooks, skip?: ReadonlySet<string>, withServerStatus = true) {
  const originalRegister = server.registerTool.bind(server);
  if (skip?.size) server.registerTool = ((name: string, config: never, cb: never) => (skip.has(name) ? undefined : originalRegister(name, config, cb))) as never;
  const resolveProject = (project?: string) => findProject(db, scope, project);
  const outsideTree = (ticketId: string | undefined) => treeRefusal(db, scope, ticketId);
  // A run that had no ticket now works on one: say so on the run (BOS-254). Never blocks the tool.
  const noteRunTicket = (ticketId: string) => (scope.agentId ? Promise.resolve(hooks.onRunTicket?.(ticketId, scope.runId)).catch(() => undefined) : undefined);

  async function isManager() {
    const [me] = scope.agentId ? await db.select({ role: agents.role }).from(agents).where(eq(agents.id, scope.agentId)) : [];
    return me?.role === "ceo" || me?.role === "manager";
  }

  registerTicketAdmin(server, db, { work, engagements, feedback }, scope);

  server.registerTool(
    "sizing_guide",
    {
      description: "Before create_ticket: finished tickets of each size (1, 2, 3, 5, 8) with their real time, cost and send-backs, the typical figures per role, and the company's sizing playbook if it has one. Size a new task by comparing it with these.",
      inputSchema: {},
    },
    async () => text(await sizingGuideText(db, scope.companyId)),
  );

  server.registerTool(
    "attach_image",
    {
      description:
        "Attach an image you saved while working, such as a test screenshot, to a ticket so the owner sees it on the ticket. Save it where you work (e.g. agent-browser screenshot shots/step-2.png) and give that path; PNG, JPEG or WebP up to 5 MB. The ticket can be its id or its reference (e.g. HOL-12). Add a caption saying what it shows. The reply gives the image's Markdown, ![caption](/api/ticket-images/ID): paste it into a wiki page (wiki write) and the owner sees the picture inline, so put a report's images in the page. Any ticket image can be used this way again, without re-uploading. Never commit images to the repo.",
      inputSchema: { ticketId: z.string().max(40), path: z.string().min(1).max(500), caption: z.string().max(500).optional() },
    },
    async ({ ticketId: given, path, caption }) => {
      const byRef = REF.exec(given);
      const ticketId = byRef ? (await db.select({ id: tickets.id }).from(tickets).where(and(eq(tickets.companyId, scope.companyId), eq(tickets.number, Number(byRef[1])))))[0]?.id : given;
      if (!ticketId || !z.string().uuid().safeParse(ticketId).success) return fail(`No ticket ${given} in your company.`);
      const reviewWrite = await reviewTicketWriteRefusal(db, scope.companyId, ticketId, scope.agentId);
      if (reviewWrite) return fail(reviewWrite);
      try {
        const id = await images.attach(scope.companyId, { ticketId, path, caption, agentId: scope.agentId });
        return text(`Attached ${path} to the ticket. To show it in a wiki page, write: ${imageMarkdown(caption?.replace(/[\][()\n\r]/g, "") || path, id)}`);
      } catch (err) {
        if (err instanceof TicketImageError) return fail(err.message);
        throw err;
      }
    },
  );

  registerScheduleCheck(server, { work }, scope, hooks);

  server.registerTool(
    "request_check",
    {
      description:
        "Ask for a check of your ticket to be run for you by the runner, outside your session, so it survives the end of your run and nobody can stop it. ticketId; scope quick (default: the 2-5 minute check of what your branch changed) or full (only after the merge gate has bounced the ticket twice, or for a change to check-all.sh or the test setup). Commit first: the check runs on your latest commit. It queues behind merge checks. You are woken with the result: end your turn or do other work, and do not poll or run your own loop. Only the ticket's assignee can use it while the ticket is in progress or in review. The merge gate runs the one full check itself.",
      inputSchema: { ticketId: z.string().uuid(), scope: z.enum(["quick", "full"]).optional() },
    },
    async ({ ticketId, scope: checkScope }) => {
      if (!scope.agentId) return fail("Only an agent can ask for a check.");
      if (!checkRequests) return fail("The check queue is not available on this server.");
      try {
        const msg = await checkRequests.request({ companyId: scope.companyId, agentId: scope.agentId, ticketId, scope: checkScope });
        await noteRunTicket(ticketId);
        return text(msg);
      } catch (err) {
        if (err instanceof CheckRequestError) return fail(err.message);
        throw err;
      }
    },
  );

  registerClearCheck(server, { work }, scope);


  server.registerTool(
    "ticket_reply",
    {
      description: "Write on a ticket's conversation, where the owner talks to the agents working it. Use it to answer the owner's messages there, or to tell them something about the ticket. Name a wiki page as [[slug]] so the owner can open it with one click. For anything you need the owner to decide or do (including closing a ticket you can't), use raise_decision with blocksTicketId instead: a reply doesn't reach their queue or the Your review lane on the board. Ask the owner only after you have tried every way to do it yourself. If you are the CEO, a reply that asks the owner to act is not posted until an open decision covers it; a status-only reply that trips this can be sent again with notAnAsk true. The owner is not a developer: start with 1 to 3 plain sentences (what changed for them and whether they need to do anything), then a line \"Details:\" followed by the technical report (files, commits, tests).",
      inputSchema: { ticketId: z.string().uuid(), text: z.string().min(1).max(8000), notAnAsk: z.boolean().optional().describe("CEO only: send a reply that only reports status and asks nothing of the owner, even though its wording looks like an ask. Without it, a CEO reply that asks the owner to act is held (not posted) until an open decision covers it.") },
    },
    async ({ ticketId, text: body, notAnAsk }) => {
      // The CEO's owner-ask is held, not posted, until a card covers it (BOS-901): the hint after posting is too late for them.
      let hint: { uncovered: boolean; message: string } | null = null;
      if (scope.agentId) {
        const [me] = await db.select({ role: agents.role }).from(agents).where(and(eq(agents.id, scope.agentId), eq(agents.companyId, scope.companyId)));
        if (me?.role === "ceo") {
          hint = await ownerActionHint(db, scope, ticketId, body);
          if (hint?.uncovered && !notAnAsk) return fail(CEO_ASK_HELD);
        }
      }
      try {
        await ticketChat.agentSays({ companyId: scope.companyId, ticketId, agentId: scope.agentId, runId: scope.runId, text: body });
      } catch (err) {
        if (err instanceof TicketChatError) return fail(err.message);
        throw err;
      }
      await noteRunTicket(ticketId);
      const [t] = await db.select({ title: tickets.title, watcher: tickets.watcherAgentId, companyId: tickets.companyId, mergeCommit: tickets.mergeCommit, touchesRunner: tickets.touchesRunner }).from(tickets).where(eq(tickets.id, ticketId));
      const notLiveWarning = t ? await liveClaimWarning(db, t, body) : null;
      // A watcher's report reads as a status update (R80).
      const title = t?.watcher && t.watcher === scope.agentId ? `Status: "${t.title}"` : `Reply on "${t?.title ?? "a ticket"}"`;
      await notes.notify({ companyId: scope.companyId, agentId: scope.agentId, level: "note", title, body, link: `#/tickets/${ticketId}` });
      // A reply that asks the owner to act doesn't reach their queue (BOS-122). Say so in the result so the
      // agent's next turn raises a decision; the reply still posts, so a status update isn't blocked.
      hint ??= await ownerActionHint(db, scope, ticketId, body);
      const links = await missingPageNote(db, scope.companyId, body);
      return text(`Posted on the ticket's conversation.${links ? `\n\n${links}` : ""}${hint ? `\n\n${hint.message}` : ""}${notLiveWarning ? `\n\n${notLiveWarning}` : ""}`);
    },
  );

  server.registerTool(
    "nudge",
    {
      description: NUDGE_DESCRIPTION,
      inputSchema: NUDGE_INPUT,
    },
    async ({ agent, ticketId, why }) => {
      if (!scope.agentId || !hooks.nudge) return fail("Only an agent's run can nudge.");
      const out = ticketId ? await outsideTree(ticketId) : null;
      if (out) return fail(out);
      const r = await hooks.nudge({ runId: scope.runId, fromAgentId: scope.agentId, to: agent, ticketId, why });
      return r.ok ? text(`Nudged: ${r.delivered}.`) : fail(r.error);
    },
  );

  server.registerTool(
    "raise_decision",
    {
      description: "Ask the owner to decide or do something only they can. Always give your recommended answer, which must be one of the options. If a ticket can't move until this is answered, pass its ID so it waits. triedFirst is required: what you already tried yourself, and why an agent can't do it (no host access, a secret only the owner can grant, owner sign-off); a vague or empty one is refused. Set ownerMustDo to true when the owner has to do something (run, click, grant, check); then steps is required: short numbered steps in plain words with exact paths in the app (for example Settings → Server and runner → Updates → Build and update runners), ending with how to undo it. Prefer pointing to a button in the app over host commands. The owner is not a developer. The card links to the ticket it blocks and to any ticket you name in the text (like BOS-70), so you needn't paste a URL; a link is background only, and each step must be complete on its own. Steps are checked when the card is raised (BOS-417): one that points to another document (\"follow docs/06\", a .md file, \"see the guide\", \"with changes\", \"as before\"), uses a shell variable like $X that no step up to there sets (inline X=1 cmd counts), has a command that isn't copy-safe (a placeholder like <host-ip> or YOUR_KEY, a prompt character, more than one line, trailing punctuation) or has an unfilled {{token}} is refused, saying which step and why. Put each command in its own fenced \`\`\`sh block. Each fence line must say where the command runs and as which account: sh host=\"<name>\" as=\"root\" or as=\"login\". For the command that runs on the server Boss Man itself runs on, write host=\"{{host}}\": Boss Man fills it with the name the host deployer reports (the same name server_status gives as the host), so never an old name from memory, an old runbook or a compose file, as the owner would be sent to a machine that no longer runs Boss Man. A card that names another host is refused and names the one Boss Man has on record; leave the host out and Boss Man fills in the reported name; with no host report yet {{host}} is refused and a named host is raised unconfirmed. A card that sets up a new host Boss Man has no record for yet passes newHost with that name; only the CEO may pass it, and only that one name may be unrecorded on the card. A step that relies on an add-on (Tailscale: tailscale, ts.net, tailnet; ntfy: ntfy, test push, test notification, phone notification; Penpot: penpot) that server_status records as not set up, stopped or waiting for a login is refused, and one whose state is unknown is flagged; on the card that sets an add-on up, pass setsUp with its name so its own steps aren't refused; that card then closes by itself (and frees the ticket it blocks) once Boss Man sees the add-on working after the card was raised, so you need not withdraw it. A command that waits for typed input (read, read -p, sudo -S, passwd, ssh-keygen without -N, docker login without --password-stdin) is refused: give the value in the command, or for a secret an editor step naming the exact line or Boss Man's Secrets screen. So is a pager (psql without -P pager=off, git log/diff/show without --no-pager, systemctl status or journalctl without --no-pager, less, more, man), a database or container-shell prompt the owner would type into (psql with no -c, docker exec -it … bash; use psql -P pager=off -c \"…\"), and a command that never returns by itself (docker stats without --no-stream, docker logs -f, tail -f, watch, top, ping without -c); none of these can be overridden. A command block that prints nothing when it works (only assignments, cd, export, or cp/mv/install/mkdir/chmod/chown/ln/touch/rm without -v) must say so in its sentence (\"This prints nothing.\") or show the result (D=$(…); echo \"$D\"). Steps with a host command (docker, docker compose, systemctl, tailscale, chown, chmod, anything naming .env) need proof (DR-024): \"rehearsed <script> @ <commit>\" when the CI rehearsal under scripts/rehearse/ passed on that commit, or \"not rehearsed: <what hasn't been tried and why>\", and then the last step must be a look-only check (docker compose ps, docker logs, tailscale status, curl...) saying what to paste back. The card shows the proof as a banner. The CEO may pass lintOverride with a reason the owner reads, except for copy-safety, unfilled tokens, and typed input, pagers and commands that never return. If the owner already answered this on the ticket or its blockers, the call is refused and quotes their answer; pass stillNeeded saying what changed if it really must be asked again. approveSummary (optional, one line, up to 120 characters, plain text) says what choosing your recommended option does, e.g. \"Use deSEC for DNS on the website\": with it, the owner's phone notification can offer an Approve button that answers with your recommended option. Approve is offered only on a plain question with 2 to 4 options and no blocksTicketId, steps, ownerMustDo, stillNeeded, setsUp or doAfter, so write the summary so it can be approved without opening the card. When the card is how the owner checks a merged ticket's after-merge acceptance criterion, pass criterion with that check's number (as listed on the ticket, 1-based) or its exact text: the owner's answer then records that criterion's pass or fail however the card is worded, and the ticket can close on it. Without criterion the answer only records a check the card's own question or options name, and the tool tells you when it names none.",
      // Ordering (BOS-551): when this card must come before or after another owner card, pass doAfter/doBefore
      // (the other card's id and a short label) so the owner's queue numbers them and says which to do first.
      inputSchema: {
        question: z.string().min(1).max(1000),
        options: z.array(z.string().min(1).max(200)).min(2).max(6),
        recommended: z.string(),
        blocksTicketId: z.string().uuid().optional(),
        triedFirst: z.string().max(1000),
        ownerMustDo: z.boolean().optional(),
        steps: z.array(z.string().min(1).max(500)).max(12).optional(),
        stillNeeded: z.string().max(500).optional(),
        lintOverride: z.string().max(500).optional(),
        setsUp: z.enum(ADDONS).optional(),
        // The host a CEO-raised card is setting up, which Boss Man has no record for yet (DR-046): only that one name may be unrecorded.
        newHost: z.string().min(1).max(64).optional(),
        approveSummary: z.string().max(SUMMARY_MAX).optional(),
        proof: z.string().max(300).optional(),
        // Ordering against other owner cards (BOS-551): the ids of the cards this one must be done after or before, each with a short label.
        doAfter: z.array(z.object({ decisionId: z.string().uuid(), label: z.string().min(1).max(120) })).max(10).optional(),
        doBefore: z.array(z.object({ decisionId: z.string().uuid(), label: z.string().min(1).max(120) })).max(10).optional(),
        // A restart of the server resets what this card measures (a memory reading, say), so the next
        // update card lists it to do first (BOS-551).
        resetsOnRestart: z.boolean().optional(),
        // Which of the ticket's after-merge acceptance criteria this card settles (BOS-963): its number (1, 2, ...)
        // or its text. The owner's answer then records that criterion's pass or fail however the card is worded.
        criterion: z.union([z.number().int(), z.string().min(1).max(500)]).optional(),
      },
    },
    async ({ question, options, recommended, blocksTicketId, triedFirst, ownerMustDo, steps, stillNeeded, lintOverride, setsUp, newHost, approveSummary, proof, doAfter, doBefore, resetsOnRestart, criterion }) => {
      if (!options.includes(recommended)) return fail("The recommended answer must be one of the options.");
      // Stored cleaned, so the phone shows exactly what is stored (BOS-243 rule 2).
      const summary = approveSummary === undefined ? undefined : cleanSummary(approveSummary);
      if (summary === null) return fail("approveSummary is empty once line breaks and control characters are taken out. Write one plain line saying what your recommended option does, or leave it out.");
      const [me] = scope.agentId ? await db.select({ role: agents.role }).from(agents).where(and(eq(agents.id, scope.agentId), eq(agents.companyId, scope.companyId))) : [];
      const ask = checkAsk({ triedFirst, ownerMustDo, steps, options, lintOverride, byCeo: me?.role === "ceo", hosts: await hostFacts.hosts(), serverHost: await hostFacts.serverHost(), ...(newHost ? { newHost } : {}), hostValues: await hostFacts.valuesFor(steps), addons: steps?.length ? await addons?.() : undefined, setsUp, proof, ...(steps?.length && selfDeployCards ? { selfDeploy: await selfDeployCards() } : {}) });
      if (ask.error) return fail(ask.error);
      steps = ask.steps ?? steps; // {{host.…}} filled in
      if (blocksTicketId) {
        const [t] = await db.select({ id: tickets.id }).from(tickets).where(and(eq(tickets.id, blocksTicketId), eq(tickets.companyId, scope.companyId)));
        if (!t) return fail("No ticket with that ID in your company.");
        // Second layer: the service refuses too, but the tool should give the reason (BOS-86 round 12).
        const reviewWrite = await reviewTicketWriteRefusal(db, scope.companyId, blocksTicketId, scope.agentId);
        if (reviewWrite) return fail(reviewWrite);
        // BOS-1021: no owner card on a merged ticket until the merge is running. Judged from merge order, so a
        // ticket merged before the wait existed is covered too.
        const [m] = await db.select({ companyId: tickets.companyId, mergeCommit: tickets.mergeCommit, touchesRunner: tickets.touchesRunner }).from(tickets).where(eq(tickets.id, blocksTicketId));
        const notLive = m ? await goLiveWaitOf(db, m) : null;
        if (notLive) return fail(`This ticket's merge isn't live yet (${goLiveWaitWords(notLive)}), so the owner is not asked about it. Boss Man wakes you when it is live; don't raise this card before then.`);
      }
      // A card can name the after-merge criterion it settles (BOS-963), by number or by its text. Refuse now
      // if it points at nothing, or at a criterion that isn't checked after merge, rather than after an answer.
      let criterionIndexes: number[] | undefined;
      if (criterion !== undefined) {
        if (!blocksTicketId) return fail("criterion says which acceptance criterion this card settles, so it goes with blocksTicketId set to that ticket.");
        const [owner] = await db.select({ criteria: tickets.acceptanceCriteria, wait: tickets.goLiveWait }).from(tickets).where(and(eq(tickets.id, blocksTicketId), eq(tickets.companyId, scope.companyId)));
        // BOS-1021: the owner can't check what isn't running yet.
        if (owner?.wait) return fail(`This ticket's merge isn't live yet (${goLiveWaitWords(owner.wait as GoLiveWait)}), so its after-merge checks can't pass and the owner is not asked. Boss Man wakes you when it is live; don't raise this card before then.`);
        const list = readCriteria(owner?.criteria);
        const at = typeof criterion === "number" ? criterion - 1 : list.findIndex((c) => criterionText(c).toLowerCase() === criterion.trim().toLowerCase());
        if (!(at >= 0 && at < list.length)) return fail(`No criterion ${JSON.stringify(criterion)} on this ticket. Its criteria are:${list.length ? list.map((c, i) => ` ${i + 1}. ${criterionText(c)}${isAfterMerge(c) ? " (checked after merge)" : ""}`).join(";") : " none"}. Pass its number or its exact text.`);
        if (!isAfterMerge(list[at]!)) return fail(`Criterion ${at + 1} ("${criterionText(list[at]!)}") is checked before merge, so a review reports it, not an owner card.`);
        criterionIndexes = [at];
      }
      // Safe to repeat (R42): the same open question from the same agent isn't raised twice.
      if (scope.agentId) {
        const [same] = await db
          .select({ id: decisionsTable.id })
          .from(decisionsTable)
          .where(and(eq(decisionsTable.raisedByAgentId, scope.agentId), eq(decisionsTable.status, "open"), eq(decisionsTable.question, question)));
        if (same) return text(`Decision ${same.id} is already in the owner's queue. You'll be woken with the answer; don't wait in this turn.`);
      }
      // Don't ask again what the owner has already answered (BOS-123). A fresh reason lets it through.
      if (blocksTicketId) {
        const blockers = await db.select({ id: ticketDependencies.blockerTicketId }).from(ticketDependencies).where(eq(ticketDependencies.blockedTicketId, blocksTicketId));
        const earlier = await recentOwnerAnswer(db, { companyId: scope.companyId, ticketIds: [blocksTicketId, ...blockers.map((b) => b.id).filter((id): id is string => !!id)], includeMessages: false, decisionTypes: ["question"], question });
        if (earlier && !stillNeeded?.trim()) {
          return fail(`${quotedAnswer(earlier)}. It looks answered already, so this card wasn't raised. If it really still needs the owner, call raise_decision again with stillNeeded saying what has changed.`);
        }
      }
      let d: { id: string; droppedLinks?: DroppedOrderLink[] };
      try {
        d = await decisions.raise({ companyId: scope.companyId, agentId: scope.agentId, question, options, recommended, blocksTicketId, triedFirst: triedFirst.trim(), steps: steps?.length ? steps : undefined, stillNeeded: stillNeeded?.trim() || undefined, lint: ask.lint, setsUp, criterionIndexes, doAfter, doBefore, resetsOnRestart, ownerMustDo: ownerMustDo || undefined, approveSummary: summary });
      } catch (err) {
        if (err instanceof WorkError) return fail(err.message);
        throw err;
      }
      const links = await missingPageNote(db, scope.companyId, `${question}\n${options.join("\n")}\n${steps?.join("\n") ?? ""}`);
      // A link the raiser asked for that wasn't stored is named, with the reason (BOS-625).
      const skipped = (d.droppedLinks ?? []).map((l) => `${l.link} link ${l.decisionId} ignored: ${l.reason === "another company" ? "not an open card in your company" : l.reason === "not open" ? "the card is already answered" : "no such card"}.`);
      // Say now, not after the owner answers, whether this card's answer can settle an after-merge check (BOS-963):
      // the answer records against the criteria the card names, so a card worded differently would record nothing.
      const settle = blocksTicketId ? await afterMergeCardNote(db, blocksTicketId, question, options, criterionIndexes) : "";
      return text(`Decision ${d.id} is in the owner's queue. You'll be woken with the answer; don't wait in this turn.${skipped.length ? `\n\n${skipped.join("\n")}` : ""}${settle ? `\n\n${settle}` : ""}${links ? `\n\n${links}` : ""}`);
    },
  );

  server.registerTool(
    "submit_plan",
    {
      description: "For a plan-first ticket when you have no plan mode or ExitPlanMode (OpenCode and other non-Claude agents): save your plan on the ticket and raise the plan card for the approver. Approving it releases the ticket (the same as approving a plan from ExitPlanMode); \"Keep planning\" sends you feedback to revise, and you call submit_plan again. Stop and wait after calling it; don't change code until you are woken with the approval.",
      inputSchema: { ticketId: z.string().uuid(), plan: z.string().min(1).max(40000) },
    },
    async ({ ticketId, plan }) => {
      const [t] = await db.select({ id: tickets.id, title: tickets.title, planFirst: tickets.planFirst, planApprovedAt: tickets.planApprovedAt }).from(tickets).where(and(eq(tickets.id, ticketId), eq(tickets.companyId, scope.companyId)));
      if (!t) return fail("No ticket with that ID in your company.");
      if (!t.planFirst) return fail("This ticket is not plan-first, so it needs no plan card.");
      if (t.planApprovedAt) return fail("This ticket's plan is already approved; go ahead with it.");
      const reviewWrite = await reviewTicketWriteRefusal(db, scope.companyId, ticketId, scope.agentId);
      if (reviewWrite) return fail(reviewWrite);
      let d: { id: string };
      try {
        d = await decisions.raise({
          companyId: scope.companyId,
          agentId: scope.agentId,
          question: `Plan for "${t.title}": approve it?\n\n${plan}`.slice(0, 4000),
          options: [APPROVE_PLAN, KEEP_PLANNING],
          recommended: APPROVE_PLAN,
          blocksTicketId: ticketId,
          plan,
        });
      } catch (err) {
        if (err instanceof WorkError) return fail(err.message);
        throw err;
      }
      return text(`Plan card ${d.id} is with the plan approver. You'll be woken with the answer; stop now and don't change code until the plan is approved.`);
    },
  );

  server.registerTool(
    "withdraw_decision",
    {
      description: "Take back a decision card you raised, once it no longer needs the owner: they have already acted, or the thing resolved itself. Only a card you raised and only while it is open; any ticket it blocked can move again. Say why in reason.",
      inputSchema: { decisionId: z.string().uuid(), reason: z.string().max(500).optional() },
    },
    async ({ decisionId, reason }) => {
      if (!scope.agentId) return fail("Only an agent's run can withdraw a decision.");
      try {
        const r = await decisions.withdraw(decisionId, { agentId: scope.agentId }, reason);
        return r ? text(`Withdrew decision ${r.id}. Any ticket it blocked can move again.`) : fail("No open decision with that ID that you raised.");
      } catch (err) {
        if (err instanceof AnswerError) return fail(err.message);
        throw err;
      }
    },
  );

  server.registerTool(
    "report_key_result",
    {
      description: "Report the current value of one of your company's key results, e.g. after measuring progress.",
      inputSchema: { keyResultId: z.string().uuid(), value: z.number() },
    },
    async ({ keyResultId, value }) => {
      const [kr] = await db
        .select({ id: keyResults.id })
        .from(keyResults)
        .innerJoin(objectives, eq(objectives.id, keyResults.objectiveId))
        .where(and(eq(keyResults.id, keyResultId), eq(objectives.companyId, scope.companyId)));
      if (!kr) return fail("No key result with that ID in your company.");
      await db.update(keyResults).set({ current: value }).where(eq(keyResults.id, keyResultId));
      return text(`Key result ${keyResultId} is now ${value}.`);
    },
  );

  server.registerTool(
    "request_engagement",
    {
      description: "Ask another company to do work for yours, e.g. ask the homelab company to deploy a release. Say what is in scope and how you'll know it's done. The other company accepts or declines; you'll be woken when it does.",
      inputSchema: {
        providerCompany: z.string().min(1),
        title: z.string().min(1).max(200),
        scope: z.string().min(1).max(5000),
        deliverables: z.string().max(2000).optional(),
        acceptanceCriteria: z.array(z.string().min(1)).min(1).max(10),
        budgetCapUsd: z.number().positive().optional(),
        project: z.string().optional(),
      },
    },
    async (input) => {
      const [provider] = await db
        .select()
        .from(companies)
        .where(and(eq(companies.name, input.providerCompany), ne(companies.id, scope.companyId)));
      if (!provider) {
        const names = (await db.select({ name: companies.name }).from(companies).where(ne(companies.id, scope.companyId))).map((c) => c.name);
        return fail(`No other company called "${input.providerCompany}". Companies: ${names.join(", ") || "none"}.`);
      }
      const project = input.project ? await resolveProject(input.project) : await resolveProject();
      try {
        const eng = await engagements.request(
          { companyId: scope.companyId, agentId: scope.agentId, runId: scope.runId },
          { ...input, providerCompanyId: provider.id, requesterProjectId: project?.id ?? null },
        );
        return text(`Engagement ${eng.id} sent to ${provider.name}. You'll be woken when they respond. To make a ticket wait for it, the owner can add the engagement as a dependency.`);
      } catch (err) {
        if (err instanceof EngagementError) return fail(err.message);
        throw err;
      }
    },
  );

  server.registerTool(
    "engagement",
    {
      description:
        "Work on an engagement between your company and another. action: list (your company's engagements), view (status, terms and the last 20 thread messages; all: true for the whole thread), message, and the lifecycle steps. As the provider: accept, reject, counter (with changed terms), deliver (summary plus refs). As the requester: accept_counter, withdraw, sign_off, request_revision. Never put credentials in an engagement.",
      inputSchema: {
        action: z.enum(["list", "view", "accept", "reject", "counter", "accept_counter", "withdraw", "message", "deliver", "sign_off", "request_revision"]),
        engagementId: z.string().uuid().optional(),
        all: z.boolean().optional(),
        message: z.string().max(5000).optional(),
        summary: z.string().max(5000).optional(),
        refs: z.array(z.string().max(500)).max(20).optional(),
        scope: z.string().max(5000).optional(),
        deliverables: z.string().max(2000).optional(),
        acceptanceCriteria: z.array(z.string().min(1)).max(10).optional(),
        budgetCapUsd: z.number().positive().optional(),
      },
    },
    async (input) => {
      try {
        if (input.action === "list") return text(JSON.stringify(await engagements.list(scope.companyId)));
        if (!input.engagementId) return fail("Give the engagementId.");
        if (input.action === "view") return text(JSON.stringify(await engagements.view(input.engagementId, scope.companyId, input.all)));
        const needs = (field: "message" | "summary") => (input[field] ? null : fail(`The ${input.action.replace("_", " ")} action needs a ${field}.`));
        const missing =
          input.action === "counter" || input.action === "message" || input.action === "request_revision" ? needs("message") : input.action === "deliver" ? needs("summary") : null;
        if (missing) return missing;
        const result = await engagements.act(input.engagementId, { companyId: scope.companyId, agentId: scope.agentId, runId: scope.runId }, input as EngagementAction);
        return text(`${result.note} The engagement is now ${result.engagement.status.replace("_", " ")}.`);
      } catch (err) {
        if (err instanceof EngagementError) return fail(err.message);
        throw err;
      }
    },
  );

  server.registerTool(
    "deploy",
    {
      description:
        "Ship work to one of your company's deploy targets. action: targets (list them, each with its deploy tag if it has one and its last successful deploy: commit, time and tag result, so you can say what is live), request (target, ref, optional notes and ticketId; Boss Man records the commit the ref names and the approval names it; production targets wait for the owner, and you're woken in a run that holds the target's secrets once approved), report (deployId and outcome, from that run, when the deploy is done). Deploy scripts must not push git tags themselves (agents have no git login): when a target has a deploy tag, Boss Man moves it to the deployed commit after you report success.",
      inputSchema: {
        action: z.enum(["targets", "request", "report"]),
        target: z.string().optional(),
        ref: z.string().min(1).max(200).optional(),
        notes: z.string().max(2000).optional(),
        ticketId: z.string().uuid().optional(),
        deployId: z.string().uuid().optional(),
        outcome: z.enum(["succeeded", "failed"]).optional(),
      },
    },
    async (input) => {
      try {
        if (input.action === "targets") {
          const [ts, last] = await Promise.all([deploys.listTargets(scope.companyId), deploys.lastSucceeded(scope.companyId)]);
          return text(
            JSON.stringify(
              ts.map((t) => {
                const d = last.get(t.id);
                return {
                  name: t.name,
                  kind: t.kind,
                  endpoint: t.endpoint,
                  production: t.isProduction,
                  deployTag: liveTagOf(t)?.name ?? null,
                  lastSucceeded: d ? { deployId: d.id, ref: d.ref, commit: d.commit, at: d.finishedAt, tag: d.tagName ? { name: d.tagName, result: d.tagResult, from: d.tagFrom, to: d.tagTo } : null } : null,
                };
              }),
            ),
          );
        }
        if (input.action === "request") {
          if (!input.target || !input.ref) return fail("Give the target and the ref to deploy.");
          const r = await deploys.request({ companyId: scope.companyId, agentId: scope.agentId, runId: scope.runId }, { target: input.target, ref: input.ref, notes: input.notes, ticketId: input.ticketId });
          return text(`Deploy ${r.deploy.id}: ${r.note}`);
        }
        if (!input.deployId || !input.outcome) return fail("Give the deployId and the outcome.");
        const d = await deploys.report({ companyId: scope.companyId, runId: scope.runId }, { deployId: input.deployId, outcome: input.outcome, notes: input.notes });
        const tag = d.tagResult === "pending" ? ` Boss Man is moving the tag ${d.tagName} to ${d.commit?.slice(0, 7)}; the result goes on the ticket.` : "";
        return text(`Deploy ${d.id} recorded as ${d.status}. The target's secrets are no longer available.${tag}`);
      } catch (err) {
        if (err instanceof DeployError) return fail(err.message);
        throw err;
      }
    },
  );

  server.registerTool(
    "runs",
    {
      description:
        "For CEOs: see your company's running agents and steer them. action: list; message (runId, message; add interrupt to stop the current turn first; an ended run is woken again with the message); stop (runId).",
      inputSchema: {
        action: z.enum(["list", "message", "stop"]),
        runId: z.string().uuid().optional(),
        message: z.string().max(20_000).optional(),
        interrupt: z.boolean().optional(),
      },
    },
    async (input) => {
      const [me] = scope.agentId ? await db.select({ role: agents.role, name: agents.name }).from(agents).where(eq(agents.id, scope.agentId)) : [];
      if (me?.role !== "ceo") return fail("Only your company's CEO can steer runs.");
      try {
        if (input.action === "list") return text(JSON.stringify(await runs.active(scope.companyId)));
        if (!input.runId) return fail("Give the runId.");
        if (input.runId === scope.runId) return fail("That's your own run.");
        if (input.action === "stop") {
          await runs.cancel(input.runId, scope.companyId);
          return text(`Stopping run ${input.runId}.`);
        }
        if (!input.message) return fail("Give the message.");
        const r = await runs.message(input.runId, { text: input.message, interrupt: input.interrupt, from: `${me.name} (your CEO)`, companyId: scope.companyId, causedByRunId: scope.runId });
        return text(r.delivered === "woken" ? "That run had ended; the agent is woken again with your message." : `Message ${r.delivered}.`);
      } catch (err) {
        if (err instanceof RunError) return fail(err.message);
        throw err;
      }
    },
  );

  // Standing rules (BOS-353): the CEO writes them here; the owner has their own route, and no other agent can change them.
  server.registerTool(
    "standing_rules",
    {
      description:
        `For CEOs only: the company-wide "Standing rules" every agent reads at the start of every run (at most ${STANDING_RULES_MAX} characters). action read shows the current text and who changed it last; action write replaces it with text. Only you and the owner can change them; agents cannot. Unless the owner has asked to approve your edits, a change is applied at once, notifies the owner and can be undone on the Settings page; otherwise it waits in Decisions. Write rules that fit any host and any company (for example "never force-push"), not one-off instructions for a single ticket.`,
      inputSchema: { action: z.enum(["read", "write"]), text: z.string().max(20_000).optional() },
    },
    async ({ action, text: body }) => {
      const [me] = scope.agentId ? await db.select({ role: agents.role, name: agents.name }).from(agents).where(eq(agents.id, scope.agentId)) : [];
      if (me?.role !== "ceo") return fail("Only your company's CEO can change the standing rules.");
      if (action === "read") {
        const r = await getStandingRules(db, scope.companyId);
        return text(r.text ? `Standing rules (last changed by ${r.by ?? "someone"}):\n\n${r.text}` : "No standing rules are set.");
      }
      if (body === undefined) return fail("Give the text to save, or an empty string to clear them.");
      try {
        const r = await team.proposeStandingRules(scope.companyId, scope.agentId!, body);
        if ("decisionId" in r) return text(`The change is waiting for the owner's approval (decision ${r.decisionId}).`);
        return text(r.saved.text ? "Standing rules saved; every run from now on reads them." : "Standing rules cleared.");
      } catch (err) {
        if (err instanceof StandingRulesError) return fail(err.message);
        if (err instanceof AgentError) return fail(err.message);
        throw err;
      }
    },
  );

  server.registerTool(
    "notify_owner",
    {
      description:
        "Tell the owner something they should know without needing to answer: note (the feed only), flag (a browser notification) or page (also their phone; for something urgent). For a question, use raise_decision instead. Pass the ticket it's about, if any, and link to what you made (a wiki page, say) so the owner sees the work itself. Each agent has an hourly cap, past which notifications become notes, and quiet hours lower the level.",
      inputSchema: {
        level: z.enum(["note", "flag", "page"]),
        title: z.string().min(1).max(200),
        body: z.string().max(4000).optional(),
        ticketId: z.string().uuid().optional(),
        stillNeeded: z.string().max(500).optional(),
        link: z
          .string()
          .regex(/^#\/(wiki|tickets|runs|features|roadmap|plan)(\/[\w-]+)*$/)
          .optional()
          .describe("The page that shows what you're telling them about, e.g. the #/wiki/... link the wiki tool gave you. Defaults to the ticket, else this run."),
      },
    },
    async (input) => {
      if (input.ticketId) {
        const [t] = await db.select({ id: tickets.id }).from(tickets).where(and(eq(tickets.id, input.ticketId), eq(tickets.companyId, scope.companyId)));
        if (!t) return fail("No ticket with that ID in your company.");
        // Don't tell the owner they still must act on something they have already answered (BOS-123).
        const asks = /\b(need(s)? you|your (approval|decision|answer|sign-?off)|waiting (on|for) you|blocked on you|over to you)\b/i.test(`${input.title} ${input.body ?? ""}`);
        if (asks && !input.stillNeeded?.trim()) {
          const blockers = await db.select({ id: ticketDependencies.blockerTicketId }).from(ticketDependencies).where(eq(ticketDependencies.blockedTicketId, input.ticketId));
          const earlier = await recentOwnerAnswer(db, { companyId: scope.companyId, ticketIds: [input.ticketId, ...blockers.map((b) => b.id).filter((id): id is string => !!id)], includeMessages: false, decisionTypes: ["question"], question: `${input.title} ${input.body ?? ""}` });
          if (earlier) return fail(`${quotedAnswer(earlier)}. Check the live state before telling the owner they must act; if it really still needs them, pass stillNeeded saying what changed.`);
        }
      }
      const link = input.link ?? (input.ticketId ? `#/tickets/${input.ticketId}` : `#/runs/${scope.runId}`);
      const n = await notes.notify({ companyId: scope.companyId, agentId: scope.agentId, level: input.level, title: input.title, body: input.body ?? null, link });
      if (!n) return fail("Couldn't record that notification.");
      const links = await missingPageNote(db, scope.companyId, `${input.title}\n${input.body ?? ""}`);
      const sent = n.level === input.level ? `Sent as a ${n.level}.` : `Sent as a ${n.level} instead of a ${input.level} (${n.demotedBy}).`;
      return text(`${sent}${links ? `\n\n${links}` : ""}`);
    },
  );

  server.registerTool(
    "feedback",
    {
      description:
        "Your company's feature requests. Anyone can: inbox (unprocessed feedback, oldest first; long notes are cut, note noteId reads one in full), features (each feature's id, status, rank, column, demand and priority), log (feedback you heard: text, optional from and title; set fromOutside when it came from outside the company). The CEO also triages: link (noteId, featureId, importance nice_to_have|important|critical, optional highlight copied exactly from the note), create_feature (title, optional description, optional objectiveId or milestoneId from board when the feature serves one), mark (noteId, state processed|archived). The CEO, managers and product managers size features (size: featureId, effort 1 tiny to 5 huge, optional scores by the company's criteria, each 0 to 5, from features' criteria list, and a reason) and place them on the roadmap (update_feature: featureId plus any of objectiveId or milestoneId, rank 1 to 5, horizon now|next|later, status, publicSummary, publicTitle, showPublicly, portalVisible, keepOffPortal (true only: marking a feature sensitive; clearing that mark is the owner's job in the app), and a reason). Priority is value divided by effort, so an unsized feature can't be ranked: size the ones features lists with effort null. Rank is a person's own 1 to 5 ordering; horizon is the Now / Next / Later column. publicSummary is the feature's public roadmap blurb (up to 2000 plain characters): visitors see it, so use plain words with no internal names or secrets. showPublicly puts the summary on the public roadmap; it needs a publicSummary, so write the summary first. On the feedback portal visitors see the public summary and, as its title, the public title (publicTitle, up to 200 plain characters) or the public summary's first line; portalVisible cannot be turned on for a feature that reads as security work (only the owner can do that in the app).",
      inputSchema: {
        action: z.enum(["inbox", "note", "features", "log", "link", "create_feature", "mark", "size", "update_feature"]),
        effort: z.number().int().min(1).max(5).optional(),
        rank: z.number().int().min(1).max(5).nullable().optional(),
        horizon: z.enum(HORIZONS).nullable().optional(),
        status: z.enum(FEATURE_STATUSES).optional(),
        scores: z.record(z.string().min(1).max(100), z.number().int().min(0).max(5)).optional(),
        reason: z.string().trim().min(1).max(240).optional(),
        noteId: z.string().uuid().optional(),
        featureId: z.string().uuid().optional(),
        objectiveId: z.string().uuid().nullable().optional(),
        milestoneId: z.string().uuid().nullable().optional(),
        publicSummary: z.string().trim().max(2000).nullable().optional(),
        publicTitle: z.string().trim().max(200).nullable().optional(),
        showPublicly: z.boolean().optional(),
        portalVisible: z.boolean().optional(),
        keepOffPortal: z.literal(true).optional(),
        importance: z.enum(IMPORTANCE).optional(),
        highlight: z.string().max(2000).optional(),
        title: z.string().min(1).max(200).optional(),
        description: z.string().max(10_000).optional(),
        text: z.string().min(1).max(20_000).optional(),
        from: z.string().min(1).max(200).optional(),
        fromOutside: z.boolean().optional(),
        state: z.enum(["processed", "archived"]).optional(),
      },
    },
    async (input) => {
      try {
        if (input.action === "inbox") {
          const rows = await feedback.untriaged(scope.companyId, 20);
          if (!rows.length) return text("No unprocessed feedback.");
          return text(
            rows
              .map(({ note: n, customer }) => {
                const head = `Note ${n.id} from ${customer ?? "someone anonymous"} via ${n.source}, ${n.createdAt.toISOString().slice(0, 10)}${n.title ? `: ${n.title}` : ""}`;
                const body = cut(n.text, 2000, () => `read it all with feedback note noteId=${n.id}`);
                return `${head}\n${n.untrusted ? untrusted(`feedback via ${n.source}`, body) : body}`;
              })
              .join("\n\n"),
          );
        }
        if (input.action === "note") {
          if (!input.noteId) return fail("Give the noteId.");
          const { note: n } = await feedback.noteDetail(input.noteId, scope.companyId);
          return text(`${n.title ? `${n.title}\n` : ""}${n.untrusted ? untrusted(`feedback via ${n.source}`, n.text) : n.text}`);
        }
        if (input.action === "features") {
          const all = await feedback.scored(scope.companyId);
          const list = all.features
            .filter((f) => f.status !== "declined")
            .sort((a, b) => b.priority - a.priority)
            .slice(0, 60)
            .map((f) => ({ id: f.id, title: f.title, status: f.status, parentId: f.parentId, objectiveId: f.objectiveId, milestoneId: f.milestoneId, rank: f.rank, horizon: f.horizon, demand: f.demand, people: f.customerCount, effort: f.effort, scores: Object.fromEntries(all.drivers.map((d) => [d.name, f.driverScores[d.id] ?? null])), value: f.value, priority: f.priority, tickets: f.tickets }));
          return text(JSON.stringify({ criteria: all.drivers.map((d) => ({ name: d.name, weight: d.weight })), features: list }));
        }
        if (input.action === "update_feature") {
          const [me] = scope.agentId ? await db.select({ name: agents.name, role: agents.role, template: agents.template }).from(agents).where(eq(agents.id, scope.agentId)) : [];
          if (!me || (me.role !== "ceo" && me.role !== "manager" && me.template !== "product-manager")) return fail("Only the CEO, a manager or a product manager can place features on the roadmap.");
          if (!input.featureId) return fail("Give featureId.");
          // update_feature never saves a feature's title or description, so a title/description here would be silently
          // ignored; worse, it could be used as decoy text to slip a security-worded feature onto the portal (BOS-991).
          if (input.title !== undefined || input.description !== undefined) return fail("update_feature does not change a feature's title or description. Leave them out.");
          const changes = {
            ...(input.objectiveId !== undefined ? { objectiveId: input.objectiveId } : {}),
            ...(input.milestoneId !== undefined ? { milestoneId: input.milestoneId } : {}),
            ...(input.rank !== undefined ? { rank: input.rank } : {}),
            ...(input.horizon !== undefined ? { horizon: input.horizon } : {}),
            ...(input.status !== undefined ? { status: input.status } : {}),
            ...(input.publicSummary !== undefined ? { publicSummary: input.publicSummary } : {}),
            ...(input.publicTitle !== undefined ? { publicTitle: input.publicTitle } : {}),
            ...(input.showPublicly !== undefined ? { showPublicly: input.showPublicly } : {}),
            ...(input.portalVisible !== undefined ? { portalVisible: input.portalVisible } : {}),
            // An agent may mark a feature sensitive, but only the owner clears that mark: these agents read outside
            // feedback during triage, so a hostile note must not be able to talk one into publishing a marked feature.
            ...(input.keepOffPortal === true ? { keepOffPortal: true } : {}),
          };
          if (!Object.keys(changes).length) return fail("Nothing to change: give objectiveId, milestoneId, rank (1 to 5), horizon (now, next or later), status, publicSummary, publicTitle, showPublicly, portalVisible or keepOffPortal (true only).");
          if (!input.reason) return fail("Say why in reason (up to 240 characters); it goes in the activity log.");
          // A feature the portal rule calls security work stays off the portal: agents read hostile feedback during
          // triage, so a note must not talk one into publishing it. Only the owner can tick it on in the app (BOS-991).
          if (input.portalVisible === true) {
            const target = await feedback.feature(input.featureId, scope.companyId);
            const facts = await feedback.portalFacts(scope.companyId, target.areaId, target.driverScores as Record<string, number | null>);
            // Judge the stored feature: update_feature never saves title/description, so input values must not be used here.
            const verdict = portalVerdict({
              title: target.title,
              description: target.description,
              ...facts,
              keepOffPortal: input.keepOffPortal ?? target.keepOffPortal,
              hasPublicSummary: true,
            });
            if (verdict.reason === "security") return fail("This feature reads as security work, so it stays off the feedback portal. Only the owner can put it there, in the Features page.");
          }
          const f = await feedback.updateFeature(input.featureId, changes, scope.companyId);
          const parts = [
            input.objectiveId !== undefined ? (input.objectiveId ? "linked it to an objective" : "unlinked its objective") : null,
            input.milestoneId !== undefined ? (input.milestoneId ? "put it in a milestone" : "took it out of its milestone") : null,
            input.rank !== undefined ? `rank ${input.rank ?? "none"}` : null,
            input.horizon !== undefined ? `column ${input.horizon ?? "automatic"}` : null,
            input.status !== undefined ? `status ${input.status}` : null,
            input.publicSummary !== undefined ? (input.publicSummary ? "wrote its public summary" : "cleared its public summary") : null,
            input.publicTitle !== undefined ? (input.publicTitle ? "wrote its public title" : "cleared its public title") : null,
            input.showPublicly !== undefined ? (input.showPublicly ? "shows it publicly" : "hides it from the public roadmap") : null,
            input.portalVisible !== undefined ? (input.portalVisible ? "put it on the feedback portal" : "took it off the feedback portal") : null,
            input.keepOffPortal === true ? "kept it off the portal (sensitive)" : null,
          ].filter(Boolean);
          await record(db, { companyId: scope.companyId, agentId: scope.agentId, kind: "feature_updated", summary: `${me.name} placed "${f.title}" on the roadmap: ${parts.join(", ")}. ${input.reason}` });
          return text(`Updated "${f.title}": ${parts.join(", ")}.`);
        }
        if (input.action === "size") {
          const [me] = scope.agentId ? await db.select({ name: agents.name, role: agents.role, template: agents.template }).from(agents).where(eq(agents.id, scope.agentId)) : [];
          if (!me || (me.role !== "ceo" && me.role !== "manager" && me.template !== "product-manager")) return fail("Only the CEO, a manager or a product manager can size features.");
          if (!input.featureId || (input.effort === undefined && !input.scores)) return fail("Give featureId and effort (1 to 5), scores, or both.");
          if (!input.reason) return fail("Say why in reason (up to 240 characters); it goes in the activity log.");
          const drivers = await feedback.drivers(scope.companyId);
          const driverScores: Record<string, number> = {};
          for (const [name, v] of Object.entries(input.scores ?? {})) {
            const d = drivers.find((x) => x.name.toLowerCase() === name.toLowerCase() || x.id === name);
            if (!d) return fail(`No criterion called ${name}. Criteria: ${drivers.map((x) => x.name).join(", ") || "none set up yet"}.`);
            driverScores[d.id] = v;
          }
          const f = await feedback.updateFeature(input.featureId, { ...(input.effort !== undefined ? { effort: input.effort } : {}), ...(Object.keys(driverScores).length ? { driverScores } : {}) }, scope.companyId);
          await record(db, { companyId: scope.companyId, agentId: scope.agentId, kind: "feature_sized", summary: `${me.name} sized "${f.title}"${input.effort !== undefined ? `: effort ${input.effort}` : ""}${Object.keys(input.scores ?? {}).length ? `, ${Object.entries(input.scores!).map(([k, v]) => `${k} ${v}`).join(", ")}` : ""}. ${input.reason}` });
          return text(`Sized "${f.title}".`);
        }
        if (input.action === "log") {
          if (!input.text) return fail("Give the feedback as text.");
          const n = await feedback.createNote(scope.companyId, {
            text: input.text,
            title: input.title ?? null,
            source: "agent",
            customer: input.from ? { name: input.from } : null,
            untrusted: input.fromOutside ?? false,
            createdByAgentId: scope.agentId,
          });
          return text(`Logged as note ${n.id}.`);
        }
        const [me] = scope.agentId ? await db.select({ role: agents.role }).from(agents).where(eq(agents.id, scope.agentId)) : [];
        if (me?.role !== "ceo") return fail("Only your company's CEO triages feedback. You can log it and read it.");
        const by = (await db.select({ name: agents.name }).from(agents).where(eq(agents.id, scope.agentId!)))[0]?.name ?? "the CEO";
        if (input.action === "link") {
          if (!input.noteId || !input.featureId) return fail("Give noteId and featureId.");
          await feedback.link(input.noteId, { featureId: input.featureId, importance: input.importance ?? "important", highlight: input.highlight ?? null, createdBy: by }, scope.companyId);
          return text("Linked.");
        }
        if (input.action === "create_feature") {
          if (!input.title) return fail("Give the feature a title.");
          const existing = (await feedback.scored(scope.companyId)).features.find((f) => f.title.toLowerCase() === input.title!.toLowerCase());
          if (existing) return text(`Feature ${existing.id} "${existing.title}" already exists; link to it.`);
          const f = await feedback.createFeature(scope.companyId, { title: input.title, description: input.description ?? null, objectiveId: input.objectiveId ?? null, milestoneId: input.milestoneId ?? null, createdByAgentId: scope.agentId });
          return text(`Created feature ${f.id}.`);
        }
        if (!input.noteId || !input.state) return fail("Give noteId and state.");
        await feedback.updateNote(input.noteId, { state: input.state }, scope.companyId);
        return text(`Marked ${input.state}.`);
      } catch (err) {
        if (err instanceof FeedbackError) return fail(err.message);
        throw err;
      }
    },
  );

  server.registerTool(
    "handoff",
    {
      description:
        "CEO only. Write the handoff for your next chapter, which starts with a fresh conversation: what you're in the middle of, what you've promised and to whom, pending decisions and your recommendations, risks you're watching, and anything not yet in your notes. Calling it again replaces the previous handoff.",
      inputSchema: { summary: z.string().min(1).max(20_000) },
    },
    async ({ summary }) => {
      const [me] = scope.agentId ? await db.select({ role: agents.role }).from(agents).where(eq(agents.id, scope.agentId)) : [];
      if (me?.role !== "ceo" || !scope.agentId) return fail("Only your company's CEO writes chapter handoffs.");
      const c = await chapters.writeHandoff(scope.agentId, summary);
      if (!c) return fail("You have no open chapter to hand off from.");
      return text(`Handoff saved for chapter ${c.number + 1}.`);
    },
  );

  registerDecisionTools(server, db, { decisions, review, notes, retro, alerts, hostFacts, addons, selfDeployCards }, scope, noteRunTicket);


  server.registerTool(
    "pa_verdict",
    {
      description: "For CEOs: mark one of your PA's answers correct or wrong, with a note on what was off. The ids are in the \"PA answers to check\" part of your brief. This only keeps score; it changes nothing else.",
      inputSchema: { answerId: z.string().uuid(), verdict: z.enum(["correct", "wrong"]), note: z.string().max(1000).optional() },
    },
    async ({ answerId, verdict, note }) => {
      const [me] = scope.agentId ? await db.select({ role: agents.role }).from(agents).where(eq(agents.id, scope.agentId)) : [];
      if (me?.role !== "ceo") return fail("Only your company's CEO marks the PA's answers.");
      return (await pa.verdict(scope.companyId, answerId, verdict, note)) ? text(`Marked ${verdict}.`) : fail("No PA answer with that id in your company.");
    },
  );

  // The server view is the CEO's (BOS-224), in its chat and its runs: it names the server's work,
  // so it is not registered for a worker's run, however safe its contents are filtered.
  if (withServerStatus) {
    server.registerTool(
      "server_status",
      {
        description:
          "A read-only view of the server, for when you or the owner need to know what is actually running. Say Boss Man is up only when the stack field says healthy: one server answering is not enough. stack is healthy, degraded or down, and stackWhy gives the reasons (for example a failed or partial last deploy, which stays degraded until a later deploy result replaces it). Also shown: both blue/green colours (colours), when the database last started (database.startedAt), the live commit and when it went live, whether this server leads, the state of your company's runner, wakes that are waiting or failed to start (with their age), the last run starts and failures with their reasons, the latest migration, recent server errors with secrets redacted, server freezes over 1 s with memory, GC time and requests in flight (stalls), and the Synthetic plan's quota (syntheticUsage: which measure it is, used of the limit (the plan's weekly credits, which regenerate 2% at a time, or else the old request window), when it renews, how old the reading is, recent readings this period and which of your company's agents are paid from it, with the number of other companies' agents on the same plan but not their names). Also runLimits: the all-companies and per-company run limits in force, with how many work runs each has going (counts only); a waiting wake held 'at a concurrency limit: all companies' waits for the first, 'this company' for the second, and 'this agent is busy' for the agent's own run. Also addons: ntfy, Tailscale and Penpot, each with state (not_set_up, stopped, needs_login, running or unknown), since and source. Never tell the owner an add-on carries over, is back up or works unless its state is running; unknown means Boss Man can't see it, so say so. It changes nothing and shows no other company's tickets, runs or errors.",
        inputSchema: {},
      },
      async () => text(JSON.stringify(await serverStatus.status(scope.companyId))),
    );
  }

  server.registerTool(
    "devices",
    {
      description:
        "The owner's recorded screens (BOS-641), read-only. Each profile is one of the owner's own browsers, measured there: CSS width and height, pixel ratio, touch (coarse pointer), display-mode (standalone or browser), and the measured pixel heights of 100vh, 100dvh, 100svh, 100lvh and the visual viewport, once at load and again after the first scroll (the phone toolbar shows on load and hides after a scroll). A layout or sizing ticket that names a device is accepted at this profile: write a rendering test (headless browser at the exact figures) rather than a CSS-text test, and take any imitated toolbar or safe-area gap from the readings here, saying so in the test. A CSS-text test never counts as the rendering check. Only screen facts are kept; a device the owner hasn't opened Boss Man on won't appear.",
      inputSchema: {},
    },
    async () => text(JSON.stringify(await deviceProfiles.allRenderable())),
  );

  if (skip?.size) (server.registerTool as unknown) = originalRegister;
}



/**
 * Tools every run has, chat included (R69, R71, R77): the wiki, the skill library, and reading
 * the company's tickets, so an agent can look things up instead of saying it can't see them.
 */
/** Opening a picture or file the owner attached, or a screenshot an agent attached, in every kind of run. */
function registerViewImage(server: McpServer, images: Services["images"], scope: Scope) {
  server.registerTool(
    "open_attachment",
    {
      description: "Open something the owner attached. In a task, a message or the chat, a picture appears as ![name](/api/ticket-images/<id>) and a file as [📎 name](/api/ticket-images/<id>); open each one with this tool (pass the id) before you act on it. Pictures come back as images, text files as text, PDFs as a document, and a .zip (such as a company export) as a listing of its entries plus the text files inside it. Long text comes in parts; pass offset to read the rest.",
      inputSchema: { id: z.string().uuid(), offset: z.number().int().min(0).optional() },
    },
    async ({ id, offset }) => {
      const a = await images.forCompany(id, scope.companyId);
      if (!a) return fail("No attachment with that id in your company.");
      const bytes = Buffer.from(a.bytes);
      const label = a.caption ? `${a.name}: ${a.caption}` : a.name;
      if (a.type.startsWith("image/")) return { content: [{ type: "image" as const, data: bytes.toString("base64"), mimeType: a.type }, { type: "text" as const, text: label }] };
      // Text comes in parts so a long log reaches the agent whole, never silently cut.
      if (a.type === "text/plain") {
        const body = bytes.toString("utf8");
        return text(`${label}\n\n${cut(body, CAP, (m) => `continue with open_attachment id=${id} offset=${m}`, offset)}`);
      }
      if (a.type === "application/pdf") return { content: [{ type: "resource" as const, resource: { uri: `bossman:attachment/${id}`, mimeType: a.type, blob: bytes.toString("base64") } }, { type: "text" as const, text: `${label} (PDF)` }] };
      // A zip (BOS-228) comes back as its file listing plus the text files inside, in parts like any long text.
      if (a.type === "application/zip") {
        try {
          const body = readZip(bytes);
          return text(`${label} (zip)\n\n${cut(body, CAP, (m) => `continue with open_attachment id=${id} offset=${m}`, offset)}`);
        } catch (err) {
          if (err instanceof ZipReadError) return fail(`${label}: ${err.message}`);
          throw err;
        }
      }
      return text(`${label} is a ${a.type} file of ${bytes.length} bytes that can't be shown as text or a picture. Ask the owner what's in it, or for a PDF or text copy.`);
    },
  );
}

function registerSharedTools(server: McpServer, db: Db, { notes, wiki, skills, skillProposals, review, agents: team }: Pick<Services, "notes" | "wiki" | "skills" | "skillProposals" | "review" | "agents">, scope: Scope) {
  server.registerTool(
    "tickets",
    {
      description:
        "Look up your company's tickets. Each has a reference like HOL-12, which you can use anywhere this tool takes a ticketId. find (optional q to search titles and descriptions, or a reference, optional state) lists matches with their ids and references; read (ticketId) gives one ticket: description (long ones are cut; pass offset to continue), state, assignee, its branch, what it produced (wiki pages, repo files, links) and its recent conversation; file (ticketId, path, optional offset) reads a file from that ticket's work in the repo, such as a document it wrote, even if it was never merged; long files come in parts of 40000 characters.",
      inputSchema: { action: z.enum(["find", "read", "file"]), q: z.string().max(200).optional(), state: z.enum(STATES).optional(), ticketId: z.string().max(40).optional(), path: z.string().max(500).optional(), offset: z.number().int().min(0).optional() },
    },
    async ({ action, q, state, ticketId: given, path, offset }) => {
      const asRef = given ? REF.exec(given) : null;
      const ref = await refsOf(db, scope.companyId);
      const idStartsWith = (p: string) => sql`${tickets.id}::text like ${`${p.toLowerCase()}%`}`;
      let ticketId = asRef
        ? (await db.select({ id: tickets.id }).from(tickets).where(and(eq(tickets.companyId, scope.companyId), eq(tickets.number, Number(asRef[1])))))[0]?.id
        : given && z.string().uuid().safeParse(given).success ? given : undefined;
      // A unique 8-character id prefix finds the ticket; several matches are listed (BOS-435).
      if (given && !ticketId && ID_PREFIX.test(given)) {
        const hits = await db.select({ id: tickets.id, number: tickets.number, title: tickets.title }).from(tickets).where(and(eq(tickets.companyId, scope.companyId), idStartsWith(given))).limit(10);
        if (hits.length > 1) return fail(`${hits.length} tickets start with ${given}; use the reference or the full id:\n${hits.map((h) => `- ${ref(h).ref ?? h.id}: ${h.title} (id ${h.id})`).join("\n")}`);
        ticketId = hits[0]?.id;
      }
      if (given && !ticketId) return fail(`No ticket ${given} in your company.`);
      if (action === "file") {
        if (!ticketId || !path) return fail("Give the ticketId and the file's path in the repo.");
        try {
          const f = await review.readFile(ticketId, path, scope.companyId);
          return text(`${path} (from the ticket's ${f.from === "worktree" ? "worktree" : "branch"}${f.truncated ? "; cut off at 256 KB" : ""}):\n\n${cut(f.text, CAP, (m) => `continue with tickets file offset=${m}`, offset)}`);
        } catch (err) {
          if (err instanceof ReviewError) return fail(err.message);
          throw err;
        }
      }
      if (action === "find") {
        const byRef = q ? REF.exec(q.trim()) : null;
        const byPrefix = q && ID_PREFIX.test(q.trim()) ? q.trim() : null;
        const like = q?.trim() && !byRef ? `%${q.trim().replace(/[%_\\]/g, (c) => `\\${c}`)}%` : null;
        const rows = await db
          .select({ id: tickets.id, number: tickets.number, title: tickets.title, state: tickets.systemState, version: tickets.version, outcome: tickets.outcome, assignee: agents.name, lastActivityAt: tickets.lastActivityAt, stateNote: tickets.stateNote, stateNoteAt: tickets.stateNoteAt, stateNoteStaleAt: tickets.stateNoteStaleAt })
          .from(tickets)
          .leftJoin(agents, eq(agents.id, tickets.assigneeAgentId))
          .where(and(eq(tickets.companyId, scope.companyId), state ? eq(tickets.systemState, state) : undefined, byRef ? eq(tickets.number, Number(byRef[1])) : undefined, like ? or(ilike(tickets.title, like), ilike(tickets.body, like), byPrefix ? idStartsWith(byPrefix) : undefined) : undefined))
          .orderBy(desc(tickets.lastActivityAt))
          .limit(40);
        return text(JSON.stringify(rows.map((r) => withNote(ref(r)))));
      }
      if (!ticketId) return fail("Give the ticketId to read.");
      const [row] = await db
        .select({ t: tickets, project: projects.name, repoUrl: projects.repoUrl, assignee: agents.name })
        .from(tickets)
        .innerJoin(projects, eq(projects.id, tickets.projectId))
        .leftJoin(agents, eq(agents.id, tickets.assigneeAgentId))
        .where(and(eq(tickets.id, ticketId), eq(tickets.companyId, scope.companyId)));
      if (!row) return fail("No ticket with that ID in your company.");
      const made = await wiki.artifacts(ticketId);
      const talk = await conversationLines(db, ticketId);
      const pics = await db.select({ id: ticketImages.id, name: ticketImages.name, caption: ticketImages.caption }).from(ticketImages).where(and(eq(ticketImages.ticketId, ticketId), eq(ticketImages.companyId, scope.companyId), sql`${ticketImages.type} like 'image/%'`)).orderBy(asc(ticketImages.createdAt));
      const t = row.t;
      const note = stateNoteLine(t, new Date());
      // The sign-off in plain words, from the decisions themselves (BOS-503): agents can't see decision state otherwise.
      const signoff = t.systemState === "review" ? signoffLine(await signoffState(db, t)) : null;
      const signoffLog = await signoffHistory(db, ticketId);
      const mergeState = t.systemState === "review" ? await review.mergeState(ticketId) : null;
      const hv = t.systemState === "review" ? await holdView(db, ticketId) : null;
      const holdLine = hv ? `Merge held by ${hv.reviewer ?? "a reviewer"} (${hv.label}): ${hv.reason}.${hv.ready ? " What it waited for is done; the reviewer re-checks and releases it." : ""}` : null;
      const ciLine = await review.branchChecksLine(ticketId, scope.companyId);
      const liveLine = await goLiveLine(db, t);
      // One page covers the whole thing, description through conversation, so a long owner message is
      // followed rather than cut; the whole text is paged by offset, and a long line is split and continued.
      const head = [
        `# ${t.title}`,
        `Ticket ${ref(t).ref ?? ""} (id ${t.id}) in project "${row.project}". State: ${t.systemState}${t.outcome ? ` (${t.outcome})` : ""}. Version: ${t.version}. Assigned to: ${row.assignee ?? (t.assignedToOwner ? "the owner" : "nobody")}. Risk: ${t.risk ?? "medium"}.`,
        ...(note ? [note] : []),
        ...(signoff ? [signoff] : []),
        ...(signoffLog ? [signoffLog] : []),
        ...(mergeState ? [`Merge state: ${mergeState}.`] : []),
        ...(holdLine ? [holdLine] : []),
        ...(ciLine ? [ciLine] : []),
        ...(liveLine ? [liveLine] : []),
        ...(t.systemState === "blocked" && t.blockedUntil ? [`Blocked until ${t.blockedUntil.toISOString().slice(0, 16).replace("T", " ")} UTC${t.blockedUntilReason ? `: ${t.blockedUntilReason}` : ""}.`] : []),
        t.branch ? `Branch: ${t.branch}${row.repoUrl ? ` in ${row.repoUrl}` : ""}${t.mergeCommit ? `, merged as ${t.mergeCommit}` : ", not merged"}.` : "No branch yet.",
        "",
        "## Description",
        t.body || "(none)",
        ...(t.acceptanceCriteria?.length
          ? ["", "## Acceptance criteria", ...criterionLines(t.acceptanceCriteria, t.stateNote)]
          : []),
        ...(t.ownerSetup?.trim() ? ["", "## After it goes live, the owner will need to", ...t.ownerSetup.trim().split(/\r?\n/).map((l) => `- ${l.trim()}`)] : []),
        ...(t.fixesLive?.trim() ? ["", "## Fixes live", `${t.fixesLive.trim()} (when it merges, the deploy card is marked urgent and the owner is paged once).`] : []),
        ...(t.plan && t.planApprovedAt ? ["", "## Approved plan", t.plan] : []),
        "",
        "## What it produced",
        ...(made.length ? made.map((m) => (m.kind === "wiki_page" ? `- wiki page ${m.slug} (read it with wiki read)` : m.kind === "url" ? `- link ${m.url}` : `- repo file ${m.path}${m.ref ? ` at ${m.ref}` : ""} (read it with tickets file)`)) : ["(nothing attached)"]),
        "",
        ...(pics.length ? ["## Images (put one in a wiki page with the Markdown shown)", ...pics.map((i) => `- ${imageMarkdown((i.caption || i.name).replace(/[\][()\n\r]/g, ""), i.id)}`), ""] : []),
        "## Recent conversation",
        ...(talk.length ? talk : ["(none)"]),
      ];
      const full = head.join("\n");
      return text(cut(full, CAP, (m) => `continue with tickets read ticketId=${t.id} offset=${m}`, offset));
    },
  );

  server.registerTool(
    "whats_new",
    { description: "What changed in your company since your last run, as of now: your open tickets and decisions, changes that touch them, and what other agents are running. The CEO gets the whole company. The same brief you got at the start of this run; it doesn't mark anything as seen.", inputSchema: {} },
    async () => {
      const [me] = scope.agentId ? await db.select({ role: agents.role, since: agents.briefSeenAt }).from(agents).where(eq(agents.id, scope.agentId)) : [];
      if (!me) return fail("Only agents have a brief.");
      return text(await buildBrief(db, { companyId: scope.companyId, agentId: scope.agentId, role: me.role, since: me.since, now: new Date() }));
    },
  );

  // The agent admin tools (skills through set_agent_picture) live in mcp-agent-admin.ts (BOS-298 step 15).
  registerAgentAdminTools(server, db, { notes, skills, skillProposals, agents: team }, scope);

  server.registerTool(
    "wiki",
    {
      description:
        "The company wiki: Markdown pages in nested folders, shared by the owner and agents. list (optional q to search), read (slug; a page over 8000 characters comes back as an outline, then read one part with section=\"Heading\" or \"Parent > Heading\", or the text in parts with offset), write (title, body, folder such as \"Research/Competitors\" to file it, optional slug to update a page — a different folder moves it — and optional ticketId when it's a ticket's output), append (slug, entry, optional heading and position), history (slug: every version of a page, newest first, with its size and who saved it; pass offset to page further back when a page has a long history) and restore (slug and version id: put an old version back as a new version), and attach (link a repo file — path and branch or commit as ref — or a web url to a ticket as its output). write always sets the whole page: it takes no section or offset (those are for read). A write to an existing page that would remove more than about a quarter of its text, or any of its headings, is refused unless you pass replace: true; only the CEO or the owner may replace a page another agent created. For a running log (a release log, a cock-ups log, a status page) never re-send the whole body to write: add one entry with append, which inserts it under a heading (newest first by default, or position \"oldest\" at the end of that section) or at the top or the end of the page, and never shortens the page (one entry is a line or two, at most 20,000 characters). An append needs a real heading: \"intro\" (the text above the first heading) is refused, and an entry whose code fence (```) never closes is refused so it can't swallow the page after it. If a page was wiped, history shows the full version and restore puts it back; the CEO and the page's last writer may restore. Put documents you produce (research, specs, reports, how-tos) in the wiki with the ticket's id, so the owner can read them from the ticket. A page shows pictures inline: attach each one to the ticket with attach_image (which gives the Markdown), or reuse one already on a ticket (tickets read lists its image ids), and put ![caption](/api/ticket-images/ID) in the page. Never commit images to the repo. Link pages with [[slug]] or [[slug#Section heading]]; reads show a page's links and what links to it.",
      inputSchema: {
        action: z.enum(["list", "read", "write", "append", "history", "restore", "attach"]),
        q: z.string().max(200).optional(),
        slug: z.string().max(500).optional(),
        folder: z.string().max(400).optional(),
        title: z.string().max(200).optional(),
        body: z.string().max(200_000).optional(),
        ticketId: z.string().uuid().optional(),
        path: z.string().max(500).optional(),
        ref: z.string().max(200).optional(),
        url: z.string().max(2000).optional(),
        section: z.string().max(300).optional(),
        offset: z.number().int().min(0).optional(),
        replace: z.boolean().optional(),
        entry: z.string().max(20_000).optional(),
        position: z.enum(["top", "bottom", "oldest"]).optional(),
        revisionId: z.string().uuid().optional(),
        heading: z.string().max(300).optional(),
        limit: z.number().int().min(1).max(HISTORY_PAGE_MAX).optional(),
      },
    },
    async (input) => {
      const by = { agentId: scope.agentId, runId: scope.runId };
      try {
        switch (input.action) {
          case "list": {
            const hits = input.q?.trim() ? await wiki.search(scope.companyId, input.q) : [];
            if (hits.length)
              return text(hits.map((h) => `${h.slug} — ${h.title} › ${h.path}\n  ${h.snippet}\n  read: wiki read slug="${h.slug}" section="${h.path}"`).join("\n\n"));
            return text(JSON.stringify((await wiki.list(scope.companyId, input.q)).map((p) => ({ slug: p.slug, folder: p.folder, title: p.title, updatedAt: p.updatedAt }))));
          }
          case "read": {
            if (!input.slug) return fail("Give the page's slug.");
            const p = await wiki.get(scope.companyId, input.slug);
            // The exact app link, so an agent (or the CEO) pastes it rather than guessing the format (BOS-356).
            const link = `#/wiki/${scope.companyId}/${p.slug}`;
            const sections = splitSections(p.body);
            const outline = (error?: string) =>
              [
                ...(error ? [error, ""] : []),
                `# ${p.title}`,
                `${p.body.length} characters, ${sections.length} sections:`,
                ...sections.map((s) => `- ${s.path} (${s.ownEnd - s.start} chars): ${p.body.slice(s.start, s.ownEnd).split("\n").find((l) => l.trim() && !/^#+\s/.test(l))?.trim().slice(0, 100) ?? ""}`),
                "",
                `Read a section with section="<heading>", or the whole page in parts with offset=0.`,
                `Link: ${link}`,
              ].join("\n");
            let body: string;
            let shown: string;
            if (input.section) {
              const s = findSection(sections, input.section);
              if (!s) return text(outline(`No section "${input.section}" on this page.`));
              shown = p.body.slice(s.start, s.end);
              body = `# ${p.title} > ${s.path}\n\n${shown}`;
            } else if (input.offset !== undefined || p.body.length <= OUTLINE_OVER) {
              shown = p.body.slice(input.offset ?? 0, (input.offset ?? 0) + CAP);
              body = `${input.offset ? "" : `# ${p.title}\n\n`}${cut(p.body, CAP, (m) => `continue with offset=${m}`, input.offset ?? 0)}`;
            } else return text(outline());
            const l = await wiki.links(scope.companyId, p.slug, shown);
            return text([body, ...(l.links.length ? [`Links: ${l.links.join(", ")}`] : []), ...(l.linkedFrom.length ? [`Linked from: ${l.linkedFrom.join(", ")}`] : []), `Link: ${link}`].join("\n\n"));
          }
          case "write": {
            if (!input.title || input.body === undefined) return fail("Give a title and a body.");
            // section and offset are for read: write always sets the whole page, so ignore them at your peril (BOS-430).
            if (input.section !== undefined) return fail("write has no section argument: it replaces the whole page. To add an entry under a heading, use append; to read one section, use read with section.");
            if (input.offset !== undefined) return fail("write has no offset argument: it replaces the whole page. To read the page in parts, use read with offset.");
            if (input.ticketId) {
              const reviewWrite = await reviewTicketWriteRefusal(db, scope.companyId, input.ticketId, scope.agentId);
              if (reviewWrite) return fail(reviewWrite);
            }
            const [me] = scope.agentId ? await db.select({ role: agents.role }).from(agents).where(eq(agents.id, scope.agentId)) : [];
            const r = await wiki.write(scope.companyId, { slug: input.slug, folder: input.folder, title: input.title, body: input.body, ticketId: input.ticketId ?? null, replace: input.replace, isCeo: me?.role === "ceo", ...by });
            const link = `#/wiki/${scope.companyId}/${r.page.slug}`;
            return text(`${r.created ? "Created" : "Updated"} ${link}${input.ticketId ? ", linked to the ticket" : ""}. Pass link "${link}" to notify_owner when you tell the owner about it.`);
          }
          case "append": {
            if (!input.slug) return fail("Give the page's slug.");
            if (input.entry === undefined) return fail("Give the entry to add.");
            if (input.section !== undefined) return fail("append has no section argument: give the heading to add under as heading.");
            if (input.replace !== undefined) return fail("append adds an entry and never replaces the page; to replace it, use write with the whole body.");
            const r = await wiki.append(scope.companyId, { slug: input.slug, entry: input.entry, heading: input.heading, position: input.position, title: input.title, ticketId: input.ticketId ?? null, agentId: scope.agentId, runId: scope.runId });
            const link = `#/wiki/${scope.companyId}/${r.page.slug}`;
            return text(`Added the entry${r.where} of ${link} (${r.size.toLocaleString("en-GB")} characters now)${input.ticketId ? ", linked to the ticket" : ""}. Pass link "${link}" to notify_owner when you tell the owner about it.`);
          }
          case "history": {
            // Every saved version, newest first; offset pages further back (BOS-496), so a page with a
            // long history still shows the version from before a wipe.
            if (!input.slug) return fail("Give the page's slug.");
            const p = await wiki.get(scope.companyId, input.slug);
            const offset = input.offset ?? 0;
            const rows = await wiki.versions(scope.companyId, p.slug, { offset, limit: input.limit });
            if (!rows.length)
              return text(`${p.slug} has ${p.revisionCount} saved ${p.revisionCount === 1 ? "version" : "versions"}${offset ? `; there is none at offset ${offset}` : ""}.`);
            const more = offset + rows.length < p.revisionCount ? `\n\nMore: wiki history slug="${p.slug}" offset=${offset + rows.length}` : "";
            return text(
              `# ${p.title} (${p.slug}): ${p.body.length.toLocaleString("en-GB")} characters now, ${p.revisionCount} version${p.revisionCount === 1 ? "" : "s"}, newest first. Showing versions ${offset + 1} to ${offset + rows.length}:\n` +
                rows.map((r) => `- ${r.id} · ${r.createdAt.toISOString()} · ${r.agent ?? "the owner"} · ${r.size.toLocaleString("en-GB")} chars${r.runId ? ` · run #/runs/${r.runId}` : ""}`).join("\n") +
                `\n\nPut one back with restore (slug and version id). A restore is itself a new version, so it can be undone.${more}`,
            );
          }
          case "restore": {
            if (!input.slug) return fail("Give the page's slug.");
            if (!input.revisionId) return fail("Give the version id (from history).");
            const [me] = scope.agentId ? await db.select({ role: agents.role }).from(agents).where(eq(agents.id, scope.agentId)) : [];
            const r = await wiki.restore(scope.companyId, { slug: input.slug, revisionId: input.revisionId, agentId: scope.agentId, runId: scope.runId, isCeo: me?.role === "ceo" });
            const link = `#/wiki/${scope.companyId}/${r.page.slug}`;
            return text(`Restored ${link} to that version (${r.size.toLocaleString("en-GB")} characters), kept as a new version so it can be undone. Pass link "${link}" to notify_owner when you tell the owner about it.`);
          }
          case "attach": {
            if (!input.ticketId) return fail("Give the ticketId it belongs to.");
            const reviewWrite = await reviewTicketWriteRefusal(db, scope.companyId, input.ticketId, scope.agentId);
            if (reviewWrite) return fail(reviewWrite);
            await wiki.attach(scope.companyId, { ticketId: input.ticketId, title: input.title ?? "", path: input.path ?? null, ref: input.ref ?? null, url: input.url ?? null, ...by });
            return text("Linked to the ticket.");
          }
        }
      } catch (err) {
        if (err instanceof WikiError) return fail(err.message);
        throw err;
      }
    },
  );

}


const NUDGE_DESCRIPTION =
  "Call a colleague over: hand something to them or ask them a question, by name (or id), in your own company. Pass the ticket it's about, if any, and say why in a sentence or two. If they're working on that ticket now it reaches them straight away; otherwise they're woken with it. Not for routine updates: those go in ticket_reply or the ticket's state note. A few nudges per colleague every ten minutes at most, none back and forth about the same ticket, and a company-wide limit each hour.";
const NUDGE_INPUT = { agent: z.string().min(1), ticketId: z.string().uuid().optional(), why: z.string().min(1).max(500) };
/** Run tools the owner chat replaces with its own version (BOS-224). */
const CHAT_SKIP: ReadonlySet<string> = new Set(["create_ticket", "nudge"]);

/**
 * The owner chat's tools (v1.1): the board, plus the CEO's own run tools (BOS-224). Tickets it
 * makes are the owner's, not an agent's, and go through the same checks as the board's own forms.
 */
function buildChatServer(db: Db, services: Services, scope: Scope, hooks: McpHooks, withRunTools: boolean) {
  const { work, feedback, notes, wiki, skills, skillProposals, review, agents: team, images, ticketChat } = services;
  // Wrapped before any tool registers, or the registrars below keep the plain one (BOS-758).
  const server = traceCalls(new McpServer({ name: "bossman", version: "0.1.0" }), db, scope.runId, scope.companyId);
  // The CEO gets the same tools in its chat as in its runs, except create_ticket and nudge, which
  // have chat versions below (BOS-224). Another agent's chat keeps the board tools only: its runs
  // may be deliberately restricted (BOS-58), and a chat must not widen them. No tool here edits
  // code or runs a command.
  if (withRunTools) registerRunTools(server, db, services, scope, hooks, CHAT_SKIP);
  registerListMyWork(server, db, scope);
  registerRequestNote(server, db, scope, hooks);
  registerSharedTools(server, db, { notes, wiki, skills, skillProposals, review, agents: team }, scope);
  registerViewImage(server, images, scope);
  const ownTicket = async (id: string) => (await db.select({ id: tickets.id }).from(tickets).where(and(eq(tickets.id, id), eq(tickets.companyId, scope.companyId))))[0] ?? null;
  const workFail = (err: unknown) => {
    if (err instanceof WorkError) return fail(err.message);
    throw err;
  };

  registerBoard(server, db, scope);
  registerRoadmap(server, db, work, scope);
  registerTicketMoves(server, db, { review, work, feedback, skillProposals }, scope, hooks, true);
  registerNotes(server, db, scope, true, { ticketChat });

  // So an agent asked in chat for something it can't do here asks the colleague who can, instead of the owner.
  server.registerTool("nudge", { description: NUDGE_DESCRIPTION, inputSchema: NUDGE_INPUT }, async ({ agent, ticketId, why }) => {
    if (!scope.agentId || !hooks.nudge) return fail("Only an agent's run can nudge.");
    const r = await hooks.nudge({ runId: scope.runId, fromAgentId: scope.agentId, to: agent, ticketId, why });
    return r.ok ? text(`Nudged: ${r.delivered}.`) : fail(r.error);
  });

  server.registerTool(
    "create_ticket",
    {
      description:
        "Create a ticket for the owner. Give the project by name when there's more than one. Rate its risk: trivial, low, medium (the default), high or critical. Optionally put it in a milestone, assign it to an agent by name, and list tickets it waits on. Size (1, 2, 3, 5 or 8) is optional here; the CEO sizes the tickets it plans.",
      inputSchema: {
        title: z.string().min(1).max(200),
        body: z.string().max(10_000).optional(),
        project: z.string().optional(),
        size: z.number().refine(isTaskSize, `Size is one of ${SIZE_SCALE}.`).optional(),
        risk: z.enum(RISK_TIERS).optional(),
        planFirst: z.boolean().optional(),
        milestoneId: z.string().uuid().optional(),
        assignee: z.string().optional(),
        waitsOn: z.array(z.string().uuid()).max(20).optional(),
        featureId: z.string().uuid().optional(),
        acceptanceCriteria: acceptanceCriteriaSchema.optional(),
        noCode: z.boolean().optional(),
      },
    },
    async (input) => {
      const ps = await db.select({ id: projects.id, name: projects.name }).from(projects).where(and(eq(projects.companyId, scope.companyId), isNull(projects.archivedAt)));
      const p = input.project ? ps.find((x) => x.name.toLowerCase() === input.project!.toLowerCase()) : ps.length === 1 ? ps[0] : undefined;
      if (!p) return fail(ps.length ? `Name the project: one of ${ps.map((x) => x.name).join(", ")}.` : "The company has no projects yet; the owner creates them on the Board.");
      let assigneeAgentId: string | undefined;
      if (input.assignee) {
        const [a] = await db.select({ id: agents.id }).from(agents).where(and(eq(agents.companyId, scope.companyId), sql`lower(${agents.name}) = lower(${input.assignee})`));
        if (!a) return fail(`No agent called ${input.assignee}. Use board to see who there is.`);
        assigneeAgentId = a.id;
      }
      for (const id of input.waitsOn ?? []) if (!(await ownTicket(id))) return fail(`No ticket ${id} in this company.`);
      try {
        const t = await work.createTicket(p.id, { title: input.title, body: input.body ?? null, risk: input.risk, size: input.size as TaskSize | undefined, planFirst: input.planFirst, milestoneId: input.milestoneId, assigneeAgentId, featureId: input.featureId, acceptanceCriteria: input.acceptanceCriteria, noCode: input.noCode });
        for (const id of input.waitsOn ?? []) await work.addDependency(t.id, { ticketId: id }, scope.agentId);
        // A code ticket nobody can pick up cleanly gets a nudge, but it is still created (BOS-595).
        const thin = input.noCode ? "" : thinTicketWarning(input.body, input.assignee);
        return text(`Created #/tickets/${t.id} "${t.title}" in ${p.name}${t.planFirst ? " (plan first)" : ""}.${criteriaWarning(input.acceptanceCriteria)}${thin}`);
      } catch (err) {
        return workFail(err);
      }
    },
  );

  server.registerTool(
    "log_feedback",
    {
      description: "File feedback the owner passes on (a customer's email, a call, their own idea) in the company's feedback inbox, as they said it. Give who it's from if the owner said.",
      inputSchema: { text: z.string().min(1).max(20_000), from: z.string().min(1).max(200).optional(), title: z.string().min(1).max(200).optional() },
    },
    async ({ text: body, from, title }) => {
      const n = await feedback.createNote(scope.companyId, { text: body, title: title ?? null, source: "chat", customer: from ? { name: from } : null });
      return text(`Filed in the feedback inbox: #/feedback/${scope.companyId}/${n.id}`);
    },
  );

  server.registerTool(
    "features",
    { description: "The company's feature requests, highest priority first: id, title, status, rank, column, demand and priority. Pass featureId to create_ticket to deliver one.", inputSchema: {} },
    async () => {
      const all = await feedback.scored(scope.companyId);
      return text(JSON.stringify(all.features.filter((f) => f.status !== "declined").sort((a, b) => b.priority - a.priority).slice(0, 60).map((f) => ({ id: f.id, title: f.title, status: f.status, rank: f.rank, horizon: f.horizon, demand: f.demand, priority: f.priority, link: `#/features/${scope.companyId}/${f.id}` }))));
    },
  );

  server.registerTool(
    "create_feature",
    {
      description: "Add a feature to the company's feature requests (it starts as an idea). Give a title and a description: the problem, who it's for, what done looks like, what's out of scope and the risk. Pass objectiveId or milestoneId from board when it serves one. Pass the returned id as featureId to create_ticket to deliver it.",
      inputSchema: { title: z.string().min(1).max(200), description: z.string().max(10_000).optional(), objectiveId: z.string().uuid().optional(), milestoneId: z.string().uuid().optional() },
    },
    async (input) => {
      const existing = (await feedback.scored(scope.companyId)).features.find((f) => f.title.toLowerCase() === input.title.toLowerCase());
      if (existing) return text(`Feature ${existing.id} "${existing.title}" already exists; use its id as featureId.`);
      try {
        const f = await feedback.createFeature(scope.companyId, { title: input.title, description: input.description ?? null, objectiveId: input.objectiveId ?? null, milestoneId: input.milestoneId ?? null, createdByAgentId: scope.agentId });
        return text(`Created feature ${f.id} "${f.title}": #/features/${scope.companyId}/${f.id}`);
      } catch (err) {
        if (err instanceof FeedbackError) return fail(err.message);
        throw err;
      }
    },
  );

  server.registerTool(
    "link_tickets",
    { description: "Make one ticket wait on another: ticketId can't start until waitsOnTicketId is done.", inputSchema: { ticketId: z.string().uuid(), waitsOnTicketId: z.string().uuid() } },
    async ({ ticketId, waitsOnTicketId }) => {
      if (!(await ownTicket(ticketId))) return fail("No such ticket in this company.");
      try {
        await work.addDependency(ticketId, { ticketId: waitsOnTicketId }, scope.agentId);
        return text(`#/tickets/${ticketId} now waits on #/tickets/${waitsOnTicketId}.`);
      } catch (err) {
        return workFail(err);
      }
    },
  );

  server.registerTool(
    "set_milestone",
    { description: "Put a ticket in a milestone, or take it out with milestoneId null.", inputSchema: { ticketId: z.string().uuid(), milestoneId: z.string().uuid().nullable() } },
    async ({ ticketId, milestoneId }) => {
      if (!(await ownTicket(ticketId))) return fail("No such ticket in this company.");
      try {
        await work.updateTicket(ticketId, { milestoneId });
        return text(milestoneId ? `#/tickets/${ticketId} is in the milestone now.` : `#/tickets/${ticketId} has no milestone now.`);
      } catch (err) {
        return workFail(err);
      }
    },
  );

  return server;
}

export async function mcpRoutes(app: FastifyInstance, db: Db, services: Services, hooks: McpHooks = {}) {
  const handler = async (req: import("fastify").FastifyRequest, reply: import("fastify").FastifyReply) => {
    const header = req.headers.authorization;
    const token = header?.startsWith("Bearer ") ? header.slice(7) : undefined;
    const [scope] = token
      ? await db
          .select({ companyId: runTokens.companyId, agentId: runTokens.agentId, runId: runTokens.runId })
          .from(runTokens)
          // A token works only while its own run is live (BOS-513): a copy left in a file stops working when the run ends. A token whose run row is missing is refused too (inner join).
          .innerJoin(runsTable, eq(runsTable.id, runTokens.runId))
          .where(and(eq(runTokens.tokenHash, hashToken(token)), gt(runTokens.expiresAt, new Date()), isNull(runsTable.endedAt)))
      : [];
    if (!scope) return reply.code(401).send({ error: "unknown_or_expired_run_token" });

    // Stateless: a fresh server and transport per request.
    const [run] = await db.select({ purpose: runsTable.purpose }).from(runsTable).where(eq(runsTable.id, scope.runId));
    // A PA gets its read-only server whatever woke it (R87).
    const [me] = scope.agentId ? await db.select({ duty: agents.duty, role: agents.role }).from(agents).where(eq(agents.id, scope.agentId)) : [];
    // The Scrum Master gets its restricted server for its own runs (BOS-58); the owner's chat with it keeps the chat tools.
    const retroAgent = !!scope.agentId && run?.purpose !== "chat" && me?.duty !== "assistant" && (await services.retro.isRetroAgent(scope.companyId, scope.agentId));
    // The server view is the CEO's alone (BOS-224). In chat, only the CEO also gets its run tools:
    // another agent's chat stays board-only, so it can't outgrow its run's restrictions (BOS-58).
    const ceo = me?.role === "ceo";
    const server =
      me?.duty === "assistant"
        ? buildPaServer(db, services, scope, { registerSharedTools, registerViewImage, registerBoard, registerListMyWork })
        : run?.purpose === "chat"
          ? buildChatServer(db, services, scope, hooks, ceo)
          : me?.duty === SCRUM_MASTER_DUTY
            ? buildServer(db, services, scope, hooks, SCRUM_MASTER_TOOLS, retroAgent, false)
            : buildServer(db, services, scope, hooks, undefined, retroAgent, ceo);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    reply.hijack();
    reply.raw.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req.raw, reply.raw, req.body);
  };
  app.post("/mcp", handler);
  app.get("/mcp", handler);
  app.delete("/mcp", handler);
}
