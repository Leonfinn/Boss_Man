// Boss Man's MCP server: the one way agents act on Boss Man (R11). Every call carries a
// per-run bearer token that pins it to one company and agent, so an agent can only see and
// change its own company's work. The tool set is kept small (R36); descriptions say when
// to use each tool so Claude Code's tool search finds them.
import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { and, eq, gt, ne, sql } from "drizzle-orm";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { RISK_TIERS } from "@boss-man/shared";
import { hashToken } from "./auth.js";
import type { Db } from "./db/client.js";
import { agents, companies, decisions as decisionsTable, keyResults, objectives, projects, runTokens, tickets } from "./db/schema.js";
import { AnswerError, type decisionsService } from "./services/decisions.js";
import { EngagementError, type EngagementAction, type engagementsService } from "./services/engagements.js";
import { DeployError, type deploysService } from "./services/deploys.js";
import { RunError, type runsService } from "./services/runs.js";
import { ReviewError, type reviewService } from "./services/review.js";

type Scope = { companyId: string; agentId: string | null; runId: string };

export async function issueRunToken(db: Db, scope: Scope, ttlHours = 12): Promise<string> {
  const token = `bm_run_${randomBytes(32).toString("base64url")}`;
  await db.insert(runTokens).values({ tokenHash: hashToken(token), runId: scope.runId, companyId: scope.companyId, agentId: scope.agentId, expiresAt: new Date(Date.now() + ttlHours * 3_600_000) });
  return token;
}

const STATES = ["backlog", "ready", "in_progress", "blocked", "review", "done"] as const;
const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
const fail = (t: string) => ({ content: [{ type: "text" as const, text: t }], isError: true });

export type McpHooks = { onTicketDone?: (ticketId: string, causedByRunId: string) => Promise<unknown> };

type Services = { decisions: ReturnType<typeof decisionsService>; engagements: ReturnType<typeof engagementsService>; deploys: ReturnType<typeof deploysService>; runs: ReturnType<typeof runsService>; review: ReturnType<typeof reviewService> };

function buildServer(db: Db, { decisions, engagements, deploys, runs, review }: Services, scope: Scope, hooks: McpHooks) {
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
        "Create a ticket in your company's backlog. Use it to record work you or your team should do. Give the project by name when your company has more than one. Pass engagementId when the ticket does work another company engaged you for. Rate its risk: trivial, low, medium (the default), high or critical; high and critical work is reviewed by the owner, gets the project's deeper check and goes to staging before production. Set planFirst for work that should be planned and approved before anything changes.",
      inputSchema: {
        title: z.string().min(1).max(200),
        body: z.string().max(10_000).optional(),
        project: z.string().optional(),
        engagementId: z.string().uuid().optional(),
        risk: z.enum(RISK_TIERS).optional(),
        planFirst: z.boolean().optional(),
      },
    },
    async ({ title, body, project, engagementId, risk, planFirst }) => {
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
        .values({ companyId: scope.companyId, projectId: p.id, title, body, engagementId: engagementId ?? null, createdByAgentId: scope.agentId, risk: risk ?? null, planFirst: planFirst ?? false })
        .returning({ id: tickets.id });
      return text(`Created ticket ${t!.id} in ${p.name}.`);
    },
  );

  server.registerTool(
    "set_ticket_state",
    {
      description: "Move one of your company's tickets to a new state. Call it with state \"review\" when your work is ready to check, or \"done\" when it is finished; ending your turn does not move the ticket.",
      inputSchema: { ticketId: z.string().uuid(), state: z.enum(STATES), outcome: z.enum(["completed", "cancelled"]).optional() },
    },
    async ({ ticketId, state, outcome }) => {
      // In a project with a repo, a ticket is done when its branch is merged after review (R46, R47).
      if (state === "done") {
        const [t] = await db
          .select({ repoUrl: projects.repoUrl })
          .from(tickets)
          .innerJoin(projects, eq(projects.id, tickets.projectId))
          .where(and(eq(tickets.id, ticketId), eq(tickets.companyId, scope.companyId)));
        if (t?.repoUrl && outcome !== "cancelled") return fail('This project has a repo: move the ticket to "review" instead. It becomes done when its branch is approved, checked and merged.');
      }
      const rows = await db
        .update(tickets)
        .set({ systemState: state, outcome: state === "done" ? (outcome ?? "completed") : null, lastActivityAt: new Date() })
        .where(and(eq(tickets.id, ticketId), eq(tickets.companyId, scope.companyId)))
        .returning({ id: tickets.id });
      if (!rows.length) return fail("No ticket with that ID in your company.");
      // Work that waited on this ticket can start; the wake carries this run's chain depth.
      if (state === "done") await hooks.onTicketDone?.(ticketId, scope.runId);
      return text(`Ticket ${ticketId} is now ${state}.`);
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

  server.registerTool(
    "list_my_work",
    { description: "List the open tickets assigned to you.", inputSchema: {} },
    async () => {
      if (!scope.agentId) return text("[]");
      const rows = await db
        .select({ id: tickets.id, title: tickets.title, state: tickets.systemState, due: tickets.dueDate })
        .from(tickets)
        .where(and(eq(tickets.assigneeAgentId, scope.agentId), ne(tickets.systemState, "done")));
      return text(JSON.stringify(rows));
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

    // Stateless: a fresh server and transport per request.
    const server = buildServer(db, services, scope, hooks);
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
