import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import cookie from "@fastify/cookie";
import websocket from "@fastify/websocket";
import { and, count, eq, gt, inArray } from "drizzle-orm";
import { z, ZodError } from "zod";
import { SECRET_KINDS, SYSTEM_STATES, findCredential, usdToMicros } from "@boss-man/shared";
import { hashPassword, hashToken, newSessionToken, SESSION_COOKIE, SESSION_DAYS, verifyPassword } from "./auth.js";
import type { MasterKey } from "./crypto.js";
import type { Db } from "./db/client.js";
import { agents, companies, engagements, owners, projects, runs as runsTable, sessions, tickets, wakes } from "./db/schema.js";
import { fundingService } from "./services/funding.js";
import { runnersService } from "./services/runners.js";
import { AnswerError, decisionsService } from "./services/decisions.js";
import { sweepService, type SweepLimits } from "./services/sweeps.js";
import { EngagementError, engagementsService } from "./services/engagements.js";
import { DeployError, deploysService } from "./services/deploys.js";
import { RunError, runsService } from "./services/runs.js";
import { recoveryService } from "./services/recovery.js";
import { ReviewError, reviewService } from "./services/review.js";
import { loopGuards, type LoopLimits } from "./services/loop-guards.js";
import { workService, WorkError } from "./services/work.js";
import { schedulerService, type Limits } from "./services/scheduler.js";
import { mcpRoutes } from "./mcp.js";
import { SecretRejected, secretsService, type LiveValidator } from "./services/secrets.js";
import { runnerSocketRoutes } from "./routes/runner-socket.js";

export type AppOptions = {
  db: Db;
  master: MasterKey;
  liveValidator?: LiveValidator;
  /** Mark cookies Secure. Turn off only for plain-HTTP local development. */
  secureCookies?: boolean;
  logger?: boolean;
  /** Runner heartbeat interval; tests shorten it. */
  heartbeatMs?: number;
  /** Launch-safety limits (R30); defaults in DEFAULT_LIMITS. */
  limits?: Partial<Limits>;
  /** Where runners put each ticket's workspace. */
  workspaceRoot?: string;
  /** Stale-blocker and stalled-run thresholds (R21, R32). */
  sweepLimits?: Partial<SweepLimits>;
  /** Review-loop and circular-failure limits (R49, R50). */
  loopLimits?: Partial<LoopLimits>;
  /** Clock for scheduling, sweeps and ranking; tests move it forward. */
  now?: () => Date;
};

const Credentials = z.object({ username: z.string().trim().min(1).max(64), password: z.string().min(12).max(256) });
const Uuid = z.string().uuid();
const IdParam = z.object({ id: Uuid });

/** Unique-violation detection across node-postgres and PGlite, including Drizzle's wrapper. */
function pgCode(err: unknown): string | undefined {
  let e: unknown = err;
  for (let i = 0; i < 3 && e; i++) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === "string") return code;
    e = (e as { cause?: unknown }).cause;
  }
  return undefined;
}

const NIL_UUID = "00000000-0000-0000-0000-000000000000";

