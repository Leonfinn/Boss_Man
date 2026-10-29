import path from "node:path";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import cookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import websocket from "@fastify/websocket";
import { and, asc, count, desc, eq, gt, gte, inArray, isNull, ne, sql } from "drizzle-orm";
import { readFileSync } from "node:fs";
import { monthStartUtc, projectSpendMicros } from "./services/project-spend.js";
import { z, ZodError } from "zod";
import { FEATURE_STATUSES, HORIZONS, IMPORTANCE, NOTE_SOURCES, RISK_TIERS, SECRET_KINDS, SYSTEM_STATES, dateIn, findCredential, riskSummary, usdToMicros, REVIEW_KINDS, TOOL_KINDS, SENIOR_DEV, ruleFor } from "@boss-man/shared";
import { BLOCKED_UNTIL_MAX_DAYS, BLOCKED_UNTIL_MAX_MS, BLOCKED_UNTIL_REASON_MAX, CEO_TEMPLATE, timeZoneOr, WatchdogSettings } from "@boss-man/shared";
import { NO_CHECK, RUNNER_ADDONS, STANDARD_CHECKS, THINKING_LEVELS, TICKET_PREFIX, defaultTicketPrefix, ticketRef, type DetectResult } from "@boss-man/shared";
import { FUNDING_KINDS, FUNDING_PROVIDERS, fundingComboError, windowLabel } from "@boss-man/shared";
import { hashPassword, hashToken, newSessionToken, SESSION_COOKIE, SESSION_DAYS, verifyPassword } from "./auth.js";
import type { MasterKey } from "./crypto.js";
import type { Db } from "./db/client.js";
import { agentAvatars, agentNotes, agents, companies, costEvents, engagements, fundingSources, mcpServers, objectives, owners, projects, runners as runnersTable, runs as runsTable, sessions, settings, tickets, wakes } from "./db/schema.js";
import { fundingService } from "./services/funding.js";
import { AGENT_APPROVALS, AgentError, agentsService } from "./services/agents.js";
import { NOTE_LIMITS, NoteError, notesService } from "./services/agent-notes.js";
import { modelsService } from "./services/models.js";
import { modelProbeService } from "./services/model-probe.js";
import { parseRepoUrl, repoUrlAllowed } from "@boss-man/shared";
import { gitHostService } from "./services/git-hosts.js";
import { setupService } from "./services/setup.js";
import { secretGrants, watchdogActions } from "./db/schema.js";
import { runnersService } from "./services/runners.js";
import { LauncherError, launcherService, type LauncherOptions } from "./services/launcher.js";
import { AnswerError, decisionsService } from "./services/decisions.js";
import { maintenanceService } from "./services/maintenance.js";
import { selfDeployService } from "./services/self-deploy.js";
import { sweepService, type SweepLimits } from "./services/sweeps.js";
import { WatchdogError, watchdogService } from "./services/watchdog.js";
import { alertLadder } from "./services/alert-ladder.js";
import { EngagementError, engagementsService } from "./services/engagements.js";
import { acceptanceCriteriaSchema, isTaskSize, SIZE_SCALE } from "@boss-man/shared";
import { DeployError, deploysService } from "./services/deploys.js";
import { RunError, runsService } from "./services/runs.js";
import { recoveryService } from "./services/recovery.js";
import { ReviewError, reviewService } from "./services/review.js";
import { checkPolicy as checkPolicyIn, effectivePolicy } from "./services/review-policy.js";
import { listReviews } from "./services/review-kinds.js";
import { loopGuards, type LoopLimits } from "./services/loop-guards.js";
import { record } from "./services/activity.js";
import { workService, WorkError } from "./services/work.js";
import { BRIEF_TITLES, briefSlug, briefTicketBody, findBrief, openBriefTicket, refreshBriefs } from "./services/project-brief.js";
import { OBJECTIVE_STATUSES, planningService } from "./services/planning.js";
import { chaptersService } from "./services/chapters.js";
import { FeedbackError, feedbackService } from "./services/feedback.js";
import { portalRoutes, sendLogo, type PortalLimits } from "./portal.js";
import { TicketImageError, ticketImagesService } from "./services/ticket-images.js";
import { ChatError, chatService } from "./services/chat.js";
import { paService } from "./services/pa.js";
import { dashboardService } from "./services/dashboard.js";
import { RetroError, retroService } from "./services/retro.js";
import { workflowService } from "./services/workflow.js";
import { SkillError, skillsService } from "./services/skills.js";
import { hashFiles } from "./services/skill-files.js";
import { skillProposalsService } from "./services/skill-proposals.js";
import { TicketChatError, ticketChatService } from "./services/ticket-chat.js";
import { buildBrief } from "./services/brief.js";
import { wikiSemanticService } from "./services/wiki-semantic.js";
import { cleanFolder, MAX_BODY, pageSlug, WikiError, wikiService } from "./services/wiki.js";
import { DEFAULT_LIMITS, schedulerService, type Limits } from "./services/scheduler.js";
import { exportCompany } from "./services/company-export.js";
import { applyPackage, ImportError, previewPackage, readPackage } from "./services/company-import.js";
import { mcpRoutes } from "./mcp.js";
import { SecretRejected, secretsService, type LiveValidator } from "./services/secrets.js";
import { runnerSocketRoutes } from "./routes/runner-socket.js";
import { createLeader, type Leader } from "./leader.js";
import { diskService, type DiskLimits } from "./services/disk.js";
import { loginLimiter, type LoginLimits } from "./login-limit.js";
import { policyRulesService, RuleError } from "./services/policy-rules.js";
import { NotifySettings, notificationsService } from "./services/notifications.js";

/** The owner's timezone for times and days shown: the server's TZ when it's a zone name, else UK time. */
const OWNER_TZ = timeZoneOr(process.env.TZ);

