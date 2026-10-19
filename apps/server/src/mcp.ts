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
import { AGENT_TEMPLATES, IMPORTANCE, planFirstByDefault, RISK_TIERS, stateNoteLine, untrusted } from "@boss-man/shared";
import { hashToken } from "./auth.js";
import type { Db } from "./db/client.js";
import { agents, companies, decisions as decisionsTable, features, keyResults, milestones, objectives, projects, runs as runsTable, runTokens, tickets, workflowColumns } from "./db/schema.js";
import { record } from "./services/activity.js";
import { buildBrief } from "./services/brief.js";
import { AnswerError, type decisionsService } from "./services/decisions.js";
import { EngagementError, type EngagementAction, type engagementsService } from "./services/engagements.js";
import { DeployError, type deploysService } from "./services/deploys.js";
import { RunError, type runsService } from "./services/runs.js";
import { ReviewError, type reviewService } from "./services/review.js";
import type { notificationsService } from "./services/notifications.js";
import type { chaptersService } from "./services/chapters.js";
import { WorkError, type workService } from "./services/work.js";
import { FeedbackError, type feedbackService } from "./services/feedback.js";
import { TicketChatError, type ticketChatService } from "./services/ticket-chat.js";
import { WikiError, type wikiService } from "./services/wiki.js";
import { conversationLines } from "./services/ticket-chat.js";
import { SkillError, type skillsService } from "./services/skills.js";
import { AgentError, type agentsService } from "./services/agents.js";
import { markSearched, remember, type paService } from "./services/pa.js";

type Scope = { companyId: string; agentId: string | null; runId: string };

export async function issueRunToken(db: Db, scope: Scope, ttlHours = 12): Promise<string> {
  const token = `bm_run_${randomBytes(32).toString("base64url")}`;
  await db.insert(runTokens).values({ tokenHash: hashToken(token), runId: scope.runId, companyId: scope.companyId, agentId: scope.agentId, expiresAt: new Date(Date.now() + ttlHours * 3_600_000) });
  return token;
}

const STATES = ["backlog", "ready", "in_progress", "blocked", "review", "done"] as const;
const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
const fail = (t: string) => ({ content: [{ type: "text" as const, text: t }], isError: true });

export type McpHooks = {
  onTicketDone?: (ticketId: string, causedByRunId: string) => Promise<unknown>;
  onTicketReview?: (ticketId: string, byAgentId: string | null, causedByRunId: string) => Promise<unknown>;
  nudge?: (input: { runId: string; fromAgentId: string; to: string; ticketId?: string | null; why: string }) => Promise<{ ok: true; delivered: string } | { ok: false; error: string }>;
};

/** The ticket row for an agent, with its state note shown with its age (R85). */
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
};

