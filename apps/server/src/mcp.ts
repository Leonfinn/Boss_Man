// Boss Man's MCP server: the one way agents act on Boss Man (R11). Every call carries a
// per-run bearer token that pins it to one company and agent, so an agent can only see and
// change its own company's work. The tool set is kept small (R36); descriptions say when
// to use each tool so Claude Code's tool search finds them.
import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { and, asc, desc, eq, gt, ilike, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { AGENT_TEMPLATES, HORIZONS, IMPORTANCE, planFirstByDefault, REVIEW_KINDS, RISK_TIERS, stateNoteLine, ticketRef, untrusted } from "@boss-man/shared";
import { hashToken } from "./auth.js";
import type { Db } from "./db/client.js";
import { agents, companies, decisions as decisionsTable, engagements as engagementsTable, features, keyResults, milestones, objectives, projects, runs as runsTable, runTokens, ticketDependencies, ticketImages, tickets, wakes, workflowColumns } from "./db/schema.js";
import { record } from "./services/activity.js";
import { buildBrief } from "./services/brief.js";
import { imageMarkdown, TicketImageError, type ticketImagesService } from "./services/ticket-images.js";
import { policyRulesService, RuleError } from "./services/policy-rules.js";
import { AnswerError, checkAsk, type decisionsService } from "./services/decisions.js";
import { EngagementError, type EngagementAction, type engagementsService } from "./services/engagements.js";
import { DeployError, type deploysService } from "./services/deploys.js";
import { RunError, type runsService } from "./services/runs.js";
import { NOTHING_CHANGED, ReviewError, type reviewService } from "./services/review.js";
import type { notificationsService } from "./services/notifications.js";
import type { chaptersService } from "./services/chapters.js";
import { WorkError, type workService } from "./services/work.js";
import { FeedbackError, type feedbackService } from "./services/feedback.js";
import { acceptanceCriteriaSchema, missingVerdicts, readVerdicts } from "@boss-man/shared";
import { TicketChatError, type ticketChatService } from "./services/ticket-chat.js";
import { findSection, splitSections, WikiError, type wikiService } from "./services/wiki.js";
import { conversationLines } from "./services/ticket-chat.js";
import { SkillError, type skillsService } from "./services/skills.js";
import { AgentError, type agentsService } from "./services/agents.js";
import { resolveReviewer } from "./services/review-policy.js";
import { latestRows } from "./services/review-kinds.js";
import { markSearched, remember, type paService } from "./services/pa.js";
import { SCRUM_MASTER_DUTY, WatchdogError, type watchdogService } from "./services/watchdog.js";

/** Why the watcher is woken when everything in its watched tree has stopped; the wake's note names the tree's root ticket. */
export const TREE_REASON = "tree stopped";
export const TREE_ROOT_LINE = /^Tree of ticket ([0-9a-f-]{36})$/gm;

type Scope = { companyId: string; agentId: string | null; runId: string };

export async function issueRunToken(db: Db, scope: Scope, ttlHours = 12): Promise<string> {
  const token = `bm_run_${randomBytes(32).toString("base64url")}`;
  await db.insert(runTokens).values({ tokenHash: hashToken(token), runId: scope.runId, companyId: scope.companyId, agentId: scope.agentId, expiresAt: new Date(Date.now() + ttlHours * 3_600_000) });
  return token;
}

const STATES = ["backlog", "ready", "in_progress", "blocked", "review", "done"] as const;
const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
const fail = (t: string) => ({ content: [{ type: "text" as const, text: t }], isError: true });
/** A lossless cap: at most n chars of s from offset; when there's more, says how much and how to get it. */
export const cut = (s: string, n: number, how: (next: number) => string, offset = 0) =>
  s.length <= offset + n ? s.slice(offset) : `${s.slice(offset, offset + n)}\n\n… ${s.length - offset - n} more chars; ${how(offset + n)}`;
const CAP = 40_000;
const OUTLINE_OVER = 8000;

export type McpHooks = {
  onTicketDone?: (ticketId: string, causedByRunId: string) => Promise<unknown>;
  onTicketReview?: (ticketId: string, byAgentId: string | null, causedByRunId: string) => Promise<unknown>;
  nudge?: (input: { runId: string; fromAgentId: string; to: string; ticketId?: string | null; why: string }) => Promise<{ ok: true; delivered: string } | { ok: false; error: string }>;
};

/** The ticket row for an agent, with its state note shown with its age (R85). */
/** Shows a company's ticket numbers as references (HOL-12). */
async function refsOf(db: Db, companyId: string) {
  const [c] = await db.select({ prefix: companies.ticketPrefix }).from(companies).where(eq(companies.id, companyId));
  return <T extends { number: number | null }>({ number, ...r }: T) => ({ ref: ticketRef(c?.prefix, number), ...r });
}
/** A reference like HOL-12 (any prefix: an old one still finds the number). */
const REF = /^[A-Za-z0-9]{1,10}-(\d{1,9})$/;

const withNote = <T extends { stateNote: string | null; stateNoteAt: Date | null; lastActivityAt: Date }>({ stateNote, stateNoteAt, ...r }: T) => {
  const note = stateNoteLine({ stateNote, stateNoteAt, lastActivityAt: r.lastActivityAt }, new Date());
  return note ? { ...r, stateNote: note } : r;
};

type Services = {
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
  agents: ReturnType<typeof agentsService>;
  pa: ReturnType<typeof paService>;
  images: ReturnType<typeof ticketImagesService>;
  watchdog: ReturnType<typeof watchdogService>;
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

function buildServer(db: Db, { decisions, engagements, deploys, runs, review, notes, chapters, work, feedback, ticketChat, wiki, skills, agents: team, pa, images, watchdog }: Services, scope: Scope, hooks: McpHooks, only?: ReadonlySet<string>) {
  const server = new McpServer({ name: "bossman", version: "0.1.0" });
  if (only) restrictTo(server, only);
  if (only === SCRUM_MASTER_TOOLS) {
    registerBoard(server, db, scope);
    registerWatchdog(server, watchdog, scope);
  }

  const resolveProject = (project?: string) => findProject(db, scope, project);
  const outsideTree = (ticketId: string | undefined) => treeRefusal(db, scope, ticketId);

  async function isManager() {
    const [me] = scope.agentId ? await db.select({ role: agents.role }).from(agents).where(eq(agents.id, scope.agentId)) : [];
    return me?.role === "ceo" || me?.role === "manager";
  }

  // CEOs and managers hand work to a colleague by name; returns the agent's id or the refusal text.
  async function delegateTarget(name: string): Promise<{ id: string } | { error: string }> {
    if (!(await isManager())) return { error: "Only your company's CEO or a manager can assign tickets to colleagues." };
    // The PA only answers the owner from read-only tools, so it can't take ticket work.
    const team_ = await db.select({ id: agents.id, name: agents.name, paused: agents.paused }).from(agents).where(and(eq(agents.companyId, scope.companyId), isNull(agents.retiredAt), sql`${agents.duty} is distinct from 'assistant'`));
    const a = team_.find((x) => x.name.toLowerCase() === name.trim().toLowerCase());
    if (!a) return { error: `No active agent called ${name} in your company. Valid names: ${team_.map((x) => x.name).join(", ")}.` };
    // The work service lets the owner assign to a paused agent, but the wake would sit unanswered; an agent shouldn't hand work to a dead end.
    if (a.paused) return { error: `${a.name} is paused, so they would not pick it up. Pick someone else.` };
    return { id: a.id };
  }

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
      const to = await delegateTarget(agent);
      if ("error" in to) return fail(to.error);
      const [t] = await db.select({ version: tickets.version, state: tickets.systemState, assignee: tickets.assigneeAgentId }).from(tickets).where(and(eq(tickets.id, ticketId), eq(tickets.companyId, scope.companyId)));
      if (!t) return fail("No ticket with that ID in your company.");
      // shortcut: version is checked just before the write, not inside it; fine for one CEO per company, upgrade if two agents assign at once.
      if (expected_version !== undefined && t.version !== expected_version) return fail(`Nothing changed: the ticket changed since you last saw it (you had version ${expected_version}). It is now ${t.state}, version ${t.version}. Read it again with tickets, then decide.`);
      if (t.assignee === to.id) return fail(`That ticket is already assigned to ${agent}.`);
      try {
        const u = await work.updateTicket(ticketId, { assigneeAgentId: to.id, stateNote: note.trim() });
        return text(`Ticket ${ticketId} is now assigned to ${agent} (version ${u.version}); they are woken with your note.`);
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

  registerRoadmap(server, db, work, scope);

  registerTicketMoves(server, db, { review, work, feedback }, scope, hooks, false);

  server.registerTool(
    "create_ticket",
    {
      description:
        "Create a ticket in your company's backlog. Use it to record work you or your team should do. CEOs and managers can pass assignee (an agent's name) to hand it straight to that colleague, who is woken to work on it. Give the project by name when your company has more than one. Pass engagementId when the ticket does work another company engaged you for. Pass feature (a feature's id or exact title) when the task delivers a feature request. Pass waitsOn (a task's id) to make this task wait until that one is done, such as a QA task waiting on its build task: it starts, and its assignee is woken, when that task is done. Set noCode to true for research, wiki, docs or deploy-only work that changes nothing in the repository; a ticket without it can't go to review until the repository has changed. Pass parent (a task's id) to make this a sub-task: use one when you need help from a colleague (say, a developer needing infra input) without handing over your own task. The parent waits on it and is woken when it is done; a sub-task can't have sub-tasks, and it joins the parent's feature and project. Rate its risk: trivial, low, medium (the default), high or critical; high and critical work is reviewed by the owner, gets the project's deeper check and goes to staging before production. High and critical tickets are planned and approved before anything changes unless you set planFirst to false; set it to true for other work that needs that.",
      inputSchema: {
        title: z.string().min(1).max(200),
        body: z.string().max(10_000).optional(),
        project: z.string().optional(),
        engagementId: z.string().uuid().optional(),
        risk: z.enum(RISK_TIERS).optional(),
        planFirst: z.boolean().optional(),
        featureId: z.string().uuid().optional(),
        feature: z.string().optional(),
        parent: z.string().uuid().optional(),
        assignee: z.string().optional(),
        waitsOn: z.string().uuid().optional(),
        acceptanceCriteria: acceptanceCriteriaSchema.optional(),
        noCode: z.boolean().optional().describe("true for research, wiki, docs or deploy-only work that changes nothing in the repository; such a ticket can reach review and be closed with an empty diff. Leave it off for anything that changes code."),
      },
    },
    async ({ title, body, project, engagementId, risk, planFirst, feature, parent, assignee, waitsOn, acceptanceCriteria, noCode, ...rest }) => {
      const out = await outsideTree(parent);
      if (out) return fail(`${out} Pass parent (a ticket in the tree) to add a sub-task.`);
      const to = assignee ? await delegateTarget(assignee) : null;
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
        .values({ companyId: scope.companyId, projectId: p.id, title, body, engagementId: engagementId ?? null, createdByAgentId: scope.agentId, risk: risk ?? null, planFirst: planFirst ?? (risk ? planFirstByDefault(risk) : false), featureId, parentTicketId: parentTask?.id ?? null, ...(blocker && blocker.state !== "done" ? { systemState: "blocked" as const } : {}), ...(acceptanceCriteria?.length ? { acceptanceCriteria } : {}), ...(noCode ? { noCode } : {}) })
        .returning({ id: tickets.id });
      if (parentTask) await work.waitOnSubtask(parentTask, t!.id);
      if (waitsOn) await work.addDependency(t!.id, { ticketId: waitsOn });
      await feedback.syncFeature(featureId);
      await record(db, { companyId: scope.companyId, agentId: scope.agentId, ticketId: t!.id, kind: "ticket_created", summary: `Created "${title}" in ${p.name}` });
      if (to) await work.updateTicket(t!.id, { assigneeAgentId: to.id });
      return text(`Created ticket ${t!.id} in ${p.name}${assignee ? `, assigned to ${assignee}` : ""}.`);
    },
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
      try {
        const id = await images.attach(scope.companyId, { ticketId, path, caption, agentId: scope.agentId });
        return text(`Attached ${path} to the ticket. To show it in a wiki page, write: ${imageMarkdown(caption?.replace(/[\][()\n\r]/g, "") || path, id)}`);
      } catch (err) {
        if (err instanceof TicketImageError) return fail(err.message);
        throw err;
      }
    },
  );

  server.registerTool(
    "schedule_check",
    {
      description:
        "Use this when you are waiting on CI, a deploy, a review or an outside service, instead of ending your turn without a plan. It wakes you on this ticket later to re-check (ticketId, note saying what to re-check, and either inMinutes 5 to 1440 or at as an ISO time; maxChecks 1 to 20, default 5). Only the ticket's assignee can use it, while the ticket is in progress or in review. Calling it again replaces the earlier check; when you are woken and still need to wait, call it again. After maxChecks checks the owner is told and you are not woken again.",
      inputSchema: { ticketId: z.string().uuid(), note: z.string().min(1).max(500), inMinutes: z.number().int().min(5).max(1440).optional(), at: z.string().optional(), maxChecks: z.number().int().min(1).max(20).optional() },
    },
    async ({ ticketId, note, inMinutes, at, maxChecks }) => {
      if (!scope.agentId) return fail("Only an agent can schedule a check.");
      if ((inMinutes === undefined) === (at === undefined)) return fail("Give exactly one of inMinutes or at.");
      const when = inMinutes !== undefined ? new Date(Date.now() + inMinutes * 60_000) : new Date(at!);
      try {
        const u = await work.setMonitor(ticketId, { at: when, note, maxChecks, by: { agentId: scope.agentId, companyId: scope.companyId } });
        return text(`You will be woken on ticket ${ticketId} at ${u.monitorAt!.toISOString()} to re-check (check ${u.monitorAttempts + 1} of ${u.monitorMax}).`);
      } catch (err) {
        if (err instanceof WorkError) return fail(err.message);
        throw err;
      }
    },
  );

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

  registerSharedTools(server, db, { notes, wiki, skills, review, agents: team }, scope);
  registerViewImage(server, images, scope);

  server.registerTool(
    "ticket_reply",
    {
      description: "Write on a ticket's conversation, where the owner talks to the agents working it. Use it to answer the owner's messages there, or to tell them something about the ticket. Name a wiki page as [[slug]] so the owner can open it with one click. For anything you need the owner to decide or do (including closing a ticket you can't), use raise_decision with blocksTicketId instead: a reply doesn't reach their queue or the Your review lane on the board. Ask the owner only after you have tried every way to do it yourself. The owner is not a developer: start with 1 to 3 plain sentences (what changed for them and whether they need to do anything), then a line \"Details:\" followed by the technical report (files, commits, tests).",
      inputSchema: { ticketId: z.string().uuid(), text: z.string().min(1).max(8000) },
    },
    async ({ ticketId, text: body }) => {
      try {
        await ticketChat.agentSays({ companyId: scope.companyId, ticketId, agentId: scope.agentId, runId: scope.runId, text: body });
      } catch (err) {
        if (err instanceof TicketChatError) return fail(err.message);
        throw err;
      }
      const [t] = await db.select({ title: tickets.title, watcher: tickets.watcherAgentId }).from(tickets).where(eq(tickets.id, ticketId));
      // A watcher's report reads as a status update (R80).
      const title = t?.watcher && t.watcher === scope.agentId ? `Status: "${t.title}"` : `Reply on "${t?.title ?? "a ticket"}"`;
      await notes.notify({ companyId: scope.companyId, agentId: scope.agentId, level: "note", title, body, link: `#/tickets/${ticketId}` });
      return text("Posted on the ticket's conversation.");
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
      description: "Ask the owner to decide or do something only they can. Always give your recommended answer, which must be one of the options. If a ticket can't move until this is answered, pass its ID so it waits. triedFirst is required: what you already tried yourself, and why an agent can't do it (no host access, a secret only the owner can grant, owner sign-off); a vague or empty one is refused. Set ownerMustDo to true when the owner has to do something (run, click, grant, check); then steps is required: short numbered steps in plain words with exact paths in the app (for example Settings → Server and runner → Updates → Build and update runners), ending with how to undo it. Prefer pointing to a button in the app over host commands. The owner is not a developer.",
      inputSchema: {
        question: z.string().min(1).max(1000),
        options: z.array(z.string().min(1).max(200)).min(2).max(6),
        recommended: z.string(),
        blocksTicketId: z.string().uuid().optional(),
        triedFirst: z.string().max(1000),
        ownerMustDo: z.boolean().optional(),
        steps: z.array(z.string().min(1).max(500)).max(12).optional(),
      },
    },
    async ({ question, options, recommended, blocksTicketId, triedFirst, ownerMustDo, steps }) => {
      if (!options.includes(recommended)) return fail("The recommended answer must be one of the options.");
      const bad = checkAsk({ triedFirst, ownerMustDo, steps });
      if (bad) return fail(bad);
      if (blocksTicketId) {
        const [t] = await db.select({ id: tickets.id }).from(tickets).where(and(eq(tickets.id, blocksTicketId), eq(tickets.companyId, scope.companyId)));
        if (!t) return fail("No ticket with that ID in your company.");
      }
      // Safe to repeat (R42): the same open question from the same agent isn't raised twice.
      if (scope.agentId) {
        const [same] = await db
          .select({ id: decisionsTable.id })
          .from(decisionsTable)
          .where(and(eq(decisionsTable.raisedByAgentId, scope.agentId), eq(decisionsTable.status, "open"), eq(decisionsTable.question, question)));
        if (same) return text(`Decision ${same.id} is already in the owner's queue. You'll be woken with the answer; don't wait in this turn.`);
      }
      const d = await decisions.raise({ companyId: scope.companyId, agentId: scope.agentId, question, options, recommended, blocksTicketId, triedFirst: triedFirst.trim(), steps: steps?.length ? steps : undefined });
      return text(`Decision ${d.id} is in the owner's queue. You'll be woken with the answer; don't wait in this turn.`);
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
        "Ship work to one of your company's deploy targets. action: targets (list them), request (target, ref, optional notes and ticketId; production targets wait for the owner, and you're woken in a run that holds the target's secrets once approved), report (deployId and outcome, from that run, when the deploy is done).",
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
          const ts = await deploys.listTargets(scope.companyId);
          return text(JSON.stringify(ts.map((t) => ({ name: t.name, kind: t.kind, endpoint: t.endpoint, production: t.isProduction }))));
        }
        if (input.action === "request") {
          if (!input.target || !input.ref) return fail("Give the target and the ref to deploy.");
          const r = await deploys.request({ companyId: scope.companyId, agentId: scope.agentId, runId: scope.runId }, { target: input.target, ref: input.ref, notes: input.notes, ticketId: input.ticketId });
          return text(`Deploy ${r.deploy.id}: ${r.note}`);
        }
        if (!input.deployId || !input.outcome) return fail("Give the deployId and the outcome.");
        const d = await deploys.report({ companyId: scope.companyId, runId: scope.runId }, { deployId: input.deployId, outcome: input.outcome, notes: input.notes });
        return text(`Deploy ${d.id} recorded as ${d.status}. The target's secrets are no longer available.`);
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
      }
      const link = input.link ?? (input.ticketId ? `#/tickets/${input.ticketId}` : `#/runs/${scope.runId}`);
      const n = await notes.notify({ companyId: scope.companyId, agentId: scope.agentId, level: input.level, title: input.title, body: input.body ?? null, link });
      if (!n) return fail("Couldn't record that notification.");
      return text(n.level === input.level ? `Sent as a ${n.level}.` : `Sent as a ${n.level} instead of a ${input.level} (${n.demotedBy}).`);
    },
  );

  server.registerTool(
    "feedback",
    {
      description:
        "Your company's feature requests. Anyone can: inbox (unprocessed feedback, oldest first; long notes are cut, note noteId reads one in full), features (each feature's id, status, demand and priority), log (feedback you heard: text, optional from and title; set fromOutside when it came from outside the company). The CEO also triages: link (noteId, featureId, importance nice_to_have|important|critical, optional highlight copied exactly from the note), create_feature (title, optional description, optional objectiveId or milestoneId from board when the feature serves one), mark (noteId, state processed|archived). The CEO, managers and product managers size features: size (featureId, effort 1 tiny to 5 huge, optional scores by the company's criteria, each 0 to 5, from features' criteria list, and a reason). Priority is value divided by effort, so an unsized feature can't be ranked: size the ones features lists with effort null.",
      inputSchema: {
        action: z.enum(["inbox", "note", "features", "log", "link", "create_feature", "mark", "size"]),
        effort: z.number().int().min(1).max(5).optional(),
        scores: z.record(z.string().min(1).max(100), z.number().int().min(0).max(5)).optional(),
        reason: z.string().trim().min(1).max(240).optional(),
        noteId: z.string().uuid().optional(),
        featureId: z.string().uuid().optional(),
        objectiveId: z.string().uuid().optional(),
        milestoneId: z.string().uuid().optional(),
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
            .map((f) => ({ id: f.id, title: f.title, status: f.status, parentId: f.parentId, demand: f.demand, people: f.customerCount, effort: f.effort, scores: Object.fromEntries(all.drivers.map((d) => [d.name, f.driverScores[d.id] ?? null])), value: f.value, priority: f.priority, tickets: f.tickets }));
          return text(JSON.stringify({ criteria: all.drivers.map((d) => ({ name: d.name, weight: d.weight })), features: list }));
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

  server.registerTool(
    "decisions",
    {
      description:
        "For CEOs, and for an agent the review settings name as a plan approver: decisions your company's agents need from you, such as permission requests and plans that your company's rules send to you. Plan approvers see and answer only the plans put to them. action: list, or answer (id, answer: one of the decision's options, and an optional note, e.g. what to change in a plan you send back). The owner sees the same queue and may answer first. You can't answer your own requests.",
      inputSchema: {
        action: z.enum(["list", "answer"]),
        id: z.string().uuid().optional(),
        answer: z.string().max(200).optional(),
        note: z.string().max(2000).optional(),
      },
    },
    async (input) => {
      const [me] = scope.agentId ? await db.select({ role: agents.role }).from(agents).where(eq(agents.id, scope.agentId)) : [];
      const isCeo = me?.role === "ceo";
      // A plan approver answers only plans put to them, never permission requests.
      const mine = (d: typeof decisionsTable.$inferSelect) => isCeo || (!!scope.agentId && d.forAgentId === scope.agentId && (d.context as { plan?: boolean }).plan === true);
      if (input.action === "list") {
        const open = (
          await db
            .select()
            .from(decisionsTable)
            .where(and(eq(decisionsTable.companyId, scope.companyId), eq(decisionsTable.status, "open"), eq(decisionsTable.tier, "ceo")))
            .orderBy(decisionsTable.createdAt)
        ).filter(mine);
        if (!open.length) return text("No decisions are waiting for you.");
        return text(
          open
            .map((d) => {
              const { planText: plan, explain } = d.context as { planText?: string | null; explain?: { command?: string } };
              return [`${d.id}: ${d.question}`, ...(explain?.command ? [`Command: ${explain.command}`] : []), `Options: ${(d.options as string[]).join(" | ")} (recommended: ${d.recommendedOption ?? "none"})`, ...(plan ? ["Plan:", plan.slice(0, 8000)] : [])].join("\n");
            })
            .join("\n\n"),
        );
      }
      if (!input.id || !input.answer) return fail("Give the decision's id and your answer.");
      const [d] = await db.select().from(decisionsTable).where(and(eq(decisionsTable.id, input.id), eq(decisionsTable.companyId, scope.companyId)));
      if (!d || d.tier !== "ceo" || !mine(d)) return fail("No decision with that id is waiting for you.");
      if (d.raisedByAgentId === scope.agentId) return fail("That's your own request; the owner answers it.");
      try {
        const r = await decisions.answer(input.id, input.answer, { note: input.note });
        return r ? text(`Answered: ${input.answer}.`) : fail("That decision has already been answered.");
      } catch (err) {
        if (err instanceof AnswerError) return fail(err.message);
        throw err;
      }
    },
  );

  server.registerTool(
    "review",
    {
      description:
        "For the CEO and the reviewers your company's review settings name for a ticket: review a ticket in your company that's ready for review. A ticket may need several reviews (code, security, infra, adversarial); they're requested together unless the CEO orders them. action: diff (ticketId; shows the changes against the ticket's base), submit (ticketId, verdict approved or changes_requested, optional comments as {path, line, body} and a summary; kind if you hold more than one review on the ticket). When requesting changes you may add lesson: a one-line lesson learned for the project's brief — the owner decides whether it's added. If the ticket lists acceptance criteria, check the work against each one, and when you request changes, name the criterion that fails. CEO only: sequence (ticketId, order: kinds listed in the order they should run, e.g. [\"infra\",\"security\"]; empty runs them all at once) and overrule (ticketId, kind, reason: overrules a review that asked for changes; it does not replace the owner's sign-off). You can't review a ticket assigned to you.",
      inputSchema: {
        action: z.enum(["diff", "submit", "sequence", "overrule"]),
        ticketId: z.string().uuid(),
        verdict: z.enum(["approved", "changes_requested"]).optional(),
        comments: z.array(z.object({ path: z.string(), line: z.number().int().positive(), body: z.string().min(1) })).max(50).optional(),
        summary: z.string().max(5000).optional(),
        lesson: z.string().max(1000).optional(),
        kind: z.enum(["code", ...REVIEW_KINDS]).optional(),
        order: z.array(z.enum(["code", ...REVIEW_KINDS])).max(4).optional(),
        reason: z.string().max(2000).optional(),
      },
    },
    async (input) => {
      const [me] = scope.agentId ? await db.select({ role: agents.role, name: agents.name, title: agents.title }).from(agents).where(eq(agents.id, scope.agentId)) : [];
      if (!me) return fail("Only your company's CEO or the ticket's reviewer reviews tickets.");
      const [rt] = await db.select().from(tickets).where(and(eq(tickets.id, input.ticketId), eq(tickets.companyId, scope.companyId)));
      if (!rt) return fail("No ticket with that ID in your company.");
      if (rt.assigneeAgentId === scope.agentId) return fail("You can't review a ticket assigned to you.");
      const rows = await latestRows(db, rt.id);
      const named = rows.length ? rows.some((r) => r.reviewerAgentId === scope.agentId) : (await resolveReviewer(db, rt)).agent?.id === scope.agentId;
      if (me.role !== "ceo" && !named) return fail("Only your company's CEO or this ticket's reviewer reviews it.");
      if ((input.action === "sequence" || input.action === "overrule") && me.role !== "ceo") return fail("Only your company's CEO can do that.");
      try {
        if (input.action === "sequence") {
          const woken = await review.sequence(input.ticketId, input.order ?? [], scope.agentId!, scope.companyId);
          return text(input.order?.length ? `Reviews will run in this order: ${input.order.join(", then ")}.${woken ? ` ${woken} reviewer(s) woken for their turn.` : ""}` : "Reviews will run all at once.");
        }
        if (input.action === "overrule") {
          if (!input.kind || !input.reason) return fail("Give the kind of review and your reason.");
          const r = await review.overrule(input.ticketId, { kind: input.kind, reason: input.reason, byAgentId: scope.agentId!, companyId: scope.companyId, causedByRunId: scope.runId });
          return text(`Overruled the ${input.kind} review. ${reviewOutcome(r)}`);
        }
        if (input.action === "diff") {
          const d = await review.diff(input.ticketId, scope.companyId);
          // Keep the agent's context in check: the file list always, the patch up to 60 KB.
          const files = d.files.map((f) => `${f.path} (+${f.added} -${f.removed})`).join("\n");
          const patch = d.diff.length > 60_000 ? `${d.diff.slice(0, 60_000)}\n[diff truncated]` : d.diff;
          const checklist = rt.acceptanceCriteria.length
            ? `Acceptance criteria:\n${readVerdicts(rt.acceptanceCriteria, rt.stateNote).map((r) => `- [${r.verdict ?? "not reported"}] ${r.criterion}`).join("\n")}\nIf one fails, request changes and name it.\n\n`
            : "";
          return text(`${checklist}Base ${d.baseCommit.slice(0, 12)}, ${d.commits.length} commit(s).\nFiles:\n${files || "(none)"}\n\n${patch}${d.truncated ? "\n[diff truncated by the runner]" : ""}`);
        }
        if (!input.verdict) return fail("Give the verdict.");
        const r = await review.submit(input.ticketId, {
          verdict: input.verdict,
          comments: input.comments,
          summary: input.summary,
          lesson: input.lesson,
          kind: input.kind,
          reviewer: `${me.name} (${me.role === "ceo" ? "CEO" : me.title ?? me.role})`,
          reviewerAgentId: scope.agentId,
          companyId: scope.companyId,
          causedByRunId: scope.runId,
        });
        return text(reviewOutcome(r));
      } catch (err) {
        if (err instanceof ReviewError) return fail(err.message);
        throw err;
      }
    },
  );

  registerListMyWork(server, db, scope);

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

  return server;
}

/** What a verdict (or an overrule) did, in a sentence for the reviewer. */
function reviewOutcome(r: { verdict: string; delivered?: string | null; outcome?: string }): string {
  const outcome = r.outcome ?? "done";
  if (outcome === "waiting") return `Recorded: ${r.delivered}.`;
  if (r.verdict !== "approved") return `Changes requested; ${r.delivered}.`;
  return outcome === "owner_review"
    ? `Approved. ${r.delivered}: the owner signs it off before it merges.`
    : outcome === "merged" || outcome === "done"
      ? "Approved; the ticket is done."
      : `Approved, but it couldn't merge yet (${outcome.replace(/_/g, " ")}); it's gone back to the assignee with what to fix.`;
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
      description: "Open something the owner attached. In a task, a message or the chat, a picture appears as ![name](/api/ticket-images/<id>) and a file as [📎 name](/api/ticket-images/<id>); open each one with this tool (pass the id) before you act on it. Pictures come back as images, text files as text, PDFs as a document.",
      inputSchema: { id: z.string().uuid() },
    },
    async ({ id }) => {
      const a = await images.forCompany(id, scope.companyId);
      if (!a) return fail("No attachment with that id in your company.");
      const bytes = Buffer.from(a.bytes);
      const label = a.caption ? `${a.name}: ${a.caption}` : a.name;
      if (a.type.startsWith("image/")) return { content: [{ type: "image" as const, data: bytes.toString("base64"), mimeType: a.type }, { type: "text" as const, text: label }] };
      // shortcut: long text is cut at 200,000 characters; page through it if owners attach bigger files.
      if (a.type === "text/plain") return text(`${label}\n\n${bytes.toString("utf8").slice(0, 200_000)}`);
      if (a.type === "application/pdf") return { content: [{ type: "resource" as const, resource: { uri: `bossman:attachment/${id}`, mimeType: a.type, blob: bytes.toString("base64") } }, { type: "text" as const, text: `${label} (PDF)` }] };
      return text(`${label} is a ${a.type} file of ${bytes.length} bytes that can't be shown as text or a picture. Ask the owner what's in it, or for a PDF or text copy.`);
    },
  );
}

function registerSharedTools(server: McpServer, db: Db, { notes, wiki, skills, review, agents: team }: Pick<Services, "notes" | "wiki" | "skills" | "review" | "agents">, scope: Scope) {
  server.registerTool(
    "tickets",
    {
      description:
        "Look up your company's tickets. Each has a reference like HOL-12, which you can use anywhere this tool takes a ticketId. find (optional q to search titles and descriptions, or a reference, optional state) lists matches with their ids and references; read (ticketId) gives one ticket: description (long ones are cut; pass offset to continue), state, assignee, its branch, what it produced (wiki pages, repo files, links) and its recent conversation; file (ticketId, path, optional offset) reads a file from that ticket's work in the repo, such as a document it wrote, even if it was never merged; long files come in parts of 40000 characters.",
      inputSchema: { action: z.enum(["find", "read", "file"]), q: z.string().max(200).optional(), state: z.enum(STATES).optional(), ticketId: z.string().max(40).optional(), path: z.string().max(500).optional(), offset: z.number().int().min(0).optional() },
    },
    async ({ action, q, state, ticketId: given, path, offset }) => {
      const asRef = given ? REF.exec(given) : null;
      const ticketId = asRef
        ? (await db.select({ id: tickets.id }).from(tickets).where(and(eq(tickets.companyId, scope.companyId), eq(tickets.number, Number(asRef[1])))))[0]?.id
        : given && z.string().uuid().safeParse(given).success ? given : undefined;
      if (given && !ticketId) return fail(`No ticket ${given} in your company.`);
      const ref = await refsOf(db, scope.companyId);
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
        const like = q?.trim() && !byRef ? `%${q.trim().replace(/[%_\\]/g, (c) => `\\${c}`)}%` : null;
        const rows = await db
          .select({ id: tickets.id, number: tickets.number, title: tickets.title, state: tickets.systemState, version: tickets.version, outcome: tickets.outcome, assignee: agents.name, lastActivityAt: tickets.lastActivityAt, stateNote: tickets.stateNote, stateNoteAt: tickets.stateNoteAt })
          .from(tickets)
          .leftJoin(agents, eq(agents.id, tickets.assigneeAgentId))
          .where(and(eq(tickets.companyId, scope.companyId), state ? eq(tickets.systemState, state) : undefined, byRef ? eq(tickets.number, Number(byRef[1])) : undefined, like ? or(ilike(tickets.title, like), ilike(tickets.body, like)) : undefined))
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
      return text(
        [
          `# ${t.title}`,
          `Ticket ${ref(t).ref ?? ""} (id ${t.id}) in project "${row.project}". State: ${t.systemState}${t.outcome ? ` (${t.outcome})` : ""}. Version: ${t.version}. Assigned to: ${row.assignee ?? (t.assignedToOwner ? "the owner" : "nobody")}. Risk: ${t.risk ?? "medium"}.`,
          ...(note ? [note] : []),
          t.branch ? `Branch: ${t.branch}${row.repoUrl ? ` in ${row.repoUrl}` : ""}${t.mergeCommit ? `, merged as ${t.mergeCommit}` : ", not merged"}.` : "No branch yet.",
          "",
          "## Description",
          t.body ? cut(t.body, CAP, (m) => `continue with tickets read ticketId=${t.id} offset=${m}`, offset) : "(none)",
          ...(t.acceptanceCriteria?.length
            ? [
                "",
                "## Acceptance criteria",
                ...readVerdicts(t.acceptanceCriteria, t.stateNote).map((r) => `- [${r.verdict ?? "not reported"}] ${r.criterion}`),
              ]
            : []),
          ...(t.plan && t.planApprovedAt ? ["", "## Approved plan", cut(t.plan, CAP, () => "the rest isn't shown here")] : []), // shortcut: plans over 40000 chars aren't paged; add an offset if one ever is
          "",
          "## What it produced",
          ...(made.length ? made.map((m) => (m.kind === "wiki_page" ? `- wiki page ${m.slug} (read it with wiki read)` : m.kind === "url" ? `- link ${m.url}` : `- repo file ${m.path}${m.ref ? ` at ${m.ref}` : ""} (read it with tickets file)`)) : ["(nothing attached)"]),
          "",
          ...(pics.length ? ["## Images (put one in a wiki page with the Markdown shown)", ...pics.map((i) => `- ${imageMarkdown((i.caption || i.name).replace(/[\][()\n\r]/g, ""), i.id)}`), ""] : []),
          "## Recent conversation",
          ...(talk.length ? talk : ["(none)"]),
        ].join("\n"),
      );
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

  server.registerTool(
    "skills",
    {
      description:
        "The company's skill library (R71): reusable instructions agents load when relevant. list shows each skill, what it's for and who has it. The CEO can give a skill to an agent (skill name and agent name) or take it away; giving a pack's name (e.g. obra/superpowers) gives every skill in it. The owner is told. Skills are added to the library by the owner.",
      inputSchema: { action: z.enum(["list", "give", "take"]), skill: z.string().max(200).optional(), agent: z.string().max(80).optional() },
    },
    async ({ action, skill, agent }) => {
      if (action === "list") return text(JSON.stringify((await skills.list(scope.companyId)).map((s) => ({ name: s.name, ...(s.pack ? { pack: s.pack } : {}), description: s.description, agents: s.agents.map((a) => a.name) }))));
      const [me] = scope.agentId ? await db.select({ role: agents.role }).from(agents).where(eq(agents.id, scope.agentId)) : [];
      if (me?.role !== "ceo") return fail("Only your company's CEO can give or take skills.");
      if (!skill || !agent) return fail("Give the skill's name and the agent's name.");
      const [who] = await db.select({ id: agents.id, name: agents.name }).from(agents).where(and(eq(agents.companyId, scope.companyId), sql`lower(${agents.name}) = lower(${agent})`));
      if (!who) return fail(`No agent called ${agent}. Use board to see who there is.`);
      try {
        if (action === "give") await skills.give(scope.companyId, skill, who.id, scope.agentId);
        else await skills.take(scope.companyId, skill, who.id);
      } catch (err) {
        if (err instanceof SkillError) return fail(err.message);
        throw err;
      }
      await notes.notify({ companyId: scope.companyId, agentId: scope.agentId, level: "note", title: action === "give" ? `The CEO gave ${who.name} the ${skill} skill` : `The CEO took the ${skill} skill from ${who.name}`, body: null, link: "#/skills" });
      return text(action === "give" ? `${who.name} has the ${skill} skill from their next run.` : `${who.name} no longer has the ${skill} skill.`);
    },
  );

  // The CEO builds the team (R62): hires wait for the owner unless they've said otherwise, and
  // instruction changes go through with a notification and an Undo unless they want to approve those too.
  const ceoOnly = async () => {
    const [me] = scope.agentId ? await db.select({ role: agents.role }).from(agents).where(eq(agents.id, scope.agentId)) : [];
    return me?.role === "ceo" && scope.agentId ? scope.agentId : null;
  };
  server.registerTool(
    "propose_hire",
    {
      description: `Hire a new agent for the company (CEO only). Start from a template (${AGENT_TEMPLATES.map((t) => `${t.id}: ${t.summary}`).join("; ")}), give it a name, and tailor its title and instructions to the company. Say why you're hiring. Pass forTickets (ticket ids) for tickets waiting for this person: they are assigned to them once the hire is approved. Unless the owner has said otherwise, the hire waits for their approval in Decisions. Use board to see who there is first.`,
      inputSchema: {
        name: z.string().trim().min(1).max(80),
        template: z.string().max(40).optional(),
        title: z.string().trim().max(80).optional(),
        instructions: z.string().trim().max(20_000).optional(),
        model: z.string().max(200).optional(),
        fundingSourceId: z.string().uuid().optional(),
        forTickets: z.array(z.string().uuid()).max(20).optional(),
        reason: z.string().trim().min(1).max(2000),
      },
    },
    async (input) => {
      const ceo = await ceoOnly();
      if (!ceo) return fail("Only your company's CEO can hire.");
      if (input.forTickets?.length) {
        const found = await db.select({ id: tickets.id }).from(tickets).where(and(eq(tickets.companyId, scope.companyId), inArray(tickets.id, input.forTickets)));
        if (found.length !== new Set(input.forTickets).size) return fail("One of forTickets is not a ticket in your company.");
      }
      try {
        const r = await team.proposeHire(scope.companyId, ceo, input);
        return text("hired" in r ? `${r.hired.name} is hired (agent ${r.hired.id}); give them work with create_ticket.` : `The hire is waiting for the owner's approval (decision ${r.decisionId}).`);
      } catch (err) {
        if (err instanceof AgentError) return fail(err.message);
        throw err;
      }
    },
  );
  server.registerTool(
    "propose_team",
    {
      description: `Propose a team for a project, or for the company, as ONE decision the owner ticks through (CEO only). Use it when the owner asks for a team, or a project is new or its scope grew. Read the project and the current team first (board), reuse existing agents, and propose the smallest team that covers the scope. For each hire: a name, a template (${AGENT_TEMPLATES.map((t) => t.id).join(", ")}), optionally a title and model, the skills or packs from the library to give it, and the reason. Say in "covered" who already covers what.`,
      inputSchema: {
        projectId: z.string().uuid().optional(),
        covered: z.string().trim().min(1).max(2000),
        hires: z
          .array(
            z.object({
              name: z.string().trim().min(1).max(80),
              template: z.string().max(40).optional(),
              title: z.string().trim().max(80).optional(),
              model: z.string().max(200).optional(),
              skills: z.array(z.string().max(200)).max(30).optional(),
              reason: z.string().trim().min(1).max(600),
            }),
          )
          .min(1)
          .max(8),
      },
    },
    async (input) => {
      const ceo = await ceoOnly();
      if (!ceo) return fail("Only your company's CEO can propose a team.");
      try {
        const r = await team.proposeTeam(scope.companyId, ceo, input);
        return text(`The team plan is waiting for the owner (decision ${r.decisionId}). They tick the hires they want; each is hired with its skills.`);
      } catch (err) {
        if (err instanceof AgentError) return fail(err.message);
        throw err;
      }
    },
  );
  server.registerTool(
    "propose_rule",
    {
      description:
        "Draft a permission rule for the owner (CEO only), after they ask for one. Call it once with a plain-English explanation: what the rule matches, what happens, and examples of requests it would and wouldn't catch. The owner sees your explanation with the exact rule and adds it or not. Give at least one of kinds, commandPattern, titlePattern. A rule that allows is always limited to safe requests.",
      inputSchema: {
        name: z.string().trim().min(1).max(100),
        explanation: z.string().trim().min(1).max(2000),
        outcome: z.enum(["allow", "ceo", "owner", "deny"]),
        match: z.object({ kinds: z.array(z.string()).max(10).optional(), commandPattern: z.string().min(1).max(500).optional(), titlePattern: z.string().min(1).max(500).optional() }),
      },
    },
    async (input) => {
      const ceo = await ceoOnly();
      if (!ceo) return fail("Only your company's CEO can propose rules.");
      try {
        const id = await policyRulesService(db).propose(scope.companyId, ceo, input);
        return text(`The rule is waiting for the owner's answer (decision ${id}).`);
      } catch (err) {
        if (err instanceof RuleError) return fail(err.message);
        throw err;
      }
    },
  );
  server.registerTool(
    "agent_instructions",
    {
      description: "Read an agent's standing instructions (CEO only): its title, the template it was hired from, and the full text, so you can revise it with update_instructions. Long text comes in parts; pass offset to continue.",
      inputSchema: { agent: z.string().trim().min(1).max(80), offset: z.number().int().min(0).optional() },
    },
    async ({ agent, offset }) => {
      if (!(await ceoOnly())) return fail("Only your company's CEO can read other agents' instructions.");
      const [who] = await db.select({ name: agents.name, title: agents.title, role: agents.role, template: agents.template, instructions: agents.instructions }).from(agents).where(and(eq(agents.companyId, scope.companyId), sql`lower(${agents.name}) = lower(${agent})`, isNull(agents.retiredAt)));
      if (!who) return fail(`No agent called ${agent}. Use board to see who there is.`);
      return text(`# ${who.name}: ${who.title ?? who.role}${who.template ? ` (hired from the ${who.template} template)` : ""}\n\n${who.instructions ? cut(who.instructions, CAP, (m) => `continue with agent_instructions agent="${who.name}" offset=${m}`, offset) : "(no instructions yet)"}`);
    },
  );

  server.registerTool(
    "update_instructions",
    {
      description: "Change an agent's standing instructions (CEO only): the whole new text, which replaces the old. Read the current text first with agent_instructions. Say why. The owner is told, and can undo it; if they've asked to approve such changes, it waits in Decisions.",
      inputSchema: { agent: z.string().trim().min(1).max(80), instructions: z.string().trim().min(1).max(20_000), reason: z.string().trim().min(1).max(2000) },
    },
    async ({ agent, instructions, reason }) => {
      const ceo = await ceoOnly();
      if (!ceo) return fail("Only your company's CEO can change instructions.");
      const [who] = await db.select({ id: agents.id, name: agents.name }).from(agents).where(and(eq(agents.companyId, scope.companyId), sql`lower(${agents.name}) = lower(${agent})`, isNull(agents.retiredAt)));
      if (!who) return fail(`No agent called ${agent}. Use board to see who there is.`);
      try {
        const r = await team.proposeInstructions(who.id, ceo, instructions, reason);
        return text("applied" in r ? `${who.name}'s instructions are updated from their next run.` : `The change is waiting for the owner's approval (decision ${r.decisionId}).`);
      } catch (err) {
        if (err instanceof AgentError) return fail(err.message);
        throw err;
      }
    },
  );

  server.registerTool(
    "wiki",
    {
      description:
        "The company wiki: Markdown pages in nested folders, shared by the owner and agents. list (optional q to search; with q it returns the best matching sections with snippets, otherwise each page's slug and folder), read (slug; a page over 8000 characters comes back as an outline, then read one part with section=\"Heading\" or \"Parent > Heading\", or the text in parts with offset; offset=0 gives the whole text), write (title, body, folder such as \"Research/Competitors\" to file it, optional slug to update a page — a different folder moves it — and optional ticketId when it's a ticket's output) and attach (link a repo file — path and branch or commit as ref — or a web url to a ticket as its output). Put documents you produce (research, specs, reports, how-tos) in the wiki with the ticket's id, so the owner can read them from the ticket. A page shows pictures inline: attach each one to the ticket with attach_image (which gives the Markdown), or reuse one already on a ticket (tickets read lists its image ids), and put ![caption](/api/ticket-images/ID) in the page. Never commit images to the repo. Writing to an existing slug updates it; older versions are kept. Link pages with [[slug]] or [[slug#Section heading]]; reads show a page's links and what links to it.",
      inputSchema: {
        action: z.enum(["list", "read", "write", "attach"]),
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
            const sections = splitSections(p.body);
            const outline = (error?: string) =>
              [
                ...(error ? [error, ""] : []),
                `# ${p.title}`,
                `${p.body.length} characters, ${sections.length} sections:`,
                ...sections.map((s) => `- ${s.path} (${s.ownEnd - s.start} chars): ${p.body.slice(s.start, s.ownEnd).split("\n").find((l) => l.trim() && !/^#+\s/.test(l))?.trim().slice(0, 100) ?? ""}`),
                "",
                `Read a section with section="<heading>", or the whole page in parts with offset=0.`,
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
            return text([body, ...(l.links.length ? [`Links: ${l.links.join(", ")}`] : []), ...(l.linkedFrom.length ? [`Linked from: ${l.linkedFrom.join(", ")}`] : [])].join("\n\n"));
          }
          case "write": {
            if (!input.title || input.body === undefined) return fail("Give a title and a body.");
            const r = await wiki.write(scope.companyId, { slug: input.slug, folder: input.folder, title: input.title, body: input.body, ticketId: input.ticketId ?? null, ...by });
            const link = `#/wiki/${scope.companyId}/${r.page.slug}`;
            return text(`${r.created ? "Created" : "Updated"} ${link}${input.ticketId ? ", linked to the ticket" : ""}. Pass link "${link}" to notify_owner when you tell the owner about it.`);
          }
          case "attach": {
            if (!input.ticketId) return fail("Give the ticketId it belongs to.");
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

/** CEOs and managers: whether the run's agent is one. */
async function findProject(db: Db, scope: Scope, project?: string) {
  const rows = await db.select().from(projects).where(and(eq(projects.companyId, scope.companyId), isNull(projects.archivedAt)));
  if (project) return rows.find((p) => p.id === project || p.name.toLowerCase() === project.toLowerCase()) ?? null;
  return rows.length === 1 ? rows[0]! : null;
}

// A run woken with "tree stopped" may act only on the watched ticket and its sub-tasks; returns the refusal text, or null.
async function treeRefusal(db: Db, scope: Scope, ticketId: string | undefined): Promise<string | null> {
  const [w] = await db.select({ note: wakes.note }).from(wakes).where(and(eq(wakes.runId, scope.runId), eq(wakes.reason, TREE_REASON)));
  if (!w) return null;
  // Wakes for several trees of one watcher can merge, so the note may name more than one root.
  const roots = [...(w.note ?? "").matchAll(TREE_ROOT_LINE)].map((m) => m[1]!);
  const inside = roots.length && ticketId ? await db.select({ id: tickets.id }).from(tickets).where(and(eq(tickets.id, ticketId), or(inArray(tickets.id, roots), inArray(tickets.parentTicketId, roots)))) : [];
  return inside.length ? null : "Refused: this run was woken to watch one task and its sub-tasks, and may only change those. That ticket is outside the tree.";
}

/**
 * Moving and reorganising tickets, in ticket runs and the owner chat. In chat only the CEO and
 * managers may: the owner asks them there to close or tidy work, and workers move their own
 * tickets from the ticket's run.
 */
function registerTicketMoves(server: McpServer, db: Db, { review, work, feedback }: Pick<Services, "review" | "work" | "feedback">, scope: Scope, hooks: McpHooks, chat: boolean) {
  const isManager = () => managerIn(db, scope);
  const resolveProject = (project?: string) => findProject(db, scope, project);
  const outsideTree = (ticketId: string | undefined) => treeRefusal(db, scope, ticketId);
  const chatRefusal = async () => (chat && !(await isManager()) ? "In chat only your CEO or a manager can move tickets. Offer the owner to create a ticket for the work, or nudge your CEO." : null);

  server.registerTool(
    "update_ticket",
    {
      description:
        "For CEOs and managers: reorganise one of your company's tickets. Move it to another project (project: name or id; its sub-tasks go with it; not while it is in progress or in review), put it under a feature (featureId, or null to take it out), make it a sub-task of a task (parentTicketId, or null to take it out; it joins the parent's feature and the parent waits on it), fix its title or description, or set who it is assigned to (assignee: an agent's name, or null to leave it unassigned; the new assignee is woken), or mark it as not needing code (noCode true for research, wiki, docs or deploy-only work, so it can reach review with an empty diff; false to clear it). Give at least one change and a reason up to 240 characters; the reason is kept on the ticket. Pass expected_version so it is refused if the ticket changed since you read it. To close a duplicate, use set_ticket_state done with outcome cancelled.",
      inputSchema: {
        ticketId: z.string().uuid(),
        project: z.string().min(1).optional(),
        featureId: z.string().uuid().nullable().optional(),
        parentTicketId: z.string().uuid().nullable().optional(),
        title: z.string().trim().min(1).max(200).optional(),
        body: z.string().max(10_000).optional(),
        assignee: z.string().min(1).nullable().optional(),
        noCode: z.boolean().optional(),
        reason: z.string().trim().min(1).max(240),
        expected_version: z.number().int().optional(),
      },
    },
    async ({ ticketId, project, featureId, parentTicketId, title, body, assignee, noCode, reason, expected_version }) => {
      if (!(await isManager())) return fail("Only your company's CEO or a manager can reorganise tickets.");
      const out = await outsideTree(ticketId);
      if (out) return fail(out);
      if (project === undefined && featureId === undefined && parentTicketId === undefined && title === undefined && body === undefined && assignee === undefined && noCode === undefined) return fail("Nothing to change: give project, featureId, parentTicketId, title, body, assignee or noCode.");
      const [t] = await db.select({ version: tickets.version }).from(tickets).where(and(eq(tickets.id, ticketId), eq(tickets.companyId, scope.companyId)));
      if (!t) return fail("No ticket with that ID in your company.");
      if (expected_version !== undefined && t.version !== expected_version) return fail(`Nothing changed: the ticket changed since you last saw it (you had version ${expected_version}; it is now ${t.version}). Read it again with tickets, then decide.`);
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
        const u = await work.updateTicket(ticketId, { ...(assigneeId !== undefined ? { assigneeAgentId: assigneeId } : {}), ...(p ? { projectId: p.id } : {}), ...(featureId !== undefined ? { featureId } : {}), ...(parentTicketId !== undefined ? { parentTicketId } : {}), ...(title !== undefined ? { title } : {}), ...(body !== undefined ? { body } : {}), ...(noCode !== undefined ? { noCode } : {}) });
        const [me] = scope.agentId ? await db.select({ name: agents.name }).from(agents).where(eq(agents.id, scope.agentId)) : [];
        await record(db, { companyId: scope.companyId, agentId: scope.agentId, ticketId, kind: "reorganised", summary: `${me?.name ?? "An agent"} reorganised it${noCode === undefined ? "" : noCode ? " (marked no code)" : " (no longer marked no code)"}: ${reason}` });
        return text(`Ticket ${ticketId} updated (version ${u.version}).`);
      } catch (err) {
        if (err instanceof WorkError) return fail(err.message);
        throw err;
      }
    },
  );

  server.registerTool(
    "set_ticket_state",
    {
      description: "Move one of your company's tickets to a new state. Call it with state \"review\" when your work is ready to check, or \"done\" when it is finished; ending your turn does not move the ticket. Moving to review, done or blocked needs a summary (up to 240 characters): what you did, or what you are waiting on. Blocked is refused unless something open holds the ticket; if you are waiting on the owner (to run something, answer or sign off), call raise_decision with blocksTicketId first, and only after you have tried every way to do it yourself. Naming the owner in the summary does not reach them. It is kept on the ticket for whoever reads it next, so write it in plain words with no file paths unless essential. If the ticket has acceptance criteria, the summary must say pass or fail for each of them. Pass expected_version (the ticket's version as you last saw it) so the move is refused if the ticket has changed since.",
      inputSchema: { ticketId: z.string().uuid(), state: z.enum(STATES), outcome: z.enum(["completed", "cancelled"]).optional(), expected_version: z.number().int().optional(), summary: z.string().max(240).optional() },
    },
    async ({ ticketId, state, outcome, expected_version, summary }) => {
      const no = await chatRefusal();
      if (no) return fail(no);
      // In a project with a repo, a ticket is done when its branch is merged after review (R46, R47).
      if (state === "done") {
        const [t] = await db
          .select({ repoUrl: projects.repoUrl, mergeCommit: tickets.mergeCommit })
          .from(tickets)
          .innerJoin(projects, eq(projects.id, tickets.projectId))
          .where(and(eq(tickets.id, ticketId), eq(tickets.companyId, scope.companyId)));
        // A ticket whose branch is already merged but stayed in review (e.g. waiting on the owner's yes) can be closed by a manager.
        const merged = !!t?.mergeCommit && (await managerIn(db, scope));
        // A ticket whose change shipped on another ticket has nothing of its own to merge; the CEO or a manager may close it.
        if (t?.repoUrl && outcome !== "cancelled" && !merged) {
          const nothingOwn = await review.needsChanges(ticketId, scope.companyId).catch(() => false);
          if (!nothingOwn) return fail('This project has a repo: move the ticket to "review" instead. It becomes done when its branch is approved, checked and merged.');
          if (!(await managerIn(db, scope))) return fail("This ticket has no changes of its own, so it can't be merged. If its change shipped on another ticket, ask your CEO or manager to close it (set_ticket_state done, naming that ticket in the summary).");
        }
      }
      if ((state === "review" || state === "done" || state === "blocked") && !summary?.trim()) return fail(`Moving a ticket to ${state} needs a summary (up to 240 characters): what you did, or what you are waiting on. Call set_ticket_state again with summary.`);
      // With criteria on the ticket, moving to review is only allowed once the state note reports
      // pass or fail for each of them; the refusal names the ones it can't find.
      const [withCriteria] = await db
        .select({ criteria: tickets.acceptanceCriteria, current: tickets.stateNote })
        .from(tickets)
        .where(and(eq(tickets.id, ticketId), eq(tickets.companyId, scope.companyId)));
      if (!withCriteria) return fail("No ticket with that ID in your company.");
      const missing = state === "review" ? missingVerdicts(withCriteria.criteria, summary ?? withCriteria.current) : [];
      if (missing.length)
        return fail(
          `This ticket has acceptance criteria, and the summary must give pass or fail for each of them. Not reported: ${missing.map((m) => `"${m}"`).join(", ")}. Say whether each one passes or fails, then move it again.`,
        );
      // A code ticket with nothing changed in the repository can't be reviewed; research and wiki
      // tickets are marked "no code" and are not held to this.
      if (state === "review" && (await review.needsChanges(ticketId, scope.companyId).catch(() => false))) return fail(NOTHING_CHANGED);
      // A ticket waiting on the owner has to show in their Your review lane, which it only does through an open decision.
      if (state === "blocked" && !(await hasOpenBlocker(db, ticketId))) {
        return fail("A blocked ticket must be waiting on something the board can see. If you need the owner (to run something, answer or sign off), call raise_decision with blocksTicketId set to this ticket: it blocks the ticket and puts the ask in their Your review lane. A note in the summary or ticket_reply does not reach them. If you need a colleague's work first, create_ticket with parent set to this ticket: that blocks it until the sub-task is done. For CI or an outside service, use schedule_check instead.");
      }
      // The card moves to the project's first column for a new state, so the board matches; a note alone leaves it where it is.
      const [col] = await db
        .select({ id: workflowColumns.id })
        .from(workflowColumns)
        .innerJoin(tickets, eq(tickets.projectId, workflowColumns.projectId))
        .where(and(eq(tickets.id, ticketId), eq(workflowColumns.systemState, state)))
        .orderBy(asc(workflowColumns.position))
        .limit(1);
      const at = new Date();
      const rows = await db
        .update(tickets)
        // One timestamp for both, so a fresh note isn't called out of date.
        .set({ systemState: state, columnId: sql`case when ${tickets.systemState} = ${state} then ${tickets.columnId} else ${col?.id ?? null}::uuid end`, outcome: state === "done" ? (outcome ?? "completed") : null, ...(state === "done" ? { monitorAt: null } : {}), lastActivityAt: at, ...(summary?.trim() ? { stateNote: summary.trim(), stateNoteAt: at } : {}) })
        // The version is checked in the same statement, so a change between read and write can't slip through (R81).
        .where(and(eq(tickets.id, ticketId), eq(tickets.companyId, scope.companyId), expected_version === undefined ? undefined : eq(tickets.version, expected_version)))
        .returning({ id: tickets.id });
      if (!rows.length) {
        const [now] = await db
          .select({ state: tickets.systemState, version: tickets.version, changed: tickets.lastActivityAt, assignee: agents.name })
          .from(tickets)
          .leftJoin(agents, eq(agents.id, tickets.assigneeAgentId))
          .where(and(eq(tickets.id, ticketId), eq(tickets.companyId, scope.companyId)));
        if (!now) return fail("No ticket with that ID in your company.");
        return fail(`Nothing changed: the ticket changed since you last saw it (you had version ${expected_version}). It is now ${now.state}, assigned to ${now.assignee ?? "nobody"}, version ${now.version}, last changed ${now.changed.toISOString()}. Read it again with tickets, then decide whether to move it.`);
      }
      await record(db, { companyId: scope.companyId, agentId: scope.agentId, ticketId, kind: "state", summary: `-> ${state}${summary?.trim() ? `: ${summary.trim()}` : ""}`, at });
      const [moved] = await db.select({ featureId: tickets.featureId }).from(tickets).where(eq(tickets.id, ticketId));
      await feedback.syncFeature(moved?.featureId);
      // Work that waited on this ticket can start; the wake carries this run's chain depth.
      if (state === "done") await hooks.onTicketDone?.(ticketId, scope.runId);
      if (state === "review") await hooks.onTicketReview?.(ticketId, scope.agentId, scope.runId);
      return text(`Ticket ${ticketId} is now ${state}.`);
    },
  );

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

async function managerIn(db: Db, scope: Scope) {
  const [me] = scope.agentId ? await db.select({ role: agents.role }).from(agents).where(eq(agents.id, scope.agentId)) : [];
  return me?.role === "ceo" || me?.role === "manager";
}

/** The roadmap tool, in ticket runs and the owner chat alike. */
function registerRoadmap(server: McpServer, db: Db, work: Services["work"], scope: Scope) {
  server.registerTool(
    "roadmap",
    {
      description:
        "For CEOs and managers: the company's roadmap, as the owner sees it on the Roadmap and Plan pages. action list (objectives with their ids, priority and milestones with dates), add_objective (title, priority 1 most important to 5, optional project by name or id), add_milestone (objectiveId, title, targetDate YYYY-MM-DD, optional horizon now, next or later) and set (ticketId, milestoneId or null: put a ticket in a milestone or take it out). Give a reason up to 240 characters for any change; it is kept in the activity log. List first, and reuse an objective or milestone that already fits rather than adding a near-duplicate.",
      inputSchema: {
        action: z.enum(["list", "add_objective", "add_milestone", "set"]),
        title: z.string().trim().min(1).max(200).optional(),
        priority: z.number().int().min(1).max(5).optional(),
        project: z.string().min(1).optional(),
        objectiveId: z.string().uuid().optional(),
        targetDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD").optional(),
        horizon: z.enum(HORIZONS).optional(),
        ticketId: z.string().uuid().optional(),
        milestoneId: z.string().uuid().nullable().optional(),
        reason: z.string().trim().min(1).max(240).optional(),
      },
    },
    async ({ action, title, priority, project, objectiveId, targetDate, horizon, ticketId, milestoneId, reason }) => {
      if (!(await managerIn(db, scope))) return fail("Only your company's CEO or a manager can change the roadmap.");
      if (action === "list") {
        const tree = await work.objectivesTree(scope.companyId);
        return text(JSON.stringify(tree.map((o) => ({ id: o.id, title: o.title, priority: o.priority, projectId: o.projectId, milestones: o.milestones.map((m) => ({ id: m.id, title: m.title, targetDate: m.targetDate, horizon: m.horizon })) }))));
      }
      if (!reason) return fail("Say why in reason (up to 240 characters); it goes in the activity log.");
      const [me] = scope.agentId ? await db.select({ name: agents.name }).from(agents).where(eq(agents.id, scope.agentId)) : [];
      const log = (summary: string, ticket?: string) => record(db, { companyId: scope.companyId, agentId: scope.agentId, ticketId: ticket ?? null, kind: "roadmap", summary: `${me?.name ?? "An agent"} ${summary}: ${reason}` });
      try {
        if (action === "add_objective") {
          if (!title) return fail("Give the objective a title.");
          const p = project !== undefined ? (await db.select().from(projects).where(and(eq(projects.companyId, scope.companyId), isNull(projects.archivedAt)))).find((x) => x.id === project || x.name.toLowerCase() === project.toLowerCase()) ?? null : null;
          if (project !== undefined && !p) return fail(`No open project called ${project} in your company.`);
          const o = await work.createObjective(scope.companyId, { title, priority, ...(p ? { projectId: p.id } : {}) });
          await log(`added the objective "${o.title}"`);
          return text(`Added the objective "${o.title}" (id ${o.id}, priority ${o.priority}).`);
        }
        if (action === "add_milestone") {
          if (!objectiveId || !title) return fail("Give objectiveId and a title (and a targetDate if it has one).");
          const [o] = await db.select({ title: objectives.title }).from(objectives).where(and(eq(objectives.id, objectiveId), eq(objectives.companyId, scope.companyId)));
          if (!o) return fail("No objective with that id in your company. Call roadmap list for the ids.");
          const m = await work.addMilestone(objectiveId, { title, targetDate, horizon });
          await log(`added the milestone "${m.title}"${targetDate ? ` (${targetDate})` : ""} under "${o.title}"`);
          return text(`Added the milestone "${m.title}" (id ${m.id}) under "${o.title}".`);
        }
        if (!ticketId || milestoneId === undefined) return fail("Give ticketId and milestoneId (or null to take it out).");
        const [t] = await db.select({ id: tickets.id }).from(tickets).where(and(eq(tickets.id, ticketId), eq(tickets.companyId, scope.companyId)));
        if (!t) return fail("No ticket with that ID in your company.");
        await work.updateTicket(ticketId, { milestoneId });
        await log(milestoneId ? "put it in a milestone" : "took it out of its milestone", ticketId);
        return text(milestoneId ? `Ticket ${ticketId} is in the milestone now.` : `Ticket ${ticketId} has no milestone now.`);
      } catch (err) {
        if (err instanceof WorkError) return fail(err.message);
        throw err;
      }
    },
  );
}

function registerBoard(server: Pick<McpServer, "registerTool">, db: Db, scope: Scope) {
  server.registerTool(
    "board",
    { description: "See the company's board: projects, objectives with their milestones, agents, and open tickets with their ids.", inputSchema: {} },
    async () => {
      const ps = await db.select({ id: projects.id, name: projects.name }).from(projects).where(and(eq(projects.companyId, scope.companyId), isNull(projects.archivedAt))).orderBy(asc(projects.name));
      const os = await db.select({ id: objectives.id, title: objectives.title, priority: objectives.priority }).from(objectives).where(and(eq(objectives.companyId, scope.companyId), eq(objectives.status, "active")));
      const ms = os.length ? await db.select({ id: milestones.id, objectiveId: milestones.objectiveId, title: milestones.title, targetDate: milestones.targetDate }).from(milestones).where(inArray(milestones.objectiveId, os.map((o) => o.id))) : [];
      const as = await db.select({ id: agents.id, name: agents.name, role: agents.role }).from(agents).where(eq(agents.companyId, scope.companyId));
      const ts = await db
        .select({ id: tickets.id, number: tickets.number, title: tickets.title, state: tickets.systemState, projectId: tickets.projectId, milestoneId: tickets.milestoneId, assigneeAgentId: tickets.assigneeAgentId, risk: tickets.risk })
        .from(tickets)
        .where(and(eq(tickets.companyId, scope.companyId), ne(tickets.systemState, "done")))
        .orderBy(asc(tickets.createdAt))
        .limit(300);
      const ref = await refsOf(db, scope.companyId);
      return text(JSON.stringify({ projects: ps, objectives: os.map((o) => ({ ...o, milestones: ms.filter((m) => m.objectiveId === o.id) })), agents: as, openTickets: ts.map(ref) }));
    },
  );
}

function registerListMyWork(server: Pick<McpServer, "registerTool">, db: Db, scope: Scope) {
  server.registerTool(
    "list_my_work",
    { description: "List the open tickets assigned to you.", inputSchema: {} },
    async () => {
      if (!scope.agentId) return text("[]");
      const rows = await db
        .select({ id: tickets.id, number: tickets.number, title: tickets.title, state: tickets.systemState, version: tickets.version, due: tickets.dueDate, stateNote: tickets.stateNote, stateNoteAt: tickets.stateNoteAt, lastActivityAt: tickets.lastActivityAt })
        .from(tickets)
        .where(and(eq(tickets.assigneeAgentId, scope.agentId), ne(tickets.systemState, "done")));
      const ref = await refsOf(db, scope.companyId);
      return text(JSON.stringify(rows.map((r) => withNote(ref(r)))));
    },
  );
}

/** The tools a PA may have (R87): all reads. Anything else is never registered for it. */
const PA_READS = new Set(["tickets", "decisions", "list_my_work", "wiki", "whats_new", "board"]);

/**
 * A view of the server that registers only the PA's read tools. What they return is remembered
 * for the run, since pa_reply may cite only that; a wiki write is refused.
 */
function readOnly(server: McpServer, runId: string): Pick<McpServer, "registerTool"> {
  return {
    registerTool: ((name: string, config: never, cb: (input: { action?: string }, extra: never) => Promise<unknown>) => {
      if (!PA_READS.has(name)) return undefined;
      return server.registerTool(name, config, (async (input: { action?: string }, extra: never) => {
        if (name === "wiki" && input.action !== "list" && input.action !== "read") return fail("You can only read the wiki.");
        const r = await cb(input, extra);
        // Only a search can show "nothing found"; reading one ticket can't.
        if ((name === "tickets" && input.action === "find") || (name === "decisions" && input.action === "list")) markSearched(runId);
        if (name !== "wiki" && input.action !== "file") remember(runId, JSON.stringify(r));
        return r;
      }) as never);
    }) as never,
  };
}

/** The PA's server: the read tools plus pa_reply and pa_escalate, and nothing that writes (R87). */
function buildPaServer(db: Db, { notes, wiki, skills, review, agents: team, pa, images }: Services, scope: Scope) {
  const server = new McpServer({ name: "bossman", version: "0.1.0" });
  const reads = readOnly(server, scope.runId);
  registerSharedTools(reads as McpServer, db, { notes, wiki, skills, review, agents: team }, scope);
  registerViewImage(server, images, scope);
  registerBoard(reads, db, scope);
  registerListMyWork(reads, db, scope);
  reads.registerTool(
    "decisions",
    { description: "Decisions that are waiting on the owner or the CEO: id, question, options and who raised it.", inputSchema: { action: z.literal("list") } },
    async () => {
      const open = await db.select().from(decisionsTable).where(and(eq(decisionsTable.companyId, scope.companyId), eq(decisionsTable.status, "open"))).orderBy(decisionsTable.createdAt).limit(40);
      return text(open.length ? JSON.stringify(open.map((d) => ({ id: d.id, question: d.question, options: d.options, recommended: d.recommendedOption, waitingOn: d.tier, raisedAt: d.createdAt }))) : "No decisions are waiting.");
    },
  );

  server.registerTool(
    "pa_reply",
    {
      description:
        "Answer the owner's last message. The only way you answer them. text is the answer, in plain words, from what your tools returned. cites lists every ticket or decision it rests on, each with its id (ids your tools returned in this run only). An empty list is allowed for a \"nothing found\" answer, but only after you searched with the tickets or decisions tool. confidence is high only when the tools show the answer plainly. Boss Man checks the reply and may hand the question to the CEO instead; the result says so.",
      inputSchema: {
        text: z.string().min(1).max(4000),
        cites: z.array(z.object({ kind: z.enum(["ticket", "decision", "run"]), id: z.string().uuid() })).max(20),
        confidence: z.enum(["high", "low"]),
      },
    },
    async (input) => {
      const r = await pa.reply(scope.runId, input);
      return r.posted ? text(r.note) : fail(r.note);
    },
  );

  server.registerTool(
    "pa_escalate",
    { description: "Pass the owner's last message to the CEO when you can't answer it from your tools or it needs judgement. summary is what you found, for the CEO. The owner is told it's with the CEO.", inputSchema: { summary: z.string().min(1).max(2000) } },
    async ({ summary }) => ((await pa.escalate(scope.runId, summary)).ok ? text("Passed to the CEO; the owner was told. Don't answer it yourself.") : fail("There's no unanswered owner message to pass on.")),
  );

  return server;
}

/** The Scrum Master's watchdog actions (BOS-58). Each needs a one-line reason, is logged and can be undone. */
function registerWatchdog(server: McpServer, watchdog: Services["watchdog"], scope: Scope) {
  server.registerTool(
    "watchdog",
    {
      description:
        "Your only way to act on the problems the watchdog hands you. Every action needs reason: one line saying why. list: the open flags. nudge (ticketId): ask the assignee to pick it up or say why it's stuck. assign (ticketId, to): an unassigned ticket only, to the obvious colleague by name, or \"ceo\" if none is obvious. rewake (ticketId): wake the assignee again after their run crashed or ended without moving the ticket. chase_review (ticketId): wake the pending reviewers. snooze (flagId, hours up to 48): the flag is fine for now; a third snooze in a row is refused and the ticket goes to the CEO. escalate (ticketId): hand it to the CEO. raise_decision (ticketId, question, options, recommended, triedFirst, ownerMustDo, steps): when only the owner can unblock it. Act only on the problems the watchdog handed you, each action at most once per problem until it is handed to you again. The owner can undo any of your actions. You can't do the work, change risk or priority, or close or cancel tickets. Actions are capped per hour; past the cap the watchdog switches off and the owner is told.",
      inputSchema: {
        action: z.enum(["list", "nudge", "assign", "rewake", "chase_review", "snooze", "escalate", "raise_decision"]),
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
            const open = await watchdog.flags(companyId, { status: "open", limit: 50 });
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
            return done(await watchdog.raiseDecision(companyId, agentId, runId, { ticketId: input.ticketId!, question: input.question!, options: input.options!, recommended: input.recommended!, triedFirst: input.triedFirst!, ownerMustDo: input.ownerMustDo, steps: input.steps, reason }));
        }
      } catch (err) {
        if (err instanceof WatchdogError) return fail(err.message);
        throw err;
      }
    },
  );
}

const NUDGE_DESCRIPTION =
  "Call a colleague over: hand something to them or ask them a question, by name (or id), in your own company. Pass the ticket it's about, if any, and say why in a sentence or two. If they're working on that ticket now it reaches them straight away; otherwise they're woken with it. Not for routine updates: those go in ticket_reply or the ticket's state note. A few nudges per colleague every ten minutes at most, and none back and forth about the same ticket.";
const NUDGE_INPUT = { agent: z.string().min(1), ticketId: z.string().uuid().optional(), why: z.string().min(1).max(500) };

/**
 * The owner chat's tools (v1.1): the board and nothing else. Tickets it makes are the owner's,
 * not an agent's, and go through the same checks as the board's own forms.
 */
function buildChatServer(db: Db, { work, feedback, notes, wiki, skills, review, agents: team, images }: Services, scope: Scope, hooks: McpHooks) {
  const server = new McpServer({ name: "bossman", version: "0.1.0" });
  registerSharedTools(server, db, { notes, wiki, skills, review, agents: team }, scope);
  registerViewImage(server, images, scope);
  const ownTicket = async (id: string) => (await db.select({ id: tickets.id }).from(tickets).where(and(eq(tickets.id, id), eq(tickets.companyId, scope.companyId))))[0] ?? null;
  const workFail = (err: unknown) => {
    if (err instanceof WorkError) return fail(err.message);
    throw err;
  };

  registerBoard(server, db, scope);
  registerRoadmap(server, db, work, scope);
  registerTicketMoves(server, db, { review, work, feedback }, scope, hooks, true);

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
        "Create a ticket for the owner. Give the project by name when there's more than one. Rate its risk: trivial, low, medium (the default), high or critical. Optionally put it in a milestone, assign it to an agent by name, and list tickets it waits on.",
      inputSchema: {
        title: z.string().min(1).max(200),
        body: z.string().max(10_000).optional(),
        project: z.string().optional(),
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
        const t = await work.createTicket(p.id, { title: input.title, body: input.body ?? null, risk: input.risk, planFirst: input.planFirst, milestoneId: input.milestoneId, assigneeAgentId, featureId: input.featureId, acceptanceCriteria: input.acceptanceCriteria, noCode: input.noCode });
        for (const id of input.waitsOn ?? []) await work.addDependency(t.id, { ticketId: id });
        return text(`Created #/tickets/${t.id} "${t.title}" in ${p.name}${t.planFirst ? " (plan first)" : ""}.`);
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
    { description: "The company's feature requests, highest priority first: id, title, status, demand and priority. Pass featureId to create_ticket to deliver one.", inputSchema: {} },
    async () => {
      const all = await feedback.scored(scope.companyId);
      return text(JSON.stringify(all.features.filter((f) => f.status !== "declined").sort((a, b) => b.priority - a.priority).slice(0, 60).map((f) => ({ id: f.id, title: f.title, status: f.status, demand: f.demand, priority: f.priority, link: `#/features/${scope.companyId}/${f.id}` }))));
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
        await work.addDependency(ticketId, { ticketId: waitsOnTicketId });
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
          .where(and(eq(runTokens.tokenHash, hashToken(token)), gt(runTokens.expiresAt, new Date())))
      : [];
    if (!scope) return reply.code(401).send({ error: "unknown_or_expired_run_token" });

    // Stateless: a fresh server and transport per request. Owner chat runs get board tools only.
    const [run] = await db.select({ purpose: runsTable.purpose }).from(runsTable).where(eq(runsTable.id, scope.runId));
    // A PA gets its read-only server whatever woke it (R87).
    const [me] = scope.agentId ? await db.select({ duty: agents.duty }).from(agents).where(eq(agents.id, scope.agentId)) : [];
    // The Scrum Master gets its restricted server for its own runs (BOS-58); the owner's chat with it keeps the chat tools.
    const server =
      me?.duty === "assistant"
        ? buildPaServer(db, services, scope)
        : run?.purpose === "chat"
          ? buildChatServer(db, services, scope, hooks)
          : me?.duty === SCRUM_MASTER_DUTY
            ? buildServer(db, services, scope, hooks, SCRUM_MASTER_TOOLS)
            : buildServer(db, services, scope, hooks);
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