export async function buildApp(opts: AppOptions) {
  const { db, master } = opts;
  const app = Fastify({ logger: opts.logger ?? false });
  await app.register(cookie);
  await app.register(websocket);

  const secretsSvc = secretsService(db, master, opts.liveValidator);
  const funding = fundingService(db);
  const runners = runnersService(db, funding);
  await runnerSocketRoutes(app, runners, secretsSvc, { heartbeatMs: opts.heartbeatMs });
  const decisionsSvc = decisionsService(db, (runnerId, command) => runners.send(runnerId, command), opts.now);
  runners.setPermissionHook((runner, event) => decisionsSvc.onPermissionRequest(runner, event));
  const deploysSvc = deploysService(db, { now: opts.now });
  const scheduler = schedulerService(db, {
    runners,
    funding,
    deploys: deploysSvc,
    limits: opts.limits,
    workspaceRoot: opts.workspaceRoot,
    now: opts.now,
    // Loop and runaway alerts land in the owner's decision queue.
    alert: (companyId, question) => decisionsSvc.raise({ companyId, agentId: null, question, options: ["Got it"], recommended: "Got it" }),
  });
  decisionsSvc.setWakeHook((w) => scheduler.wake(w));
  const engagementsSvc = engagementsService(db, { release: (ticketId) => decisionsSvc.release(ticketId), now: opts.now });
  engagementsSvc.setWakeHook((w) => scheduler.wake(w));
  decisionsSvc.setEngagementHook((id, approved) => engagementsSvc.approve(id, approved));
  deploysSvc.setWakeHook((w) => scheduler.wake(w));
  const runsSvc = runsService(db, { runners });
  runsSvc.setWakeHook((w) => scheduler.wake(w));
  const recovery = recoveryService(db);
  recovery.setWakeHook((w) => scheduler.wake(w));
  // A runner that comes back gets any permission verdicts it missed (R22).
  runners.onConnect((runnerId) => decisionsSvc.redeliver(runnerId));
  decisionsSvc.setDeployHook((id, approved) => deploysSvc.approve(id, approved));
  runners.onEvent((_runner, event) => {
    if (event.type === "run.ended") {
      // A deploy whose run ended without a report is failed, which also ends its secrets.
      // An interrupted run gets a recovery run (R42).
      void deploysSvc
        .onRunEnded(event.runId)
        .then(() => (event.interrupted ? recovery.onInterrupted(event.runId) : null))
        .then(async () => {
          // The same run error again and again means the agent is going round in circles (R50).
          if (!event.error || event.interrupted) return;
          const [run] = await db.select().from(runsTable).where(eq(runsTable.id, event.runId));
          if (run) await loops.failure({ companyId: run.companyId, ticketId: run.ticketId, agentId: run.agentId, text: event.error, what: "An agent run" });
        })
        .then(() => scheduler.tick())
        .catch((err) => app.log.error({ err }, "run-ended handling failed"));
    }
  });
  const sweeps = sweepService(db, { limits: opts.sweepLimits, now: opts.now });
  const work = workService(db, {
    onAssigned: (t) => scheduler.wake({ agentId: t.assigneeAgentId!, ticketId: t.id, reason: "assigned" }),
    onDone: (t) => scheduler.onTicketDone(t.id),
  });
  const loops = loopGuards(db, { limits: opts.loopLimits, now: opts.now });
  const review = reviewService(db, { runners, runs: runsSvc, work, loops });
  review.setWakeHook((w) => scheduler.wake(w));
  decisionsSvc.setLoopHooks({
    sendBack: (ticketId, text, reviewer) => review.sendBack(ticketId, text, reviewer),
    stopTicket: async (ticketId) => {
      await db.update(wakes).set({ status: "dropped", statusReason: "work stopped by the owner" }).where(and(eq(wakes.ticketId, ticketId), inArray(wakes.status, ["queued", "deferred"])));
      await work.updateTicket(ticketId, { state: "done", outcome: "cancelled", overLimit: true });
    },
    raiseCap: async (ticketId) => {
      const [t] = await db.select({ cap: tickets.costCapMicros, projectCap: projects.ticketCostCapMicros }).from(tickets).innerJoin(projects, eq(projects.id, tickets.projectId)).where(eq(tickets.id, ticketId));
      const cap = t?.cap ?? t?.projectCap;
      if (cap) await db.update(tickets).set({ costCapMicros: Math.ceil(cap * 1.5) }).where(eq(tickets.id, ticketId));
      // Waiting work for the ticket can go again.
      await db.update(wakes).set({ status: "queued", statusReason: null, notBefore: null }).where(and(eq(wakes.ticketId, ticketId), eq(wakes.status, "deferred")));
    },
  });
  await mcpRoutes(app, db, { decisions: decisionsSvc, engagements: engagementsSvc, deploys: deploysSvc, runs: runsSvc, review }, { onTicketDone: (ticketId, runId) => scheduler.onTicketDone(ticketId, runId) });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ZodError) return reply.code(400).send({ error: "invalid_request", issues: err.issues });
    if (err instanceof SecretRejected) return reply.code(422).send({ error: "secret_rejected", problems: err.problems });
    if (err instanceof WorkError) return reply.code(err.status).send({ error: "rejected", message: err.message });
    const code = pgCode(err);
    if (code === "23505") return reply.code(409).send({ error: "already_exists" });
    if (code === "23503") return reply.code(422).send({ error: "unknown_reference" });
    if (code === "23514") return reply.code(422).send({ error: "constraint_violated" });
    if ((err as { statusCode?: number }).statusCode && (err as { statusCode: number }).statusCode < 500) return reply.send(err);
    app.log.error(err);
    return reply.code(500).send({ error: "internal_error" });
  });

  async function startSession(reply: FastifyReply, ownerId: string) {
    const token = newSessionToken();
    const expiresAt = new Date(Date.now() + SESSION_DAYS * 86_400_000);
    await db.insert(sessions).values({ tokenHash: hashToken(token), ownerId, expiresAt });
    reply.setCookie(SESSION_COOKIE, token, {
      path: "/",
      httpOnly: true,
      sameSite: "strict",
      secure: opts.secureCookies ?? true,
      expires: expiresAt,
    });
  }

  async function requireOwner(req: FastifyRequest, reply: FastifyReply) {
    const token = req.cookies[SESSION_COOKIE];
    if (token) {
      const [s] = await db
        .select({ ownerId: sessions.ownerId })
        .from(sessions)
        .where(and(eq(sessions.tokenHash, hashToken(token)), gt(sessions.expiresAt, new Date())));
      if (s) return;
    }
    return reply.code(401).send({ error: "not_signed_in" });
  }

  // ---------- Public ----------

  app.get("/api/health", async () => ({ ok: true }));

  app.get("/api/setup", async () => {
    const [row] = await db.select({ n: count() }).from(owners);
    return { needsSetup: (row?.n ?? 0) === 0 };
  });

  /** First run only: create the single owner account. */
  app.post("/api/setup", async (req, reply) => {
    const body = Credentials.parse(req.body);
    const [row] = await db.select({ n: count() }).from(owners);
    if ((row?.n ?? 0) > 0) return reply.code(409).send({ error: "already_set_up" });
    const [owner] = await db.insert(owners).values({ username: body.username, passwordHash: await hashPassword(body.password) }).returning();
    await startSession(reply, owner!.id);
    return reply.code(201).send({ username: owner!.username });
  });

  app.post("/api/login", async (req, reply) => {
    const body = Credentials.parse(req.body);
    const [owner] = await db.select().from(owners).where(eq(owners.username, body.username));
    if (!owner || !(await verifyPassword(body.password, owner.passwordHash))) {
      return reply.code(401).send({ error: "wrong_username_or_password" });
    }
    await startSession(reply, owner.id);
    return { username: owner.username };
  });

  app.post("/api/logout", async (req, reply) => {
    const token = req.cookies[SESSION_COOKIE];
    if (token) await db.delete(sessions).where(eq(sessions.tokenHash, hashToken(token)));
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return { ok: true };
  });

  // ---------- Owner only ----------

  await app.register(async (owner) => {
    owner.addHook("preHandler", requireOwner);

    owner.get("/api/me", async () => {
      const [o] = await db.select({ username: owners.username }).from(owners);
      return o;
    });

    // Companies: creating one always creates its CEO (R18).
    const CompanyInput = z.object({
      name: z.string().trim().min(1).max(80),
      mission: z.string().max(2000).optional(),
      ceo: z.object({ name: z.string().trim().min(1).max(80).default("CEO"), agentKind: z.string().min(1).default("claude"), model: z.string().optional() }).default({ name: "CEO", agentKind: "claude" }),
    });

    owner.post("/api/companies", async (req, reply) => {
      const body = CompanyInput.parse(req.body);
      const result = await db.transaction(async (tx) => {
        const [company] = await tx.insert(companies).values({ name: body.name, mission: body.mission }).returning();
        const [ceo] = await tx
          .insert(agents)
          .values({ companyId: company!.id, name: body.ceo.name, role: "ceo", agentKind: body.ceo.agentKind, model: body.ceo.model })
          .returning();
        return { company: company!, ceo: ceo! };
      });
      return reply.code(201).send(result);
    });

    owner.patch("/api/companies/:id", async (req, reply) => {
      const { id } = IdParam.parse(req.params);
      const b = z.object({ name: z.string().trim().min(1).max(80), mission: z.string().max(2000).nullable(), ownerApprovesEngagements: z.boolean() }).partial().parse(req.body);
      const [c] = await db.update(companies).set(b).where(eq(companies.id, id)).returning();
      return c ?? reply.code(404).send({ error: "not_found" });
    });

    owner.get("/api/companies", async () => {
      const rows = await db.select().from(companies).orderBy(companies.name);
      const allAgents = await db.select().from(agents);
      return rows.map((c) => ({ ...c, agents: allAgents.filter((a) => a.companyId === c.id) }));
    });

    // Secrets: values go in, never come out over the API.
    const SecretInput = z.object({
      name: z.string().trim().min(1).max(80),
      kind: z.enum(SECRET_KINDS),
      value: z.string().min(1).max(20_000),
      acceptUnusualFormat: z.boolean().optional(),
      verify: z.boolean().optional(),
    });

    owner.get("/api/secrets", async () => secretsSvc.list());

    owner.post("/api/secrets", async (req, reply) => {
      const result = await secretsSvc.create(SecretInput.parse(req.body));
      return reply.code(201).send(result);
    });

    owner.put("/api/secrets/:id/value", async (req, reply) => {
      const { id } = IdParam.parse(req.params);
      const body = SecretInput.pick({ value: true, acceptUnusualFormat: true, verify: true }).parse(req.body);
      const result = await secretsSvc.rotate(id, body.value, body);
      return result ?? reply.code(404).send({ error: "not_found" });
    });

    owner.delete("/api/secrets/:id", async (req, reply) => {
      const { id } = IdParam.parse(req.params);
      return (await secretsSvc.remove(id)) ? reply.code(204).send() : reply.code(404).send({ error: "not_found" });
    });

    const GrantInput = z.object({
      companyId: Uuid,
      envName: z.string().regex(/^[A-Z_][A-Z0-9_]*$/, "Use an environment variable name like CLAUDE_CODE_OAUTH_TOKEN"),
      /** Only runs carrying out an approved deploy to this target get the secret. */
      deployTargetId: Uuid.optional(),
    });

    owner.post("/api/secrets/:id/grants", async (req, reply) => {
      const { id } = IdParam.parse(req.params);
      const body = GrantInput.parse(req.body);
      try {
        return reply.code(201).send(await secretsSvc.grant(id, body.companyId, body.envName, body.deployTargetId));
      } catch (err) {
        if ((err as Error).message.startsWith("That deploy target")) return reply.code(422).send({ error: "invalid_target", message: (err as Error).message });
        throw err;
      }
    });

    owner.delete("/api/grants/:id", async (req, reply) => {
      const { id } = IdParam.parse(req.params);
      return (await secretsSvc.revoke(id)) ? reply.code(204).send() : reply.code(404).send({ error: "not_found" });
    });

    /** Issues the company's runner token. It is shown once; issuing again replaces it. */
    owner.post("/api/companies/:id/runner", async (req, reply) => {
      const { id } = IdParam.parse(req.params);
      return reply.code(201).send(await runners.register(id));
    });

    owner.get("/api/companies/:id/grants", async (req) => {
      const { id } = IdParam.parse(req.params);
      return secretsSvc.grantsForCompany(id);
    });

    // Funding sources, cost and quota (R27–R29).
    const FundingInput = z.object({
      name: z.string().trim().min(1).max(80),
      kind: z.enum(["api_credit", "subscription", "usage_credits", "api_payg"]),
      provider: z.enum(["anthropic", "openai"]),
      monthlyGrantUsd: z.number().nonnegative().optional(),
      cycleAnchor: z.coerce.date().optional(),
      secretId: Uuid.optional(),
    });

    owner.post("/api/funding-sources", async (req, reply) => {
      const b = FundingInput.parse(req.body);
      const row = await funding.create({
        name: b.name,
        kind: b.kind,
        provider: b.provider,
        monthlyGrantMicros: b.monthlyGrantUsd != null ? usdToMicros(b.monthlyGrantUsd) : null,
        cycleAnchor: b.cycleAnchor ?? null,
        secretId: b.secretId ?? null,
      });
      return reply.code(201).send(row);
    });

    owner.get("/api/funding-sources", async () => funding.list());

    owner.get("/api/funding-sources/:id/status", async (req, reply) => {
      const { id } = IdParam.parse(req.params);
      return (await funding.status(id)) ?? reply.code(404).send({ error: "not_found" });
    });

    // Runners will post these; until the runner protocol lands the owner session is required.
    const CostInput = z.object({
      fundingSourceId: Uuid,
      companyId: Uuid,
      projectId: Uuid.optional(),
      agentId: Uuid.optional(),
      runId: Uuid.optional(),
      engagementId: Uuid.optional(),
      chargedCompanyId: Uuid.optional(),
      chargedProjectId: Uuid.optional(),
      model: z.string().optional(),
      costUsd: z.number().nonnegative(),
      basis: z.enum(["list_estimate", "billed"]).default("list_estimate"),
      inputTokens: z.number().int().nonnegative().optional(),
      outputTokens: z.number().int().nonnegative().optional(),
      occurredAt: z.coerce.date().optional(),
    });

    owner.post("/api/cost-events", async (req, reply) => {
      const { costUsd, ...rest } = CostInput.parse(req.body);
      return reply.code(201).send(await funding.recordCost({ ...rest, costMicros: usdToMicros(costUsd) }));
    });

    const QuotaInput = z.object({ fundingSourceId: Uuid, claudeMeta: z.unknown().optional(), codexRateLimits: z.unknown().optional() });

    owner.post("/api/quota-samples", async (req, reply) => {
      const b = QuotaInput.parse(req.body);
      const rows = await funding.recordQuotaFromAdapter(b.fundingSourceId, b);
      return reply.code(201).send(rows);
    });

    const PolicyInput = z.object({
      scopeKind: z.enum(["company", "project", "agent", "instance"]),
      /** Not needed for an instance-wide cap (R53). */
      scopeId: Uuid.optional(),
      fundingSourceId: Uuid.optional(),
      windowKind: z.enum(["lifetime", "calendar_month", "billing_cycle", "rolling_days"]),
      rollingDays: z.number().int().positive().optional(),
      limitUsd: z.number().nonnegative(),
      onLimit: z.enum(["ask", "pause"]),
      warnAt: z.number().gt(0).lte(1).optional(),
    });

    owner.post("/api/budget-policies", async (req, reply) => {
      const { limitUsd, scopeId, ...rest } = PolicyInput.parse(req.body);
      if (rest.scopeKind !== "instance" && !scopeId) return reply.code(400).send({ error: "scope_id_required" });
      return reply.code(201).send(await funding.createPolicy({ ...rest, scopeId: rest.scopeKind === "instance" ? NIL_UUID : scopeId!, limitMicros: usdToMicros(limitUsd) }));
    });

    owner.get("/api/budgets", async () => funding.budgetStatuses());

    // Work: projects, boards, tickets, dependencies, objectives (R16–R18, R25).
    const State = z.enum(SYSTEM_STATES);
    const Column = z.object({ name: z.string().trim().min(1).max(60), systemState: State, wipLimit: z.number().int().positive().nullable().optional() });
    const DateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");
    const TicketFields = z.object({
      title: z.string().trim().min(1).max(200),
      body: z.string().max(20_000).nullable(),
      columnId: Uuid,
      state: State,
      outcome: z.enum(["completed", "cancelled"]),
      assigneeAgentId: Uuid.nullable(),
      assignedToOwner: z.boolean(),
      milestoneId: Uuid.nullable(),
      keyResultId: Uuid.nullable(),
      dueDate: DateStr.nullable(),
      customFields: z.record(z.string(), z.unknown()),
      overLimit: z.boolean(),
    });

    owner.post("/api/companies/:id/projects", async (req, reply) => {
      const { id } = IdParam.parse(req.params);
      const body = z.object({ name: z.string().trim().min(1).max(80), columns: z.array(Column).optional() }).parse(req.body);
      return reply.code(201).send(await work.createProject(id, body.name, body.columns));
    });

    owner.patch("/api/projects/:id", async (req, reply) => {
      const { id } = IdParam.parse(req.params);
      const b = z
        .object({
          name: z.string().trim().min(1).max(80),
          repoUrl: z
            .string()
            .trim()
            .max(500)
            .refine((u) => /^(https:\/\/|ssh:\/\/|git@|file:\/\/|\/)/.test(u), "Give an https://, ssh://, git@ or local path address.")
            .refine((u) => !findCredential(u), "The address looks like it contains a credential. Grant a GIT_TOKEN secret to the company instead.")
            .nullable(),
          defaultBranch: z.string().trim().min(1).max(200),
          verifyCommand: z.string().trim().min(1).max(1000).nullable(),
          ticketCostCapUsd: z.number().positive().nullable(),
        })
        .partial()
        .parse(req.body);
      const { ticketCostCapUsd, ...fields } = b;
      const [p] = await db
        .update(projects)
        .set({ ...fields, ...(ticketCostCapUsd !== undefined ? { ticketCostCapMicros: ticketCostCapUsd === null ? null : usdToMicros(ticketCostCapUsd) } : {}) })
        .where(eq(projects.id, id))
        .returning();
      return p ?? reply.code(404).send({ error: "not_found" });
    });

    owner.put("/api/projects/:id/columns", async (req) => {
      const { id } = IdParam.parse(req.params);
      return work.setColumns(id, z.array(Column).parse(req.body));
    });

    owner.get("/api/projects/:id/board", async (req) => work.board(IdParam.parse(req.params).id));

    owner.post("/api/projects/:id/tickets", async (req, reply) => {
      const { id } = IdParam.parse(req.params);
      const body = TicketFields.partial().required({ title: true }).parse(req.body);
      return reply.code(201).send(await work.createTicket(id, body));
    });

    owner.patch("/api/tickets/:id", async (req) => {
      const { id } = IdParam.parse(req.params);
      const { costCapUsd, ...fields } = TicketFields.extend({ costCapUsd: z.number().positive().nullable() }).partial().parse(req.body);
      // A per-ticket spend ceiling across all its runs (R53); null falls back to the project's default.
      if (costCapUsd !== undefined) await db.update(tickets).set({ costCapMicros: costCapUsd === null ? null : usdToMicros(costCapUsd) }).where(eq(tickets.id, id));
      return work.updateTicket(id, fields);
    });

    owner.post("/api/tickets/:id/dependencies", async (req, reply) => {
      const { id } = IdParam.parse(req.params);
      const body = z.object({ ticketId: Uuid.optional(), engagementId: Uuid.optional() }).parse(req.body);
      return reply.code(201).send(await work.addDependency(id, body));
    });

    owner.post("/api/companies/:id/objectives", async (req, reply) => {
      const { id } = IdParam.parse(req.params);
      const body = z.object({ title: z.string().trim().min(1).max(200), priority: z.number().int().min(1).max(5).optional(), projectId: Uuid.optional() }).parse(req.body);
      return reply.code(201).send(await work.createObjective(id, body));
    });

    owner.post("/api/objectives/:id/key-results", async (req, reply) => {
      const { id } = IdParam.parse(req.params);
      const body = z.object({ title: z.string().trim().min(1).max(200), target: z.number().optional(), current: z.number().optional(), unit: z.string().max(20).optional(), method: z.enum(["manual", "agent", "check"]).optional() }).parse(req.body);
      return reply.code(201).send(await work.addKeyResult(id, body));
    });

    owner.post("/api/objectives/:id/milestones", async (req, reply) => {
      const { id } = IdParam.parse(req.params);
      const body = z.object({ title: z.string().trim().min(1).max(200), targetDate: DateStr.optional() }).parse(req.body);
      return reply.code(201).send(await work.addMilestone(id, body));
    });

    owner.get("/api/companies/:id/objectives", async (req) => work.objectivesTree(IdParam.parse(req.params).id));

    // Agents: hire, and change model or funding source.
    owner.post("/api/companies/:id/agents", async (req, reply) => {
      const { id } = IdParam.parse(req.params);
      const b = z.object({ name: z.string().trim().min(1).max(80), role: z.enum(["manager", "worker"]).default("worker"), agentKind: z.string().min(1).default("claude"), model: z.string().optional(), fundingSourceId: Uuid.optional(), reportsTo: Uuid.optional() }).parse(req.body);
      const [a] = await db.insert(agents).values({ companyId: id, ...b }).returning();
      return reply.code(201).send(a);
    });

    owner.patch("/api/agents/:id", async (req, reply) => {
      const { id } = IdParam.parse(req.params);
      const b = z.object({ name: z.string().trim().min(1).max(80), model: z.string().nullable(), fundingSourceId: Uuid.nullable(), agentKind: z.string().min(1) }).partial().parse(req.body);
      const [a] = await db.update(agents).set(b).where(eq(agents.id, id)).returning();
      return a ?? reply.code(404).send({ error: "not_found" });
    });

    // Scheduling and kill switches (R30).
    owner.post("/api/agents/:id/wake", async (req, reply) => {
      const { id } = IdParam.parse(req.params);
      const b = z.object({ ticketId: Uuid.optional(), note: z.string().max(5000).optional(), priority: z.number().int().min(1).max(5).optional() }).parse(req.body ?? {});
      return reply.code(201).send(await scheduler.wake({ agentId: id, reason: "woken by owner", ...b }));
    });
    owner.get("/api/scheduler/queue", async () => scheduler.queue());
    owner.post("/api/scheduler/tick", async () => scheduler.tick());
    owner.post("/api/kill-switch", async (req) => {
      const { paused } = z.object({ paused: z.boolean() }).parse(req.body);
      await scheduler.setGlobalPause(paused);
      return { paused };
    });
    owner.post("/api/companies/:id/pause", async (req) => {
      const { id } = IdParam.parse(req.params);
      const { paused } = z.object({ paused: z.boolean() }).parse(req.body);
      await scheduler.setCompanyPause(id, paused);
      return { paused };
    });

    // The decision queue (R20), ranked, with what each row holds up.
    owner.get("/api/decisions", async () => decisionsSvc.queue());

    owner.post("/api/decisions/:id/answer", async (req, reply) => {
      const { id } = IdParam.parse(req.params);
      const { answer, assigneeAgentId } = z.object({ answer: z.string().min(1), assigneeAgentId: Uuid.optional() }).parse(req.body);
      try {
        const result = await decisionsSvc.answer(id, answer, { assigneeAgentId });
        return result ?? reply.code(404).send({ error: "not_open" });
      } catch (err) {
        if (err instanceof AnswerError) return reply.code(422).send({ error: "invalid_answer", message: err.message });
        throw err;
      }
    });

    // Engagements (R23–R26). The owner can act for either side.
    const Terms = {
      scope: z.string().min(1).max(5000),
      deliverables: z.string().max(2000).optional(),
      acceptanceCriteria: z.array(z.string().min(1)).min(1).max(10),
      budgetCapUsd: z.number().positive().optional(),
    };
    const engagementErrors = (reply: import("fastify").FastifyReply) => (err: unknown) => {
      if (err instanceof EngagementError) return reply.code(err.status).send({ error: "engagement", message: err.message });
      throw err;
    };
    owner.get("/api/engagements", async () => engagementsSvc.list());
    owner.get("/api/engagements/:id", async (req, reply) => engagementsSvc.view(IdParam.parse(req.params).id).catch(engagementErrors(reply)));
    owner.post("/api/engagements", async (req, reply) => {
      const b = z
        .object({ requesterCompanyId: Uuid, providerCompanyId: Uuid, requesterProjectId: Uuid.optional(), title: z.string().trim().min(1).max(200), ...Terms })
        .parse(req.body);
      return engagementsSvc
        .request({ companyId: b.requesterCompanyId, agentId: null }, b)
        .then((e) => reply.code(201).send(e))
        .catch(engagementErrors(reply));
    });
    owner.post("/api/engagements/:id/actions", async (req, reply) => {
      const { id } = IdParam.parse(req.params);
      const Msg = z.string().min(1).max(5000);
      const b = z
        .object({ as: z.enum(["requester", "provider"]) })
        .and(
          z.discriminatedUnion("action", [
            z.object({ action: z.literal("accept") }),
            z.object({ action: z.literal("reject"), message: Msg.optional() }),
            z.object({ action: z.literal("counter"), message: Msg, ...z.object(Terms).partial().shape }),
            z.object({ action: z.literal("accept_counter") }),
            z.object({ action: z.literal("withdraw"), message: Msg.optional() }),
            z.object({ action: z.literal("message"), message: Msg }),
            z.object({ action: z.literal("deliver"), summary: Msg, refs: z.array(z.string().max(500)).max(20).optional() }),
            z.object({ action: z.literal("sign_off"), message: Msg.optional() }),
            z.object({ action: z.literal("request_revision"), message: Msg }),
          ]),
        )
        .parse(req.body);
      const [e] = await db.select().from(engagements).where(eq(engagements.id, id));
      if (!e) return reply.code(404).send({ error: "not_found" });
      const { as, ...action } = b;
      return engagementsSvc.act(id, { companyId: as === "requester" ? e.requesterCompanyId : e.providerCompanyId, agentId: null }, action).catch(engagementErrors(reply));
    });

    // Deploy targets and deploys (R14, R15).
    const TargetInput = z.object({
      name: z.string().trim().min(1).max(80),
      kind: z.enum(["ssh", "docker", "git"]),
      endpoint: z.string().trim().min(1).max(500),
      isProduction: z.boolean().optional(),
      requiresApproval: z.boolean().optional(),
    });
    const deployErrors = (reply: import("fastify").FastifyReply) => (err: unknown) => {
      if (err instanceof DeployError) return reply.code(err.status).send({ error: "deploy", message: err.message });
      throw err;
    };
    owner.get("/api/companies/:id/deploy-targets", async (req) => deploysSvc.listTargets(IdParam.parse(req.params).id));
    owner.post("/api/companies/:id/deploy-targets", async (req, reply) => {
      const { id } = IdParam.parse(req.params);
      return deploysSvc
        .createTarget(id, TargetInput.parse(req.body))
        .then((t) => reply.code(201).send(t))
        .catch(deployErrors(reply));
    });
    owner.patch("/api/deploy-targets/:id", async (req, reply) =>
      deploysSvc.updateTarget(IdParam.parse(req.params).id, TargetInput.partial().parse(req.body)).catch(deployErrors(reply)),
    );
    owner.delete("/api/deploy-targets/:id", async (req, reply) => ((await deploysSvc.deleteTarget(IdParam.parse(req.params).id)) ? reply.code(204).send() : reply.code(404).send({ error: "not_found" })));
    owner.get("/api/deploys", async (req) => deploysSvc.list(z.object({ companyId: Uuid.optional() }).parse(req.query).companyId));

    // Review (R39): diffs, line comments back to the agent, and commit / PR prompts.
    const reviewErrors = (reply: import("fastify").FastifyReply) => (err: unknown) => {
      if (err instanceof ReviewError) return reply.code(err.status).send({ error: "review", message: err.message });
      throw err;
    };
    const ReviewComment = z.object({ path: z.string().min(1).max(500), line: z.number().int().positive(), body: z.string().trim().min(1).max(5000), code: z.string().max(2000).optional() });
    owner.get("/api/tickets/:id/diff", async (req, reply) => review.diff(IdParam.parse(req.params).id).catch(reviewErrors(reply)));
    owner.post("/api/tickets/:id/review", async (req, reply) => {
      const { id } = IdParam.parse(req.params);
      const b = z
        .object({ verdict: z.enum(["approved", "changes_requested"]), comments: z.array(ReviewComment).max(100).optional(), summary: z.string().max(5000).optional() })
        .parse(req.body);
      return review.submit(id, { ...b, reviewer: "the owner" }).catch(reviewErrors(reply));
    });
    owner.post("/api/tickets/:id/git-action", async (req, reply) => {
      const { id } = IdParam.parse(req.params);
      const { action } = z.object({ action: z.enum(["commit", "pr"]) }).parse(req.body);
      return review.gitAction(id, action).catch(reviewErrors(reply));
    });
    owner.get("/api/companies/:id/git-templates", async (req) => review.templates(IdParam.parse(req.params).id));
    owner.put("/api/companies/:id/git-templates", async (req) => {
      const { id } = IdParam.parse(req.params);
      return review.setTemplates(id, z.object({ commit: z.string().min(1).max(5000), pr: z.string().min(1).max(5000) }).partial().parse(req.body));
    });

    // Steering and stopping running agents (R37).
    const runErrors = (reply: import("fastify").FastifyReply) => (err: unknown) => {
      if (err instanceof RunError) return reply.code(err.status).send({ error: "run", message: err.message });
      throw err;
    };
    owner.get("/api/runs", async (req) => runsSvc.active(z.object({ companyId: Uuid.optional() }).parse(req.query).companyId));
    owner.post("/api/runs/:id/message", async (req, reply) => {
      const { id } = IdParam.parse(req.params);
      const b = z.object({ text: z.string().trim().min(1).max(20_000), interrupt: z.boolean().optional() }).parse(req.body);
      return runsSvc.message(id, { ...b, from: "the owner" }).catch(runErrors(reply));
    });
    owner.post("/api/runs/:id/cancel", async (req, reply) => runsSvc.cancel(IdParam.parse(req.params).id).catch(runErrors(reply)));

    // Stale-blocker and stalled-run sweeps (R21, R32); also run on a timer.
    owner.post("/api/sweep", async () => sweeps.run());
  });

  return { app, secrets: secretsSvc, funding, runners, decisions: decisionsSvc, scheduler, work, sweeps, engagements: engagementsSvc, deploys: deploysSvc, runs: runsSvc, recovery, review, loops };
}