function buildServer(db: Db, { decisions, engagements, deploys, runs, review, notes, chapters, feedback, ticketChat, wiki, skills, agents: team, pa }: Services, scope: Scope, hooks: McpHooks) {
  const server = new McpServer({ name: "bossman", version: "0.1.0" });

  async function resolveProject(project?: string) {
    const rows = await db.select().from(projects).where(eq(projects.companyId, scope.companyId));
    if (project) return rows.find((p) => p.id === project || p.name.toLowerCase() === project.toLowerCase()) ?? null;
    return rows.length === 1 ? rows[0]! : null;
  }

  server.registerTool(
    "create_ticket",
    {
      description:
        "Create a ticket in your company's backlog. Use it to record work you or your team should do. Give the project by name when your company has more than one. Pass engagementId when the ticket does work another company engaged you for, and featureId when it delivers a feature request. Rate its risk: trivial, low, medium (the default), high or critical; high and critical work is reviewed by the owner, gets the project's deeper check and goes to staging before production. High and critical tickets are planned and approved before anything changes unless you set planFirst to false; set it to true for other work that needs that.",
      inputSchema: {
        title: z.string().min(1).max(200),
        body: z.string().max(10_000).optional(),
        project: z.string().optional(),
        engagementId: z.string().uuid().optional(),
        risk: z.enum(RISK_TIERS).optional(),
        planFirst: z.boolean().optional(),
        featureId: z.string().uuid().optional(),
      },
    },
    async ({ title, body, project, engagementId, risk, planFirst, featureId }) => {
      if (featureId) {
        const [f] = await db.select({ id: features.id }).from(features).where(and(eq(features.id, featureId), eq(features.companyId, scope.companyId)));
        if (!f) return fail("No feature with that id in your company.");
      }
      const p = await resolveProject(project);
      if (!p) {
        const names = (await db.select({ name: projects.name }).from(projects).where(eq(projects.companyId, scope.companyId))).map((r) => r.name);
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
        .values({ companyId: scope.companyId, projectId: p.id, title, body, engagementId: engagementId ?? null, createdByAgentId: scope.agentId, risk: risk ?? null, planFirst: planFirst ?? (risk ? planFirstByDefault(risk) : false), featureId: featureId ?? null })
        .returning({ id: tickets.id });
      await record(db, { companyId: scope.companyId, agentId: scope.agentId, ticketId: t!.id, kind: "ticket_created", summary: `Created "${title}" in ${p.name}` });
      return text(`Created ticket ${t!.id} in ${p.name}.`);
    },
  );

  server.registerTool(
    "set_ticket_state",
    {
      description: "Move one of your company's tickets to a new state. Call it with state \"review\" when your work is ready to check, or \"done\" when it is finished; ending your turn does not move the ticket. Moving to review, done or blocked needs a summary (up to 240 characters): what you did, or what you are waiting on. It is kept on the ticket for whoever reads it next. Pass expected_version (the ticket's version as you last saw it) so the move is refused if the ticket has changed since.",
      inputSchema: { ticketId: z.string().uuid(), state: z.enum(STATES), outcome: z.enum(["completed", "cancelled"]).optional(), expected_version: z.number().int().optional(), summary: z.string().max(240).optional() },
    },
    async ({ ticketId, state, outcome, expected_version, summary }) => {
      // In a project with a repo, a ticket is done when its branch is merged after review (R46, R47).
      if (state === "done") {
        const [t] = await db
          .select({ repoUrl: projects.repoUrl })
          .from(tickets)
          .innerJoin(projects, eq(projects.id, tickets.projectId))
          .where(and(eq(tickets.id, ticketId), eq(tickets.companyId, scope.companyId)));
        if (t?.repoUrl && outcome !== "cancelled") return fail('This project has a repo: move the ticket to "review" instead. It becomes done when its branch is approved, checked and merged.');
      }
      if ((state === "review" || state === "done" || state === "blocked") && !summary?.trim()) return fail(`Moving a ticket to ${state} needs a summary (up to 240 characters): what you did, or what you are waiting on. Call set_ticket_state again with summary.`);
      // The card moves to the project's first column for the new state, so the board matches.
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
        .set({ systemState: state, columnId: col?.id ?? null, outcome: state === "done" ? (outcome ?? "completed") : null, lastActivityAt: at, ...(summary?.trim() ? { stateNote: summary.trim(), stateNoteAt: at } : {}) })
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
      // Work that waited on this ticket can start; the wake carries this run's chain depth.
      if (state === "done") await hooks.onTicketDone?.(ticketId, scope.runId);
      if (state === "review") await hooks.onTicketReview?.(ticketId, scope.agentId, scope.runId);
      return text(`Ticket ${ticketId} is now ${state}.`);
    },
  );

  registerSharedTools(server, db, { notes, wiki, skills, review, agents: team }, scope);

  server.registerTool(
    "ticket_reply",
    {
      description: "Write on a ticket's conversation, where the owner talks to the agents working it. Use it to answer the owner's messages there, or to tell them something about the ticket. For a decision you need from them, use raise_decision instead.",
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
      await notes.notify({ companyId: scope.companyId, agentId: scope.agentId, level: "note", title, body: body.slice(0, 300), link: `#/tickets/${ticketId}` });
      return text("Posted on the ticket's conversation.");
    },
  );

  server.registerTool(
    "nudge",
    {
      description:
        "Call a colleague over: hand something to them or ask them a question, by name (or id), in your own company. Pass the ticket it's about, if any, and say why in a sentence or two. If they're working on that ticket now it reaches them straight away; otherwise they're woken with it. Not for routine updates: those go in ticket_reply or the ticket's state note. A few nudges per colleague every ten minutes at most, and none back and forth about the same ticket.",
      inputSchema: { agent: z.string().min(1), ticketId: z.string().uuid().optional(), why: z.string().min(1).max(500) },
    },
    async ({ agent, ticketId, why }) => {
      if (!scope.agentId || !hooks.nudge) return fail("Only an agent's run can nudge.");
      const r = await hooks.nudge({ runId: scope.runId, fromAgentId: scope.agentId, to: agent, ticketId, why });
      return r.ok ? text(`Nudged: ${r.delivered}.`) : fail(r.error);
    },
  );

  server.registerTool(
    "raise_decision",
    {
      description: "Ask the owner to decide something you shouldn't decide alone. Always give your recommended answer, which must be one of the options. If a ticket can't move until this is answered, pass its ID so it waits.",
      inputSchema: {
        question: z.string().min(1).max(1000),
        options: z.array(z.string().min(1).max(200)).min(2).max(6),
        recommended: z.string(),
        blocksTicketId: z.string().uuid().optional(),
      },
    },
    async ({ question, options, recommended, blocksTicketId }) => {
      if (!options.includes(recommended)) return fail("The recommended answer must be one of the options.");
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
      const d = await decisions.raise({ companyId: scope.companyId, agentId: scope.agentId, question, options, recommended, blocksTicketId });
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
        "Work on an engagement between your company and another. action: list (your company's engagements), view (status, terms and thread), message, and the lifecycle steps. As the provider: accept, reject, counter (with changed terms), deliver (summary plus refs). As the requester: accept_counter, withdraw, sign_off, request_revision. Never put credentials in an engagement.",
      inputSchema: {
        action: z.enum(["list", "view", "accept", "reject", "counter", "accept_counter", "withdraw", "message", "deliver", "sign_off", "request_revision"]),
        engagementId: z.string().uuid().optional(),
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
        if (input.action === "view") return text(JSON.stringify(await engagements.view(input.engagementId, scope.companyId)));
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
        "Your company's feature requests. Anyone can: inbox (unprocessed feedback, oldest first), features (each feature's id, status, demand and priority), log (feedback you heard: text, optional from and title; set fromOutside when it came from outside the company). The CEO also triages: link (noteId, featureId, importance nice_to_have|important|critical, optional highlight copied exactly from the note), create_feature (title, optional description), mark (noteId, state processed|archived).",
      inputSchema: {
        action: z.enum(["inbox", "features", "log", "link", "create_feature", "mark"]),
        noteId: z.string().uuid().optional(),
        featureId: z.string().uuid().optional(),
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
                return `${head}\n${n.untrusted ? untrusted(`feedback via ${n.source}`, n.text) : n.text}`;
              })
              .join("\n\n"),
          );
        }
        if (input.action === "features") {
          const all = await feedback.scored(scope.companyId);
          const list = all.features
            .filter((f) => f.status !== "declined")
            .sort((a, b) => b.priority - a.priority)
            .slice(0, 60)
            .map((f) => ({ id: f.id, title: f.title, status: f.status, parentId: f.parentId, demand: f.demand, people: f.customerCount, priority: f.priority, tickets: f.tickets }));
          return text(JSON.stringify(list));
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
          const f = await feedback.createFeature(scope.companyId, { title: input.title, description: input.description ?? null, createdByAgentId: scope.agentId });
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
        "For CEOs: decisions your company's agents need from you, such as permission requests and plans that your company's rules send to you. action: list, or answer (id, answer: one of the decision's options, and an optional note, e.g. what to change in a plan you send back). The owner sees the same queue and may answer first. You can't answer your own requests.",
      inputSchema: {
        action: z.enum(["list", "answer"]),
        id: z.string().uuid().optional(),
        answer: z.string().max(200).optional(),
        note: z.string().max(2000).optional(),
      },
    },
    async (input) => {
      const [me] = scope.agentId ? await db.select({ role: agents.role }).from(agents).where(eq(agents.id, scope.agentId)) : [];
      if (me?.role !== "ceo") return fail("Only your company's CEO answers decisions.");
      if (input.action === "list") {
        const open = await db
          .select()
          .from(decisionsTable)
          .where(and(eq(decisionsTable.companyId, scope.companyId), eq(decisionsTable.status, "open"), eq(decisionsTable.tier, "ceo")))
          .orderBy(decisionsTable.createdAt);
        if (!open.length) return text("No decisions are waiting for you.");
        return text(
          open
            .map((d) => {
              const plan = (d.context as { planText?: string | null }).planText;
              return [`${d.id}: ${d.question}`, `Options: ${(d.options as string[]).join(" | ")} (recommended: ${d.recommendedOption ?? "none"})`, ...(plan ? ["Plan:", plan.slice(0, 8000)] : [])].join("\n");
            })
            .join("\n\n"),
        );
      }
      if (!input.id || !input.answer) return fail("Give the decision's id and your answer.");
      const [d] = await db.select().from(decisionsTable).where(and(eq(decisionsTable.id, input.id), eq(decisionsTable.companyId, scope.companyId)));
      if (!d || d.tier !== "ceo") return fail("No decision with that id is waiting for you.");
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
        "For CEOs: review a ticket in your company that's ready for review. action: diff (ticketId; shows the changes against the ticket's base), submit (ticketId, verdict approved or changes_requested, optional comments as {path, line, body} and a summary). You can't review a ticket assigned to you.",
      inputSchema: {
        action: z.enum(["diff", "submit"]),
        ticketId: z.string().uuid(),
        verdict: z.enum(["approved", "changes_requested"]).optional(),
        comments: z.array(z.object({ path: z.string(), line: z.number().int().positive(), body: z.string().min(1) })).max(50).optional(),
        summary: z.string().max(5000).optional(),
      },
    },
    async (input) => {
      const [me] = scope.agentId ? await db.select({ role: agents.role, name: agents.name }).from(agents).where(eq(agents.id, scope.agentId)) : [];
      if (me?.role !== "ceo") return fail("Only your company's CEO reviews tickets.");
      try {
        if (input.action === "diff") {
          const d = await review.diff(input.ticketId, scope.companyId);
          // Keep the agent's context in check: the file list always, the patch up to 60 KB.
          const files = d.files.map((f) => `${f.path} (+${f.added} -${f.removed})`).join("\n");
          const patch = d.diff.length > 60_000 ? `${d.diff.slice(0, 60_000)}\n[diff truncated]` : d.diff;
          return text(`Base ${d.baseCommit.slice(0, 12)}, ${d.commits.length} commit(s).\nFiles:\n${files || "(none)"}\n\n${patch}${d.truncated ? "\n[diff truncated by the runner]" : ""}`);
        }
        if (!input.verdict) return fail("Give the verdict.");
        const r = await review.submit(input.ticketId, {
          verdict: input.verdict,
          comments: input.comments,
          summary: input.summary,
          reviewer: `${me.name} (CEO)`,
          reviewerAgentId: scope.agentId,
          companyId: scope.companyId,
          causedByRunId: scope.runId,
        });
        if (r.verdict !== "approved") return text(`Changes requested; ${r.delivered}.`);
        const outcome = "outcome" in r ? r.outcome : "done";
        return text(
          outcome === "owner_review"
            ? `Approved. ${r.delivered}: the owner signs it off before it merges.`
            : outcome === "merged" || outcome === "done"
              ? "Approved; the ticket is done."
              : `Approved, but it couldn't merge yet (${outcome.replace(/_/g, " ")}); it's gone back to the assignee with what to fix.`,
        );
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

/**
 * Tools every run has, chat included (R69, R71, R77): the wiki, the skill library, and reading
 * the company's tickets, so an agent can look things up instead of saying it can't see them.
 */
function registerSharedTools(server: McpServer, db: Db, { notes, wiki, skills, review, agents: team }: Pick<Services, "notes" | "wiki" | "skills" | "review" | "agents">, scope: Scope) {
  server.registerTool(
    "tickets",
    {
      description:
        "Look up your company's tickets. find (optional q to search titles and descriptions, optional state) lists matches with their ids; read (ticketId) gives one ticket in full: description, state, assignee, its branch, what it produced (wiki pages, repo files, links) and its recent conversation; file (ticketId, path) reads a file from that ticket's work in the repo, such as a document it wrote, even if it was never merged.",
      inputSchema: { action: z.enum(["find", "read", "file"]), q: z.string().max(200).optional(), state: z.enum(STATES).optional(), ticketId: z.string().uuid().optional(), path: z.string().max(500).optional() },
    },
    async ({ action, q, state, ticketId, path }) => {
      if (action === "file") {
        if (!ticketId || !path) return fail("Give the ticketId and the file's path in the repo.");
        try {
          const f = await review.readFile(ticketId, path, scope.companyId);
          return text(`${path} (from the ticket's ${f.from === "worktree" ? "worktree" : "branch"}${f.truncated ? "; cut off at 256 KB" : ""}):\n\n${f.text}`);
        } catch (err) {
          if (err instanceof ReviewError) return fail(err.message);
          throw err;
        }
      }
      if (action === "find") {
        const like = q?.trim() ? `%${q.trim().replace(/[%_\\]/g, (c) => `\\${c}`)}%` : null;
        const rows = await db
          .select({ id: tickets.id, title: tickets.title, state: tickets.systemState, version: tickets.version, outcome: tickets.outcome, assignee: agents.name, lastActivityAt: tickets.lastActivityAt, stateNote: tickets.stateNote, stateNoteAt: tickets.stateNoteAt })
          .from(tickets)
          .leftJoin(agents, eq(agents.id, tickets.assigneeAgentId))
          .where(and(eq(tickets.companyId, scope.companyId), state ? eq(tickets.systemState, state) : undefined, like ? or(ilike(tickets.title, like), ilike(tickets.body, like)) : undefined))
          .orderBy(desc(tickets.lastActivityAt))
          .limit(40);
        return text(JSON.stringify(rows.map(withNote)));
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
      const t = row.t;
      const note = stateNoteLine(t, new Date());
      return text(
        [
          `# ${t.title}`,
          `Ticket ${t.id} in project "${row.project}". State: ${t.systemState}${t.outcome ? ` (${t.outcome})` : ""}. Version: ${t.version}. Assigned to: ${row.assignee ?? (t.assignedToOwner ? "the owner" : "nobody")}. Risk: ${t.risk ?? "medium"}.`,
          ...(note ? [note] : []),
          t.branch ? `Branch: ${t.branch}${row.repoUrl ? ` in ${row.repoUrl}` : ""}${t.mergeCommit ? `, merged as ${t.mergeCommit}` : ", not merged"}.` : "No branch yet.",
          "",
          "## Description",
          t.body ?? "(none)",
          "",
          "## What it produced",
          ...(made.length ? made.map((m) => (m.kind === "wiki_page" ? `- wiki page ${m.slug} (read it with wiki read)` : m.kind === "url" ? `- link ${m.url}` : `- repo file ${m.path}${m.ref ? ` at ${m.ref}` : ""} (read it with tickets file)`)) : ["(nothing attached)"]),
          "",
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
      description: `Hire a new agent for the company (CEO only). Start from a template (${AGENT_TEMPLATES.map((t) => `${t.id}: ${t.summary}`).join("; ")}), give it a name, and tailor its title and instructions to the company. Say why you're hiring. Unless the owner has said otherwise, the hire waits for their approval in Decisions. Use board to see who there is first.`,
      inputSchema: {
        name: z.string().trim().min(1).max(80),
        template: z.string().max(40).optional(),
        title: z.string().trim().max(80).optional(),
        instructions: z.string().trim().max(20_000).optional(),
        model: z.string().max(200).optional(),
        fundingSourceId: z.string().uuid().optional(),
        reason: z.string().trim().min(1).max(2000),
      },
    },
    async (input) => {
      const ceo = await ceoOnly();
      if (!ceo) return fail("Only your company's CEO can hire.");
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
    "update_instructions",
    {
      description: "Change an agent's standing instructions (CEO only): the whole new text, which replaces the old. Say why. The owner is told, and can undo it; if they've asked to approve such changes, it waits in Decisions.",
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
        "The company wiki: Markdown pages in nested folders, shared by the owner and agents. list (optional q to search; gives each page's slug and folder), read (slug), write (title, body, folder such as \"Research/Competitors\" to file it, optional slug to update a page — a different folder moves it — and optional ticketId when it's a ticket's output) and attach (link a repo file — path and branch or commit as ref — or a web url to a ticket as its output). Put documents you produce (research, specs, reports, how-tos) in the wiki with the ticket's id, so the owner can read them from the ticket. Writing to an existing slug updates it; older versions are kept.",
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
      },
    },
    async (input) => {
      const by = { agentId: scope.agentId, runId: scope.runId };
      try {
        switch (input.action) {
          case "list":
            return text(JSON.stringify((await wiki.list(scope.companyId, input.q)).map((p) => ({ slug: p.slug, folder: p.folder, title: p.title, updatedAt: p.updatedAt }))));
          case "read": {
            if (!input.slug) return fail("Give the page's slug.");
            const p = await wiki.get(scope.companyId, input.slug);
            return text(`# ${p.title}\n\n${p.body}`);
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

function registerBoard(server: Pick<McpServer, "registerTool">, db: Db, scope: Scope) {
  server.registerTool(
    "board",
    { description: "See the company's board: projects, objectives with their milestones, agents, and open tickets with their ids.", inputSchema: {} },
    async () => {
      const ps = await db.select({ id: projects.id, name: projects.name }).from(projects).where(eq(projects.companyId, scope.companyId)).orderBy(asc(projects.name));
      const os = await db.select({ id: objectives.id, title: objectives.title, priority: objectives.priority }).from(objectives).where(and(eq(objectives.companyId, scope.companyId), eq(objectives.status, "active")));
      const ms = os.length ? await db.select({ id: milestones.id, objectiveId: milestones.objectiveId, title: milestones.title, targetDate: milestones.targetDate }).from(milestones).where(inArray(milestones.objectiveId, os.map((o) => o.id))) : [];
      const as = await db.select({ id: agents.id, name: agents.name, role: agents.role }).from(agents).where(eq(agents.companyId, scope.companyId));
      const ts = await db
        .select({ id: tickets.id, title: tickets.title, state: tickets.systemState, projectId: tickets.projectId, milestoneId: tickets.milestoneId, assigneeAgentId: tickets.assigneeAgentId, risk: tickets.risk })
        .from(tickets)
        .where(and(eq(tickets.companyId, scope.companyId), ne(tickets.systemState, "done")))
        .orderBy(asc(tickets.createdAt))
        .limit(300);
      return text(JSON.stringify({ projects: ps, objectives: os.map((o) => ({ ...o, milestones: ms.filter((m) => m.objectiveId === o.id) })), agents: as, openTickets: ts }));
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
        .select({ id: tickets.id, title: tickets.title, state: tickets.systemState, version: tickets.version, due: tickets.dueDate, stateNote: tickets.stateNote, stateNoteAt: tickets.stateNoteAt, lastActivityAt: tickets.lastActivityAt })
        .from(tickets)
        .where(and(eq(tickets.assigneeAgentId, scope.agentId), ne(tickets.systemState, "done")));
      return text(JSON.stringify(rows.map(withNote)));
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
        if (name === "tickets" || name === "decisions") markSearched(runId);
        if (name !== "wiki" && input.action !== "file") remember(runId, JSON.stringify(r));
        return r;
      }) as never);
    }) as never,
  };
}

/** The PA's server: the read tools plus pa_reply and pa_escalate, and nothing that writes (R87). */
function buildPaServer(db: Db, { notes, wiki, skills, review, agents: team, pa }: Services, scope: Scope) {
  const server = new McpServer({ name: "bossman", version: "0.1.0" });
  const reads = readOnly(server, scope.runId);
  registerSharedTools(reads as McpServer, db, { notes, wiki, skills, review, agents: team }, scope);
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

/**
 * The owner chat's tools (v1.1): the board and nothing else. Tickets it makes are the owner's,
 * not an agent's, and go through the same checks as the board's own forms.
 */
function buildChatServer(db: Db, { work, feedback, notes, wiki, skills, review, agents: team }: Services, scope: Scope) {
  const server = new McpServer({ name: "bossman", version: "0.1.0" });
  registerSharedTools(server, db, { notes, wiki, skills, review, agents: team }, scope);
  const ownTicket = async (id: string) => (await db.select({ id: tickets.id }).from(tickets).where(and(eq(tickets.id, id), eq(tickets.companyId, scope.companyId))))[0] ?? null;
  const workFail = (err: unknown) => {
    if (err instanceof WorkError) return fail(err.message);
    throw err;
  };

  registerBoard(server, db, scope);

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
      },
    },
    async (input) => {
      const ps = await db.select({ id: projects.id, name: projects.name }).from(projects).where(eq(projects.companyId, scope.companyId));
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
        const t = await work.createTicket(p.id, { title: input.title, body: input.body ?? null, risk: input.risk, planFirst: input.planFirst, milestoneId: input.milestoneId, assigneeAgentId, featureId: input.featureId });
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
    const server = me?.duty === "assistant" ? buildPaServer(db, services, scope) : run?.purpose === "chat" ? buildChatServer(db, services, scope) : buildServer(db, services, scope, hooks);
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
