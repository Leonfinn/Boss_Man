import path from "node:path";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import cookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import websocket from "@fastify/websocket";
import { and, asc, count, eq, gt, inArray, isNull } from "drizzle-orm";
import { z, ZodError } from "zod";
import { FEATURE_STATUSES, HORIZONS, IMPORTANCE, NOTE_SOURCES, RISK_TIERS, SECRET_KINDS, SYSTEM_STATES, dateIn, findCredential, riskSummary, usdToMicros } from "@boss-man/shared";
import { timeZoneOr } from "@boss-man/shared";
import { NO_CHECK, STANDARD_CHECKS, type DetectResult } from "@boss-man/shared";
import { hashPassword, hashToken, newSessionToken, SESSION_COOKIE, SESSION_DAYS, verifyPassword } from "./auth.js";
import type { MasterKey } from "./crypto.js";
import type { Db } from "./db/client.js";
import { agents, companies, engagements, owners, projects, runners as runnersTable, runs as runsTable, sessions, settings, tickets, wakes } from "./db/schema.js";
import { fundingService } from "./services/funding.js";
import { AgentError, agentsService } from "./services/agents.js";
import { repoUrlAllowed } from "@boss-man/shared";
import { gitHostService } from "./services/git-hosts.js";
import { runnersService } from "./services/runners.js";
import { LauncherError, launcherService, type LauncherOptions } from "./services/launcher.js";
import { AnswerError, decisionsService } from "./services/decisions.js";
import { sweepService, type SweepLimits } from "./services/sweeps.js";
import { EngagementError, engagementsService } from "./services/engagements.js";
import { DeployError, deploysService } from "./services/deploys.js";
import { RunError, runsService } from "./services/runs.js";
import { recoveryService } from "./services/recovery.js";
import { ReviewError, reviewService } from "./services/review.js";
import { loopGuards, type LoopLimits } from "./services/loop-guards.js";
import { workService, WorkError } from "./services/work.js";
import { OBJECTIVE_STATUSES, planningService } from "./services/planning.js";
import { chaptersService } from "./services/chapters.js";
import { FeedbackError, feedbackService } from "./services/feedback.js";
import { portalRoutes, type PortalLimits } from "./portal.js";
import { ChatError, chatService } from "./services/chat.js";
import { dashboardService } from "./services/dashboard.js";
import { SkillError, skillsService } from "./services/skills.js";
import { TicketChatError, ticketChatService } from "./services/ticket-chat.js";
import { cleanFolder, MAX_BODY, pageSlug, WikiError, wikiService } from "./services/wiki.js";
import { schedulerService, type Limits } from "./services/scheduler.js";
import { mcpRoutes } from "./mcp.js";
import { SecretRejected, secretsService, type LiveValidator } from "./services/secrets.js";
import { runnerSocketRoutes } from "./routes/runner-socket.js";
import { diskService, type DiskLimits } from "./services/disk.js";
import { loginLimiter, type LoginLimits } from "./login-limit.js";
import { policyRulesService, RuleError } from "./services/policy-rules.js";
import { NotifySettings, notificationsService } from "./services/notifications.js";

/** The owner's timezone for times and days shown: the server's TZ when it's a zone name, else UK time. */
const OWNER_TZ = timeZoneOr(process.env.TZ);

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
  /** The built web UI (apps/web/dist). Without it the server is API-only, e.g. under `vite dev`. */
  webDir?: string;
  /** Login failures allowed per address and per username in a window (R45). */
  loginLimits?: LoginLimits;
  /** Default disk cap and how long done tickets keep their worktrees (R54). */
  diskLimits?: Partial<DiskLimits>;
  /** Outbound HTTP, e.g. phone pushes; tests replace it. */
  fetch?: typeof fetch;
  /** Rate limits on the public feedback portal; tests lower them. */
  portalLimits?: Partial<PortalLimits>;
  /** Clock for scheduling, sweeps and ranking; tests move it forward. */
  now?: () => Date;
  /** The runner launcher (R55), when BOSSMAN_LAUNCHER=1. */
  launcher?: LauncherOptions;
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

// The UI is one static page that only talks to this origin, so the policy can be strict.
const WEB_CSP = "default-src 'self'; img-src 'self' data:; font-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'";

/** Serves the built web UI. Hashed assets are cached for good; the page itself never is. */
async function serveWeb(app: FastifyInstance, root: string) {
  await app.register(fastifyStatic, {
    root,
    wildcard: false,
    cacheControl: false,
    index: ["index.html"],
    setHeaders(res, file) {
      res.header("cache-control", file.includes(`${path.sep}assets${path.sep}`) ? "public, max-age=31536000, immutable" : "no-cache");
    },
  });
  app.addHook("onSend", async (req, reply) => {
    if (req.url.startsWith("/api/") || req.url === "/mcp") return;
    reply.header("content-security-policy", WEB_CSP);
    reply.header("x-content-type-options", "nosniff");
    reply.header("referrer-policy", "same-origin");
  });
  app.setNotFoundHandler((req, reply) => {
    // The UI routes after "#", so anything else that isn't a file is simply not found.
    if (req.method === "GET" && !req.url.startsWith("/api/")) return reply.code(404).type("text/plain").send("Not found");
    return reply.code(404).send({ error: "Not Found", message: `Route ${req.method}:${req.url} not found`, statusCode: 404 });
  });
}

