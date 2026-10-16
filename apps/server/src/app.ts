import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import cookie from "@fastify/cookie";
import websocket from "@fastify/websocket";
import { count, eq, gt, and } from "drizzle-orm";
import { z, ZodError } from "zod";
import { SECRET_KINDS, SYSTEM_STATES, usdToMicros } from "@boss-man/shared";
import { hashPassword, hashToken, newSessionToken, SESSION_COOKIE, SESSION_DAYS, verifyPassword } from "./auth.js";
import type { MasterKey } from "./crypto.js";
import type { Db } from "./db/client.js";
import { agents, companies, owners, sessions } from "./db/schema.js";
import { fundingService } from "./services/funding.js";
import { runnersService } from "./services/runners.js";
import { decisionsService } from "./services/decisions.js";
import { workService, WorkError } from "./services/work.js";
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

export async function buildApp(opts: AppOptions) {
  const { db, master } = opts;
  const app = Fastify({ logger: opts.logger ?? false });
  await app.register(cookie);
  await app.register(websocket);

  const secretsSvc = secretsService(db, master, opts.liveValidator);
  const funding = fundingService(db);
  const runners = runnersService(db, funding);
  await runnerSocketRoutes(app, runners, secretsSvc, { heartbeatMs: opts.heartbeatMs });
  const decisionsSvc = decisionsService(db, (runnerId, command) => runners.send(runnerId, command));
  runners.setPermissionHook((runner, event) => decisionsSvc.onPermissionRequest(runner, event));
  await mcpRoutes(app, db, decisionsSvc);
  const work = workService(db);

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

    const GrantInput = z.object({ companyId: Uuid, envName: z.string().regex(/^[A-Z_][A-Z0-9_]*$/, "Use an environment variable name like CLAUDE_CODE_OAUTH_TOKEN") });

    owner.post("/api/secrets/:id/grants", async (req, reply) => {
      const { id } = IdParam.parse(req.params);
      const body = GrantInput.parse(req.body);
      return reply.code(201).send(await secretsSvc.grant(id, body.companyId, body.envName));
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
      scopeKind: z.enum(["company", "project", "agent"]),
      scopeId: Uuid,
      fundingSourceId: Uuid.optional(),
      windowKind: z.enum(["lifetime", "calendar_month", "billing_cycle", "rolling_days"]),
      rollingDays: z.number().int().positive().optional(),
      limitUsd: z.number().nonnegative(),
      onLimit: z.enum(["ask", "pause"]),
      warnAt: z.number().gt(0).lte(1).optional(),
    });

    owner.post("/api/budget-policies", async (req, reply) => {
      const { limitUsd, ...rest } = PolicyInput.parse(req.body);
      return reply.code(201).send(await funding.createPolicy({ ...rest, limitMicros: usdToMicros(limitUsd) }));
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
      return work.updateTicket(id, TicketFields.partial().parse(req.body));
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

    // Decisions (ranking arrives in Phase 4; for now oldest first).
    owner.get("/api/decisions", async () => decisionsSvc.listOpen());

    owner.post("/api/decisions/:id/answer", async (req, reply) => {
      const { id } = IdParam.parse(req.params);
      const { answer } = z.object({ answer: z.string().min(1) }).parse(req.body);
      try {
        const result = await decisionsSvc.answer(id, answer);
        return result ?? reply.code(404).send({ error: "not_open" });
      } catch (err) {
        return reply.code(422).send({ error: "invalid_answer", message: (err as Error).message });
      }
    });
  });

  return { app, secrets: secretsSvc, funding, runners, decisions: decisionsSvc };
}