/** Set on the blue/green colours only (deploy/truenas-bluegreen.yml); null on a single server. */
const colour = () => (process.env.BOSSMAN_COLOUR === "blue" || process.env.BOSSMAN_COLOUR === "green" ? process.env.BOSSMAN_COLOUR : null);
const STARTED_AT = new Date().toISOString();
const SERVER_VERSION = (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version;

export type AppOptions = {
  db: Db;
  master: MasterKey;
  liveValidator?: LiveValidator;
  /** Mark cookies Secure. Turn off only for plain-HTTP local development. */
  secureCookies?: boolean;
  logger?: boolean;
  /** Quiet time before a wiki page is embedded after a write. Default 30s. */
  semanticDebounceMs?: number;
  /** Runner heartbeat interval; tests shorten it. */
  heartbeatMs?: number;
  /** Launch-safety limits (R30); defaults in DEFAULT_LIMITS. */
  limits?: Partial<Limits>;
  /** Start a scheduler pass as soon as a wake is queued; on unless a test turns it off (R85). */
  tickOnWake?: boolean;
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
  /** The portal's own address for share links, e.g. http://192.168.68.67:3111; without it links use the owner's address. */
  portalUrl?: string;
  /** Rate limits on the public feedback portal; tests lower them. */
  portalLimits?: Partial<PortalLimits>;
  /** Clock for scheduling, sweeps and ranking; tests move it forward. */
  now?: () => Date;
  /** The runner launcher (R55), when BOSSMAN_LAUNCHER=1. */
  launcher?: LauncherOptions;
  /** The folder shared with the host deployer (docs/09-self-deploy.md); self-deploy is off without it. */
  deployerDir?: string;
  /** How long a runner update waits for runs to finish before asking the owner (default 30). */
  drainMinutes?: number;
  /** How long a recreated runner has to reconnect before the update is reported as a problem (ms, default 5 minutes). */
  drainReconnectMs?: number;
  /** Who is in charge (leader.ts). Default: a lone server that always leads. */
  leader?: Leader;
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
  const notesSvc = notesService(db);
  const agentsSvc = agentsService(db, {
    now: opts.now,
    notify: (n) => notes.notify(n),
    catalog: (companyId) => models.forCompany(companyId),
    // Tickets the CEO planned for a hire go to them once hired; one already taken or finished is left alone.
    assignPlanned: async (companyId, hired, ticketIds) => {
      for (const id of ticketIds) {
        const [t] = await db.select({ assignee: tickets.assigneeAgentId, state: tickets.systemState }).from(tickets).where(and(eq(tickets.id, id), eq(tickets.companyId, companyId)));
        if (!t || t.assignee || t.state === "done") continue;
        await work.updateTicket(id, { assigneeAgentId: hired.id, stateNote: `Assigned to ${hired.name}: the hire was approved.` }).catch((e) => app.log.warn(`Could not assign planned ticket ${id} to ${hired.name}: ${e instanceof Error ? e.message : String(e)}`));
      }
    },
  });
  const models = modelsService(db, { reveal: (id) => secretsSvc.reveal(id), fetch: opts.fetch, now: opts.now });
  const launch = launcherService(db, { runners, options: opts.launcher, fetch: opts.fetch });
  const rules = policyRulesService(db);
  const notes = notificationsService(db, { reveal: (id) => secretsSvc.reveal(id), now: opts.now, fetch: opts.fetch, log: (m) => app.log.warn(m) });
  const leader = opts.leader ?? createLeader();
  // A standby holds no runner: on demotion every runner socket is closed with 1013 ("try again later"), and they retry.
  leader.onDemote(() => {
    for (const c of app.websocketServer.clients) c.close(1013, "standby");
  });
  // A standby serves reads and login, nothing that changes or sends anything. Runner and agent paths are closed to it entirely.
  const STANDBY_WRITES = new Set(["/api/login", "/api/logout"]);
  app.addHook("onRequest", async (req, reply) => {
    if (leader.isLeader()) return;
    const path = req.url.split("?")[0]!;
    const write = req.method !== "GET" && req.method !== "HEAD" && req.method !== "OPTIONS";
    const blocked = path.startsWith("/api/runner/") || path === "/mcp" || (write && path.startsWith("/api/") && !STANDBY_WRITES.has(path));
    if (blocked) return reply.code(503).header("retry-after", "2").send({ error: "standby", message: "This server is on standby (another copy is in charge); changes go to the leader. Retry in a moment." });
  });
  await runnerSocketRoutes(app, runners, secretsSvc, { heartbeatMs: opts.heartbeatMs, isLeader: () => leader.isLeader() });
  const selfDeploy = selfDeployService(db, { dir: opts.deployerDir, notify: (n) => notes.notify(n), log: (m) => app.log.warn(m) });
  const decisionsSvc = decisionsService(db, (runnerId, command) => runners.send(runnerId, command), opts.now, (runnerId) => runners.isConnected(runnerId));
  runners.setPermissionHook((runner, event) => decisionsSvc.onPermissionRequest(runner, event));
  const deploysSvc = deploysService(db, {
    now: opts.now,
    onShipped: async (ticketId) => {
      const [t] = await db.select({ featureId: tickets.featureId }).from(tickets).where(eq(tickets.id, ticketId));
      await feedback.syncFeature(t?.featureId);
    },
  });
  const chapters = chaptersService(db, { now: opts.now });
  const feedback = feedbackService(db, {
    now: opts.now,
    // New feedback wakes the CEO to triage it, when the owner has asked for that; one wake at a time.
    onNote: async (n) => {
      if (!(await feedback.settings(n.companyId)).ceoTriage) return;
      const [ceo] = await db.select({ id: agents.id }).from(agents).where(and(eq(agents.companyId, n.companyId), eq(agents.role, "ceo")));
      if (!ceo || n.createdByAgentId === ceo.id) return;
      await scheduler.notify(ceo.id, {
        reason: "feedback",
        priority: 1,
        note: "New feedback is waiting. Use the feedback tool: read the inbox, link each request to a feature (create one if none fits) with how much it matters to them, and mark each note processed. Don't build anything yet; just triage.",
      });
    },
    onReleased: (f) => notes.notify({ companyId: f.companyId, level: "note", title: `Released: ${f.title}`, body: "Every ticket delivering it is done.", link: `#/features/${f.companyId}/${f.id}` }),
  });
  // The scheduler is made below; the chat only needs it once a message is sent.
  const chat = chatService(db, { notify: (agentId, input) => scheduler.notify(agentId, input), workspaceRoot: opts.workspaceRoot ?? "/home/node/workspaces" });
  const pa = paService(db, {
    notify: (agentId, input) => scheduler.notify(agentId, input),
    now: opts.now,
    auditRate: Number(process.env.PA_AUDIT_RATE ?? 0.1),
    timeZone: async () => (await notes.getSettings()).quietHours?.timeZone,
  });
  const scheduler = schedulerService(db, {
    runners,
    chapters,
    chat,
    funding,
    deploys: deploysSvc,
    onFeature: (id) => feedback.syncFeature(id),
    limits: opts.limits,
    workspaceRoot: opts.workspaceRoot,
    now: opts.now,
    quietHours: async () => (await notes.getSettings()).quietHours,
    tickOnWake: opts.tickOnWake,
    log: (m) => app.log.error(m),
    // Loop and runaway alerts go up the alert ladder (BOS-64): Scrum Master, CEO, then the owner.
    alert: (companyId, question, o) => alerts.raise({ companyId, question, ...o }),
  });
  decisionsSvc.setWakeHook((w) => scheduler.notify(w.agentId, w));
  const maintenance = maintenanceService(db, {
    fleet: async () => (launch.enabled ? launch.fleet() : []),
    recreate: (slug) => launch.recreate(slug),
    connected: async (companyId) => {
      const [r] = await db.select({ id: runnersTable.id }).from(runnersTable).where(eq(runnersTable.companyId, companyId));
      return !!r && runners.isConnected(r.id);
    },
    settled: () => scheduler.settled(),
    tick: () => scheduler.tick(),
    notify: (n) => notes.notify(n),
    tellRunning: async (text) => {
      const live = await db.select({ id: runsTable.id, companyId: runsTable.companyId }).from(runsTable).where(and(isNull(runsTable.endedAt), sql`${runsTable.purpose} is distinct from 'chat'`));
      for (const r of live) {
        const [runner] = await db.select({ id: runnersTable.id }).from(runnersTable).where(eq(runnersTable.companyId, r.companyId));
        if (runner) runners.send(runner.id, { type: "run.message", runId: r.id, text: `Message from Boss Man: ${text}`, interrupt: false });
      }
    },
    dir: opts.deployerDir,
    drainMinutes: opts.drainMinutes,
    reconnectMs: opts.drainReconnectMs,
    now: opts.now,
    log: (m) => app.log.warn(m),
  });
  decisionsSvc.setMaintenanceHook(maintenance);
  const engagementsSvc = engagementsService(db, { release: (ticketId) => decisionsSvc.release(ticketId), now: opts.now });
  engagementsSvc.setWakeHook((w) => scheduler.wake(w));
  decisionsSvc.setEngagementHook((id, approved) => engagementsSvc.approve(id, approved));
  deploysSvc.setWakeHook((w) => scheduler.wake(w));
  const runsSvc = runsService(db, { runners, now: opts.now });
  decisionsSvc.setCancelHook((runId) => runsSvc.cancel(runId));
  runsSvc.setWakeHook((w) => scheduler.wake(w));
  const ticketChat = ticketChatService(db, { runs: runsSvc, notify: (agentId, w) => scheduler.notify(agentId, w) });
  const semantic = wikiSemanticService(db, { reveal: (id) => secretsSvc.reveal(id), fetch: opts.fetch, log: (m) => app.log.warn(m), debounceMs: opts.semanticDebounceMs });
  app.addHook("onClose", async () => semantic.stop());
  const wiki = wikiService(db, semantic);
  const images = ticketImagesService(db, { runners });
  const dashboard = dashboardService(db, { now: opts.now });
  const workflow = workflowService(db, { now: opts.now });
  const skillsSvc = skillsService(db, { fetch: opts.fetch });
  const recovery = recoveryService(db);
  recovery.setWakeHook((w) => scheduler.wake(w));
  // A runner that comes back gets any permission verdicts it missed (R22).
  runners.onConnect((runnerId) => decisionsSvc.redeliver(runnerId));
  // Model lists come from a throwaway session on the runner, so the picker fills before any chat.
  const modelProbe = modelProbeService(db, { runners, models, now: opts.now, log: (m) => app.log.warn(m) });
  runners.onConnect((runnerId) => void modelProbe.onConnect(runnerId).catch((err) => app.log.warn({ err }, "model probe failed")));
  runners.onResume((runner, pending) => decisionsSvc.resume(runner, pending));
  decisionsSvc.setDeployHook((id, approved) => deploysSvc.approve(id, approved));
  decisionsSvc.setSelfDeployHook(selfDeploy);
  decisionsSvc.setAgentHook((ctx, companyId, approved) => agentsSvc.onDecision(ctx, companyId, approved));
  decisionsSvc.setModelChangeHook((ctx, companyId, config) => agentsSvc.applyModelChange(ctx, companyId, config));
  decisionsSvc.setTeamPlanHook((ctx, companyId, picks) => agentsSvc.hireTeam(companyId, picks.map((i) => ctx.hires[i]!), ctx.byAgentId, (agentId, skill) => skillsSvc.give(companyId, skill, agentId, ctx.byAgentId)));
  const disk = diskService(db, { send: (runnerId, command) => runners.send(runnerId, command), limits: opts.diskLimits, now: opts.now });
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
      const dayAt = (d: Date) => `${d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: OWNER_TZ })} at ${hhmm(d)}`;
      await notes.notify({
        companyId: null,
        agentId: null,
        level: "flag",
        title: `${status.source.name}: the limit "${windowLabel(window).name}" runs out about ${dayAt(f.runsOutAt)}`,
        body: `It's at ${Math.round(f.utilization * 100)}% and rising about ${Math.round((f.perHour ?? 0) * 100)}% an hour${f.resetsAt ? `, and resets ${dayAt(f.resetsAt)}` : ""}. Boss Man holds new runs on it once it's nearly used up, until it resets; pause less urgent work, or move agents to another funding source, to keep the important work going.`,
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
      void pa.onAgentMessage(event.runId, String((event.update as { text?: unknown }).text ?? "")).catch((err) => app.log.error({ err }, "PA relay failed"));
      void ticketChat.onAgentMessage(event.runId, String((event.update as { text?: unknown }).text ?? "")).catch((err) => app.log.error({ err }, "ticket reply failed"));
    }
    if (event.type === "run.ended") void chat.onRunEnded(event.runId, event.error, !!event.interrupted).catch((err) => app.log.error({ err }, "chat end failed"));
    if (event.type === "run.ended") void pa.onRunEnded(event.runId, event.error).catch((err) => app.log.error({ err }, "PA fail-open failed"));
    // A subscription window set to run out before it resets: tell the owner once (R78).
    if (event.type === "run.quota") void quotaWatch(event.fundingSourceId).catch((err) => app.log.error({ err }, "quota forecast failed"));
    // What each agent kind offers, for the model picker (R60).
    if (event.type === "runner.models") void models.record(runner.companyId, event.agentKind, event.models).catch((err) => app.log.error({ err }, "model list failed"));
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
        .then(() => (event.interrupted ? null : scheduler.afterTicketRun(event.runId)))
        .then(() => scheduler.tick())
        .catch((err) => app.log.error({ err }, "run-ended handling failed"));
    }
  });
  const sweeps = sweepService(db, {
    expireAdvice: () => decisionsSvc.expireAdvice(),
    limits: opts.sweepLimits,
    now: opts.now,
    wake: (input) => scheduler.notify(input.agentId, input),
    isConnected: (runnerId) => runners.isConnected(runnerId),
    endRun: (runId, outcome, at) => runners.endRun(runId, outcome, at),
    endUnconfirmedCancels: (t) => runsSvc.endUnconfirmedCancels(t),
    // An approved merge cut off (e.g. by a deploy's hand-over) is tried once more, in the background.
    retryLand: (ticketId) => review.startLanding(ticketId, "Boss Man (trying an interrupted merge again)"),
    expireSkills: () => skillProposals.expireOld(),
    // Stalled runs go to the Scrum Master first (BOS-119); `alerts` is built below.
    alert: (input) => alerts.raise(input),
  });
  const work = workService(db, {
    // A blocked ticket wakes its assignee when it is freed, not when it is assigned.
    onAssigned: async (t) => (t.systemState === "blocked" ? null : scheduler.notify(t.assigneeAgentId!, { ticketId: t.id, reason: "assigned" })),
    onDone: (t) => Promise.all([scheduler.onTicketDone(t.id), decisionsSvc.withdrawMergeCardsForTicket(t.id)]),
    onFeature: (id) => feedback.syncFeature(id),
    now: opts.now,
  });
  // The CEO's proposed skills (BOS-86): review by the Security Reviewer where required, the owner's decision, then install.
  const skillProposals = skillProposalsService(db, skillsSvc, {
    createTicket: (projectId, input) => work.createTicket(projectId, input),
    raiseDecision: (input, tx) => decisionsSvc.raiseSkill(input, tx),
    withdrawDecision: (id) => decisionsSvc.withdrawSkill(id),
    tell: (agentId, note) => scheduler.notify(agentId, { reason: "skill decided", note, priority: 2 }),
    closeReview: (ticketId, stateNote) => work.updateTicket(ticketId, { state: "done", outcome: "cancelled", stateNote }),
    now: opts.now,
  });
  decisionsSvc.setSkillHook((ctx, companyId, answer, by) => skillProposals.decide(companyId, ctx.proposalId, answer, by));
  const loops = loopGuards(db, { limits: opts.loopLimits, now: opts.now, alert: (input) => alerts.raise(input) });
  // The Scrum Master watchdog (BOS-58): its sweep runs on the leader's timer (main.ts), its actions through the Scrum Master's MCP tool.
  const watchdog = watchdogService(db, {
    notify: (agentId, input) => scheduler.notify(agentId, input),
    nudge: (input) => scheduler.nudge(input),
    raise: (input) => decisionsSvc.raise(input),
    assign: (ticketId, agentId) => work.updateTicket(ticketId, { assigneeAgentId: agentId }),
    restoreState: (ticketId, state) => work.updateTicket(ticketId, { state, overLimit: true }),
    // A trip means the Scrum Master is the problem: straight to the owner.
    alert: (companyId, question) => decisionsSvc.raise({ companyId, agentId: null, question, options: ["Got it"], recommended: "Got it" }),
    notifyOwner: (n) => notes.notify({ ...n, agentId: null }),
    localHour: (t) => Number(new Intl.DateTimeFormat("en-GB", { hour: "2-digit", hourCycle: "h23", timeZone: OWNER_TZ }).format(t)),
    now: opts.now,
    log: (m) => app.log.error(m),
  });
  // Workflow retros (docs/19): the leader's timer starts them (main.ts), the retro agent's MCP tools fill them, and decisions apply the changes.
  const retro = retroService(db, { agents: agentsSvc, skills: skillsSvc, watchdog, notify: (agentId, input) => scheduler.notify(agentId, input), now: opts.now, log: (m) => app.log.error(m) });
  decisionsSvc.setRetroHook(retro);
  const alerts = alertLadder(db, { notify: (agentId, input) => scheduler.notify(agentId, input), answer: (id, answer, extra) => decisionsSvc.answer(id, answer, extra), watchdog, nudge: (input) => scheduler.nudge(input), now: opts.now });
  const gitHosts = gitHostService({ fetch: opts.fetch });
  const setup = setupService(db, { isConnected: (id) => runners.isConnected(id) });
  const review = reviewService(db, {
    runners,
    work,
    loops,
    gitHosts,
    gitToken: async (companyId) => (await secretsSvc.resolveCompanyEnv(companyId, "pull_request")).GIT_TOKEN,
    notes,
    isLeader: () => leader.isLeader(),
  });
  review.setWakeHook((agentId, w) => scheduler.notify(agentId, w));
  decisionsSvc.setLoopHooks({
    sendBack: (ticketId, text, reviewer) => review.sendBack(ticketId, text, reviewer),
    // A merge that can't run now (e.g. the runner is offline) is put back to the owner, not lost.
    land: (ticketId, reviewer) =>
      review.land(ticketId, reviewer).catch(async (err) => {
        const [t] = await db.select({ companyId: tickets.companyId, title: tickets.title }).from(tickets).where(eq(tickets.id, ticketId));
        if (t) await decisionsSvc.raise({ companyId: t.companyId, agentId: null, question: `You approved "${t.title}", but it couldn't be merged: ${(err as Error).message} Approve it again from the ticket once that's fixed.`, options: ["Got it"], recommended: "Got it", steps: ["Fix what stopped the merge, then open the ticket and approve the merge again."] });
      }),
    // An answer that arrives after the ticket moved on is told to the owner, not thrown back at them.
    landAgain: (ticketId, skipChecks) =>
      review.startLanding(ticketId, "the owner", null, { skipChecks }).catch(async (err) => {
        const [t] = await db.select({ companyId: tickets.companyId, title: tickets.title }).from(tickets).where(eq(tickets.id, ticketId));
        if (t) await decisionsSvc.raise({ companyId: t.companyId, agentId: null, question: `"${t.title}" couldn't be merged: ${(err as Error).message} Approve it again from the ticket once that's fixed.`, options: ["Got it"], recommended: "Got it", steps: ["Fix what stopped the merge, then open the ticket and approve the merge again."] });
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
  await mcpRoutes(app, db, { decisions: decisionsSvc, engagements: engagementsSvc, deploys: deploysSvc, runs: runsSvc, review, notes, chapters, work, feedback, ticketChat, wiki, skills: skillsSvc, skillProposals, agents: agentsSvc, pa, images, watchdog, alerts, retro }, { onTicketDone: (ticketId, runId) => Promise.all([scheduler.onTicketDone(ticketId, runId), decisionsSvc.withdrawMergeCardsForTicket(ticketId)]), onTicketReview: (ticketId, agentId, runId) => scheduler.onTicketReview(ticketId, agentId, runId), nudge: (i) => scheduler.nudge(i), wake: (agentId, i) => scheduler.notify(agentId, i) });
  // The feedback portal's public API, on this listener too, so the owner can try it here.
  await portalRoutes(app, { feedback, secureCookies: opts.secureCookies ?? true, limits: opts.portalLimits, now: opts.now ? () => opts.now!().getTime() : undefined });

  app.setErrorHandler((err, _req, reply) => {
    // `message` is what the web app shows, so it names the first problem and its field.
    if (err instanceof ZodError) {
      const i = err.issues[0];
      return reply.code(400).send({ error: "invalid_request", message: i ? `${i.path.length ? `${i.path.join(".")}: ` : ""}${i.message}` : "The request isn't valid.", issues: err.issues });
    }
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

  /** The signed-in owner's username, for the log. */
  async function ownerName(req: FastifyRequest) {
    const token = req.cookies[SESSION_COOKIE];
    const [row] = token ? await db.select({ username: owners.username }).from(sessions).innerJoin(owners, eq(owners.id, sessions.ownerId)).where(eq(sessions.tokenHash, hashToken(token))) : [];
    return row?.username ?? "the owner";
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

  // Public and cheap: no DB. Build facts only, nothing secret. The image HEALTHCHECK and the deploy script read `ok`.
  const build = () => ({ version: SERVER_VERSION, commit: process.env.BOSSMAN_COMMIT || "dev", role: leader.role(), colour: colour(), startedAt: STARTED_AT });
  app.get("/api/health", async () => ({ ok: true, ...build() }));
  // Readiness: also proves the database answers.
  app.get("/api/ready", async (_req, reply) => {
    try {
      await db.execute(sql`select 1`);
      return { ok: true, db: true, ...build() };
    } catch {
      return reply.code(503).send({ ok: false, db: false, ...build() });
    }
  });

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
    /** Blue/green at a glance: each colour's own /api/health over the compose network, or down when it doesn't answer. */
    owner.get("/api/bluegreen", async () => {
      const self = colour();
      if (!self) return { enabled: false };
      const peek = async (c: string) => {
        if (c === self) return { ...build(), colour: c, up: true };
        try {
          const r = await fetch(`http://server-${c}:3100/api/health`, { signal: AbortSignal.timeout(2000) });
          const h = (await r.json()) as { role?: string; commit?: string; startedAt?: string };
          return { colour: c, up: r.ok, role: h.role ?? null, commit: h.commit ?? null, startedAt: h.startedAt ?? null };
        } catch {
          return { colour: c, up: false, role: null, commit: null, startedAt: null };
        }
      };
      return { enabled: true, self, colours: await Promise.all(["blue", "green"].map(peek)) };
    });

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
        const [company] = await tx.insert(companies).values({ name: body.name, mission: body.mission, ticketPrefix: defaultTicketPrefix(body.name) }).returning();
        const [ceo] = await tx
          .insert(agents)
          .values({ companyId: company!.id, name: body.ceo.name, role: "ceo", agentKind: body.ceo.agentKind, model: body.ceo.model, instructions: CEO_TEMPLATE.instructions })
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
      const b = z.object({ name: z.string().trim().min(1).max(80), mission: z.string().max(2000).nullable(), ownerApprovesEngagements: z.boolean(), goalCheckDays: z.number().int().min(1).max(365), nudgesPerHour: z.number().int().min(1).max(1000), adviceTimeoutMinutes: z.number().int().min(5).max(1440), diskCapGb: z.number().positive().max(100_000).nullable(), ticketPrefix: z.string().trim().toUpperCase().regex(TICKET_PREFIX, "1 to 10 letters or digits") }).partial().parse(req.body);
      const { diskCapGb, ...rest } = b;
      const patch = { ...rest, ...(diskCapGb !== undefined ? { diskCapBytes: diskCapGb === null ? null : Math.round(diskCapGb * 1024 ** 3) } : {}) };
      const [c] = await db.update(companies).set(patch).where(eq(companies.id, id)).returning();
      return c ?? reply.code(404).send({ error: "not_found" });
    });

    owner.get("/api/companies", async () => {
      const rows = await db.select().from(companies).orderBy(companies.name);
      // Retired agents (R62) only show on the Agents page, so they can't be given new work.
      const allAgents = await db.select().from(agents).where(isNull(agents.retiredAt));
      const allProjects = await db.select({ id: projects.id, companyId: projects.companyId, name: projects.name, starred: projects.starred }).from(projects).where(isNull(projects.archivedAt)).orderBy(projects.name);
      return rows.map((c) => ({ ...c, agents: allAgents.filter((a) => a.companyId === c.id), projects: allProjects.filter((p) => p.companyId === c.id) }));
    });

    /** What each risk tier means, in the server's own words, for the help next to every risk picker (R61). */
    // With ?companyId the reviewer and sign-off come from that company's review policy.
    owner.get("/api/risk-tiers", async (req) => {
      const { companyId } = z.object({ companyId: Uuid.optional() }).parse(req.query);
      if (!companyId) return RISK_TIERS.map((tier) => ({ tier, summary: riskSummary(tier) }));
      const [c] = await db.select({ policy: companies.reviewPolicy }).from(companies).where(eq(companies.id, companyId));
      if (!c) return RISK_TIERS.map((tier) => ({ tier, summary: riskSummary(tier) }));
      const names = new Map((await db.select({ id: agents.id, name: agents.name }).from(agents).where(eq(agents.companyId, companyId))).map((a) => [a.id, a.name]));
      const who = (ref: string) => (ref === "ceo" ? "the CEO" : ref === SENIOR_DEV ? "the Senior Developer (the CEO until one is hired)" : (names.get(ref) ?? "the CEO"));
      return RISK_TIERS.map((tier) => ({ tier, summary: riskSummary(tier, c.policy[tier].ownerSignoff, who(c.policy[tier].reviewer)) }));
    });

    // Review routing: per risk tier, who approves plans, who reviews code and whether the owner signs off.
    // Validates the policy, and that every agent it names belongs to the company.
    const checkPolicy = (companyId: string, body: unknown) => checkPolicyIn(db, companyId, body);
    owner.get("/api/companies/:id/review-policy", async (req, reply) => {
      const [c] = await db.select({ policy: companies.reviewPolicy }).from(companies).where(eq(companies.id, IdParam.parse(req.params).id));
      return c ? c.policy : reply.code(404).send({ error: "not_found" });
    });
    owner.put("/api/companies/:id/review-policy", async (req, reply) => {
      const { id } = IdParam.parse(req.params);
      const p = await checkPolicy(id, req.body);
      if (typeof p === "string") return reply.code(400).send({ error: "invalid_review_policy", message: p });
      const [c] = await db.update(companies).set({ reviewPolicy: p }).where(eq(companies.id, id)).returning({ policy: companies.reviewPolicy });
      return c ? c.policy : reply.code(404).send({ error: "not_found" });
    });
    /** The project's own policy, or null when it uses the company's. */
    owner.get("/api/projects/:id/review-policy", async (req, reply) => {
      const [p] = await db.select({ policy: projects.reviewPolicy }).from(projects).where(eq(projects.id, IdParam.parse(req.params).id));
      return p ? { policy: p.policy } : reply.code(404).send({ error: "not_found" });
    });
    owner.put("/api/projects/:id/review-policy", async (req, reply) => {
      const { id } = IdParam.parse(req.params);
      const [proj] = await db.select({ companyId: projects.companyId }).from(projects).where(eq(projects.id, id));
      if (!proj) return reply.code(404).send({ error: "not_found" });
      const p = await checkPolicy(proj.companyId, req.body);
      if (typeof p === "string") return reply.code(400).send({ error: "invalid_review_policy", message: p });
      await db.update(projects).set({ reviewPolicy: p }).where(eq(projects.id, id));
      return { policy: p };
    });
    owner.delete("/api/projects/:id/review-policy", async (req, reply) => {
      const [p] = await db.update(projects).set({ reviewPolicy: null }).where(eq(projects.id, IdParam.parse(req.params).id)).returning({ id: projects.id });
      return p ? { policy: null } : reply.code(404).send({ error: "not_found" });
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
        const grant = await secretsSvc.grant(id, body.companyId, body.envName, body.deployTargetId);
        void modelProbe.onGrant(body.companyId, body.envName).catch((err) => app.log.warn({ err }, "model probe failed"));
        return reply.code(201).send(grant);
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
      const q = z
        .object({
          before: z.coerce.date().optional(),
          limit: z.coerce.number().int().min(1).max(200).optional(),
          status: z.enum(["unread", "read"]).optional(),
          level: z.enum(["note", "flag", "page", "ask"]).optional(),
          company: z.union([z.literal("none"), Uuid]).optional(),
        })
        .parse(req.query);
      return { items: await notes.list(q), unread: await notes.unread() };
    });
    owner.post("/api/notifications/read", async (req) => {
      const b = z.object({ ids: z.array(Uuid).max(500).optional(), all: z.boolean().optional() }).parse(req.body);
      await notes.markRead(b.all ? "all" : (b.ids ?? []));
      return { unread: await notes.unread() };
    });
    // Run limits: how many agents may work at once (instance-wide and per company); per-agent stays fixed at 1.
    const runLimits = async () => {
      const [row] = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, "run_limits"));
      const v = row?.value as { instance?: number; company?: number } | undefined;
      return { instance: v?.instance ?? scheduler.limits.instance, company: v?.company ?? scheduler.limits.company, defaults: { instance: DEFAULT_LIMITS.instance, company: DEFAULT_LIMITS.company } };
    };
    owner.get("/api/run-limits", async () => runLimits());
    owner.put("/api/run-limits", async (req) => {
      const value = z.object({ instance: z.number().int().min(1).max(32), company: z.number().int().min(1).max(16) }).refine((b) => b.company <= b.instance, { message: "The company limit can't be higher than the all-companies limit." }).parse(req.body);
      await db.insert(settings).values({ key: "run_limits", value }).onConflictDoUpdate({ target: settings.key, set: { value } });
      return runLimits();
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
      safeOnly: z.boolean().optional(),
      scratchOnly: z.boolean().optional(),
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
    // The owner asks in plain words; the CEO drafts the rule and it comes back as a decision.
    owner.post("/api/companies/:id/rule-requests", async (req, reply) => {
      const { id } = IdParam.parse(req.params);
      const { text } = z.object({ text: z.string().trim().min(1).max(1000) }).parse(req.body);
      const [ceo] = await db.select({ id: agents.id, name: agents.name }).from(agents).where(and(eq(agents.companyId, id), eq(agents.role, "ceo"), isNull(agents.retiredAt)));
      if (!ceo) return reply.code(409).send({ error: "rejected", message: "This company has no CEO to draft the rule." });
      await scheduler.notify(ceo.id, {
        reason: "rule request",
        priority: 3,
        note: `The owner wants a permission rule. In their words: "${text}"\n\nHow rules work: when an agent asks to use a tool, the first matching rule decides. The company's rules are checked in order, then rules for every company, then the built-in defaults. A rule matches on kinds (${TOOL_KINDS.join(", ")}), commandPattern (a regex on the shell command), titlePattern (a regex on the tool's title; MCP tools are titled mcp__<server>__<tool>), and its outcome is allow, ceo (you decide), owner (they decide) or deny.\n\nCall propose_rule once, with a plain-English explanation for a non-developer: what the rule matches, what happens, and examples of requests it would and wouldn't catch. The owner will add it or answer in their own words.`,
      });
      return reply.code(202).send({ ceo });
    });
    owner.post("/api/policy-rules/test", async (req) => {
      const b = z.object({ companyId: Uuid, command: z.string().max(5000).optional(), title: z.string().max(500).optional(), kind: z.string().max(40).optional() }).parse(req.body);
      return rules.test(b.companyId, { title: b.title ?? b.command ?? null, kind: b.kind ?? (b.command ? "execute" : null), rawInput: b.command ? { command: b.command } : null });
    });

    owner.delete("/api/grants/:id", async (req, reply) => {
      const { id } = IdParam.parse(req.params);
      return (await secretsSvc.revoke(id)) ? reply.code(204).send() : reply.code(404).send({ error: "not_found" });
    });

    owner.put("/api/grants/:id/agents", async (req, reply) => {
      const { id } = IdParam.parse(req.params);
      const { agentIds } = z.object({ agentIds: z.array(Uuid).max(200) }).parse(req.body);
      const r = await secretsSvc.setGrantAgents(id, agentIds);
      if (r.ok) return reply.code(204).send();
      return r.reason === "not_found" ? reply.code(404).send({ error: "not_found" }) : reply.code(400).send({ error: "invalid_agents", message: "Every agent must belong to the grant's company." });
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
      return { registered: true, runnerId: r.id, connected: runners.isConnected(r.id), lastSeenAt: r.lastSeenAt, imageVersion: r.imageVersion, diskUsedBytes: r.diskUsedBytes, diskCheckedAt: r.diskCheckedAt, addons: r.addons, launcher };
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

    // Extra MCP servers (tool servers). A token is only ever named here (secretEnv); the runner looks it up from the run's granted secrets.
    const McpServerInput = z.object({
      name: z.string().trim().toLowerCase().regex(/^[a-z][a-z0-9-]{0,31}$/, "Use lower-case letters, digits and hyphens, starting with a letter (32 characters at most).").refine((n) => n !== "bossman", "That name is Boss Man's own."),
      url: z.string().max(500).refine((u) => { try { return ["http:", "https:"].includes(new URL(u).protocol); } catch { return false; } }, "Use an http:// or https:// address."),
      transport: z.enum(["http", "sse"]),
      secretEnv: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/, "Use an environment variable name like SCRAPLING_MCP_TOKEN.").nullable().default(null),
      headerName: z.string().regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,100}$/, "Not a valid header name.").default("Authorization"),
      headerValue: z.string().max(200).default("Bearer {secret}"),
    }).refine((v) => !v.secretEnv || v.headerValue.includes("{secret}"), { path: ["headerValue"], message: "The header value must contain {secret}." });

    owner.get("/api/companies/:id/mcp-servers", async (req) => {
      const { id } = IdParam.parse(req.params);
      // Says whether each server's token secret is granted, since a mistyped name silently leaves the server out of every run.
      const granted = new Set((await db.select({ env: secretGrants.envName }).from(secretGrants).where(eq(secretGrants.companyId, id))).map((g) => g.env));
      return (await db.select().from(mcpServers).where(eq(mcpServers.companyId, id)).orderBy(mcpServers.name)).map((m) => ({ ...m, secretGranted: !m.secretEnv || granted.has(m.secretEnv) }));
    });
    owner.post("/api/companies/:id/mcp-servers", async (req, reply) => {
      const { id } = IdParam.parse(req.params);
      const b = McpServerInput.parse(req.body);
      const [c] = await db.select({ id: companies.id }).from(companies).where(eq(companies.id, id));
      if (!c) return reply.code(404).send({ error: "not_found" });
      const [row] = await db.insert(mcpServers).values({ ...b, companyId: id }).onConflictDoNothing().returning();
      return row ? reply.code(201).send(row) : reply.code(409).send({ error: "name_taken", message: "This company already has a tool server with that name." });
    });
    owner.delete("/api/mcp-servers/:id", async (req, reply) => {
      const [row] = await db.delete(mcpServers).where(eq(mcpServers.id, IdParam.parse(req.params).id)).returning({ id: mcpServers.id });
      return row ? reply.code(204).send() : reply.code(404).send({ error: "not_found" });
    });

    // Funding sources, cost and quota (R27–R29).
    const FundingFields = z.object({
      name: z.string().trim().min(1).max(80),
      kind: z.enum(FUNDING_KINDS),
      provider: z.enum(FUNDING_PROVIDERS),
      monthlyGrantUsd: z.number().nonnegative().optional(),
      cycleAnchor: z.coerce.date().optional(),
      secretId: Uuid.optional(),
    });
    const FundingInput = FundingFields.superRefine((v, ctx) => {
      const problem = fundingComboError(v.kind, v.provider);
      if (problem) ctx.addIssue({ code: "custom", path: ["provider"], message: problem });
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

    // Cost events keep their amounts, but readers use the source's current kind, so a kind change also recounts past spend.
    owner.patch("/api/funding-sources/:id", async (req, reply) => {
      const { id } = IdParam.parse(req.params);
      const b = FundingFields.partial().refine((v) => Object.keys(v).length > 0, "Nothing to change.").parse(req.body);
      const [cur] = await db.select().from(fundingSources).where(eq(fundingSources.id, id));
      if (!cur) return reply.code(404).send({ error: "not_found" });
      const [clash] = b.name && b.name !== cur.name ? await db.select({ id: fundingSources.id }).from(fundingSources).where(eq(fundingSources.name, b.name)) : [];
      if (clash) return reply.code(409).send({ error: "already_exists", message: `There's already a funding source called ${b.name}.` });
      const problem = fundingComboError(b.kind ?? cur.kind, b.provider ?? cur.provider);
      if (problem) return reply.code(400).send({ error: "invalid_request", message: problem });
      const row = await funding.update(id, {
        name: b.name,
        kind: b.kind,
        provider: b.provider,
        monthlyGrantMicros: b.monthlyGrantUsd != null ? usdToMicros(b.monthlyGrantUsd) : undefined,
        cycleAnchor: b.cycleAnchor,
        secretId: b.secretId,
      });
      models.forget(id);
      return row;
    });

    owner.delete("/api/funding-sources/:id", async (req, reply) => {
      const { id } = IdParam.parse(req.params);
      const r = await funding.remove(id);
      if (!r) return reply.code(404).send({ error: "not_found" });
      if (r === "has_history") return reply.code(409).send({ error: "has_history", message: "This source has recorded spend or quota readings, and deleting it would erase them. Edit it instead, or move its agents to another source." });
      models.forget(id);
      return r;
    });

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
      acceptanceCriteria: acceptanceCriteriaSchema,
      noCode: z.boolean(),
      risk: z.enum(RISK_TIERS).nullable(),
      size: z.number().refine(isTaskSize, `Size is one of ${SIZE_SCALE}.`).nullable(),
      planFirst: z.boolean(),
      featureId: Uuid.nullable(),
      overLimit: z.boolean(),
    });

    owner.get("/api/companies/:id/projects", async (req) => {
      const { id } = IdParam.parse(req.params);
      return db.select().from(projects).where(eq(projects.companyId, id)).orderBy(projects.name);
    });

    // New scope from the owner: noted for the CEO's next run, which checks the team covers it (docs/13).
    // shortcut: read-modify-write of one settings row; two owner adds in the same instant could drop one line.
    const teamCheck = async (companyId: string, what: string) => {
      const key = `team-scope:${companyId}`;
      const [row] = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, key));
      const value = [...((row?.value as string[] | undefined) ?? []), what].slice(-10);
      await db.insert(settings).values({ key, value }).onConflictDoUpdate({ target: settings.key, set: { value } });
    };

    owner.post("/api/companies/:id/projects", async (req, reply) => {
      const { id } = IdParam.parse(req.params);
      const body = z.object({ name: z.string().trim().min(1).max(80), columns: z.array(Column).optional() }).parse(req.body);
      const p = await work.createProject(id, body.name, body.columns);
      await teamCheck(id, `created a project, "${p.name}" (${p.id})`);
      return reply.code(201).send(p);
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
          starred: z.boolean(),
          monthlyCapUsd: z.number().positive().nullable(),
          archived: z.boolean(),
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
      const { ticketCostCapUsd, monthlyCapUsd, archived, ...fields } = b;
      // Archiving hides the project from agents, so work still open in it would be stranded.
      if (archived) {
        const [open] = await db.select({ n: count() }).from(tickets).where(and(eq(tickets.projectId, id), ne(tickets.systemState, "done")));
        if (open!.n) return reply.code(409).send({ error: "open_tickets", message: `This project has ${open!.n} open task${open!.n === 1 ? "" : "s"}. Finish or cancel ${open!.n === 1 ? "it" : "them"} before archiving.` });
      }
      if (archived !== undefined) Object.assign(fields, { archivedAt: archived ? new Date() : null, ...(archived ? { starred: false } : {}) });
      // A new repo address finds its host (R59), unless the owner set one with it.
      if (fields.repoUrl !== undefined && fields.gitHost === undefined) {
        const found = fields.repoUrl ? await gitHosts.detect(fields.repoUrl) : null;
        Object.assign(fields, { gitHost: found?.gitHost ?? null, gitApiBase: found?.gitApiBase ?? null });
      }
      const [p] = await db
        .update(projects)
        .set({ ...fields, ...(ticketCostCapUsd !== undefined ? { ticketCostCapMicros: ticketCostCapUsd === null ? null : usdToMicros(ticketCostCapUsd) } : {}), ...(monthlyCapUsd !== undefined ? { monthlyCapMicros: monthlyCapUsd === null ? null : usdToMicros(monthlyCapUsd) } : {}) })
        .where(eq(projects.id, id))
        .returning();
      return p ?? reply.code(404).send({ error: "not_found" });
    });

    // What a project has cost (money only, as on the dashboard: subscription use is excluded). "This month" is the UTC calendar month.
    owner.get("/api/projects/:id/spend", async (req, reply) => {
      const { id } = IdParam.parse(req.params);
      const [p] = await db.select({ cap: projects.ticketCostCapMicros, monthlyCap: projects.monthlyCapMicros }).from(projects).where(eq(projects.id, id));
      if (!p) return reply.code(404).send({ error: "not_found" });
      const t = opts.now ? opts.now() : new Date();
      const monthStart = monthStartUtc(t);
      const month = await projectSpendMicros(db, id, monthStart);
      const all = await projectSpendMicros(db, id);
      const sum = sql<string>`sum(${costEvents.costMicros})`;
      const top = await db
        .select({ id: tickets.id, title: tickets.title, micros: sum })
        .from(costEvents)
        .innerJoin(fundingSources, eq(fundingSources.id, costEvents.fundingSourceId))
        .innerJoin(runsTable, eq(runsTable.id, costEvents.runId))
        .innerJoin(tickets, eq(tickets.id, runsTable.ticketId))
        .where(and(eq(tickets.projectId, id), ne(fundingSources.kind, "subscription")))
        .groupBy(tickets.id, tickets.title)
        .orderBy(desc(sum))
        .limit(10);
      // Tokens from every run on the project's tasks, subscription runs included (they have no money cost but still use the plan).
      const tokenSum = (since?: Date) =>
        db
          .select({ input: sql<string>`coalesce(sum(${runsTable.inputTokens}), 0)`, output: sql<string>`coalesce(sum(${runsTable.outputTokens}), 0)` })
          .from(runsTable)
          .innerJoin(tickets, eq(tickets.id, runsTable.ticketId))
          .where(since ? and(eq(tickets.projectId, id), gte(runsTable.startedAt, since)) : eq(tickets.projectId, id))
          .then(([r]) => ({ input: Number(r?.input ?? 0), output: Number(r?.output ?? 0) }));
      const tokens = { month: await tokenSum(monthStart), total: await tokenSum() };
      return { tokens, monthMicros: month, totalMicros: all, ticketCostCapMicros: p.cap, monthlyCapMicros: p.monthlyCap, monthStart: monthStart.toISOString(), topTickets: top.map((r) => ({ id: r.id, title: r.title, micros: Number(r.micros) })) };
    });

    // The setup wizard (R56): where the owner is in it, and what's still to do for a company.
    owner.get("/api/setup-progress", async () => setup.progress());
    owner.put("/api/setup-progress", async (req) => setup.save(z.object({ dismissed: z.boolean(), step: z.number().int().min(0).max(10), companyId: Uuid.nullable() }).partial().parse(req.body)));
    owner.get("/api/companies/:id/setup-checklist", async (req, reply) => (await setup.checklist(IdParam.parse(req.params).id)) ?? reply.code(404).send({ error: "not_found" }));

    // Is the company's git token good for this repo (R58, R56)? One read of the repo, with its permissions.
    owner.post("/api/projects/:id/check-git-token", async (req, reply) => {
      const { id } = IdParam.parse(req.params);
      const [p] = await db.select().from(projects).where(eq(projects.id, id));
      if (!p) return reply.code(404).send({ error: "not_found" });
      const a = p.repoUrl ? parseRepoUrl(p.repoUrl) : null;
      if (!a || (p.gitHost !== "github" && p.gitHost !== "gitea") || !p.gitApiBase) return { ok: false, canPush: false, message: "Boss Man doesn't know this project's git host yet; save its repo address first." };
      const token = (await secretsSvc.resolveCompanyEnv(p.companyId, "check")).GIT_TOKEN;
      if (!token) return { ok: false, canPush: false, message: "The company has no GIT_TOKEN yet." };
      try {
        return await gitHosts.checkAccess({ kind: p.gitHost, apiBase: p.gitApiBase, owner: a.owner, repo: a.repo }, token);
      } catch (err) {
        return { ok: false, canPush: false, message: `Couldn't reach the host: ${(err as Error).message}` };
      }
    });

    // Does the company's Claude setup-token work (R58)? Only Claude Code can tell, so the runner
    // runs one tiny prompt with it, which uses a little of the subscription allowance.
    owner.post("/api/companies/:id/check-claude", async (req, reply) => {
      const { id } = IdParam.parse(req.params);
      const [c] = await db.select({ id: companies.id }).from(companies).where(eq(companies.id, id));
      if (!c) return reply.code(404).send({ error: "not_found" });
      const [grant] = await db.select({ id: secretGrants.id }).from(secretGrants).where(and(eq(secretGrants.companyId, id), eq(secretGrants.envName, "CLAUDE_CODE_OAUTH_TOKEN")));
      if (!grant) return { ok: false, message: "The company has no Claude setup-token yet." };
      const [runner] = await db.select({ id: runnersTable.id }).from(runnersTable).where(eq(runnersTable.companyId, id));
      if (!runner || !runners.isConnected(runner.id)) return { ok: false, message: "The company's runner isn't connected, and the check runs there." };
      try {
        return await runners.request<{ ok: boolean; message: string }>(runner.id, (requestId) => ({ type: "credential.check", requestId }), 2 * 60_000);
      } catch (err) {
        return { ok: false, message: `The runner couldn't run the check: ${(err as Error).message}` };
      }
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

    // The project brief: a wiki page the CEO writes from the code. One open brief ticket at a time.
    const briefStatus = async (projectId: string) => {
      const [p] = await db.select().from(projects).where(eq(projects.id, projectId));
      if (!p) return null;
      const b = await findBrief(db, p.companyId, p.id);
      return { p, exists: !!b, status: { slug: briefSlug(p.id), exists: !!b, commit: b?.commit ?? null, branch: b?.branch ?? null, updatedAt: b?.updatedAt ?? null, ticketId: (await openBriefTicket(db, p.id))?.id ?? null } };
    };
    owner.get("/api/projects/:id/brief", async (req, reply) => (await briefStatus(IdParam.parse(req.params).id))?.status ?? reply.code(404).send({ error: "not_found" }));
    owner.post("/api/projects/:id/brief", async (req, reply) => {
      const b = await briefStatus(IdParam.parse(req.params).id);
      if (!b) return reply.code(404).send({ error: "not_found" });
      const open = await openBriefTicket(db, b.p.id);
      if (open) return open;
      const [ceo] = await db.select({ id: agents.id }).from(agents).where(and(eq(agents.companyId, b.p.companyId), eq(agents.role, "ceo"), isNull(agents.retiredAt)));
      if (!ceo) throw new WorkError(400, "This company has no CEO to write the brief. Add one first.");
      const ticket = await work.createTicket(b.p.id, { title: b.exists ? BRIEF_TITLES[1]! : BRIEF_TITLES[0]!, body: briefTicketBody(b.p, b.exists), assigneeAgentId: ceo.id, noCode: true });
      return reply.code(201).send(ticket);
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
        .select({ t: tickets, project: projects.name, repoUrl: projects.repoUrl, defaultBranch: projects.defaultBranch, landing: projects.landing, verifyCommand: projects.verifyCommand, assignee: agents.name, prefix: companies.ticketPrefix })
        .from(tickets)
        .innerJoin(projects, eq(projects.id, tickets.projectId))
        .innerJoin(companies, eq(companies.id, tickets.companyId))
        .leftJoin(agents, eq(agents.id, tickets.assigneeAgentId))
        .where(eq(tickets.id, id));
      if (!row) return reply.code(404).send({ error: "not_found" });
      return { ...row.t, ref: ticketRef(row.prefix, row.t.number), project: row.project, repoUrl: row.repoUrl, defaultBranch: row.defaultBranch, landing: row.landing, verifyCommand: row.verifyCommand, ownerSignoff: ruleFor(await effectivePolicy(db, row.t), row.t.risk).ownerSignoff, assignee: row.assignee };
    });

    // Images attached to a ticket (screenshots), oldest first; the bytes are served one at a time.
    owner.get("/api/tickets/:id/images", async (req) => images.list(IdParam.parse(req.params).id));
    // The owner pastes or picks an image or file (a task's description, a ticket message, a chat); it's put in the text as Markdown.
    owner.post("/api/companies/:id/images", { bodyLimit: 15 * 1024 * 1024 }, async (req, reply) => {
      const { id } = IdParam.parse(req.params);
      const b = z.object({ data: z.string().min(1), name: z.string().max(200).optional(), ticketId: Uuid.optional() }).parse(req.body);
      try {
        return reply.code(201).send(await images.upload(id, { ticketId: b.ticketId, name: b.name, base64: b.data }));
      } catch (err) {
        if (err instanceof TicketImageError) return reply.code(422).send({ error: "rejected", message: err.message });
        throw err;
      }
    });
    owner.get("/api/ticket-images/:id", async (req, reply) => {
      const img = await images.get(IdParam.parse(req.params).id);
      if (!img) return reply.code(404).send({ error: "not_found" });
      if (img.type.startsWith("image/")) return sendLogo(reply, img);
      // Anything else is only ever downloaded, never shown in the page, so an uploaded HTML or SVG file can't run here.
      const safe = img.name.replace(/[^\w.\- ]/g, "_");
      return reply.type("application/octet-stream").header("x-content-type-options", "nosniff").header("content-disposition", `attachment; filename="${safe}"`).header("cache-control", "private, no-cache").send(img.bytes);
    });

    // The reviews a ticket needs, every round, newest first (review kinds).
    owner.get("/api/tickets/:id/reviews", async (req) => listReviews(db, IdParam.parse(req.params).id));

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
      const { text, interrupt, agentId } = z.object({ text: z.string().trim().min(1).max(4000), interrupt: z.boolean().optional(), agentId: z.string().uuid().optional() }).parse(req.body);
      return ticketChat
        .ownerSays(id, text, { interrupt, agentId })
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
    // Skills the CEO proposed: the owner answers through the decision; these show what is behind it.
    owner.get("/api/companies/:id/skill-proposals", async (req) => skillProposals.list(IdParam.parse(req.params).id));
    owner.get("/api/companies/:id/skill-proposals/:pid", async (req, reply) => {
      const { id, pid } = z.object({ id: Uuid, pid: Uuid }).parse(req.params);
      return skillProposals.detail(id, pid).catch(skillErrors(reply));
    });
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
        // The owner's own add is their call, but it skips the review: say so in the log.
        for (const x of added) await record(db, { companyId: id, kind: "skill.added_by_owner", summary: `The owner added the skill ${x.name} directly (${b.from === "link" ? `from ${b.url}` : b.from}). Added by the owner, not security-reviewed.` });
        return reply.code(201).send(added.map((s) => ({ id: s.id, name: s.name, sourceRef: s.sourceRef })));
      } catch (err) {
        return skillErrors(reply)(err);
      }
    });
    // Other companies' skills, to copy into this one (not which agents hold them).
    owner.get("/api/companies/:id/skills/elsewhere", async (req) => {
      const { id } = IdParam.parse(req.params);
      const { q } = z.object({ q: z.string().max(100).default("") }).parse(req.query);
      return skillsSvc.searchElsewhere(id, q);
    });
    owner.post("/api/companies/:id/skills/copy", async (req, reply) => {
      const { id } = IdParam.parse(req.params);
      const { skillId } = z.object({ skillId: Uuid }).parse(req.body);
      return skillsSvc.copyFrom(id, skillId).then((s) => reply.code(201).send(s), skillErrors(reply));
    });
    owner.get("/api/companies/:id/skills/:skillId", async (req, reply) => {
      const { id, skillId } = SkillParams.parse(req.params);
      return skillsSvc.get(id, skillId).catch(skillErrors(reply));
    });
    owner.put("/api/companies/:id/skills/:skillId", async (req, reply) => {
      const { id, skillId } = SkillParams.parse(req.params);
      const b = z.object({ name: z.string().trim().min(1).max(64), description: z.string().trim().min(1).max(1024), body: z.string().max(100_000) }).parse(req.body);
      try {
        // The edit replaces the skill's files: keep the old text so the log says what actually changed.
        const old = await skillsSvc.get(id, skillId);
        const oldSkillMd = old.files.find((f) => f.path === "SKILL.md")?.text ?? "";
        const s = await skillsSvc.write(id, { ...b, replaceId: skillId });
        const newSkillMd = Buffer.from(s.files.find((f) => f.path === "SKILL.md")?.content ?? "", "base64").toString("utf8");
        const newBundle = hashFiles(s.files).bundleHash;
        // An edited skill is new, unreviewed text: log it so an approved skill can never change without a trace.
        // The summary shows only the region that differs, so a hidden tail or a description change still shows.
        const differing = (before: string, after: string) => {
          const min = Math.min(before.length, after.length);
          let start = 0;
          while (start < min && before[start] === after[start]) start++;
          let endBefore = before.length;
          let endAfter = after.length;
          while (endBefore > start && endAfter > start && before[endBefore - 1] === after[endAfter - 1]) {
            endBefore--;
            endAfter--;
          }
          return { before: before.slice(start, endBefore), after: after.slice(start, endAfter) };
        };
        // Keep both ends when it is long: a payload is often added at the end, after harmless opening text.
        const flat = (text: string, max: number) => {
          const one = text.replace(/\s+/g, " ").trim();
          if (one.length <= max) return one;
          const half = Math.max(1, Math.floor((max - 1) / 2));
          return `${one.slice(0, half)}…${one.slice(-half)}`;
        };
        const diff = differing(oldSkillMd, newSkillMd);
        const head = `Owner edited the skill ${s.name}${s.name !== old.name ? ` (was ${flat(old.name, 40)})` : ""} from ${old.bundleHash.slice(0, 12)} to ${newBundle.slice(0, 12)}.`;
        const tail = " Not security-reviewed; full text in detail.";
        // Leave room for the head and tail, then share what is left between the two differing sides.
        const room = Math.max(20, 300 - head.length - tail.length - 30);
        const shown = !diff.before && !diff.after ? "The visible text is unchanged." : `Old: "${flat(diff.before, Math.floor(room / 2))}" New: "${flat(diff.after, Math.floor(room / 2))}".`;
        await record(db, {
          companyId: id,
          kind: "skill.edited_by_owner",
          summary: `${head} ${shown}${tail}`,
          // The activity row's summary is capped, so the full old and new content is kept beside it.
          detail: {
            skillId,
            name: { before: old.name, after: s.name },
            description: { before: old.description, after: s.description },
            bundleHash: { before: old.bundleHash, after: newBundle },
            skillMd: { before: oldSkillMd, after: newSkillMd },
            changedRegion: diff,
            removedFiles: old.files.filter((f) => f.path !== "SKILL.md").map((f) => f.path),
          },
        });
        return { id: s.id, name: s.name };
      } catch (err) {
        return skillErrors(reply)(err);
      }
    });
    owner.post("/api/companies/:id/skills/:skillId/refresh", async (req, reply) => {
      const { id, skillId } = SkillParams.parse(req.params);
      return skillProposals.proposeRefresh(id, skillId).then((p) => ({ changed: !!p, proposalId: p?.id ?? null, status: p?.status ?? null }), skillErrors(reply));
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
      return skillProposals.proposeRefreshPack(id, pack).catch(skillErrors(reply));
    });
    owner.delete("/api/companies/:id/skill-packs", async (req, reply) => {
      const { id } = IdParam.parse(req.params);
      const { pack } = z.object({ pack: PackName }).parse(req.query);
      return skillsSvc.removePack(id, pack).then(() => reply.code(204).send(), skillErrors(reply));
    });
    owner.put("/api/companies/:id/skills/:skillId/addons", async (req, reply) => {
      const { id, skillId } = SkillParams.parse(req.params);
      const { requires } = z.object({ requires: z.array(z.string().max(40)).max(10) }).parse(req.body);
      return skillsSvc.setRequires(id, skillId, requires).then(() => ({ requires }), skillErrors(reply));
    });
    owner.get("/api/runner-addons", async () => RUNNER_ADDONS);
    owner.put("/api/companies/:id/skills/:skillId/agents", async (req, reply) => {
      const { id, skillId } = SkillParams.parse(req.params);
      const { agentIds } = z.object({ agentIds: z.array(Uuid).max(200) }).parse(req.body);
      return skillsSvc.setHolders(id, skillId, agentIds).then(() => ({ agentIds }), skillErrors(reply));
    });

    // The company as one file (docs/11): set-up always; wiki and tickets when asked. Read-only.
    owner.get("/api/companies/:id/export", async (req, reply) => {
      const { id } = IdParam.parse(req.params);
      const q = z.object({ wiki: z.enum(["0", "1"]).optional(), tickets: z.enum(["none", "open", "all"]).optional() }).parse(req.query);
      const out = await exportCompany(db, id, { wiki: q.wiki === "1", tickets: q.tickets ?? "none" });
      if (!out) return reply.code(404).send({ error: "not_found" });
      return reply.header("content-type", "application/zip").header("content-disposition", `attachment; filename="${out.name}"`).send(Buffer.from(out.bytes));
    });

    // Import (docs/11, step 2): a package becomes a new company. Preview writes nothing.
    const ImportBody = z.object({ zip: z.string().min(1), name: z.string().trim().min(1).max(80).optional(), fundingSourceId: Uuid.nullable().optional() });
    const importErrors = (reply: import("fastify").FastifyReply) => (err: unknown) => {
      if (err instanceof ImportError) return reply.code(err.status).send({ error: "import", message: err.message });
      throw err;
    };
    owner.post("/api/companies/import/preview", { bodyLimit: 66 * 1024 * 1024 }, async (req, reply) => {
      const b = ImportBody.parse(req.body);
      try {
        return await previewPackage(db, readPackage(new Uint8Array(Buffer.from(b.zip, "base64"))), b.name);
      } catch (err) {
        return importErrors(reply)(err);
      }
    });
    owner.post("/api/companies/import", { bodyLimit: 66 * 1024 * 1024 }, async (req, reply) => {
      const b = ImportBody.parse(req.body);
      let done;
      try {
        done = await applyPackage(db, readPackage(new Uint8Array(Buffer.from(b.zip, "base64"))), { name: b.name, fundingSourceId: b.fundingSourceId });
      } catch (err) {
        return importErrors(reply)(err);
      }
      for (const pageId of done.wikiPageIds) semantic.enqueue(done.companyId, pageId);
      await decisionsSvc.raise({ companyId: done.companyId, agentId: null, question: `${done.name} was imported. Left to do:\n${done.checklist.map((x) => `- ${x}`).join("\n")}`, options: ["Done"], recommended: "Done" });
      if (launch.enabled)
        void launch.start(done.companyId).catch((err) =>
          notes.notify({ companyId: done.companyId, agentId: null, level: "flag", title: `${done.name}'s runner didn't start`, body: (err as Error).message, link: "#/settings" }).catch(() => {}),
        );
      return reply.code(201).send({ companyId: done.companyId, name: done.name, checklist: done.checklist });
    });

    // The home screen (R74).
    owner.get("/api/companies/:id/dashboard", async (req) => dashboard.get(IdParam.parse(req.params).id));

    // The workflow scorecard: how work moves between roles, and where features wait on their last tasks.
    owner.get("/api/companies/:id/workflow", async (req) => {
      const q = z.object({ days: z.coerce.number().int().min(1).max(90).default(14) }).parse(req.query);
      return workflow.scorecard(IdParam.parse(req.params).id, q.days);
    });

    // Workflow retros (docs/19 parts 2 and 3): who runs them, the latest findings and changes, and a run on demand.
    const retroErrors = (reply: import("fastify").FastifyReply) => (err: unknown) => {
      if (err instanceof RetroError) return reply.code(err.status).send({ error: "retro", message: err.message });
      throw err;
    };
    owner.get("/api/companies/:id/retro-settings", async (req) => retro.status(IdParam.parse(req.params).id));
    owner.put("/api/companies/:id/retro-settings", async (req, reply) => {
      const b = z.object({ agentId: Uuid.nullable() }).parse(req.body);
      return retro.setAgent(IdParam.parse(req.params).id, b.agentId).catch(retroErrors(reply));
    });
    owner.get("/api/companies/:id/retros/latest", async (req) => retro.latest(IdParam.parse(req.params).id));
    owner.post("/api/companies/:id/retro", async (req, reply) => {
      const r = await retro.start(IdParam.parse(req.params).id, { force: true }).catch(retroErrors(reply));
      return r && !r.started ? reply.code(409).send({ error: "retro", message: r.reason }) : reply.code(201).send(r);
    });

    // The company wiki, and what each ticket produced (R69).
    const wikiErrors = (reply: import("fastify").FastifyReply) => (err: unknown) => {
      if (err instanceof WikiError) return reply.code(err.status).send({ error: "wiki", message: err.message });
      throw err;
    };
    // A page's address can hold folders ("research/agent-landscape"), so it's the rest of the path.
    const SlugParams = z.object({ id: Uuid, "*": z.string().min(1).max(500) }).transform((p) => ({ id: p.id, slug: p["*"] }));
    const PageBody = z.object({ title: z.string().trim().min(1).max(200), body: z.string().max(MAX_BODY), folder: z.string().max(400).optional() });
    // The CEO-style brief, built when asked and never stored as a page (R84).
    owner.get("/api/companies/:id/brief", async (req, reply) => {
      const { id } = IdParam.parse(req.params);
      const [c] = await db.select({ id: companies.id }).from(companies).where(eq(companies.id, id));
      if (!c) return reply.code(404).send({ error: "not_found" });
      return { markdown: await buildBrief(db, { companyId: id, agentId: null, role: "ceo", since: null, now: opts.now?.() ?? new Date(), plain: true }) };
    });
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
    // Semantic wiki search settings. dims stays at the 768 the embeddings column holds.
    const semanticView = (s: Awaited<ReturnType<typeof semantic.settings>>) => ({ enabled: s.enabled, baseUrl: s.baseUrl, model: s.model, dims: s.dims, secretId: s.secretId });
    owner.get("/api/companies/:id/wiki-semantic", async (req) => {
      const id = IdParam.parse(req.params).id;
      return { ...semanticView(await semantic.settings(id)), status: await semantic.status(id) };
    });
    owner.post("/api/companies/:id/wiki-semantic/test", async (req) => semantic.test(IdParam.parse(req.params).id));
    owner.put("/api/companies/:id/wiki-semantic", async (req) => {
      const { id } = IdParam.parse(req.params);
      const b = z.object({ enabled: z.boolean(), baseUrl: z.string().url().max(300).regex(/^https?:/), model: z.string().trim().min(1).max(200), secretId: Uuid.nullable() }).parse(req.body);
      const before = await semantic.settings(id);
      const after = await semantic.setSettings(id, b);
      if (after.enabled && (!before.enabled || before.model !== after.model || before.baseUrl !== after.baseUrl || before.secretId !== after.secretId)) await semantic.reindexAll(id);
      return semanticView(after);
    });
    owner.post("/api/companies/:id/wiki-semantic/reindex", async (req, reply) => reply.code(202).send({ pages: await semantic.reindexAll(IdParam.parse(req.params).id) }));
    owner.get("/api/tickets/:id/artifacts", async (req) => wiki.artifacts(IdParam.parse(req.params).id, { family: true }));
    owner.delete("/api/artifacts/:id", async (req, reply) => wiki.removeArtifact(IdParam.parse(req.params).id).then(() => reply.code(204).send(), wikiErrors(reply)));

    owner.patch("/api/tickets/:id", async (req) => {
      const { id } = IdParam.parse(req.params);
      const { costCapUsd, ...fields } = TicketFields.extend({ costCapUsd: z.number().positive().nullable() }).partial().parse(req.body);
      // A per-ticket spend ceiling across all its runs (R53); null falls back to the project's default.
      if (costCapUsd !== undefined) await db.update(tickets).set({ costCapMicros: costCapUsd === null ? null : usdToMicros(costCapUsd) }).where(eq(tickets.id, id));
      return work.updateTicket(id, fields);
    });

    // The owner moves a ticket by hand (e.g. to unstick it). Done skips the merge: it is the owner's call.
    owner.post("/api/tickets/:id/state", async (req) => {
      const { id } = IdParam.parse(req.params);
      const { state, blockedUntil, blockedUntilReason } = z.object({ state: State, blockedUntil: z.string().datetime({ offset: true }).optional(), blockedUntilReason: z.string().trim().max(BLOCKED_UNTIL_REASON_MAX).regex(/^[^\r\n]*$/, "One line, please.").optional() }).parse(req.body);
      if ((blockedUntil || blockedUntilReason) && state !== "blocked") throw new WorkError(422, "A blocked-until time only goes with the Blocked status.");
      if (blockedUntilReason && !blockedUntil) throw new WorkError(422, "Give the date and time you are waiting for along with the reason.");
      if (blockedUntil && new Date(blockedUntil).getTime() <= Date.now()) throw new WorkError(422, "The blocked-until time must be in the future.");
      if (blockedUntil && new Date(blockedUntil).getTime() > Date.now() + BLOCKED_UNTIL_MAX_MS) throw new WorkError(422, `The blocked-until time can be at most ${BLOCKED_UNTIL_MAX_DAYS} days ahead.`);
      const moved = await work.updateTicket(id, { state, ...(state === "blocked" ? { blockedUntil: blockedUntil ? new Date(blockedUntil) : null, blockedUntilReason: blockedUntil ? blockedUntilReason || null : null } : {}) });
      const label = ({ backlog: "Backlog", ready: "Ready", in_progress: "In progress", blocked: "Blocked", review: "In review", done: "Done" } as Record<string, string>)[state] ?? state;
      await record(db, { companyId: moved.companyId, ticketId: id, kind: "state", summary: `Owner moved it to ${label}`, at: new Date() });
      // Nobody should start work on a ticket the owner has parked or closed.
      if (state === "done" || state === "backlog" || state === "blocked")
        await db.update(wakes).set({ status: "dropped", statusReason: `The owner moved the ticket to ${label}.` }).where(and(eq(wakes.ticketId, id), inArray(wakes.status, ["queued", "deferred"])));
      if (state === "review") await scheduler.onTicketReview(id, null);
      if ((state === "in_progress" || state === "ready") && moved.assigneeAgentId) await scheduler.notify(moved.assigneeAgentId, { ticketId: id, reason: "woken by owner", note: `The owner moved this ticket to ${label}.` });
      return moved;
    });

    // A watcher agent that reports the ticket's progress every so often (R80); agentId null turns it off.
    owner.put("/api/tickets/:id/watcher", async (req) => {
      const { id } = IdParam.parse(req.params);
      const b = z.object({ agentId: Uuid.nullable(), everyMinutes: z.number().int().min(10).max(7 * 24 * 60).optional() }).parse(req.body);
      return work.setWatcher(id, b);
    });

    // The monitor (wake the assignee to re-check something): no `at` means check now.
    owner.put("/api/tickets/:id/monitor", async (req) => {
      const { id } = IdParam.parse(req.params);
      const b = z.object({ at: z.string().datetime({ offset: true }).optional(), note: z.string().min(1).max(500), maxChecks: z.number().int().min(1).max(20).optional() }).parse(req.body);
      return work.setMonitor(id, { at: b.at ? new Date(b.at) : new Date(), note: b.note, maxChecks: b.maxChecks });
    });
    owner.delete("/api/tickets/:id/monitor", async (req) => work.clearMonitor(IdParam.parse(req.params).id));

    owner.post("/api/tickets/:id/dependencies", async (req, reply) => {
      const { id } = IdParam.parse(req.params);
      const body = z.object({ ticketId: Uuid.optional(), engagementId: Uuid.optional() }).parse(req.body);
      return reply.code(201).send(await work.addDependency(id, body));
    });

    owner.post("/api/companies/:id/objectives", async (req, reply) => {
      const { id } = IdParam.parse(req.params);
      const body = z.object({ title: z.string().trim().min(1).max(200), priority: z.number().int().min(1).max(5).optional(), projectId: Uuid.optional() }).parse(req.body);
      const o = await work.createObjective(id, body);
      await teamCheck(id, `added an objective, "${o.title}"${body.projectId ? ` for project ${body.projectId}` : ""}`);
      return reply.code(201).send(o);
    });

    owner.post("/api/objectives/:id/key-results", async (req, reply) => {
      const { id } = IdParam.parse(req.params);
      const body = z.object({ title: z.string().trim().min(1).max(200), target: z.number().optional(), current: z.number().optional(), unit: z.string().max(20).optional(), method: z.enum(["manual", "agent", "check"]).optional() }).parse(req.body);
      return reply.code(201).send(await work.addKeyResult(id, body));
    });

    owner.post("/api/objectives/:id/milestones", async (req, reply) => {
      const { id } = IdParam.parse(req.params);
      const body = z.object({ title: z.string().trim().min(1).max(200), targetDate: DateStr.optional(), horizon: z.enum(HORIZONS).optional() }).parse(req.body);
      const m = await work.addMilestone(id, body);
      const [o] = await db.select({ companyId: objectives.companyId, title: objectives.title }).from(objectives).where(eq(objectives.id, id));
      if (o) await teamCheck(o.companyId, `added a milestone, "${body.title}", under the objective "${o.title}"`);
      return reply.code(201).send(m);
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
      objectiveId: Uuid.nullable(),
      portalVisible: z.boolean(),
    });
    owner.get("/api/companies/:id/feedback-settings", async (req) => {
      const { id } = IdParam.parse(req.params);
      const s = await feedback.settings(id);
      return { ...s, portalUrl: opts.portalUrl?.replace(/\/+$/, "") || null, drivers: await feedback.drivers(id), areas: await feedback.areas(id) };
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
    // Only these three types, found by their first bytes: the portal is public, so no SVG.
    const logoType = (b: Buffer) =>
      b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) ? "image/png"
      : b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff ? "image/jpeg"
      : b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP" ? "image/webp"
      : null;
    owner.put("/api/companies/:id/feedback/portal-logo", { bodyLimit: 400 * 1024 }, async (req, reply) => {
      const { id } = IdParam.parse(req.params);
      const { data } = z.object({ data: z.string() }).parse(req.body);
      const bytes = Buffer.from(data, "base64");
      if (!bytes.length || bytes.length > 256 * 1024) return reply.code(413).send({ error: "too_large", message: "The logo must be 256 KB or smaller." });
      const type = logoType(bytes);
      if (!type) return reply.code(415).send({ error: "bad_type", message: "The logo must be a PNG, JPEG or WebP image." });
      await feedback.setPortalLogo(id, { bytes, type });
      return feedback.settings(id);
    });
    owner.delete("/api/companies/:id/feedback/portal-logo", async (req) => {
      const { id } = IdParam.parse(req.params);
      await feedback.setPortalLogo(id, null);
      return feedback.settings(id);
    });
    owner.get("/api/companies/:id/feedback/portal-logo", async (req, reply) => {
      const logo = await feedback.portalLogo(IdParam.parse(req.params).id);
      return logo ? sendLogo(reply, logo) : reply.code(404).send({ error: "not_found", message: "No logo." });
    });
    // An agent's own picture, in place of its template's portrait.
    owner.put("/api/agents/:id/avatar", { bodyLimit: 400 * 1024 }, async (req, reply) => {
      const { id } = IdParam.parse(req.params);
      const { data } = z.object({ data: z.string() }).parse(req.body);
      const bytes = Buffer.from(data, "base64");
      if (!bytes.length || bytes.length > 256 * 1024) return reply.code(413).send({ error: "too_large", message: "The picture must be 256 KB or smaller." });
      const type = logoType(bytes);
      if (!type) return reply.code(415).send({ error: "bad_type", message: "The picture must be a PNG, JPEG or WebP image." });
      const [a] = await db.select({ id: agents.id }).from(agents).where(eq(agents.id, id));
      if (!a) return reply.code(404).send({ error: "not_found", message: "No such agent." });
      await db.insert(agentAvatars).values({ agentId: id, bytes, type }).onConflictDoUpdate({ target: agentAvatars.agentId, set: { bytes, type } });
      const [row] = await db.update(agents).set({ avatarAt: new Date() }).where(eq(agents.id, id)).returning({ avatarAt: agents.avatarAt });
      return row;
    });
    owner.delete("/api/agents/:id/avatar", async (req) => {
      const { id } = IdParam.parse(req.params);
      await db.delete(agentAvatars).where(eq(agentAvatars.agentId, id));
      await db.update(agents).set({ avatarAt: null }).where(eq(agents.id, id));
      return { avatarAt: null };
    });
    owner.get("/api/agents/:id/avatar", async (req, reply) => {
      const [pic] = await db.select({ bytes: agentAvatars.bytes, type: agentAvatars.type }).from(agentAvatars).where(eq(agentAvatars.agentId, IdParam.parse(req.params).id));
      return pic ? sendLogo(reply, pic) : reply.code(404).send({ error: "not_found", message: "No picture." });
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
      const b = z.object({ projectId: Uuid, title: Text(200).optional(), risk: z.enum(RISK_TIERS).optional(), assigneeAgentId: Uuid.optional(), state: z.enum(SYSTEM_STATES).optional(), noCode: z.boolean().optional() }).parse(req.body);
      const { feature: f, body } = await feedback.brief(id);
      const [p] = await db.select({ companyId: projects.companyId }).from(projects).where(eq(projects.id, b.projectId));
      if (!p || p.companyId !== f.companyId) return reply.code(422).send({ error: "rejected", message: "Pick a project of the feature's company." });
      const t = await work.createTicket(b.projectId, { title: b.title ?? f.title, body, featureId: id, risk: b.risk, assigneeAgentId: b.assigneeAgentId, state: b.state, noCode: b.noCode });
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

    // "Let the CEO question me first": the Board's add form sends its draft here instead of creating it.
    owner.post("/api/companies/:id/chat/grill", async (req, reply) => {
      const { id } = IdParam.parse(req.params);
      const b = z.object({ kind: z.enum(["task", "feature"]), title: z.string().trim().min(1).max(200), description: z.string().trim().max(10_000).nullable().optional(), projectId: Uuid.optional() }).parse(req.body);
      return chat.grill(id, b).then((r) => reply.code(201).send(r), chatErrors(reply));
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
    owner.get("/api/tickets/:id/related", async (req) => planning.relatedTickets(IdParam.parse(req.params).id));
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
    // Model lists for the picker (R60); refresh=1 asks API providers again.
    owner.get("/api/companies/:id/models", async (req) => models.forCompany(IdParam.parse(req.params).id, { refresh: z.object({ refresh: z.string().optional() }).parse(req.query).refresh === "1" }));
    // "Refresh models": asks the company's runner for each kind's model list, then answers with what happened.
    owner.post("/api/companies/:id/models/refresh", async (req) => ({ probed: await modelProbe.probe(IdParam.parse(req.params).id, { force: true }) }));
    // What the CEO may change about the team without asking (R62).
    owner.get("/api/companies/:id/agent-approvals", async (req) => ({ approvals: await agentsSvc.approvals(IdParam.parse(req.params).id) }));
    owner.put("/api/companies/:id/agent-approvals", async (req) => {
      const { id } = IdParam.parse(req.params);
      const { approvals } = z.object({ approvals: z.enum(AGENT_APPROVALS) }).parse(req.body);
      return { approvals: await agentsSvc.setApprovals(id, approvals) };
    });
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
          thinking: z.enum(THINKING_LEVELS).nullable().optional(),
          fundingSourceId: Uuid.nullable().optional(),
          reportsTo: Uuid.optional(),
        })
        .parse(req.body);
      return agentsSvc.hire(id, b).then((a) => reply.code(201).send(a), agentErrors(reply));
    });

    owner.patch("/api/agents/:id", async (req, reply) => {
      const { id } = IdParam.parse(req.params);
      const b = z
        .object({ name: z.string().trim().min(1).max(80), title: z.string().trim().max(80).nullable(), instructions: Instructions, model: z.string().nullable(), thinking: z.enum(THINKING_LEVELS).nullable(), fundingSourceId: Uuid.nullable(), agentKind: z.string().min(1), paused: z.boolean(), starred: z.boolean(), reviewKind: z.enum(REVIEW_KINDS).nullable() })
        .partial()
        .parse(req.body);
      const { reviewKind, ...patch } = b;
      const [before] = await db.select().from(agents).where(eq(agents.id, id));
      if (!before) return reply.code(404).send({ error: "not_found" });
      // An agent with a standing job starts with no model; it needs one before it can run (R73).
      if (b.paused === false && before.duty && !(b.model !== undefined ? b.model : before.model)) {
        return reply.code(409).send({ error: "needs_model", message: `Choose a model for ${before.name} before starting it.` });
      }
      // One reviewer per kind: marking this agent unmarks whoever had it.
      if (reviewKind !== undefined) {
        if (reviewKind) await db.update(agents).set({ reviewKind: null }).where(and(eq(agents.companyId, before.companyId), eq(agents.reviewKind, reviewKind)));
        await db.update(agents).set({ reviewKind }).where(eq(agents.id, id));
      }
      return agentsSvc.update(id, patch).then((a) => {
        // Unpausing lets its waiting work start now rather than at the next tick.
        if (b.paused === false && before.paused) void scheduler.tick().catch((err) => app.log.error({ err }, "tick after unpause failed"));
        return a;
      }, agentErrors(reply));
    });
    owner.post("/api/agents/:id/retire", async (req, reply) => agentsSvc.retire(IdParam.parse(req.params).id).catch(agentErrors(reply)));
    owner.get("/api/agents/:id/history", async (req, reply) => agentsSvc.history(IdParam.parse(req.params).id).catch(agentErrors(reply)));
    owner.post("/api/agent-changes/:id/undo", async (req, reply) => agentsSvc.undo(IdParam.parse(req.params).id).catch(agentErrors(reply)));

    // The CEO's lasting notes (BOS-85): the owner sees, adds, edits and deletes them, within the same caps, and sees colleagues' requests.
    const noteErrors = (reply: import("fastify").FastifyReply) => (err: unknown) => {
      if (err instanceof NoteError) return reply.code(err.status).send({ error: "note", message: err.message });
      throw err;
    };
    const NoteBody = z.object({ title: z.string().trim().min(1).max(NOTE_LIMITS.title), text: z.string().trim().min(1).max(NOTE_LIMITS.text), why: z.string().trim().min(1).max(NOTE_LIMITS.why) });
    const noteOf = async (id: string) => (await db.select({ companyId: agentNotes.companyId }).from(agentNotes).where(eq(agentNotes.id, id)))[0];
    owner.get("/api/agents/:id/notes", async (req, reply) => {
      const [a] = await db.select({ companyId: agents.companyId }).from(agents).where(eq(agents.id, IdParam.parse(req.params).id));
      if (!a) return reply.code(404).send({ error: "not_found" });
      // Pending and declined requests from other agents show beside the notes.
      return { items: await notesSvc.withOrigin(a.companyId, IdParam.parse(req.params).id), requests: await notesSvc.requests(a.companyId, IdParam.parse(req.params).id), limits: NOTE_LIMITS };
    });
    owner.post("/api/agents/:id/notes", async (req, reply) => {
      const { id } = IdParam.parse(req.params);
      const [a] = await db.select({ companyId: agents.companyId }).from(agents).where(eq(agents.id, id));
      if (!a) return reply.code(404).send({ error: "not_found" });
      return notesSvc.save(a.companyId, id, NoteBody.parse(req.body), { source: "owner" }).then((n) => reply.code(201).send(n), noteErrors(reply));
    });
    owner.patch("/api/agent-notes/:id", async (req, reply) => {
      const { id } = IdParam.parse(req.params);
      const n = await noteOf(id);
      if (!n) return reply.code(404).send({ error: "not_found" });
      return notesSvc.update(n.companyId, id, NoteBody.partial().parse(req.body), { owner: true }).then((r) => r.after, noteErrors(reply));
    });
    owner.delete("/api/agent-notes/:id", async (req, reply) => {
      const { id } = IdParam.parse(req.params);
      const n = await noteOf(id);
      if (!n) return reply.code(404).send({ error: "not_found" });
      return notesSvc.remove(n.companyId, id, { owner: true }).then(() => ({ ok: true }), noteErrors(reply));
    });

    // The Scrum Master watchdog (BOS-58): settings and health, its flags and action log (read by the activity view and daily summary), and undo.
    const watchdogErrors = (reply: import("fastify").FastifyReply) => (err: unknown) => {
      if (err instanceof WatchdogError) return reply.code(err.status).send({ error: "watchdog", message: err.message });
      if (err instanceof z.ZodError) return reply.code(422).send({ error: "watchdog", message: err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
      throw err;
    };
    owner.get("/api/companies/:id/watchdog", async (req, reply) => watchdog.status(IdParam.parse(req.params).id).catch(watchdogErrors(reply)));
    owner.patch("/api/companies/:id/watchdog", async (req, reply) => {
      const { id } = IdParam.parse(req.params);
      const b = WatchdogSettings.partial().extend({ scrumMasterAgentId: Uuid.nullable().optional() }).strict().parse(req.body ?? {});
      return watchdog.update(id, b).catch(watchdogErrors(reply));
    });
    owner.get("/api/companies/:id/watchdog/flags", async (req, reply) => {
      const { id } = IdParam.parse(req.params);
      const q = z.object({ status: z.enum(["open", "closed"]).optional(), ticketId: Uuid.optional(), limit: z.coerce.number().int().min(1).max(500).optional() }).parse(req.query);
      return watchdog.flags(id, q).catch(watchdogErrors(reply));
    });
    owner.get("/api/companies/:id/watchdog/actions", async (req, reply) => {
      const { id } = IdParam.parse(req.params);
      const q = z.object({ ticketId: Uuid.optional(), since: z.coerce.date().optional(), limit: z.coerce.number().int().min(1).max(500).optional(), excludeKind: z.string().max(40).optional() }).parse(req.query);
      return watchdog.actions(id, q).catch(watchdogErrors(reply));
    });
    owner.get("/api/companies/:id/watchdog/backtest", async (req, reply) => {
      const { id } = IdParam.parse(req.params);
      const q = z.object({ days: z.coerce.number().int().min(1).max(60).default(14) }).parse(req.query);
      return watchdog.backtest(id, q.days).catch(watchdogErrors(reply));
    });
    owner.post("/api/watchdog-actions/:id/undo", async (req, reply) => {
      const { id } = IdParam.parse(req.params);
      const [a] = await db.select({ companyId: watchdogActions.companyId }).from(watchdogActions).where(eq(watchdogActions.id, id));
      if (!a) return reply.code(404).send({ error: "not_found" });
      const b = z.object({ reason: z.string().max(400).optional() }).parse(req.body ?? {});
      return watchdog.undo(a.companyId, id, b).catch(watchdogErrors(reply));
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

    // The runner update hold (docs/09-self-deploy.md, phase 2): the banner's numbers, a manual start, and cancel.
    owner.get("/api/maintenance", async () => maintenance.status());
    owner.post("/api/maintenance/start", async (req, reply) => {
      const { minutes } = z.object({ minutes: z.number().int().min(1).max(1440).optional() }).parse(req.body ?? {});
      if (!launch.enabled) return reply.code(409).send({ error: "no_launcher", message: "Draining needs the launcher (BOSSMAN_LAUNCHER=1); without it runners are restarted by scripts/update-runner.sh --now." });
      await maintenance.start({ minutes }); // leader-only
      return maintenance.status();
    });
    owner.post("/api/maintenance/cancel", async () => ({ cancelled: await maintenance.cancel() })); // leader-only

    // Self-deploy: what the host deployer last reported, and the "Deploy latest" button.
    owner.get("/api/self-deploy", async () => selfDeploy.overview());
    owner.post("/api/self-deploy/deploy-latest", async (_req, reply) => {
      const r = await selfDeploy.deployLatest();
      return "error" in r ? reply.code(409).send({ error: "nothing_to_deploy", message: r.error }) : r;
    });

    owner.post("/api/self-deploy/update-runners", async (_req, reply) => {
      const r = await selfDeploy.updateRunners();
      return "error" in r ? reply.code(409).send({ error: "cannot_update_runners", message: r.error }) : r;
    });

    // The decision queue (R20), ranked, with what each row holds up.
    owner.get("/api/decisions", async () => decisionsSvc.queue());
    // Boss Man's alerts still with the Scrum Master or the CEO (BOS-64), for a collapsed line under the queue.
    owner.get("/api/decisions/with-team", async () => decisionsSvc.withTeam());

    // "Ask the CEO for advice": the decision stays open while the CEO looks at it (it returns to the owner after the company's time limit).
    owner.post("/api/decisions/:id/ask-advice", async (req, reply) => {
      const { id } = IdParam.parse(req.params);
      const { note } = z.object({ note: z.string().trim().max(500).optional() }).parse(req.body ?? {});
      try {
        const r = await decisionsSvc.askAdvice(id, note || undefined);
        return r ?? reply.code(404).send({ error: "not_open" });
      } catch (err) {
        if (err instanceof AnswerError) return reply.code(422).send({ error: "invalid_answer", message: err.message });
        throw err;
      }
    });
    owner.get("/api/decisions/advised", async () => decisionsSvc.recentlyAdvised());

    owner.post("/api/decisions/:id/answer", async (req, reply) => {
      const { id } = IdParam.parse(req.params);
      const { answer, assigneeAgentId, note, custom, picks, modelConfig } = z
        .object({
          answer: z.string().trim().min(1).max(4000),
          assigneeAgentId: Uuid.optional(),
          note: z.string().trim().max(2000).optional(),
          custom: z.boolean().optional(),
          picks: z.array(z.number().int().min(0)).max(20).optional(),
          modelConfig: z
            .object({ harness: z.string().trim().min(1).max(40), provider: z.string().trim().min(1).max(40), model: z.string().trim().min(1).max(200), fundingSourceId: Uuid })
            .optional(),
        })
        .parse(req.body);
      try {
        const result = await decisionsSvc.answer(id, answer, { assigneeAgentId, note, custom, picks, modelConfig, by: await ownerName(req) });
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
    owner.get("/api/engagements/:id", async (req, reply) => engagementsSvc.view(IdParam.parse(req.params).id, undefined, true).catch(engagementErrors(reply)));
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
        .object({ verdict: z.enum(["approved", "changes_requested"]), comments: z.array(ReviewComment).max(100).optional(), summary: z.string().max(5000).optional(), lesson: z.string().max(240).optional() })
        .parse(req.body);
      // Approval lands in the background (the check can outlast a proxy or browser timeout); the page polls /landing.
      const r = await review.submit(id, { ...b, reviewer: "the owner", background: true }).catch(reviewErrors(reply));
      if ((r as { outcome?: string } | undefined)?.outcome === "landing") reply.code(202);
      return r;
    });
    owner.get("/api/tickets/:id/landing", async (req) => ({ landing: review.landing(IdParam.parse(req.params).id) }));
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

    // Stale-blocker, stalled-run and missed-work sweeps (R21, R32, R82); also run on a timer.
    owner.post("/api/sweep", async () => sweeps.run());
  });

  if (opts.webDir) await serveWeb(app, opts.webDir);

  const briefUpkeep = () => refreshBriefs(db, { work, gitHosts, gitToken: async (companyId) => (await secretsSvc.resolveCompanyEnv(companyId, "check")).GIT_TOKEN, log: (m) => app.log.warn(m) });
  return { app, briefUpkeep, retro, secrets: secretsSvc, funding, runners, decisions: decisionsSvc, selfDeploy, maintenance, scheduler, work, sweeps, watchdog, engagements: engagementsSvc, deploys: deploysSvc, runs: runsSvc, recovery, review, loops, alerts, disk, rules, notes, chapters, feedback, wiki, semantic, skills: skillsSvc, skillProposals, ticketChat };
}