export async function buildApp(opts: AppOptions) {
  const { db, master } = opts;
  const app = Fastify({ logger: opts.logger ?? false });
  await app.register(cookie);
  await app.register(websocket);

  const secretsSvc = secretsService(db, master, opts.liveValidator);
  const funding = fundingService(db);
  const runners = runnersService(db, funding);
  const agentsSvc = agentsService(db, { now: opts.now });
  const launch = launcherService(db, { runners, options: opts.launcher, fetch: opts.fetch });
  const rules = policyRulesService(db);
  const notes = notificationsService(db, { reveal: (id) => secretsSvc.reveal(id), now: opts.now, fetch: opts.fetch, log: (m) => app.log.warn(m) });
  await runnerSocketRoutes(app, runners, secretsSvc, { heartbeatMs: opts.heartbeatMs });
  const decisionsSvc = decisionsService(db, (runnerId, command) => runners.send(runnerId, command), opts.now);
  runners.setPermissionHook((runner, event) => decisionsSvc.onPermissionRequest(runner, event));
  const deploysSvc = deploysService(db, { now: opts.now });
  const chapters = chaptersService(db, { now: opts.now });
  const feedback = feedbackService(db, {
    now: opts.now,
    // New feedback wakes the CEO to triage it, when the owner has asked for that; one wake at a time.
    onNote: async (n) => {
      if (!(await feedback.settings(n.companyId)).ceoTriage) return;
      const [ceo] = await db.select({ id: agents.id }).from(agents).where(and(eq(agents.companyId, n.companyId), eq(agents.role, "ceo")));
      if (!ceo || n.createdByAgentId === ceo.id) return;
      const [waiting] = await db.select({ id: wakes.id }).from(wakes).where(and(eq(wakes.agentId, ceo.id), eq(wakes.reason, "feedback"), inArray(wakes.status, ["queued", "deferred"])));
      if (waiting) return;
      await scheduler.wake({
        agentId: ceo.id,
        reason: "feedback",
        priority: 1,
        note: "New feedback is waiting. Use the feedback tool: read the inbox, link each request to a feature (create one if none fits) with how much it matters to them, and mark each note processed. Don't build anything yet; just triage.",
      });
    },
    onReleased: (f) => notes.notify({ companyId: f.companyId, level: "note", title: `Released: ${f.title}`, body: "Every ticket delivering it is done.", link: `#/features/${f.companyId}/${f.id}` }),
  });
  // The scheduler is made below; the chat only needs it once a message is sent.
  const chat = chatService(db, { wake: (input) => scheduler.wake(input), workspaceRoot: opts.workspaceRoot ?? "/home/node/workspaces" });
  const scheduler = schedulerService(db, {
    runners,
    chapters,
    chat,
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
  const ticketChat = ticketChatService(db, { runs: runsSvc, wake: (w) => scheduler.wake(w) });
  const wiki = wikiService(db);
  const dashboard = dashboardService(db, { now: opts.now });
  const skillsSvc = skillsService(db, { fetch: opts.fetch });
  const recovery = recoveryService(db);
  recovery.setWakeHook((w) => scheduler.wake(w));
  // A runner that comes back gets any permission verdicts it missed (R22).
  runners.onConnect((runnerId) => decisionsSvc.redeliver(runnerId));
  runners.onResume((runner, pending) => decisionsSvc.resume(runner, pending));
  decisionsSvc.setDeployHook((id, approved) => deploysSvc.approve(id, approved));
  const disk = diskService(db, { send: (runnerId, command) => runners.send(runnerId, command), limits: opts.diskLimits, now: opts.now });
  const WINDOW_NAME: Record<string, string> = { five_hour: "5-hour", seven_day: "weekly" };
  async function quotaWatch(fundingSourceId: string) {
    const t = (opts.now ?? (() => new Date()))();
    const status = await funding.status(fundingSourceId, t);
    if (!status) return;
    for (const [window, f] of Object.entries(status.forecasts)) {
      if (!f?.beforeReset || !f.runsOutAt || f.utilization < 0.5) continue;
      // Once per window: the key carries the reset time, so the next window can alert again.
      const key = `quota-alert:${fundingSourceId}:${window}:${f.resetsAt?.toISOString() ?? "none"}`;
      const told = await db.insert(settings).values({ key, value: true }).onConflictDoNothing().returning();
      if (!told.length) continue;
      const hhmm = (d: Date) => d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: OWNER_TZ });
      await notes.notify({
        companyId: null,
        agentId: null,
        level: "flag",
        title: `${status.source.name}: the ${WINDOW_NAME[window] ?? window.replace(/_/g, " ")} limit runs out at about ${hhmm(f.runsOutAt)}`,
        body: `It's at ${Math.round(f.utilization * 100)}% and rising about ${Math.round((f.perHour ?? 0) * 100)}% an hour${f.resetsAt ? `, and resets at ${hhmm(f.resetsAt)}` : ""}. Boss Man holds new runs on it once it's nearly used up, until it resets; pause less urgent work, or move agents to another funding source, to keep the important work going.`,
        link: "#/funding",
      });
    }
  }
  runners.onEvent((runner, event) => {
    // CEO continuity: a chapter follows its runs' sessions and context use.
    if (event.type === "run.started") void chapters.onRunStarted(event.runId, event.acpSessionId).catch((err) => app.log.error({ err }, "chapter update failed"));
    if (event.type === "run.context") void chapters.onContext(event.runId, event.used, event.size).catch((err) => app.log.error({ err }, "chapter update failed"));
    if (event.type === "run.ended") void chapters.onRunEnded(event.runId).catch((err) => app.log.error({ err }, "chapter close failed"));
    // The owner chat's answers.
    if (event.type === "run.update" && (event.update as { kind?: string } | null)?.kind === "agent_message") {
      void chat.onAgentMessage(event.runId, String((event.update as { text?: unknown }).text ?? "")).catch((err) => app.log.error({ err }, "chat reply failed"));
      void ticketChat.onAgentMessage(event.runId, String((event.update as { text?: unknown }).text ?? "")).catch((err) => app.log.error({ err }, "ticket reply failed"));
    }
    if (event.type === "run.ended") void chat.onRunEnded(event.runId, event.error).catch((err) => app.log.error({ err }, "chat end failed"));
    // A subscription window set to run out before it resets: tell the owner once (R78).
    if (event.type === "run.quota") void quotaWatch(event.fundingSourceId).catch((err) => app.log.error({ err }, "quota forecast failed"));
    if (event.type === "runner.disk") {
      const { type: _type, ...report } = event;
      void disk.onReport(runner, report, (opts.now ?? (() => new Date()))()).catch((err) => app.log.error({ err }, "disk report handling failed"));
    }
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
    now: opts.now,
  });
  const loops = loopGuards(db, { limits: opts.loopLimits, now: opts.now });
  const gitHosts = gitHostService({ fetch: opts.fetch });
  const review = reviewService(db, {
    runners,
    runs: runsSvc,
    work,
    loops,
    gitHosts,
    gitToken: async (companyId) => (await secretsSvc.resolveCompanyEnv(companyId, "pull_request")).GIT_TOKEN,
    notes,
  });
  review.setWakeHook((w) => scheduler.wake(w));
  decisionsSvc.setLoopHooks({
    sendBack: (ticketId, text, reviewer) => review.sendBack(ticketId, text, reviewer),
    // A merge that can't run now (e.g. the runner is offline) is put back to the owner, not lost.
    land: (ticketId, reviewer) =>
      review.land(ticketId, reviewer).catch(async (err) => {
        const [t] = await db.select({ companyId: tickets.companyId, title: tickets.title }).from(tickets).where(eq(tickets.id, ticketId));
        if (t) await decisionsSvc.raise({ companyId: t.companyId, agentId: null, question: `You approved "${t.title}", but it couldn't be merged: ${(err as Error).message} Approve it again from the ticket once that's fixed.`, options: ["Got it"], recommended: "Got it" });
      }),
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
  await mcpRoutes(app, db, { decisions: decisionsSvc, engagements: engagementsSvc, deploys: deploysSvc, runs: runsSvc, review, notes, chapters, work, feedback, ticketChat, wiki, skills: skillsSvc }, { onTicketDone: (ticketId, runId) => scheduler.onTicketDone(ticketId, runId) });
  // The feedback portal's public API, on this listener too, so the owner can try it here.
  await portalRoutes(app, { feedback, secureCookies: opts.secureCookies ?? true, limits: opts.portalLimits, now: opts.now ? () => opts.now!().getTime() : undefined });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ZodError) return reply.code(400).send({ error: "invalid_request", issues: err.issues });
    if (err instanceof SecretRejected) return reply.code(422).send({ error: "secret_rejected", problems: err.problems });
    if (err instanceof WorkError || err instanceof FeedbackError) return reply.code(err.status).send({ error: "rejected", message: err.message });
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

  const logins = loginLimiter(opts.loginLimits, () => (opts.now ? opts.now().getTime() : Date.now()));
  app.post("/api/login", async (req, reply) => {
    const body = Credentials.parse(req.body);
    const wait = logins.retryAfter(req.ip, body.username);
    if (wait > 0) {
      const minutes = Math.ceil(wait / 60_000);
      return reply
        .code(429)
        .header("retry-after", String(Math.ceil(wait / 1000)))
        .send({ error: "too_many_attempts", message: `Too many failed logins. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.` });
    }
    const [owner] = await db.select().from(owners).where(eq(owners.username, body.username));
    if (!owner || !(await verifyPassword(body.password, owner.passwordHash))) {
      logins.failed(req.ip, body.username);
      return reply.code(401).send({ error: "wrong_username_or_password" });
    }
    logins.succeeded(req.ip, body.username);
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
        // The wiki maintainer starts paused: the owner gives it a model and starts it (R73).
        await tx.insert(agents).values({ companyId: company!.id, name: "Wiki Maintainer", role: "worker", agentKind: "claude", paused: true, duty: "wiki" });
        return { company: company!, ceo: ceo! };
      });
      // With the launcher, a new company's runner starts by itself (R55); a failure is the owner's to see.
      if (launch.enabled)
        void launch.start(result.company.id).catch((err) =>
          notes.notify({ companyId: result.company.id, agentId: null, level: "flag", title: `${result.company.name}'s runner didn't start`, body: (err as Error).message, link: "#/settings" }).catch(() => {}),
        );
      return reply.code(201).send(result);
    });

    owner.patch("/api/companies/:id", async (req, reply) => {
      const { id } = IdParam.parse(req.params);
      const b = z.object({ name: z.string().trim().min(1).max(80), mission: z.string().max(2000).nullable(), ownerApprovesEngagements: z.boolean(), diskCapGb: z.number().positive().max(100_000).nullable() }).partial().parse(req.body);
      const { diskCapGb, ...rest } = b;
      const patch = { ...rest, ...(diskCapGb !== undefined ? { diskCapBytes: diskCapGb === null ? null : Math.round(diskCapGb * 1024 ** 3) } : {}) };
      const [c] = await db.update(companies).set(patch).where(eq(companies.id, id)).returning();
      return c ?? reply.code(404).send({ error: "not_found" });
    });

    owner.get("/api/companies", async () => {
      const rows = await db.select().from(companies).orderBy(companies.name);
      // Retired agents (R62) only show on the Agents page, so they can't be given new work.
      const allAgents = await db.select().from(agents).where(isNull(agents.retiredAt));
      return rows.map((c) => ({ ...c, agents: allAgents.filter((a) => a.companyId === c.id) }));
    });

    /** What each risk tier means, in the server's own words, for the help next to every risk picker (R61). */
    owner.get("/api/risk-tiers", async () => RISK_TIERS.map((tier) => ({ tier, summary: riskSummary(tier) })));

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

    // Checks a value without saving it, for the Check button (R58).
    owner.post("/api/secrets/check", async (req) => {
      const { kind, value } = SecretInput.pick({ kind: true, value: true }).parse(req.body);
      return secretsSvc.check(kind, value);
    });

    owner.post("/api/secrets/:id/check", async (req, reply) => {
      const result = await secretsSvc.checkStored(IdParam.parse(req.params).id);
      return result ?? reply.code(404).send({ error: "not_found" });
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

    owner.get("/api/secrets/:id/grants", async (req) => secretsSvc.grantsForSecret(IdParam.parse(req.params).id));
    owner.get("/api/secrets/:id/access-log", async (req) => {
      const { id } = IdParam.parse(req.params);
      const { limit } = z.object({ limit: z.coerce.number().int().min(1).max(500).optional() }).parse(req.query);
      return secretsSvc.accessLog(id, limit);
    });

    // Notifications (R44): the feed, settings and a test push.
    owner.get("/api/notifications", async (req) => {
      const q = z.object({ before: z.coerce.date().optional(), limit: z.coerce.number().int().min(1).max(200).optional() }).parse(req.query);
      return { items: await notes.list(q), unread: await notes.unread() };
    });
    owner.post("/api/notifications/read", async (req) => {
      const b = z.object({ ids: z.array(Uuid).max(500).optional(), all: z.boolean().optional() }).parse(req.body);
      await notes.markRead(b.all ? "all" : (b.ids ?? []));
      return { unread: await notes.unread() };
    });
    owner.get("/api/notification-settings", async () => {
      const s = await notes.getSettings();
      return { ...s, ntfy: s.ntfy ? { url: s.ntfy.url, topic: s.ntfy.topic, hasToken: !!s.ntfy.tokenSecretId } : null };
    });
    owner.put("/api/notification-settings", async (req) => {
      const b = NotifySettings.omit({ ntfy: true })
        .extend({
          ntfy: z.object({ url: z.string().url(), topic: z.string(), token: z.string().trim().min(1).max(500).nullable().optional() }).nullable(),
        })
        .parse(req.body);
      const current = await notes.getSettings();
      let tokenSecretId = current.ntfy?.tokenSecretId ?? null;
      if (b.ntfy?.token === null) tokenSecretId = null;
      else if (b.ntfy?.token) {
        // The token goes into the encrypted secrets store, like every other credential.
        tokenSecretId = tokenSecretId
          ? ((await secretsSvc.rotate(tokenSecretId, b.ntfy.token, { acceptUnusualFormat: true })) ? tokenSecretId : null)
          : (await secretsSvc.create({ name: "ntfy access token", kind: "generic", value: b.ntfy.token })).secret.id;
      }
      const saved = await notes.setSettings({ ...b, ntfy: b.ntfy ? { url: b.ntfy.url, topic: b.ntfy.topic, tokenSecretId } : null });
      return { ...saved, ntfy: saved.ntfy ? { url: saved.ntfy.url, topic: saved.ntfy.topic, hasToken: !!saved.ntfy.tokenSecretId } : null };
    });
    owner.post("/api/notification-settings/test", async (_req, reply) => {
      try {
        await notes.test();
        return { ok: true };
      } catch (err) {
        return reply.code(502).send({ error: "push_failed", message: `The test push didn't go through: ${(err as Error).message}` });
      }
    });

    // Decision rules (R19): what happens when an agent asks to use a tool.
    const Match = z.object({
      kinds: z.array(z.string()).max(10).optional(),
      commandPattern: z.string().min(1).max(500).optional(),
      titlePattern: z.string().min(1).max(500).optional(),
    });
    const Outcome = z.enum(["allow", "ceo", "owner", "deny"]);
    const ruleErrors = (reply: FastifyReply) => (err: unknown) => {
      if (err instanceof RuleError) return reply.code(err.status).send({ error: "rejected", message: err.message });
      throw err;
    };
    owner.get("/api/policy-rules", async (req) => rules.list(z.object({ companyId: Uuid.optional() }).parse(req.query).companyId ?? null));
    owner.post("/api/policy-rules", async (req, reply) => {
      const b = z.object({ companyId: Uuid.nullable(), name: z.string().trim().min(1).max(120), match: Match, outcome: Outcome }).parse(req.body);
      return rules.create(b).then((r) => reply.code(201).send(r), ruleErrors(reply));
    });
    owner.patch("/api/policy-rules/:id", async (req, reply) => {
      const { id } = IdParam.parse(req.params);
      const b = z.object({ name: z.string().trim().min(1).max(120), match: Match, outcome: Outcome }).partial().parse(req.body);
      return rules.update(id, b).catch(ruleErrors(reply));
    });
    owner.delete("/api/policy-rules/:id", async (req, reply) => rules.remove(IdParam.parse(req.params).id).then(() => reply.code(204).send(), ruleErrors(reply)));
    owner.post("/api/policy-rules/order", async (req, reply) => {
      const b = z.object({ companyId: Uuid.nullable(), ids: z.array(Uuid).max(500) }).parse(req.body);
      return rules.reorder(b.companyId, b.ids).catch(ruleErrors(reply));
    });
    owner.post("/api/policy-rules/test", async (req) => {
      const b = z.object({ companyId: Uuid, command: z.string().max(5000).optional(), title: z.string().max(500).optional(), kind: z.string().max(40).optional() }).parse(req.body);
      return rules.test(b.companyId, { title: b.title ?? b.command ?? null, kind: b.kind ?? (b.command ? "execute" : null), rawInput: b.command ? { command: b.command } : null });
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

    /** Whether the company's runner is registered and connected, and what it last reported. */
    owner.get("/api/companies/:id/runner", async (req) => {
      const { id } = IdParam.parse(req.params);
      const [r] = await db.select().from(runnersTable).where(eq(runnersTable.companyId, id));
      const launcher = await launch.status(id);
      if (!r) return { registered: false, launcher };
      return { registered: true, runnerId: r.id, connected: runners.isConnected(r.id), lastSeenAt: r.lastSeenAt, imageVersion: r.imageVersion, diskUsedBytes: r.diskUsedBytes, diskCheckedAt: r.diskCheckedAt, launcher };
    });

    // The runner's container through the launcher (R55): start or reconnect (a new token), restart, stop.
    const launchErrors = (reply: import("fastify").FastifyReply) => (err: unknown) => {
      if (err instanceof LauncherError) return reply.code(err.status).send({ error: "launcher", message: err.message });
      throw err;
    };
    owner.post("/api/companies/:id/runner/launch", async (req, reply) => launch.start(IdParam.parse(req.params).id).catch(launchErrors(reply)));
    owner.post("/api/companies/:id/runner/restart", async (req, reply) => launch.restart(IdParam.parse(req.params).id).catch(launchErrors(reply)));
    owner.delete("/api/companies/:id/runner/launch", async (req, reply) => launch.stop(IdParam.parse(req.params).id).catch(launchErrors(reply)));

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
      // Days follow the viewer's timezone (the browser sends it), else the server's.
      const { tz } = z.object({ tz: z.string().max(64).optional() }).parse(req.query);
      return (await funding.status(id, new Date(), timeZoneOr(tz, OWNER_TZ))) ?? reply.code(404).send({ error: "not_found" });
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
      risk: z.enum(RISK_TIERS).nullable(),
      planFirst: z.boolean(),
      featureId: Uuid.nullable(),
      overLimit: z.boolean(),
    });

    owner.get("/api/companies/:id/projects", async (req) => {
      const { id } = IdParam.parse(req.params);
      return db.select().from(projects).where(eq(projects.companyId, id)).orderBy(projects.name);
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
            .refine(repoUrlAllowed, "Give an https://, ssh://, git@ or local path address. Plain http:// works for a LAN address such as http://192.168.68.67:3003/you/repo.git.")
            .refine((u) => !findCredential(u), "The address looks like it contains a credential. Grant a GIT_TOKEN secret to the company instead.")
            .nullable(),
          defaultBranch: z.string().trim().min(1).max(200),
          verifyCommand: z.string().trim().min(1).max(1000).nullable(),
          deepVerifyCommand: z.string().trim().min(1).max(1000).nullable(),
          ticketCostCapUsd: z.number().positive().nullable(),
          landing: z.enum(["merge", "pull_request"]),
          gitHost: z.enum(["github", "gitea"]).nullable(),
          gitApiBase: z
            .string()
            .trim()
            .max(500)
            .refine((u) => /^https:\/\//.test(u) || (u.startsWith("http://") && repoUrlAllowed(u)), "Give the API's https:// address, or http:// on a LAN address.")
            .nullable(),
        })
        .partial()
        .parse(req.body);
      const { ticketCostCapUsd, ...fields } = b;
      // A new repo address finds its host (R59), unless the owner set one with it.
      if (fields.repoUrl !== undefined && fields.gitHost === undefined) {
        const found = fields.repoUrl ? await gitHosts.detect(fields.repoUrl) : null;
        Object.assign(fields, { gitHost: found?.gitHost ?? null, gitApiBase: found?.gitApiBase ?? null });
      }
      const [p] = await db
        .update(projects)
        .set({ ...fields, ...(ticketCostCapUsd !== undefined ? { ticketCostCapMicros: ticketCostCapUsd === null ? null : usdToMicros(ticketCostCapUsd) } : {}) })
        .where(eq(projects.id, id))
        .returning();
      return p ?? reply.code(404).send({ error: "not_found" });
    });

    // Merge check presets (R57): the runner proposes checks from the repo, alongside the standard ones.
    owner.post("/api/projects/:id/check-presets", async (req, reply) => {
      const { id } = IdParam.parse(req.params);
      const [p] = await db.select().from(projects).where(eq(projects.id, id));
      if (!p) return reply.code(404).send({ error: "not_found" });
      const base = { standard: STANDARD_CHECKS, none: NO_CHECK };
      if (!p.repoUrl) return { ...base, detected: [], tools: null, error: "Set the project's git repo first." };
      const [runner] = await db.select({ id: runnersTable.id }).from(runnersTable).where(eq(runnersTable.companyId, p.companyId));
      if (!runner || !runners.isConnected(runner.id)) return { ...base, detected: [], tools: null, error: "The company's runner isn't connected, so it can't look at the repo." };
      try {
        const r = await runners.request<DetectResult>(runner.id, (requestId) => ({ type: "workspace.detect", requestId, projectId: p.id, repoUrl: p.repoUrl!, baseRef: p.defaultBranch }), 2 * 60_000);
        return { ...base, detected: r.checks, tools: r.tools, error: null };
      } catch (err) {
        return { ...base, detected: [], tools: null, error: `The runner couldn't read the repo: ${(err as Error).message}` };
      }
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

    /** One ticket with its project and assignee, for the ticket page. */
    owner.get("/api/tickets/:id", async (req, reply) => {
      const { id } = IdParam.parse(req.params);
      const [row] = await db
        .select({ t: tickets, project: projects.name, repoUrl: projects.repoUrl, defaultBranch: projects.defaultBranch, landing: projects.landing, assignee: agents.name })
        .from(tickets)
        .innerJoin(projects, eq(projects.id, tickets.projectId))
        .leftJoin(agents, eq(agents.id, tickets.assigneeAgentId))
        .where(eq(tickets.id, id));
      if (!row) return reply.code(404).send({ error: "not_found" });
      return { ...row.t, project: row.project, repoUrl: row.repoUrl, defaultBranch: row.defaultBranch, landing: row.landing, assignee: row.assignee };
    });

    // The runs on a ticket, oldest first, for its activity feed (R76).
    owner.get("/api/tickets/:id/runs", async (req) => {
      const { id } = IdParam.parse(req.params);
      return db
        .select({ id: runsTable.id, agent: agents.name, agentId: runsTable.agentId, startedAt: runsTable.startedAt, endedAt: runsTable.endedAt, outcome: runsTable.outcome, purpose: runsTable.purpose })
        .from(runsTable)
        .leftJoin(agents, eq(agents.id, runsTable.agentId))
        .where(eq(runsTable.ticketId, id))
        .orderBy(asc(runsTable.startedAt))
        .limit(200);
    });

    // A ticket's conversation with the agents working it (R65).
    const ticketChatErrors = (reply: import("fastify").FastifyReply) => (err: unknown) => {
      if (err instanceof TicketChatError) return reply.code(err.status).send({ error: "ticket_chat", message: err.message });
      throw err;
    };
    owner.get("/api/tickets/:id/messages", async (req, reply) => ticketChat.list(IdParam.parse(req.params).id).catch(ticketChatErrors(reply)));
    owner.post("/api/tickets/:id/messages", async (req, reply) => {
      const { id } = IdParam.parse(req.params);
      const { text, interrupt } = z.object({ text: z.string().trim().min(1).max(4000), interrupt: z.boolean().optional() }).parse(req.body);
      return ticketChat
        .ownerSays(id, text, { interrupt })
        .then((m) => reply.code(201).send(m))
        .catch(ticketChatErrors(reply));
    });

    // Skills (R71): the company's library, and who has what.
    const skillErrors = (reply: import("fastify").FastifyReply) => (err: unknown) => {
      if (err instanceof SkillError) return reply.code(err.status).send({ error: "skill", message: err.message });
      throw err;
    };
    const SkillParams = z.object({ id: Uuid, skillId: Uuid });
    const SkillFiles = z.array(z.object({ path: z.string().min(1).max(500), content: z.string().max(4_000_000) })).min(1).max(200);
    owner.get("/api/companies/:id/skills", async (req) => skillsSvc.list(IdParam.parse(req.params).id));
    owner.post("/api/companies/:id/skills", { bodyLimit: 8 * 1024 * 1024 }, async (req, reply) => {
      const { id } = IdParam.parse(req.params);
      const b = z
        .discriminatedUnion("from", [
          z.object({ from: z.literal("link"), url: z.string().url().max(2000) }),
          z.object({ from: z.literal("written"), name: z.string().trim().min(1).max(64), description: z.string().trim().min(1).max(1024), body: z.string().max(100_000) }),
          z.object({ from: z.literal("upload"), name: z.string().trim().max(64).optional(), files: SkillFiles }),
        ])
        .parse(req.body);
      try {
        const added = b.from === "link" ? await skillsSvc.fromLink(id, b.url) : b.from === "written" ? [await skillsSvc.write(id, b)] : [await skillsSvc.upload(id, b.files, b.name)];
        return reply.code(201).send(added.map((s) => ({ id: s.id, name: s.name })));
      } catch (err) {
        return skillErrors(reply)(err);
      }
    });
    owner.get("/api/companies/:id/skills/:skillId", async (req, reply) => {
      const { id, skillId } = SkillParams.parse(req.params);
      return skillsSvc.get(id, skillId).catch(skillErrors(reply));
    });
    owner.put("/api/companies/:id/skills/:skillId", async (req, reply) => {
      const { id, skillId } = SkillParams.parse(req.params);
      const b = z.object({ name: z.string().trim().min(1).max(64), description: z.string().trim().min(1).max(1024), body: z.string().max(100_000) }).parse(req.body);
      return skillsSvc.write(id, { ...b, replaceId: skillId }).then((s) => ({ id: s.id, name: s.name }), skillErrors(reply));
    });
    owner.post("/api/companies/:id/skills/:skillId/refresh", async (req, reply) => {
      const { id, skillId } = SkillParams.parse(req.params);
      return skillsSvc.refresh(id, skillId).then((r) => ({ changed: r.changed, sourceRef: r.skill.sourceRef }), skillErrors(reply));
    });
    owner.delete("/api/companies/:id/skills/:skillId", async (req, reply) => {
      const { id, skillId } = SkillParams.parse(req.params);
      return skillsSvc.remove(id, skillId).then(() => reply.code(204).send(), skillErrors(reply));
    });
    // Packs: skills added together from one link (R71), given and updated as one. A pack's name
    // has a slash in it (owner/repo), so it travels in the body or the query.
    const PackName = z.string().min(1).max(200);
    owner.put("/api/companies/:id/skill-packs/agents", async (req, reply) => {
      const { id } = IdParam.parse(req.params);
      const { pack, agentIds } = z.object({ pack: PackName, agentIds: z.array(Uuid).max(200) }).parse(req.body);
      return skillsSvc.setPackHolders(id, pack, agentIds).then(() => ({ pack, agentIds }), skillErrors(reply));
    });
    owner.post("/api/companies/:id/skill-packs/refresh", async (req, reply) => {
      const { id } = IdParam.parse(req.params);
      const { pack } = z.object({ pack: PackName }).parse(req.body);
      return skillsSvc.refreshPack(id, pack).catch(skillErrors(reply));
    });
    owner.delete("/api/companies/:id/skill-packs", async (req, reply) => {
      const { id } = IdParam.parse(req.params);
      const { pack } = z.object({ pack: PackName }).parse(req.query);
      return skillsSvc.removePack(id, pack).then(() => reply.code(204).send(), skillErrors(reply));
    });
    owner.put("/api/companies/:id/skills/:skillId/agents", async (req, reply) => {
      const { id, skillId } = SkillParams.parse(req.params);
      const { agentIds } = z.object({ agentIds: z.array(Uuid).max(200) }).parse(req.body);
      return skillsSvc.setHolders(id, skillId, agentIds).then(() => ({ agentIds }), skillErrors(reply));
    });

    // The home screen (R74).
    owner.get("/api/companies/:id/dashboard", async (req) => dashboard.get(IdParam.parse(req.params).id));

    // The company wiki, and what each ticket produced (R69).
    const wikiErrors = (reply: import("fastify").FastifyReply) => (err: unknown) => {
      if (err instanceof WikiError) return reply.code(err.status).send({ error: "wiki", message: err.message });
      throw err;
    };
    // A page's address can hold folders ("research/agent-landscape"), so it's the rest of the path.
    const SlugParams = z.object({ id: Uuid, "*": z.string().min(1).max(500) }).transform((p) => ({ id: p.id, slug: p["*"] }));
    const PageBody = z.object({ title: z.string().trim().min(1).max(200), body: z.string().max(MAX_BODY), folder: z.string().max(400).optional() });
    owner.get("/api/companies/:id/wiki", async (req) => wiki.list(IdParam.parse(req.params).id, z.object({ q: z.string().max(200).optional() }).parse(req.query).q));
    owner.post("/api/companies/:id/wiki", async (req, reply) => {
      const { id } = IdParam.parse(req.params);
      const b = PageBody.parse(req.body);
      try {
        const slug = pageSlug(cleanFolder(b.folder ?? ""), b.title);
        const [taken] = (await wiki.list(id)).filter((p) => p.slug === slug);
        if (taken) return reply.code(409).send({ error: "wiki", message: `There's already a page called "${taken.title}" there. Open it to change it, or pick another title.` });
        const r = await wiki.write(id, { ...b, slug, folder: b.folder ?? "", agentId: null, runId: null });
        return reply.code(201).send(r.page);
      } catch (err) {
        return wikiErrors(reply)(err);
      }
    });
    owner.get("/api/companies/:id/wiki/*", async (req, reply) => {
      const { id, slug } = SlugParams.parse(req.params);
      return wiki.get(id, slug).catch(wikiErrors(reply));
    });
    owner.put("/api/companies/:id/wiki/*", async (req, reply) => {
      const { id, slug } = SlugParams.parse(req.params);
      return wiki.write(id, { ...PageBody.parse(req.body), slug, agentId: null, runId: null }).then((r) => r.page, wikiErrors(reply));
    });
    owner.delete("/api/companies/:id/wiki/*", async (req, reply) => {
      const { id, slug } = SlugParams.parse(req.params);
      return wiki.remove(id, slug).then(() => reply.code(204).send(), wikiErrors(reply));
    });
    owner.get("/api/companies/:id/wiki-revisions/:rev", async (req, reply) => {
      const { id, rev } = z.object({ id: Uuid, rev: Uuid }).parse(req.params);
      return wiki.revision(id, rev).catch(wikiErrors(reply));
    });
    owner.get("/api/tickets/:id/artifacts", async (req) => wiki.artifacts(IdParam.parse(req.params).id));
    owner.delete("/api/artifacts/:id", async (req, reply) => wiki.removeArtifact(IdParam.parse(req.params).id).then(() => reply.code(204).send(), wikiErrors(reply)));

    owner.patch("/api/tickets/:id", async (req) => {
      const { id } = IdParam.parse(req.params);
      const { costCapUsd, ...fields } = TicketFields.extend({ costCapUsd: z.number().positive().nullable() }).partial().parse(req.body);
      // A per-ticket spend ceiling across all its runs (R53); null falls back to the project's default.
      if (costCapUsd !== undefined) await db.update(tickets).set({ costCapMicros: costCapUsd === null ? null : usdToMicros(costCapUsd) }).where(eq(tickets.id, id));
      return work.updateTicket(id, fields);
    });

    // A watcher agent that reports the ticket's progress every so often (R80); agentId null turns it off.
    owner.put("/api/tickets/:id/watcher", async (req) => {
      const { id } = IdParam.parse(req.params);
      const b = z.object({ agentId: Uuid.nullable(), everyMinutes: z.number().int().min(10).max(7 * 24 * 60).optional() }).parse(req.body);
      return work.setWatcher(id, b);
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
      const body = z.object({ title: z.string().trim().min(1).max(200), targetDate: DateStr.optional(), horizon: z.enum(HORIZONS).optional() }).parse(req.body);
      return reply.code(201).send(await work.addMilestone(id, body));
    });

    owner.get("/api/companies/:id/objectives", async (req) => work.objectivesTree(IdParam.parse(req.params).id));

    // Feature requests: feedback notes, features and prioritisation.
    const Text = (max: number) => z.string().trim().min(1).max(max);
    const CustomerIn = z.object({ name: Text(200), email: z.string().trim().email().max(320).nullable().optional(), segment: z.string().trim().max(100).nullable().optional() });
    const FeatureFields = z.object({
      title: Text(200),
      description: z.string().max(20_000).nullable(),
      status: z.enum(FEATURE_STATUSES),
      areaId: Uuid.nullable(),
      parentId: Uuid.nullable(),
      effort: z.number().int().min(1).max(5).nullable(),
      driverScores: z.record(Uuid, z.number().int().min(0).max(5).nullable()),
      milestoneId: Uuid.nullable(),
      portalVisible: z.boolean(),
    });
    owner.get("/api/companies/:id/feedback-settings", async (req) => {
      const { id } = IdParam.parse(req.params);
      const s = await feedback.settings(id);
      return { ...s, drivers: await feedback.drivers(id), areas: await feedback.areas(id) };
    });
    owner.patch("/api/companies/:id/feedback-settings", async (req) => {
      const { id } = IdParam.parse(req.params);
      const b = z.object({ demandWeight: z.number().int().min(0).max(10), ceoTriage: z.boolean() }).partial().parse(req.body);
      return feedback.setSettings(id, b);
    });
    owner.post("/api/companies/:id/feature-drivers", async (req, reply) => {
      const { id } = IdParam.parse(req.params);
      return reply.code(201).send(await feedback.addDriver(id, z.object({ name: Text(80), weight: z.number().int().min(0).max(10).default(1) }).parse(req.body)));
    });
    owner.patch("/api/feature-drivers/:id", async (req) => feedback.updateDriver(IdParam.parse(req.params).id, z.object({ name: Text(80), weight: z.number().int().min(0).max(10), position: z.number().int().min(0) }).partial().parse(req.body)));
    owner.delete("/api/feature-drivers/:id", async (req, reply) => (await feedback.removeDriver(IdParam.parse(req.params).id), reply.code(204).send()));
    owner.post("/api/companies/:id/feature-areas", async (req, reply) => reply.code(201).send(await feedback.addArea(IdParam.parse(req.params).id, z.object({ name: Text(80) }).parse(req.body).name)));
    owner.patch("/api/feature-areas/:id", async (req) => feedback.updateArea(IdParam.parse(req.params).id, z.object({ name: Text(80), position: z.number().int().min(0) }).partial().parse(req.body)));
    owner.delete("/api/feature-areas/:id", async (req, reply) => (await feedback.removeArea(IdParam.parse(req.params).id), reply.code(204).send()));

    owner.patch("/api/companies/:id/portal", async (req) => {
      const { id } = IdParam.parse(req.params);
      const b = z.object({ enabled: z.boolean(), title: z.string().trim().max(120).nullable(), intro: z.string().trim().max(2000).nullable() }).partial().parse(req.body);
      return feedback.setPortal(id, { ...b, ...(b.title === "" ? { title: null } : {}), ...(b.intro === "" ? { intro: null } : {}) });
    });
    owner.post("/api/companies/:id/portal/rotate", async (req) => feedback.rotatePortal(IdParam.parse(req.params).id));
    owner.get("/api/companies/:id/features", async (req) => feedback.scored(IdParam.parse(req.params).id));
    owner.post("/api/companies/:id/features", async (req, reply) => {
      const { id } = IdParam.parse(req.params);
      return reply.code(201).send(await feedback.createFeature(id, FeatureFields.partial().required({ title: true }).parse(req.body)));
    });
    owner.get("/api/features/:id", async (req) => feedback.featureDetail(IdParam.parse(req.params).id));
    owner.patch("/api/features/:id", async (req) => feedback.updateFeature(IdParam.parse(req.params).id, FeatureFields.partial().parse(req.body)));
    owner.delete("/api/features/:id", async (req, reply) => (await feedback.removeFeature(IdParam.parse(req.params).id), reply.code(204).send()));
    /** A ticket that delivers the feature, described from what people asked for. */
    owner.post("/api/features/:id/tickets", async (req, reply) => {
      const { id } = IdParam.parse(req.params);
      const b = z.object({ projectId: Uuid, title: Text(200).optional(), risk: z.enum(RISK_TIERS).optional(), assigneeAgentId: Uuid.optional(), state: z.enum(SYSTEM_STATES).optional() }).parse(req.body);
      const { feature: f, body } = await feedback.brief(id);
      const [p] = await db.select({ companyId: projects.companyId }).from(projects).where(eq(projects.id, b.projectId));
      if (!p || p.companyId !== f.companyId) return reply.code(422).send({ error: "rejected", message: "Pick a project of the feature's company." });
      const t = await work.createTicket(b.projectId, { title: b.title ?? f.title, body, featureId: id, risk: b.risk, assigneeAgentId: b.assigneeAgentId, state: b.state });
      if (f.status === "idea" || f.status === "considering") await feedback.updateFeature(id, { status: "planned" });
      return reply.code(201).send(t);
    });

    owner.get("/api/companies/:id/feedback-customers", async (req) => feedback.customers(IdParam.parse(req.params).id, z.object({ q: z.string().max(100).optional() }).parse(req.query).q));
    owner.get("/api/feedback/unprocessed", async () => feedback.unprocessedCount());
    owner.get("/api/companies/:id/feedback", async (req) => {
      const { id } = IdParam.parse(req.params);
      const q = z.object({ state: z.enum(["unprocessed", "processed", "archived"]).optional(), q: z.string().max(200).optional(), before: z.coerce.date().optional(), limit: z.coerce.number().int().min(1).max(200).optional() }).parse(req.query);
      return feedback.notes(id, q);
    });
    owner.post("/api/companies/:id/feedback", async (req, reply) => {
      const { id } = IdParam.parse(req.params);
      const b = z.object({ title: z.string().trim().max(200).nullable().optional(), text: Text(20_000), source: z.enum(NOTE_SOURCES).exclude(["portal", "agent", "chat"]).optional(), customerId: Uuid.nullable().optional(), customer: CustomerIn.nullable().optional() }).parse(req.body);
      return reply.code(201).send(await feedback.createNote(id, b));
    });
    owner.get("/api/feedback/:id", async (req) => feedback.noteDetail(IdParam.parse(req.params).id));
    owner.patch("/api/feedback/:id", async (req) => {
      const b = z.object({ title: z.string().trim().max(200).nullable(), state: z.enum(["unprocessed", "processed", "archived"]), customerId: Uuid.nullable(), customer: CustomerIn.nullable() }).partial().parse(req.body);
      return feedback.updateNote(IdParam.parse(req.params).id, b);
    });
    owner.delete("/api/feedback/:id", async (req, reply) => (await feedback.removeNote(IdParam.parse(req.params).id), reply.code(204).send()));
    owner.post("/api/feedback/:id/insights", async (req, reply) => {
      const b = z.object({ featureId: Uuid, importance: z.enum(IMPORTANCE).default("important"), highlight: z.string().max(2000).nullable().optional() }).parse(req.body);
      return reply.code(201).send(await feedback.link(IdParam.parse(req.params).id, { ...b, createdBy: "the owner" }));
    });
    owner.delete("/api/insights/:id", async (req, reply) => (await feedback.unlink(IdParam.parse(req.params).id), reply.code(204).send()));

    // The owner chat (v1.1, R70): the CEO or any agent, in plain language; tickets and links out.
    const chatErrors = (reply: import("fastify").FastifyReply) => (err: unknown) => {
      if (err instanceof ChatError) return reply.code(err.status).send({ error: "rejected", message: err.message });
      throw err;
    };
    owner.get("/api/companies/:id/chat/threads", async (req) => chat.threads(IdParam.parse(req.params).id));
    owner.get("/api/companies/:id/chat", async (req, reply) => {
      const { id } = IdParam.parse(req.params);
      const { agentId } = z.object({ agentId: Uuid.optional() }).parse(req.query);
      return chat.list(id, agentId).catch(chatErrors(reply));
    });
    owner.post("/api/companies/:id/chat", async (req, reply) => {
      const { id } = IdParam.parse(req.params);
      const { text, agentId } = z.object({ text: z.string().trim().min(1).max(4000), agentId: Uuid.optional() }).parse(req.body);
      return chat.send(id, text, agentId).then((m) => reply.code(201).send(m), chatErrors(reply));
    });

    // CEO continuity: the CEO's chapters, and asking for a new one.
    owner.get("/api/companies/:id/chapters", async (req) => chapters.list(IdParam.parse(req.params).id));
    owner.post("/api/companies/:id/chapters/roll", async (req, reply) => {
      const c = await chapters.requestRoll(IdParam.parse(req.params).id);
      return c ? { number: c.number, rollRequestedAt: c.rollRequestedAt } : reply.code(409).send({ error: "no_chapter", message: "The CEO hasn't started a chapter yet. One starts at its next run." });
    });

    // Roadmap and plan views (v1.1).
    const planning = planningService(db, { release: (ticketId) => decisionsSvc.release(ticketId) });
    owner.get("/api/roadmap", async (req) => {
      const q = z.object({ today: DateStr.optional(), closed: z.enum(["1"]).optional() }).parse(req.query);
      return planning.roadmap(q.today ?? dateIn(opts.now?.() ?? new Date(), "UTC"), { includeClosed: !!q.closed });
    });
    owner.patch("/api/objectives/:id", async (req) => {
      const { id } = IdParam.parse(req.params);
      const b = z.object({ title: z.string().trim().min(1).max(200), priority: z.number().int().min(1).max(5), status: z.enum(OBJECTIVE_STATUSES) }).partial().parse(req.body);
      return planning.updateObjective(id, b);
    });
    owner.get("/api/milestones/:id/tickets", async (req) => planning.milestoneTickets(IdParam.parse(req.params).id));
    owner.patch("/api/milestones/:id", async (req) => {
      const { id } = IdParam.parse(req.params);
      const b = z.object({ title: z.string().trim().min(1).max(200), targetDate: DateStr.nullable(), objectiveId: Uuid, horizon: z.enum(HORIZONS).nullable() }).partial().parse(req.body);
      return planning.updateMilestone(id, b);
    });
    owner.delete("/api/milestones/:id", async (req, reply) => {
      await planning.deleteMilestone(IdParam.parse(req.params).id);
      return reply.code(204).send();
    });
    owner.get("/api/companies/:id/plan", async (req) => planning.plan(IdParam.parse(req.params).id));
    owner.get("/api/companies/:id/open-tickets", async (req) => planning.openTickets(IdParam.parse(req.params).id));
    owner.get("/api/tickets/:id/links", async (req) => planning.ticketLinks(IdParam.parse(req.params).id));
    owner.delete("/api/dependencies/:id", async (req, reply) => {
      await planning.removeDependency(IdParam.parse(req.params).id);
      return reply.code(204).send();
    });

    // Agents (R62): hire from a template, change them, retire them, and undo any change.
    const agentErrors = (reply: import("fastify").FastifyReply) => (err: unknown) => {
      if (err instanceof AgentError) return reply.code(err.status).send({ error: "agent", message: err.message });
      throw err;
    };
    const Instructions = z.string().trim().max(20_000).nullable();
    owner.get("/api/agent-templates", async () => agentsSvc.templates());
    owner.get("/api/companies/:id/agents", async (req) => agentsSvc.list(IdParam.parse(req.params).id));
    owner.post("/api/companies/:id/agents", async (req, reply) => {
      const { id } = IdParam.parse(req.params);
      const b = z
        .object({
          name: z.string().trim().min(1).max(80),
          template: z.string().max(40).optional(),
          title: z.string().trim().max(80).nullable().optional(),
          instructions: Instructions.optional(),
          role: z.enum(["manager", "worker"]).optional(),
          agentKind: z.string().min(1).optional(),
          model: z.string().nullable().optional(),
          fundingSourceId: Uuid.nullable().optional(),
          reportsTo: Uuid.optional(),
        })
        .parse(req.body);
      return agentsSvc.hire(id, b).then((a) => reply.code(201).send(a), agentErrors(reply));
    });

    owner.patch("/api/agents/:id", async (req, reply) => {
      const { id } = IdParam.parse(req.params);
      const b = z
        .object({ name: z.string().trim().min(1).max(80), title: z.string().trim().max(80).nullable(), instructions: Instructions, model: z.string().nullable(), fundingSourceId: Uuid.nullable(), agentKind: z.string().min(1), paused: z.boolean() })
        .partial()
        .parse(req.body);
      const [before] = await db.select().from(agents).where(eq(agents.id, id));
      if (!before) return reply.code(404).send({ error: "not_found" });
      // An agent with a standing job starts with no model; it needs one before it can run (R73).
      if (b.paused === false && before.duty && !(b.model !== undefined ? b.model : before.model)) {
        return reply.code(409).send({ error: "needs_model", message: `Choose a model for ${before.name} before starting it.` });
      }
      return agentsSvc.update(id, b).then((a) => {
        // Unpausing lets its waiting work start now rather than at the next tick.
        if (b.paused === false && before.paused) void scheduler.tick().catch((err) => app.log.error({ err }, "tick after unpause failed"));
        return a;
      }, agentErrors(reply));
    });
    owner.post("/api/agents/:id/retire", async (req, reply) => agentsSvc.retire(IdParam.parse(req.params).id).catch(agentErrors(reply)));
    owner.get("/api/agents/:id/history", async (req, reply) => agentsSvc.history(IdParam.parse(req.params).id).catch(agentErrors(reply)));
    owner.post("/api/agent-changes/:id/undo", async (req, reply) => agentsSvc.undo(IdParam.parse(req.params).id).catch(agentErrors(reply)));

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
      const { answer, assigneeAgentId, note, custom } = z
        .object({ answer: z.string().trim().min(1).max(4000), assigneeAgentId: Uuid.optional(), note: z.string().trim().max(2000).optional(), custom: z.boolean().optional() })
        .parse(req.body);
      try {
        const result = await decisionsSvc.answer(id, answer, { assigneeAgentId, note, custom });
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
    owner.get("/api/tickets/:id/diff", async (req, reply) => {
      // range=last_turn: what the agent's last turn that changed anything did (R39).
      const { range } = z.object({ range: z.enum(["base", "last_turn"]).optional() }).parse(req.query);
      return review.diff(IdParam.parse(req.params).id, undefined, range).catch(reviewErrors(reply));
    });
    owner.post("/api/tickets/:id/review", async (req, reply) => {
      const { id } = IdParam.parse(req.params);
      const b = z
        .object({ verdict: z.enum(["approved", "changes_requested"]), comments: z.array(ReviewComment).max(100).optional(), summary: z.string().max(5000).optional() })
        .parse(req.body);
      return review.submit(id, { ...b, reviewer: "the owner" }).catch(reviewErrors(reply));
    });
    // Try the ticket's pull request again now, rather than waiting for the sync (R59).
    owner.post("/api/tickets/:id/pull-request/merge", async (req, reply) => review.mergePullRequest(IdParam.parse(req.params).id).catch(reviewErrors(reply)));
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
    owner.get("/api/runs/recent", async (req) => {
      const q = z.object({ companyId: Uuid.optional(), limit: z.coerce.number().int().min(1).max(200).optional() }).parse(req.query);
      return runsSvc.recent(q.limit, q.companyId);
    });
    owner.get("/api/runs/:id/transcript", async (req, reply) => {
      const { id } = IdParam.parse(req.params);
      const q = z.object({ after: z.coerce.number().int().min(0).optional(), limit: z.coerce.number().int().min(1).max(1000).optional() }).parse(req.query);
      return runsSvc.transcript(id, q).catch(runErrors(reply));
    });
    owner.post("/api/runs/:id/cancel", async (req, reply) => runsSvc.cancel(IdParam.parse(req.params).id).catch(runErrors(reply)));

    // Stale-blocker and stalled-run sweeps (R21, R32); also run on a timer.
    owner.post("/api/sweep", async () => sweeps.run());
  });

  if (opts.webDir) await serveWeb(app, opts.webDir);

  return { app, secrets: secretsSvc, funding, runners, decisions: decisionsSvc, scheduler, work, sweeps, engagements: engagementsSvc, deploys: deploysSvc, runs: runsSvc, recovery, review, loops, disk, rules, notes, chapters, feedback, wiki };
}
