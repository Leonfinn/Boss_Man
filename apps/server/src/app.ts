import path from "node:path";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest, type FastifyServerOptions } from "fastify";
import cookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import websocket from "@fastify/websocket";
import { and, asc, count, desc, eq, gt, gte, inArray, isNull, ne, sql } from "drizzle-orm";
import { readFileSync } from "node:fs";
import { monthStartUtc, projectSpendMicros } from "./services/project-spend.js";
import { z, ZodError } from "zod";
import { FEATURE_STATUSES, HORIZONS, IMPORTANCE, NOTE_SOURCES, RISK_TIERS, SECRET_KINDS, SYSTEM_STATES, dateIn, featureHorizon, findCredential, formatDate, riskSummary, usdToMicros, TOOL_KINDS, SENIOR_DEV, ruleFor, PERMISSION_JUDGE_MODES, FENCE_MODES, FENCE_ENFORCE_AVAILABLE } from "@boss-man/shared";
import { BLOCKED_UNTIL_MAX_DAYS, BLOCKED_UNTIL_MAX_MS, BLOCKED_UNTIL_REASON_MAX, CEO_TEMPLATE, timeZoneOr, WatchdogSettings } from "@boss-man/shared";
import { NO_CHECK, STANDARD_CHECKS, THINKING_LEVELS, TICKET_PREFIX, defaultTicketPrefix, ticketRef, type DetectResult, type WorkspaceDiff } from "@boss-man/shared";
import { FUNDING_KINDS, FUNDING_PROVIDERS, fundingComboError, windowLabel } from "@boss-man/shared";
import { OWNER_MESSAGE_MAX } from "@boss-man/shared";
import { hashPassword, hashToken, newSessionToken, SESSION_COOKIE, SESSION_DAYS, verifyPassword } from "./auth.js";
import type { MasterKey } from "./crypto.js";
import type { Db } from "./db/client.js";
import { agentAvatars, agentNotes, agents, checkJobs, companies, costEvents, decisions, engagements, features as featuresTable, fundingSources, mcpServers, objectives, owners, projects, runners as runnersTable, runs as runsTable, sessions, settings, tickets, wakes } from "./db/schema.js";
import { fundingService } from "./services/funding.js";
import { AGENT_APPROVALS, AgentError, agentsService } from "./services/agents.js";
import { NOTE_LIMITS, NoteError, notesService } from "./services/agent-notes.js";
import { modelsService } from "./services/models.js";
import { modelProbeService } from "./services/model-probe.js";
import { assetPathOf, PRECOMPRESSED_SUFFIX_LIST, parseRepoUrl, repoUrlAllowed } from "@boss-man/shared";
import { gitHostService } from "./services/git-hosts.js";
import { setupService } from "./services/setup.js";
import { secretGrants, secrets as secretsTable, watchdogActions } from "./db/schema.js";
import { runnersService } from "./services/runners.js";
import { allowsPrivate, type HostLookup, LauncherError, launcherService, type LauncherOptions } from "./services/launcher.js";
import { AnswerError, decisionsService } from "./services/decisions.js";
import { markOwnerOpened, recentClosedNotices } from "./services/closed-notice.js";
import { getHold, maintenanceService } from "./services/maintenance.js";
import { runnerWatchService } from "./services/runner-watch.js";
import { runnerReportService } from "./services/runner-report.js";
import { createErrorBuffer, logCompany, logMessage } from "./services/error-buffer.js";
import { serverStatusService } from "./services/server-status.js";
import { addonsService, mergeHostAddons, unknownAddons } from "./services/addons.js";
import { probeColours } from "./services/bluegreen.js";
import { createStallMonitor } from "./services/stall-monitor.js";
import { serverHealthService, type ServerHealth, type ServerHealthDeps } from "./services/server-health.js";
import { createPermissionLog } from "./services/permission-log.js";
import { selfDeployService } from "./services/self-deploy.js";
import { hostFactsService, OWNER_FACTS } from "./services/host-facts.js";
import { netguardAllowReport } from "./services/netguard-allow.js";
import { deviceProfilesService } from "./services/device-profiles.js";
import { releaseLogService } from "./services/release-log.js";
import { closeStallAlertForRun, sweepService, type SweepLimits } from "./services/sweeps.js";
import { alertClearing } from "./services/alert-clearing.js";
import { WatchdogError, watchdogService } from "./services/watchdog.js";
import { alertLadder, GOT_IT } from "./services/alert-ladder.js";
import { EngagementError, engagementsService } from "./services/engagements.js";
import { acceptanceCriteriaSchema, isTaskSize, SIZE_SCALE } from "@boss-man/shared";
import { deploysService } from "./services/deploys.js";
import { RunError, runsService } from "./services/runs.js";
import { recoveryService } from "./services/recovery.js";
import { holdView } from "./services/review-holds.js";
import { isSignoffPending, ReviewError, ReviewHeldError, reviewService } from "./services/review.js";
import { checkPolicy as checkPolicyIn, effectivePolicy } from "./services/review-policy.js";
import { listReviews } from "./services/review-kinds.js";
import { openSignoffCard, signoffState } from "./services/signoff.js";
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
import { mergeQueueService } from "./services/merge-queue.js";
import { mergeJamService } from "./services/merge-jam.js";
import { checkGate } from "./services/check-gate.js";
import { RetroError, retroService } from "./services/retro.js";
import { workflowService } from "./services/workflow.js";
import { skillsService } from "./services/skills.js";
import { skillProposalsService } from "./services/skill-proposals.js";
import { TicketChatError, ticketChatService } from "./services/ticket-chat.js";
import { ownerRepliesService } from "./services/owner-replies.js";
import { buildBrief } from "./services/brief.js";
import { getStandingRules, setStandingRules, standingRulesError, STANDING_RULES_MAX, undoStandingRules } from "./services/standing-rules.js";
import { wikiSemanticService } from "./services/wiki-semantic.js";
import { SecondOpinionSettings, secondOpinionService } from "./services/second-opinion.js";
import { wikiService } from "./services/wiki.js";
import { DEFAULT_LIMITS, schedulerService, type Limits } from "./services/scheduler.js";
import { exportCompany } from "./services/company-export.js";
import { applyPackage, ImportError, previewPackage, readPackage } from "./services/company-import.js";
import { mcpRoutes } from "./mcp.js";
import { SecretRejected, secretsService, type LiveValidator } from "./services/secrets.js";
import { checkDispatcher } from "./services/check-dispatcher.js";
import { checkRequestService } from "./services/check-request.js";
import { checkQueue, DEFAULT_CHECK_SLOTS, MAX_CHECK_SLOTS, type CheckQueueMode } from "./services/check-queue.js";
import { runnerIngestWaiting, runnerSocketRoutes } from "./routes/runner-socket.js";
import { serverAdminRoutes } from "./routes/server-admin.js";
import { wikiRoutes } from "./routes/wiki.js";
import { skillRoutes } from "./routes/skills.js";
import { createMemorySampler, readRssAndPeak } from "./services/memory-sampler.js";
import { readNativeDetail } from "./services/native-memory.js";
import { createLeader, type Leader } from "./leader.js";
import { diskService, type DiskLimits } from "./services/disk.js";
import { opencodeVacuumAlerts } from "./services/opencode-vacuum.js";
import { loginLimiter, type LoginLimits } from "./login-limit.js";
import { policyRulesService, RuleError } from "./services/policy-rules.js";
import { NotifySettings, NtfyUrl, notificationsService } from "./services/notifications.js";
import { approveGate, phoneApproveService } from "./services/phone-approve.js";

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
  /**
   * Mark cookies Secure: true always (default), false never (plain-HTTP development), or "auto" to
   * decide per request from req.protocol, which is https only behind a trusted proxy (BOS-242).
   */
  secureCookies?: boolean | "auto";
  /** Exact addresses of the proxies whose X-Forwarded-* headers are believed (BOS-242). Never "true". */
  trustedProxies?: string[];
  /** Fastify's logger: on, off, or options (tests pass a stream to read what is logged). */
  logger?: FastifyServerOptions["logger"];
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
  /** Replaces the runner lookup of a ticket's branch head in the missed-work sweep (tests). */
  branchHead?: (ticketId: string) => Promise<string | null>;
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
  /** The portal's own address for share links, e.g. http://192.0.2.10:3111; without it links use the owner's address. */
  portalUrl?: string;
  /** Rate limits on the public feedback portal; tests lower them. */
  portalLimits?: Partial<PortalLimits>;
  /** Clock for scheduling, sweeps and ranking; tests move it forward. */
  now?: () => Date;
  /** Server-health readings (BOS-640); tests pass made-up rss, memory limit and freezes. */
  serverHealth?: Partial<Pick<ServerHealthDeps, "rssMb" | "memoryLimit" | "stallsSince">>;
  /** The runner launcher (R55), when BOSSMAN_LAUNCHER=1. */
  launcher?: LauncherOptions;
  /** DNS lookup for the network-guard page's "resolves to a private address" check (BOS-791); tests pass a made-up one. */
  lookup?: HostLookup;
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
    // The build writes a .br/.gz sibling next to each asset (BOS-411), so a request that accepts one is
    // answered from disk with no CPU per request. A sidecar is never a route of its own: only the
    // negotiation below may pick it, so nobody downloads one as a file. @fastify/static hands setHeaders
    // the sibling's path, so the immutable rule is applied to the original name.
    preCompressed: true,
    globIgnore: PRECOMPRESSED_SUFFIX_LIST.map((suffix) => `**/*${suffix}`),
    setHeaders(res, file) {
      res.header("cache-control", assetPathOf(file).includes(`${path.sep}assets${path.sep}`) ? "public, max-age=31536000, immutable" : "no-cache");
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
  // Trust only the exact proxy addresses given (the Tailscale Serve hop), never every hop.
  // An owner's message can be a whole log (up to OWNER_MESSAGE_MAX characters, more once JSON-encoded and
  // with attachments added); the default 1 MiB body limit would refuse it before validation ever ran.
  const app = Fastify({ logger: opts.logger ?? false, trustProxy: opts.trustedProxies?.length ? opts.trustedProxies : false, bodyLimit: 4 * 1024 * 1024 });
  // Keep recent server errors for the CEO's server_status tool (BOS-224), redacted.
  const errorBuffer = createErrorBuffer();
  const logError = app.log.error.bind(app.log);
  app.log.error = ((...args: unknown[]) => {
    const message = logMessage(args);
    if (message) errorBuffer.push(message, logCompany(args));
    return logError(...(args as Parameters<typeof logError>));
  }) as typeof app.log.error;
  await app.register(cookie);
  // A long owner message (up to OWNER_MESSAGE_MAX, plus the prompt around it) travels over the runner socket;
  // the default 1 MiB frame limit could cut it off, so allow room for it.
  await app.register(websocket, { options: { maxPayload: 4 * 1024 * 1024 } });

  // Event-loop stalls and GC pauses, with memory and what was in flight (BOS-432): logged, and shown in server_status.
  const stalls = createStallMonitor({ runnerSockets: () => app.websocketServer?.clients.size ?? 0, log: (line) => app.log.warn(line) });
  stalls.start();
  app.addHook("onClose", async () => stalls.stop());
  app.addHook("onRequest", async (req, reply) => {
    if (req.headers.upgrade) return; // a websocket is counted as a runner socket, not a request
    stalls.requestStarted(req, `${req.method} ${req.routeOptions.url ?? "unmatched"}`);
    reply.raw.once("close", () => stalls.requestEnded(req));
  });

  const secretsSvc = secretsService(db, master, opts.liveValidator);
  const funding = fundingService(db, { reveal: (id) => secretsSvc.reveal(id), fetch: opts.fetch, now: opts.now });
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
  const launch = launcherService(db, { runners, options: opts.launcher, fetch: opts.fetch, lookup: opts.lookup });
  const rules = policyRulesService(db);
  const notes = notificationsService(db, { reveal: (id) => secretsSvc.reveal(id), now: opts.now, fetch: opts.fetch, log: (m) => app.log.warn(m) });
  // Which add-ons are running (DR-023, BOS-521), for server_status and the card lint's R9. Every route that raises a
  // card reads it through addonFacts, and a failed read is "unknown" for all (warnings only), never a refused card.
  const addonsSvc = addonsService(db, { trustedProxies: opts.trustedProxies ?? [], notifySettings: () => notes.getSettings(), now: opts.now });
  // The host deployer's add-on report (BOS-419) is merged in; the worse state wins when the two disagree.
  const addonFacts = async () => {
    const own = await addonsSvc.facts().catch(() => unknownAddons("Boss Man couldn't read the add-on state just now"));
    const reported = await hostFacts.reportedAddons().catch(() => ({}));
    return mergeHostAddons(own, reported, new Date().toISOString());
  };
  // The socket peer, not req.ip: the edge is the hop itself, and X-Forwarded-For is the client's to set.
  app.addHook("onRequest", async (req) => addonsSvc.noteRequest(req.socket.remoteAddress));
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
  // The server-owned check queue (DR-003, BOS-316). Off until the owner sets check_queue_mode to server; wake is filled in once the scheduler exists.
  let checkWake: ((agentId: string, w: { ticketId: string; reason: string; note: string; priority?: number }) => Promise<unknown>) | undefined;
  const checks = checkDispatcher(db, { send: (id, c) => runners.send(id, c), isConnected: (id) => runners.isConnected(id), can: (id) => runners.can(id, "check-jobs"), wake: (a, w) => checkWake?.(a, w) ?? Promise.resolve() });
  await runnerSocketRoutes(app, runners, secretsSvc, { heartbeatMs: opts.heartbeatMs, isLeader: () => leader.isLeader(), checks });
  // The live commit each company's server runs (BOS-284): a deploy, a switch-back, a rollback or a
  // restart after a hand-apply wakes the Release Manager. Its deps are filled in further down.
  const releaseLog = releaseLogService(db, {
    createTicket: (projectId, input) => work.createTicket(projectId, input),
    notify: (agentId, input) => scheduler.notify(agentId, input),
    notifyOwner: (n) => notes.notify({ ...n, agentId: null }),
    log: (m) => app.log.warn(m),
  });
  // What each host says about itself (BOS-427), for the owner-card lint's R6 and the hand-apply cards' host line.
  const hostFacts = hostFactsService({ dir: opts.deployerDir, db, now: opts.now, log: (m) => app.log.warn(m) });
  const deviceProfiles = deviceProfilesService(db);
  const selfDeploy = selfDeployService(db, { dir: opts.deployerDir, notify: (n) => notes.notify(n), releaseLog, hosts: () => hostFacts.hosts(), facts: async () => Object.fromEntries(Object.entries((await hostFacts.sync()).facts).map(([k, f]) => [k, f.value])), log: (m) => app.log.warn(m),
    // Quiet = no agent run in flight (an owner chat doesn't count) and no merge landing: a few seconds' outage of the database or proxy would cut them short (BOS-487).
    // DR-008's memory-headroom check is not built; this is the part that exists today.
    hostQuiet: async () => {
      // A run row left open by a restart must not hold the card back for ever: runs that started over 6 hours ago don't count.
      const [live] = await db.select({ n: count() }).from(runsTable).where(and(isNull(runsTable.endedAt), sql`${runsTable.purpose} is distinct from 'chat'`, sql`${runsTable.startedAt} > now() - interval '6 hours'`));
      return (live?.n ?? 0) === 0 && review.runningMerges().length === 0;
    } });
  const decisionsSvc = decisionsService(db, (runnerId, command) => runners.send(runnerId, command), opts.now, (runnerId) => runners.isConnected(runnerId), (m) => app.log.error(m), opts.workspaceRoot ?? "/home/node/workspaces");
  runners.setPermissionHook((runner, event) => decisionsSvc.onPermissionRequest(runner, event));
  // Phone Approve (BOS-243): the decision push asks it for an Approve button; a tap answers through decisionsSvc.
  const phoneApprove = phoneApproveService(db, {
    getSettings: () => notes.getSettings(),
    reveal: (id) => secretsSvc.reveal(id),
    pushPlain: (n) => notes.pushPlain(n),
    answer: (id, answer, extra) => decisionsSvc.answer(id, answer, extra),
    now: opts.now,
  });
  notes.setApproveHook(phoneApprove);
  // The optional model second opinion on permission cards (BOS-338): off until the owner sets it up.
  const secondOpinion = secondOpinionService(db, { reveal: (id) => secretsSvc.reveal(id), fetch: opts.fetch, workspaceRoot: opts.workspaceRoot ?? "/home/node/workspaces" });
  decisionsSvc.setSecondOpinion(secondOpinion);
  app.addHook("onClose", async () => decisionsSvc.drainSecondOpinions());
  const deploysSvc = deploysService(db, {
    now: opts.now,
    // DR-033: the runner resolves a deploy's commit and moves its tag; a tag it can't move goes to the CEO (`alerts` is built below).
    runners,
    alert: (input) => alerts.raise(input),
    log: (m) => app.log.warn(m),
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
    notifyOwner: (n) => notes.notify({ ...n, agentId: null }),
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
    // `sweeps` is built further down; this only runs when a hold lifts.
    afterHold: (since) => sweeps.resumeAfterUpdate(since),
    dir: opts.deployerDir,
    drainMinutes: opts.drainMinutes,
    reconnectMs: opts.drainReconnectMs,
    now: opts.now,
    log: (m) => app.log.warn(m),
  });
  decisionsSvc.setMaintenanceHook(maintenance);
  // Every runner restart, with its reason, in the owner's feed (BOS-594). Planned ones are quiet notes; a crash
  // or out-of-memory restart is a flag, since runs were cut off with no warning and it may recur.
  runners.onRestart((runner, last) =>
    notes
      .notify({
        companyId: runner.companyId,
        agentId: null,
        level: last.reason === "crash or out of memory" ? "flag" : "note",
        title: `Runner restarted: ${last.reason}`,
        body: `${last.detail}${last.reason === "crash or out of memory" ? " Runs that were going are resumed by crash recovery. If this repeats, raise the runner's memory (BOSSMAN_RUNNER_MEMORY) or ask Infrastructure to look at Settings → Server and runner." : ""}`,
        link: "#/settings",
      })
      .catch((err) => app.log.warn({ err }, "runner restart notice failed")),
  );
  // Settings → Runner leads with the live state and keeps a past problem only as history (BOS-465).
  const runnerReport = runnerReportService(db, maintenance, {
    isConnected: (id) => runners.isConnected(id),
    connectedSince: (id) => runners.connectedSince(id),
    launcher: (companyId) => launch.status(companyId),
  });
  const permLog = createPermissionLog({ log: (line) => app.log.info(line), now: opts.now });
  decisionsSvc.setPermissionLog(permLog);
  // Memory logging (BOS-410 step 1). Built here so server_status can read it; main.ts starts it on
  // every process, standby too. Tests never start it, so no timer runs under vitest.
  const memory = createMemorySampler({
    everyMs: Number(process.env.BOSSMAN_MEMORY_LOG_MS ?? 0) || undefined,
    log: (sample) => app.log.info({ memory: sample }, "memory"),
    // What the off-heap part is made of (BOS-410 step 2: 15 GiB native with a 100 MiB heap on 5 Nov).
    native: () => readNativeDetail(),
    extra: () => {
      let sockets = 0;
      let socketBuffered = 0;
      for (const c of app.websocketServer?.clients ?? []) {
        sockets++;
        socketBuffered += c.bufferedAmount;
      }
      return { sockets, socketBufferedKiB: Math.round(socketBuffered / 1024), runnerEventsWaiting: runnerIngestWaiting() };
    },
    // Catch the moment of a burst (5 Nov: 2-3 GiB to 15 GiB in one go) and what was running then.
    jump: {
      read: readRssAndPeak,
      context: (windowMs) => stalls.activity(windowMs),
      log: (line) => app.log.warn({ memoryJump: line }, "memory jump"),
    },
  });
  // BOS-770: the owner's BOSSMAN_NETGUARD_ALLOW entries, and (BOS-791) what the guard opens by itself; null when neither
  // the launcher nor the host has anything to say.
  const netguardAllow = async () => {
    const [launcher, env] = await Promise.all([launch.netguardConfig(), hostFacts.netguardEnv().catch(() => null)]);
    if (!launcher && !env) return null;
    return netguardAllowReport({ launcher, env, ...(await launch.ownAllows()) });
  };
  const serverStatus = serverStatusService(db, {
    memory,
    netguardAllow,
    runLimits: (id) => scheduler.runLimits(id),
    role: () => leader.role(),
    isConnected: (id) => runners.isConnected(id),
    isSettling: (id, at) => runners.isSettling(id, at),
    connectedSince: (id) => runners.connectedSince(id),
    deploy: () => selfDeploy.overview(),
    // Both colours, the same probe as GET /api/bluegreen (DR-020 E). `build` is defined further down; this only runs per request.
    colours: () => probeColours(colour(), build),
    hold: async () => {
      const h = await getHold(db);
      return h ? { reason: h.reason, since: h.since, deadline: h.deadline, force: h.force } : null;
    },
    errors: errorBuffer,
    stalls: () => stalls.summary(),
    cpuReserve: () => launch.cpuReserve(),
    permissions: (companyId: string) => permLog.summary(companyId),
    // Synthetic's cached quota, for the CEO's server_status in chat and runs (BOS-239).
    syntheticUsage: (companyId: string) => funding.syntheticUsage(companyId),
    addons: addonFacts,
    hostFacts: () => hostFacts.sync(),
    commit: process.env.BOSSMAN_COMMIT || "dev",
    startedAt: new Date(STARTED_AT),
    now: opts.now,
  });
  const engagementsSvc = engagementsService(db, { release: (ticketId) => decisionsSvc.release(ticketId), now: opts.now });
  engagementsSvc.setWakeHook((w) => scheduler.wake(w));
  decisionsSvc.setEngagementHook((id, approved) => engagementsSvc.approve(id, approved));
  deploysSvc.setWakeHook((w) => scheduler.wake(w));
  const runsSvc = runsService(db, { runners, now: opts.now, log: (m) => app.log.error(m) });
  decisionsSvc.setCancelHook((runId) => runsSvc.cancel(runId));
  runsSvc.setWakeHook((w) => scheduler.wake(w));
  // The owner's unanswered ticket messages (BOS-425). The scheduler and the alert ladder are built
  // further down, so the hooks look them up when they run, not when this is built.
  const ownerReplies = ownerRepliesService(db, {
    notify: (agentId, w) => scheduler.notify(agentId, w),
    alert: (input) => alerts.raise(input),
    now: opts.now,
  });
  const ticketChat = ticketChatService(db, { runs: runsSvc, notify: (agentId, w) => scheduler.notify(agentId, w), replyLane: (agentId, w) => scheduler.replyLaneFor(agentId, { reason: "message", ...w }), replies: ownerReplies });
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
  decisionsSvc.setAgentHook((ctx, companyId, approved) => agentsSvc.onDecision(ctx, companyId, approved, (agentId, skill) => skillsSvc.give(companyId, skill, agentId, ctx.byAgentId)));
  decisionsSvc.setModelChangeHook((ctx, companyId, config) => agentsSvc.applyModelChange(ctx, companyId, config));
  decisionsSvc.setTeamPlanHook((ctx, companyId, picks) => agentsSvc.hireTeam(companyId, picks.map((i) => ctx.hires[i]!), ctx.byAgentId, (agentId, skill) => skillsSvc.give(companyId, skill, agentId, ctx.byAgentId)));
  const disk = diskService(db, { send: (runnerId, command) => runners.send(runnerId, command), limits: opts.diskLimits, now: opts.now });
  async function quotaWatch(fundingSourceId: string) {
    const t = (opts.now ?? (() => new Date()))();
    const status = await funding.forecasts(fundingSourceId, t);
    if (!status) return;
    for (const [window, f] of Object.entries(status.forecasts)) {
      if (!f?.beforeReset || !f.runsOutAt || f.utilization < 0.5) continue;
      // Once per window: the key carries the reset time, so the next window can alert again.
      const key = `quota-alert:${fundingSourceId}:${window}:${f.resetsAt?.toISOString() ?? "none"}`;
      const told = await db.insert(settings).values({ key, value: true }).onConflictDoNothing().returning();
      if (!told.length) continue;
      const hhmm = (d: Date) => formatDate("en-GB", d, { hour: "2-digit", minute: "2-digit", timeZone: OWNER_TZ });
      const dayAt = (d: Date) => `${formatDate("en-GB", d, { weekday: "short", day: "numeric", month: "short", timeZone: OWNER_TZ })} at ${hhmm(d)}`;
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
  // Synthetic's own quota is cached on the server and read again at most every 5 minutes (BOS-239).
  // Every run end asks for a refresh, whatever the agent's provider: it is cheap because the reading
  // is served from the cache inside the 5-minute window, and a Synthetic run is the case that moved
  // the plan's counter. It warns the owner once per period at 80% and 100%.
  async function refreshSyntheticQuota() {
    const ownerTz = (await notes.getSettings()).quietHours?.timeZone ?? OWNER_TZ;
    await funding.refreshSynthetic((n) => notes.notify({ companyId: null, agentId: null, ...n }), ownerTz);
  }
  // A run the runner's hello left out was closed by the server: resume it like an interrupted one (BOS-583, BOS-574).
  runners.onLost((runId) =>
    deploysSvc
      .onRunEnded(runId)
      .then(() => chat.onRunEnded(runId, null, true))
      .then(() => recovery.onInterrupted(runId))
      .then(() => scheduler.tick())
      .catch((err) => app.log.error({ err, runId }, "resuming a lost run failed")),
  );
  runners.onEvent((runner, event) => {
    // CEO continuity: a chapter follows its runs' sessions and context use.
    if (event.type === "run.started") void chapters.onRunStarted(event.runId, event.acpSessionId).catch((err) => app.log.error({ err, companyId: runner.companyId }, "chapter update failed"));
    if (event.type === "run.context") void chapters.onContext(event.runId, event.used, event.size).catch((err) => app.log.error({ err, companyId: runner.companyId }, "chapter update failed"));
    if (event.type === "run.ended") void chapters.onRunEnded(event.runId).catch((err) => app.log.error({ err, companyId: runner.companyId }, "chapter close failed"));
    // The owner chat's answers.
    if (event.type === "run.update" && (event.update as { kind?: string } | null)?.kind === "agent_message") {
      void chat.onAgentMessage(event.runId, String((event.update as { text?: unknown }).text ?? "")).catch((err) => app.log.error({ err, companyId: runner.companyId }, "chat reply failed"));
      void pa.onAgentMessage(event.runId, String((event.update as { text?: unknown }).text ?? "")).catch((err) => app.log.error({ err, companyId: runner.companyId }, "PA relay failed"));
      void ticketChat.onAgentMessage(event.runId, String((event.update as { text?: unknown }).text ?? "")).catch((err) => app.log.error({ err, companyId: runner.companyId }, "ticket reply failed"));
    }
    // A tool call a fenced agent got a kernel refusal for (BOS-325).
    if (event.type === "run.update" && (event.update as { fenceDenied?: unknown } | null)?.fenceDenied === true) void decisionsSvc.onFenceDenied(runner, event.runId, ((event.update as { title?: unknown }).title as string | null) ?? null).catch((err) => app.log.error({ err, companyId: runner.companyId }, "fence refusal log failed"));
    // A tool call the agent says was refused (BOS-306).
    if (event.type === "run.update" && (event.update as { refused?: unknown } | null)?.refused === true) void decisionsSvc.onRefusedCall(runner, event.runId, ((event.update as { title?: unknown }).title as string | null) ?? null).catch((err) => app.log.error({ err, companyId: runner.companyId }, "refused call log failed"));
    if (event.type === "run.ended") void chat.onRunEnded(event.runId, event.error, !!event.interrupted).catch((err) => app.log.error({ err, companyId: runner.companyId }, "chat end failed"));
    if (event.type === "run.ended") void pa.onRunEnded(event.runId, event.error).catch((err) => app.log.error({ err, companyId: runner.companyId }, "PA fail-open failed"));
    // A subscription window set to run out before it resets: tell the owner once (R78).
    if (event.type === "run.quota") void quotaWatch(event.fundingSourceId).catch((err) => app.log.error({ err }, "quota forecast failed"));
    // What each agent kind offers, for the model picker (R60).
    if (event.type === "runner.models") void models.record(runner.companyId, event.agentKind, event.models).catch((err) => app.log.error({ err, companyId: runner.companyId }, "model list failed"));
    if (event.type === "runner.sandbox") void runners.recordSandbox(runner.id, event.report, (opts.now ?? (() => new Date()))()).catch((err) => app.log.error({ err, companyId: runner.companyId }, "sandbox report failed"));
    if (event.type === "runner.opencode_vacuum_cut") {
      const { type: _type, ...cut } = event;
      void opencodeVacuumAlerts({ alert: (input) => alerts.raise(input) })
        .onCut(runner, cut, (opts.now ?? (() => new Date()))())
        .then(() => notes.syncDecisions())
        .catch((err) => app.log.error({ err, companyId: runner.companyId }, "OpenCode VACUUM alert failed"));
    }
    if (event.type === "runner.disk") {
      const { type: _type, ...report } = event;
      void disk.onReport(runner, report, (opts.now ?? (() => new Date()))()).catch((err) => app.log.error({ err, companyId: runner.companyId }, "disk report handling failed"));
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
        // A run that took the owner's message and ended without an answer wakes its agent again (BOS-425).
        .then(() => ownerReplies.afterRunEnded(event.runId))
        .then(() => (event.interrupted ? null : scheduler.afterTicketRun(event.runId)))
        .then(() => (event.interrupted ? null : scheduler.afterReviewRun(event.runId)))
        .then(() => scheduler.tick())
        .catch((err) => app.log.error({ err, companyId: runner.companyId }, "run-ended handling failed"));
      // A run ended; ask for a quota refresh. Any provider ends here, but the reading is cached for
      // 5 minutes so only a refresh after a Synthetic run actually calls Synthetic (BOS-239).
      void refreshSyntheticQuota().catch((err) => app.log.warn({ err }, "synthetic quota refresh failed"));
    }
  });
  // One closer for every card Boss Man raises itself (DR-016, BOS-470): a card carries the conditions
  // under which its cause is gone, and this closes it, on any tier, with the reason. It runs on the
  // sweep below and on the events that make a condition true: a run ending or speaking, a runner
  // connecting, a deploy finishing.
  // Built after the ladder below (it raises through it); the closer asks it whether a rule is calm.
  let health: ServerHealth | null = null;
  const clearing = alertClearing(db, {
    isConnected: (runnerId) => runners.isConnected(runnerId),
    hasRoom: (fundingSourceId) => scheduler.hasRoom(fundingSourceId),
    addons: addonFacts,
    release: (ticketId) => decisionsSvc.release(ticketId),
    serverCalm: (rule) => health?.calmReason(rule) ?? null,
    now: opts.now,
  });
  // A runner coming back clears "could not start … runner offline" cards at once, on any tier
  // (BOS-475 E): the wake it could not start is what matters, so a connected runner alone isn't enough.
  runners.onConnect(() => void clearing.check().then((closed) => (closed ? notes.syncDecisions() : null)).catch((err) => app.log.error({ err }, "closing cards on runner connect failed")));
  // A "has sent nothing" alert for a run closes the moment the run ends or speaks again (BOS-217),
  // so the CEO and the owner are never asked about a run that has already moved on. Awaited before
  // the event is acknowledged, so nothing reads an alert the run has left behind.
  runners.onEventSync(async (runner, event) => {
    if (!("runId" in event) || event.type === "run.started") return;
    await closeStallAlertForRun(db, clearing, event.runId)
      .then((closed) => (closed ? notes.syncDecisions() : null))
      .catch((err) => app.log.error({ err, companyId: runner.companyId }, "closing a stall alert failed"));
    // A clean run (or the ticket finishing, or the deploy settling) can clear other cards too.
    await clearing
      .check()
      .then((closed) => (closed ? notes.syncDecisions() : null))
      .catch((err) => app.log.error({ err, companyId: runner.companyId }, "closing cards failed"));
  });
  const sweeps = sweepService(db, {
    // The merge line jam alert (BOS-766) reads the same view the Merge queue screen does; `mergeQueue` is
    // built below, so this resolves it per pass.
    mergeJam: () => mergeJam.run(),
    clearAlerts: () => clearing.check(),
    // A feature the roadmap commits to but nothing is working on (BOS-595): the sweep raises one CEO
    // card, which the one closer above withdraws as soon as a ticket is linked to the feature.
    featuresWithoutTickets: async () => {
      let raised = 0;
      for (const companyId of [...new Set((await db.select({ id: featuresTable.companyId }).from(featuresTable)).map((r) => r.id))]) {
        raised += await feedback.raiseFeatureNoTicket(companyId, async (f) => {
          const column = featureHorizon(f);
          const where = column === "now" ? "on the roadmap's Now column" : column === "next" ? "on the roadmap's Next column" : "in progress";
          await alerts.raise({
            companyId,
            kind: "feature_no_ticket",
            question: `The feature "${f.title}" is ${where}, but no open ticket is doing its work, so nothing will deliver it. Create a ticket for it (with create_ticket and feature set to it), or move it out of Now or Next.`,
            options: [GOT_IT],
            recommended: GOT_IT,
            from: "ceo",
            why: "creating a ticket for a feature is the CEO's",
            dedupeKey: `feature-no-ticket:${f.id}`,
            context: { type: "question", featureId: f.id, clearWhen: [{ kind: "featureHasTicket", featureId: f.id }] },
          });
        });
      }
      return raised;
    },
    // The same sweep settles second opinions whose asker was lost to a restart (BOS-338).
    expireAdvice: () => Promise.all([decisionsSvc.expireAdvice(), decisionsSvc.expireSecondOpinions()]),
    limits: opts.sweepLimits,
    now: opts.now,
    wake: (input) => scheduler.notify(input.agentId, input),
    isConnected: (runnerId) => runners.isConnected(runnerId),
    runnerSettling: (runnerId) => runners.isSettling(runnerId, (opts.now ?? (() => new Date()))()),
    runnerRestartedAt: (runnerId) => runners.restartedAt(runnerId),
    endRun: (runId, outcome, at, how) => runners.endRun(runId, outcome, at, how),
    // Free run slots go to idle in-progress work (BOS-574, DR-029).
    freeSlots: (companyId) => scheduler.freeSlots(companyId),
    // A never-started run's retry (BOS-480) is a wake of its own, not merged into a waiting one, so it keeps its resume and retry count.
    requeue: (input) => scheduler.wake(input),
    cancelOnRunner: (runnerId, runId) => runners.send(runnerId, { type: "run.cancel", runId }),
    endUnconfirmedCancels: (t) => runsSvc.endUnconfirmedCancels(t),
    // The run time limit stops a run through the Stop button's own cancel (BOS-846).
    cancelRun: (runId, reason) => runsSvc.cancel(runId, undefined, reason),
    // An approved merge cut off (e.g. by a deploy's hand-over) is tried once more, in the background.
    retryLand: (ticketId) => review.startLanding(ticketId, "Boss Man (trying an interrupted merge again)"),
    resumeLand: (ticketId) => review.startLanding(ticketId, "Boss Man (the server restarted during this merge; starting it again)"),
    releaseUnblocked: (ticketId) => scheduler.releaseIfUnblocked(ticketId),
    landingActive: (ticketId) => review.landingActive(ticketId),
    branchClash: (ticketId) => review.branchClash(ticketId),
    signoffCovers: (ticketId, signed, head) => review.signoffCovers(ticketId, signed, head),
    signoffWithdraw: (ticketId, cardHead, head, why) => review.withdrawStaleSignoff(ticketId, cardHead, head, why),
    expireSkills: () => skillProposals.expireOld(),
    // Stalled runs go to the Scrum Master first (BOS-119); `alerts` is built below.
    alert: (input) => alerts.raise(input),
    // The owner's messages on tickets that nobody has answered (BOS-425).
    ownerReplies: (t) => ownerReplies.sweep(t),
    // Whether a run committed (BOS-612): the branch head from the runner that holds the worktree. Read only when a "looks stuck" card is being written.
    branchHead: opts.branchHead ?? ((ticketId) => review.diff(ticketId).then((d) => d.head)),
  });
  const work = workService(db, {
    // A blocked ticket wakes its assignee when it is freed, not when it is assigned.
    onAssigned: async (t) => (t.systemState === "blocked" ? null : scheduler.notify(t.assigneeAgentId!, { ticketId: t.id, reason: "assigned" })),
    onDone: (t) => Promise.all([scheduler.onTicketDone(t.id), decisionsSvc.withdrawMergeCardsForTicket(t.id)]),
    onFeature: (id) => feedback.syncFeature(id),
    // The board's "Approved, merging" cards say where their merge is (BOS-667). `review` is built below; this runs per request.
    runningMerges: () => review.runningMerges(),
    now: opts.now,
  });
  // The CEO's proposed skills (BOS-86): review by the Security Reviewer where required, the owner's decision, then install.
  const skillProposals = skillProposalsService(db, skillsSvc, {
    createTicket: (projectId, input) => work.createTicket(projectId, input),
    raiseDecision: (input, tx) => decisionsSvc.raiseSkill(input, tx),
    withdrawDecision: (id) => decisionsSvc.withdrawSkill(id),
    tell: (agentId, note) => scheduler.notify(agentId, { reason: "skill decided", note, priority: 2 }),
    closeReview: (ticketId, stateNote) => work.updateTicket(ticketId, { state: "done", outcome: "cancelled", stateNote }),
    closeReviewDone: (ticketId, stateNote) => work.updateTicket(ticketId, { state: "done", outcome: "completed", stateNote }),
    // `retro` is built below; this runs per answer, after it exists.
    ended: (companyId, proposalId) => retro.proposalEnded(companyId, proposalId),
    now: opts.now,
  });
  decisionsSvc.setSkillHook((ctx, companyId, answer, by) => skillProposals.decide(companyId, ctx.proposalId, answer, by));
  // A limit or auth failure closes into one card per account (DR-017 B, BOS-469 point 3): the agent's own
  // funding source, or the one the run used when it says so.
  const loops = loopGuards(db, {
    limits: opts.loopLimits,
    now: opts.now,
    alert: (input) => alerts.raise(input),
    fundingSourceFor: async (agentId) => {
      if (!agentId) return null;
      const [row] = await db.select({ id: fundingSources.id, name: fundingSources.name }).from(fundingSources).innerJoin(agents, eq(agents.fundingSourceId, fundingSources.id)).where(eq(agents.id, agentId));
      return row ?? null;
    },
  });
  // The Scrum Master watchdog (BOS-58): its sweep runs on the leader's timer (main.ts), its actions through the Scrum Master's MCP tool.
  const watchdog = watchdogService(db, {
    addons: addonFacts,
    notify: (agentId, input) => scheduler.notify(agentId, input),
    nudge: (input) => scheduler.nudge(input),
    raise: (input) => decisionsSvc.raise(input),
    assign: (ticketId, agentId) => work.updateTicket(ticketId, { assigneeAgentId: agentId }),
    restoreState: (ticketId, state) => work.updateTicket(ticketId, { state, overLimit: true }),
    // A trip means the Scrum Master is the problem: straight to the owner.
    alert: (companyId, question) => decisionsSvc.raise({ companyId, agentId: null, question, options: ["Got it"], recommended: "Got it" }),
    alertCeo: (input) => alerts.raise(input),
    // The idle-capacity rules (BOS-659): how many of the company's run slots are busy, and its limit.
    capacity: async (companyId) => {
      const { company } = await scheduler.runLimits(companyId);
      return { busy: company.running, limit: company.limit };
    },
    notifyOwner: (n) => notes.notify({ ...n, agentId: null }),
    hosts: () => hostFacts.hosts(),
    serverHost: () => hostFacts.serverHost(),
    localHour: (t) => Number(formatDate("en-GB", t, { hour: "2-digit", hourCycle: "h23", timeZone: OWNER_TZ })),
    now: opts.now,
    log: (m) => app.log.error(m),
  });
  // Workflow retros (docs/19): the leader's timer starts them (main.ts), the retro agent's MCP tools fill them, and decisions apply the changes.
  const retro = retroService(db, { agents: agentsSvc, skills: skillsSvc, skillProposals, watchdog, notify: (agentId, input) => scheduler.notify(agentId, input), now: opts.now, log: (m) => app.log.error(m) });
  decisionsSvc.setRetroHook(retro);
  const alerts = alertLadder(db, {
    addons: addonFacts,
    notify: (agentId, input) => scheduler.notify(agentId, input),
    answer: (id, answer, extra) => decisionsSvc.answer(id, answer, extra),
    watchdog,
    nudge: (input) => scheduler.nudge(input),
    ceoCanRun: (companyId) => scheduler.ceoCanRun(companyId),
    hosts: () => hostFacts.hosts(),
    serverHost: () => hostFacts.serverHost(),
    clearExpired: async () => {
      const n = await clearing.check();
      if (n) await notes.syncDecisions();
      return n;
    },
    now: opts.now,
  });
  // Offline runners and the post-deploy "every runner is back" check (BOS-467).
  const runnerWatch = runnerWatchService(db, { isConnected: (id) => runners.isConnected(id), holdOn: async () => !!(await getHold(db)), wantedCompanies: () => launch.wantedCompanies(), notify: (n) => notes.notify(n), alert: (input) => alerts.raise(input), now: opts.now, log: (m) => app.log.warn(m) });
  // Server-health alerts (BOS-640): memory to the CEO, freezes to the owner. main.ts runs check() on the leader.
  health = serverHealthService({
    now: opts.now ? () => opts.now!().getTime() : undefined,
    stallsSince: (sinceMs) => stalls.since(sinceMs),
    ...opts.serverHealth,
    homeCompany: async () => (await db.select({ id: companies.id }).from(companies).orderBy(asc(companies.createdAt)).limit(1))[0]?.id ?? null,
    openUpdateCard: async () =>
      (
        await db
          .select({ id: decisions.id, question: decisions.question })
          .from(decisions)
          .where(and(eq(decisions.status, "open"), sql`${decisions.context}->>'type' = 'self_deploy'`, sql`${decisions.context}->>'target' = 'server'`))
          .orderBy(desc(decisions.createdAt))
          .limit(1)
      )[0] ?? null,
    isOpen: async (dedupeKey) => (await db.select({ id: decisions.id }).from(decisions).where(and(eq(decisions.dedupeKey, dedupeKey), eq(decisions.status, "open"))).limit(1)).length > 0,
    raise: async (input) => {
      const r = await alerts.raise(input);
      if (r) await notes.syncDecisions();
      return r;
    },
    log: (m) => app.log.warn(m),
  });
  const serverHealth = health;
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
  checkWake = (agentId, w) => scheduler.notify(agentId, w);
  // The owner's read-only merge queue screen (BOS-587): what runs, what waits, how the last ones ended.
  // In server mode (BOS-316, BOS-597) it reports the server-owned check queue's own mode, slots, and
  // running and waiting counts for the company, so the screen can show "waiting for a check slot".
  // The counts read only the live states, through check_jobs_state_queued: check_jobs has no company
  // index, so a company-only filter would read the whole table.
  const checkQueueSvc = checkQueue(db);
  const mergeQueue = mergeQueueService(db, {
    runningMerges: () => review.runningMerges(),
    limit: () => checkGate(db).limit(),
    queueStatus: async (companyId) => {
      const mode = await checkQueueSvc.mode();
      if (mode !== "server") return { mode, slots: await checkQueueSvc.slots(), running: 0, waiting: 0 };
      const [live] = (await db
        .select({
          running: sql<number>`(count(*) filter (where ${checkJobs.state} = 'running'))::int`.mapWith(Number),
          waiting: sql<number>`(count(*) filter (where ${checkJobs.state} = 'queued'))::int`.mapWith(Number),
        })
        .from(checkJobs)
        .where(and(eq(checkJobs.companyId, companyId), inArray(checkJobs.state, ["queued", "running"])))) as [{ running: number; waiting: number }];
      return { mode: mode as CheckQueueMode, slots: await checkQueueSvc.slots(), running: live?.running ?? 0, waiting: live?.waiting ?? 0 };
    },
    now: opts.now,
  });
  // The merge line jam alert (BOS-766): the same view the Merge queue screen reads, and the owner's own
  // notification service, so quiet hours and caps apply as for every other notification.
  const mergeJam = mergeJamService(db, {
    view: (companyId) => mergeQueue.get(companyId),
    notify: (input) => notes.notify(input),
    now: opts.now,
  });
  decisionsSvc.setLoopHooks({
    sendBack: (ticketId, text, reviewer) => review.sendBack(ticketId, text, reviewer),
    // A sign-off card for older code is replaced before the press is taken, with the reason (BOS-734).
    signoffStale: (ticketId, cardHead) => review.signoffStale(ticketId, cardHead),
    // A stalled-review card's actions (BOS-404, BOS-426): take it, hand it to another reviewer, send it back, or leave it.
    reviewStall: (ctx, answer, byAgentId) => review.reviewStall(ctx, answer, byAgentId),
    // Answering "Approve and merge" on the sign-off card starts a tracked landing without holding the
    // answer open: the check can take 10+ minutes, so the card closes at once and the ticket page and
    // Decisions show "Checking and merging" while it runs (including lock retries) (BOS-559). The merge
    // result arrives in the feed as it does today: a failed landing is recorded on the ticket and raised
    // as a card by land()/startLanding(), so the owner is still told and can approve it again.
    land: (ticketId, reviewer, merge) =>
      (merge?.markDone
        ? // Nothing to merge (no repo, or a no-code ticket): the owner's own sign-off finishes it in the same press (BOS-471).
          work.updateTicket(ticketId, { state: "done", outcome: "completed", overLimit: true, stateNote: "The owner approved and signed it off; there was nothing to merge." })
        : review.startLanding(ticketId, reviewer)
      ).catch(async (err) => {
        // Waiting on the sign-off, or another merge already running, is a wait, not a failed merge: no card.
        if (isSignoffPending(err) || err instanceof ReviewHeldError) return;
        if (err instanceof ReviewError && /already being checked and merged/i.test(err.message)) return;
        // A landing that couldn't start has already left a trail and a card (startLanding), so raise nothing
        // more, so a single failed press never leaves two cards saying the same thing; log it in case an
        // unexpected error got this far without one.
        app.log.warn(`the sign-off answer started no merge for ${ticketId}: ${(err as Error).message}`);
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
    moveAfterMerge: (ticketId, criteria) => review.moveAfterMerge(ticketId, criteria),
    raiseCap: async (ticketId) => {
      const [t] = await db.select({ cap: tickets.costCapMicros, projectCap: projects.ticketCostCapMicros }).from(tickets).innerJoin(projects, eq(projects.id, tickets.projectId)).where(eq(tickets.id, ticketId));
      const cap = t?.cap ?? t?.projectCap;
      if (cap) await db.update(tickets).set({ costCapMicros: Math.ceil(cap * 1.5) }).where(eq(tickets.id, ticketId));
      // Waiting work for the ticket can go again.
      await db.update(wakes).set({ status: "queued", statusReason: null, notBefore: null }).where(and(eq(wakes.ticketId, ticketId), eq(wakes.status, "deferred")));
    },
  });
  const checkRequests = checkRequestService(db, { command: async (scope, projectId) => { if (scope === "quick") return "scripts/check-quick.sh"; const [p] = await db.select({ v: projects.verifyCommand }).from(projects).where(eq(projects.id, projectId)); return p?.v ?? "scripts/check-all.sh"; }, diff: (runnerId, projectId, ticketId) => runners.request<WorkspaceDiff>(runnerId, (requestId) => ({ type: "workspace.diff", requestId, projectId, ticketId }), 60_000) });
  await mcpRoutes(app, db, { decisions: decisionsSvc, engagements: engagementsSvc, deploys: deploysSvc, runs: runsSvc, review, notes, chapters, work, feedback, ticketChat, wiki, skills: skillsSvc, skillProposals, agents: agentsSvc, pa, images, watchdog, alerts, retro, serverStatus, hostFacts, deviceProfiles, addons: addonFacts, selfDeployCards: () => selfDeploy.cardFacts(), checkRequests }, { onTicketDone: (ticketId, runId) => Promise.all([scheduler.onTicketDone(ticketId, runId), decisionsSvc.withdrawMergeCardsForTicket(ticketId)]), onTicketReview: (ticketId, agentId, runId) => scheduler.onTicketReview(ticketId, agentId, runId), nudge: (i) => scheduler.nudge(i), wake: (agentId, i) => scheduler.notify(agentId, i), onRunTicket: (ticketId, runId) => work.attachRun(ticketId, runId) });
  // The feedback portal's public API, on this listener too, so the owner can try it here.
  await portalRoutes(app, { feedback, secureCookies: opts.secureCookies ?? true, limits: opts.portalLimits, now: opts.now ? () => opts.now!().getTime() : undefined });

  app.setErrorHandler((err, _req, reply) => {
    // `message` is what the web app shows, so it names the first problem and its field.
    if (err instanceof ZodError) {
      const i = err.issues[0];
      return reply.code(400).send({ error: "invalid_request", message: i ? `${i.path.length ? `${i.path.join(".")}: ` : ""}${i.message}` : "The request isn't valid.", issues: err.issues });
    }
    if (err instanceof SecretRejected) return reply.code(422).send({ error: "secret_rejected", problems: err.problems });
    if (err instanceof WorkError || err instanceof FeedbackError) return reply.code(err.status).send({ error: err instanceof WorkError && err.field ? "conflict" : "rejected", message: err.message, ...(err instanceof WorkError && err.field ? { field: err.field } : {}) });
    const code = pgCode(err);
    if (code === "23505") return reply.code(409).send({ error: "already_exists" });
    if (code === "23503") return reply.code(422).send({ error: "unknown_reference" });
    if (code === "23514") return reply.code(422).send({ error: "constraint_violated" });
    if ((err as { statusCode?: number }).statusCode && (err as { statusCode: number }).statusCode < 500) return reply.send(err);
    app.log.error(err);
    return reply.code(500).send({ error: "internal_error" });
  });

  /** Secure flag for one request: see AppOptions.secureCookies. */
  const cookieSecure = (req: FastifyRequest) => (opts.secureCookies === "auto" ? req.protocol === "https" : opts.secureCookies ?? true);

  async function startSession(req: FastifyRequest, reply: FastifyReply, ownerId: string) {
    const token = newSessionToken();
    const expiresAt = new Date(Date.now() + SESSION_DAYS * 86_400_000);
    await db.insert(sessions).values({ tokenHash: hashToken(token), ownerId, expiresAt });
    reply.setCookie(SESSION_COOKIE, token, {
      path: "/",
      httpOnly: true,
      sameSite: "strict",
      secure: cookieSecure(req),
      expires: expiresAt,
    });
  }

  /** The signed-in owner's username, for the log. */
  async function ownerName(req: FastifyRequest) {
    const token = req.cookies[SESSION_COOKIE];
    const [row] = token ? await db.select({ username: owners.username }).from(sessions).innerJoin(owners, eq(owners.id, sessions.ownerId)).where(eq(sessions.tokenHash, hashToken(token))) : [];
    return row?.username ?? "the owner";
  }

  /** The signed-in owner's id, for rows kept per owner (device profiles). Only valid behind requireOwner. */
  async function currentOwnerId(req: FastifyRequest): Promise<string | null> {
    const token = req.cookies[SESSION_COOKIE];
    if (!token) return null;
    const [s] = await db.select({ ownerId: sessions.ownerId }).from(sessions).where(and(eq(sessions.tokenHash, hashToken(token)), gt(sessions.expiresAt, new Date())));
    return s?.ownerId ?? null;
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
    await startSession(req, reply, owner!.id);
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
    await startSession(req, reply, owner.id);
    return { username: owner.username };
  });

  // Phone Approve (BOS-243 rules 3, 4, 8): an ntfy http action posts {"token": "..."} here, with no
  // session. JSON in and out, never a page; request logging is off and the body is never logged or
  // echoed, so the token can't reach a log, the error buffer or a response. Its own parsers, in their
  // own scope, so a bad body gets a plain JSON answer rather than the error handler's message.
  await app.register(async (phone) => {
    phone.removeAllContentTypeParsers();
    phone.addContentTypeParser("application/json", { parseAs: "string", bodyLimit: 1024 }, (_req, body, done) => done(null, { json: body }));
    phone.addContentTypeParser("*", { parseAs: "string", bodyLimit: 1024 }, (_req, _body, done) => done(null, { json: null }));
    phone.setErrorHandler((err, _req, reply) => {
      const status = (err as { statusCode?: number }).statusCode;
      if (status && status >= 400 && status < 500) return reply.code(status).send({ ok: false, error: "bad_request" });
      // A fixed line only: the error itself could quote the request.
      app.log.warn("phone approve: a tap failed inside the server");
      return reply.code(500).send({ ok: false, error: "internal_error" });
    });
    phone.post("/api/phone/approve", { logLevel: "silent" }, async (req, reply) => {
      const raw = (req.body as { json?: string | null } | undefined)?.json;
      if (typeof raw !== "string") return reply.code(415).send({ ok: false, error: "json_only" });
      let token: unknown;
      try {
        token = (JSON.parse(raw) as { token?: unknown } | null)?.token;
      } catch {
        return reply.code(400).send({ ok: false, error: "bad_request" });
      }
      const r = await phoneApprove.redeem(token, req.ip);
      return reply.code(r.status).send(r.body);
    });
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
    owner.get("/api/bluegreen", async () => probeColours(colour(), build));

    owner.get("/api/me", async () => {
      const [o] = await db.select({ username: owners.username }).from(owners);
      return o;
    });

    // Device profiles (BOS-641): the owner's browsers report their measured screens so a layout
    // ticket can be checked at the real device. Only screen facts; one row per signed-in browser.
    owner.get("/api/devices", async (req) => {
      const ownerId = await currentOwnerId(req);
      return ownerId ? deviceProfiles.list(ownerId) : [];
    });
    owner.post("/api/devices", async (req, reply) => {
      const ownerId = await currentOwnerId(req);
      if (!ownerId) return reply.code(401).send({ error: "not_signed_in" });
      return deviceProfiles.report(ownerId, req.body);
    });
    owner.patch("/api/devices/:id", async (req, reply) => {
      const ownerId = await currentOwnerId(req);
      if (!ownerId) return reply.code(401).send({ error: "not_signed_in" });
      const { id } = IdParam.parse(req.params);
      const { label } = z.object({ label: z.string().trim().min(1).max(80) }).parse(req.body);
      const p = await deviceProfiles.rename(ownerId, id, label);
      return p ?? reply.code(404).send({ error: "not_found" });
    });
    owner.delete("/api/devices/:id", async (req, reply) => {
      const ownerId = await currentOwnerId(req);
      if (!ownerId) return reply.code(401).send({ error: "not_signed_in" });
      const { id } = IdParam.parse(req.params);
      return (await deviceProfiles.remove(ownerId, id)) ? { ok: true } : reply.code(404).send({ error: "not_found" });
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
      const b = z.object({ name: z.string().trim().min(1).max(80), mission: z.string().max(2000).nullable(), ownerApprovesEngagements: z.boolean(), goalCheckDays: z.number().int().min(1).max(365), nudgesPerHour: z.number().int().min(1).max(1000), adviceTimeoutMinutes: z.number().int().min(5).max(1440), maxRunMinutes: z.number().int().min(1).max(10_080).nullable(), permissionJudge: z.enum(PERMISSION_JUDGE_MODES), fenceMode: z.enum(FENCE_MODES), diskCapGb: z.number().positive().max(100_000).nullable(), ticketPrefix: z.string().trim().toUpperCase().regex(TICKET_PREFIX, "1 to 10 letters or digits") }).partial().parse(req.body);
      const { diskCapGb, ...rest } = b;
      // Enforce changes what an agent can do without asking (BOS-325): not selectable until BOS-323 has closed the git gap.
      if (b.fenceMode === "enforce" && !FENCE_ENFORCE_AVAILABLE) return reply.code(400).send({ error: "fence_enforce_locked", message: "Enforce isn't available yet: it waits for the fix that stops a fenced agent running programs outside the fence (BOS-323)." });
      if (b.fenceMode && b.fenceMode !== "off") {
        const [r] = await db.select({ id: runnersTable.id, sandbox: runnersTable.sandbox }).from(runnersTable).where(eq(runnersTable.companyId, id));
        if (b.fenceMode === "enforce" && r?.sandbox?.level !== "full" && r?.sandbox?.level !== "partial") return reply.code(400).send({ error: "fence_unavailable", message: "This company's runner can't fence agents, so enforce can't be switched on." });
        // Watch on a host that reported it can't fence would be saved and then do nothing (BOS-555 G2):
        // refuse it, as enforce is. A runner that hasn't reported yet is let through; a saved mode is never changed here.
        if (b.fenceMode === "watch" && r?.sandbox?.level === "unavailable")
          return reply.code(400).send({ error: "fence_unavailable", message: "This company's runner can't fence agents (its kernel has no usable Landlock, or the container blocks it), so Watch would do nothing. Update the host's kernel to 5.19 or newer, or let the container use Landlock, then restart the runner." });
      }
      const patch = { ...rest, ...(diskCapGb !== undefined ? { diskCapBytes: diskCapGb === null ? null : Math.round(diskCapGb * 1024 ** 3) } : {}) };
      const [c] = await db.update(companies).set(patch).where(eq(companies.id, id)).returning();
      if (!c) return reply.code(404).send({ error: "not_found" });
      // The disk cap is the owner's own setting (BOS-274): keep a record of who changed it and to what.
      if (diskCapGb !== undefined) {
        const gb = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(1)} GB`;
        await record(db, { companyId: id, kind: "settings", summary: diskCapGb === null ? "Owner reset the workspace disk cap to the server default (20 GB)" : `Owner set the workspace disk cap to ${gb(Math.round(diskCapGb * 1024 ** 3))}`, detail: { diskCapGb } });
      }
      return c;
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
      const who = (ref: string | string[]): string => (Array.isArray(ref) ? ref.map((r) => names.get(r) ?? "the CEO").filter((n, i, all) => all.indexOf(n) === i).join(" or ") : ref === "ceo" ? "the CEO" : ref === SENIOR_DEV ? "the Senior Developer (the CEO until one is hired)" : (names.get(ref) ?? "the CEO"));
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
    // Standing rules (BOS-353): the owner or the CEO sets a short block every agent reads at the start of every run.
    owner.get("/api/companies/:id/standing-rules", async (req, reply) => {
      const { id } = IdParam.parse(req.params);
      const [c] = await db.select({ id: companies.id }).from(companies).where(eq(companies.id, id));
      if (!c) return reply.code(404).send({ error: "not_found" });
      return { ...(await getStandingRules(db, id)), max: STANDING_RULES_MAX };
    });
    // The owner's change is kept in the company CEO's history too, so the same Undo works for either of them.
    const standingRulesCeo = async (companyId: string) => (await db.select({ id: agents.id }).from(agents).where(and(eq(agents.companyId, companyId), eq(agents.role, "ceo"), isNull(agents.retiredAt))))[0]?.id ?? null;
    owner.put("/api/companies/:id/standing-rules", async (req, reply) => {
      const { id } = IdParam.parse(req.params);
      const b = z.object({ text: z.string() }).parse(req.body);
      const [c] = await db.select({ id: companies.id }).from(companies).where(eq(companies.id, id));
      if (!c) return reply.code(404).send({ error: "not_found" });
      const problem = standingRulesError(b.text.replace(/\r\n/g, "\n").trim());
      if (problem) return reply.code(400).send({ error: "invalid_standing_rules", message: problem });
      try {
        const saved = await setStandingRules(db, id, { text: b.text, by: "the owner", byAgentId: await standingRulesCeo(id) });
        await record(db, { companyId: id, kind: "settings", summary: saved.text ? "Owner updated the standing rules" : "Owner cleared the standing rules" });
        return { ...saved, max: STANDING_RULES_MAX };
      } catch (err) {
        if (err instanceof Error && err.name === "StandingRulesError") return reply.code(400).send({ error: "invalid_standing_rules", message: err.message });
        throw err;
      }
    });
    owner.post("/api/companies/:id/standing-rules/undo", async (req, reply) => {
      const { id } = IdParam.parse(req.params);
      const ceo = await standingRulesCeo(id);
      if (!ceo) return reply.code(404).send({ error: "not_found" });
      try {
        const saved = await undoStandingRules(db, id, ceo);
        await record(db, { companyId: id, kind: "settings", summary: "Owner undid the last standing rules change" });
        return { ...saved, max: STANDING_RULES_MAX };
      } catch (err) {
        if (err instanceof Error && err.name === "StandingRulesError") return reply.code(409).send({ error: "cannot_undo_standing_rules", message: err.message });
        throw err;
      }
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
    // Infinite-mode agents have their own "background" slots instead (BOS-279), so slow free runs never take a normal one.
    const runLimits = async () => {
      const [row] = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, "run_limits"));
      const v = row?.value as { instance?: number; company?: number; background?: number } | undefined;
      return {
        instance: v?.instance ?? scheduler.limits.instance,
        company: v?.company ?? scheduler.limits.company,
        background: v?.background ?? scheduler.limits.background,
        defaults: { instance: DEFAULT_LIMITS.instance, company: DEFAULT_LIMITS.company, background: DEFAULT_LIMITS.background },
      };
    };
    owner.get("/api/run-limits", async () => runLimits());
    owner.put("/api/run-limits", async (req) => {
      const value = z
        .object({ instance: z.number().int().min(1).max(32), company: z.number().int().min(1).max(16), background: z.number().int().min(0).max(16).optional() })
        .refine((b) => b.company <= b.instance, { message: "The company limit can't be higher than the all-companies limit." })
        .parse(req.body);
      // A saved value without background (an older save) keeps whatever is stored, so this write never resets it to the default.
      const [row] = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, "run_limits"));
      const before = row?.value as { background?: number } | undefined;
      const merged = { instance: value.instance, company: value.company, background: value.background ?? before?.background ?? DEFAULT_LIMITS.background };
      await db.insert(settings).values({ key: "run_limits", value: merged }).onConflictDoUpdate({ target: settings.key, set: { value: merged } });
      return runLimits();
    });
    /** Whether phone Approve buttons are on, and if not why, for Settings → Notifications (BOS-243). */
    const approveStatus = async (s: NotifySettings) => {
      const g = approveGate(s, s.ntfy?.tokenSecretId ? await secretsSvc.reveal(s.ntfy.tokenSecretId) : null);
      return g.on ? { on: true } : { on: false, why: g.why };
    };
    // BOS-798: Settings → Server and runner → Checks. The owner's switch for the server-owned check queue (DR-003) and its slots.
    // Owner only: no agent tool or route writes these settings.
    const checkQueueView = async () => {
      const rows = await db.select({ id: runnersTable.id, company: companies.name }).from(runnersTable).innerJoin(companies, eq(companies.id, runnersTable.companyId));
      const live = rows.filter((r) => runners.isConnected(r.id));
      return {
        mode: await checkQueueSvc.mode(),
        slots: await checkQueueSvc.slots(),
        maxSlots: MAX_CHECK_SLOTS,
        defaultSlots: DEFAULT_CHECK_SLOTS,
        // Connected runners on an image too old to run queued checks: their companies' jobs would wait until the runners are updated.
        runnersTooOld: live.filter((r) => !runners.can(r.id, "check-jobs")).map((r) => r.company),
      };
    };
    owner.get("/api/settings/check-queue", async () => checkQueueView());
    owner.put("/api/settings/check-queue", async (req) => {
      const b = z.object({ mode: z.enum(["legacy", "server"]), slots: z.number().int().min(1).max(MAX_CHECK_SLOTS) }).parse(req.body);
      const was = await checkQueueSvc.mode();
      await checkQueueSvc.setSlots(b.slots);
      await checkQueueSvc.setMode(b.mode);
      // Back to legacy: nothing starts queued jobs any more, so each is cancelled with its reason and whoever asked is told
      // (an agent is woken to run check-quick.sh itself; a merge waiting on one gets the usual "check stopped" card). Running jobs finish.
      let cancelled = 0;
      if (was === "server" && b.mode === "legacy")
        for (const id of await checkQueueSvc.queuedIds())
          if (await checks.cancel(id, "The owner switched the check queue off (back to legacy), so this queued check will not run. Run scripts/check-quick.sh yourself, as before.")) cancelled++;
      if (b.mode === "server") await checks.pump();
      return { ...(await checkQueueView()), cancelled };
    });
    // BOS-313: check the merged result before pushing it (off by default while it rolls out).
    owner.get("/api/settings/check-merged-result", async () => ({ on: await review.checkMergedResult() }));
    owner.put("/api/settings/check-merged-result", async (req) => ({ on: await review.setCheckMergedResult(z.object({ on: z.boolean() }).parse(req.body).on) }));
    // BOS-419: Settings → This host. The facts the host reported (with source and any conflict) and the ones only the owner can give.
    owner.get("/api/host-facts", async () => ({ ...(await hostFacts.sync()), ownerFacts: [...OWNER_FACTS] }));
    // BOS-770: Settings → Server and runner. The .env network-guard allow entries and which ones Boss Man already covers. Read only.
    owner.get("/api/netguard-allow", async () => ({ report: await netguardAllow().catch(() => null) }));
    owner.put("/api/host-facts", async (req, reply) => {
      const body = z.object({ key: z.string(), value: z.string() }).parse(req.body);
      try {
        return { ...(await hostFacts.confirm(body.key, body.value)), ownerFacts: [...OWNER_FACTS] };
      } catch (e) {
        return reply.code(400).send({ error: e instanceof Error ? e.message : "Couldn't save that fact." });
      }
    });
    owner.get("/api/notification-settings", async () => {
      const s = await notes.getSettings();
      return { ...s, ntfy: s.ntfy ? { url: s.ntfy.url, topic: s.ntfy.topic, hasToken: !!s.ntfy.tokenSecretId } : null, approve: await approveStatus(s) };
    });
    owner.put("/api/notification-settings", async (req) => {
      const b = NotifySettings.omit({ ntfy: true })
        .extend({
          ntfy: z.object({ url: NtfyUrl, topic: z.string(), token: z.string().trim().min(1).max(500).nullable().optional() }).nullable(),
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
      return { ...saved, ntfy: saved.ntfy ? { url: saved.ntfy.url, topic: saved.ntfy.topic, hasToken: !!saved.ntfy.tokenSecretId } : null, approve: await approveStatus(saved) };
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
      agentIds: z.array(z.string().min(1).max(64)).min(1).max(50).optional(),
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
      const report = await runnerReport.companyPanel(id);
      return { registered: true, runnerId: r.id, connected: runners.isConnected(r.id), lastSeenAt: r.lastSeenAt, imageVersion: r.imageVersion, diskUsedBytes: r.diskUsedBytes, diskCheckedAt: r.diskCheckedAt, addons: r.addons, sandbox: r.sandbox, sandboxCheckedAt: r.sandboxCheckedAt, launcher, report };
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
      // The owner typed this one in, so a private host (or a LAN name) is meant; a public name they add is not trusted,
      // since it could be re-pointed at a private address later (BOS-708).
      const allowPrivate = await allowsPrivate(b.url);
      const [row] = await db.insert(mcpServers).values({ ...b, companyId: id, allowPrivate }).onConflictDoNothing().returning();
      if (row) void launch.syncAllow(id);
      return row ? reply.code(201).send(row) : reply.code(409).send({ error: "name_taken", message: "This company already has a tool server with that name." });
    });
    owner.delete("/api/mcp-servers/:id", async (req, reply) => {
      const [row] = await db.delete(mcpServers).where(eq(mcpServers.id, IdParam.parse(req.params).id)).returning({ id: mcpServers.id, companyId: mcpServers.companyId });
      if (row) void launch.syncAllow(row.companyId);
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
      /** Place in the owner's ordered list of Claude accounts (1 = first); null takes it out (BOS-383). */
      fallbackRank: z.number().int().min(1).max(10).nullable().optional(),
      /** Hold routine work at this share of a subscription window (BOS-227). */
      quotaHoldAt: z.number().min(0.8).max(1).optional(),
      /** Whether extra usage may be spent: pause (default), urgent only, or all work. */
      quotaOverage: z.enum(["pause", "urgent", "all"]).optional(),
      /** Adapter window names that never trigger the hold. */
      quotaDisabledWindows: z.array(z.string().trim().min(1).max(100)).max(50).optional(),
    });
    const FundingInput = FundingFields.superRefine((v, ctx) => {
      const problem = fundingComboError(v.kind, v.provider);
      if (problem) ctx.addIssue({ code: "custom", path: ["provider"], message: problem });
    });

    /** A ranked Claude account must be an Anthropic subscription, and its login a Claude setup-token secret (BOS-383). */
    const rankProblem = async (kind: string, provider: string, rank: number | null | undefined, secretId: string | null | undefined) => {
      if (rank == null) return null;
      if (kind !== "subscription" || provider !== "anthropic") return "Only a Claude subscription can be put in the list of accounts.";
      if (!secretId) return rank > 1 ? "Every account after the first needs its own Claude setup-token as its login." : null;
      const [s] = await db.select({ kind: secretsTable.kind }).from(secretsTable).where(eq(secretsTable.id, secretId));
      return s?.kind === "claude_oauth_token" ? null : "Pick a Claude setup-token secret as this account's login.";
    };

    owner.post("/api/funding-sources", async (req, reply) => {
      const b = FundingInput.parse(req.body);
      const bad = await rankProblem(b.kind, b.provider, b.fallbackRank, b.secretId);
      if (bad) return reply.code(400).send({ error: "invalid_request", message: bad });
      const row = await funding.create({
        name: b.name,
        kind: b.kind,
        provider: b.provider,
        monthlyGrantMicros: b.monthlyGrantUsd != null ? usdToMicros(b.monthlyGrantUsd) : null,
        cycleAnchor: b.cycleAnchor ?? null,
        secretId: b.secretId ?? null,
        fallbackRank: b.fallbackRank ?? null,
        quotaHoldAt: b.quotaHoldAt ?? 0.95,
        quotaOverage: b.quotaOverage ?? "pause",
        quotaDisabledWindows: b.quotaDisabledWindows ?? [],
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
      const badRank = await rankProblem(b.kind ?? cur.kind, b.provider ?? cur.provider, b.fallbackRank === undefined ? cur.fallbackRank : b.fallbackRank, b.secretId ?? cur.secretId);
      if (badRank) return reply.code(400).send({ error: "invalid_request", message: badRank });
      const row = await funding.update(id, {
        name: b.name,
        kind: b.kind,
        provider: b.provider,
        monthlyGrantMicros: b.monthlyGrantUsd != null ? usdToMicros(b.monthlyGrantUsd) : undefined,
        cycleAnchor: b.cycleAnchor,
        secretId: b.secretId,
        fallbackRank: b.fallbackRank,
        quotaHoldAt: b.quotaHoldAt,
        quotaOverage: b.quotaOverage,
        quotaDisabledWindows: b.quotaDisabledWindows,
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
      // The description is an owner message box too: a pasted log goes in whole (BOS-502).
      body: z.string().max(OWNER_MESSAGE_MAX).nullable(),
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
      ownerSetup: z.string().max(4000).nullable(),
      noCode: z.boolean(),
      urgent: z.boolean(),
      risk: z.enum(RISK_TIERS).nullable(),
      size: z.number().refine(isTaskSize, `Size is one of ${SIZE_SCALE}.`).nullable(),
      planFirst: z.boolean(),
      featureId: Uuid.nullable(),
      overLimit: z.boolean(),
      // What the page loaded for a text field it is saving, so a change landing since is refused, not overwritten (BOS-905).
      titleLoaded: z.string().max(200).nullable(),
      bodyLoaded: z.string().max(OWNER_MESSAGE_MAX).nullable(),
      acceptanceCriteriaLoaded: acceptanceCriteriaSchema,
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
            .refine(repoUrlAllowed, "Give an https://, ssh://, git@ or local path address. Plain http:// works for a LAN address such as http://192.0.2.10:3003/you/repo.git.")
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
      // The owner set this git address themselves, so its private address is meant (a LAN git server); the guard keeps it (BOS-708).
      if (fields.repoUrl !== undefined) Object.assign(fields, { allowPrivate: !!fields.repoUrl });
      const [p] = await db
        .update(projects)
        .set({ ...fields, ...(ticketCostCapUsd !== undefined ? { ticketCostCapMicros: ticketCostCapUsd === null ? null : usdToMicros(ticketCostCapUsd) } : {}), ...(monthlyCapUsd !== undefined ? { monthlyCapMicros: monthlyCapUsd === null ? null : usdToMicros(monthlyCapUsd) } : {}) })
        .where(eq(projects.id, id))
        .returning();
      // A new repo address (or archiving) changes which git host the company's runner may reach.
      if (p && (fields.repoUrl !== undefined || archived !== undefined)) void launch.syncAllow(p.companyId);
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
      // A ticket in review, waiting for the owner or finished has no next step for its agent, so the quota
      // hold is not about it and the page must not say routine work is paused for it (BOS-471).
      const needsAgent = row.t.systemState === "ready" || row.t.systemState === "in_progress";
      // The ticket's own held wake, or, when its wake was merged into another ticket's, the one
      // its assignee is held by (BOS-253): the page still offers Run now and says why it's held.
      const heldBy = (own: boolean) =>
        db
          .select({ until: wakes.notBefore, reason: wakes.statusReason })
          .from(wakes)
          .where(and(own ? eq(wakes.ticketId, id) : eq(wakes.agentId, row.t.assigneeAgentId!), eq(wakes.status, "deferred"), sql`${wakes.statusReason} like 'subscription %'`))
          .limit(1);
      let [held] = needsAgent ? await heldBy(true) : [];
      const heldByAgent = !held;
      if (!held && needsAgent && row.t.assigneeAgentId) [held] = await heldBy(false);
      // Plain words for the banner (BOS-471): the agent, the account it is paid from, and, when another
      // ticket really holds it, which one. Never a claim that it is "held by other work" on a guess.
      let heldSource: string | null = null;
      let heldOther: { ref: string; title: string } | null = null;
      if (held && row.t.assigneeAgentId) {
        const [src] = await db
          .select({ name: fundingSources.name })
          .from(agents)
          .innerJoin(fundingSources, eq(fundingSources.id, agents.fundingSourceId))
          .where(eq(agents.id, row.t.assigneeAgentId));
        heldSource = src?.name ?? null;
        if (heldByAgent) {
          const [other] = await db
            .select({ number: tickets.number, title: tickets.title, prefix: companies.ticketPrefix })
            .from(wakes)
            .innerJoin(tickets, eq(tickets.id, wakes.ticketId))
            .innerJoin(projects, eq(projects.id, tickets.projectId))
            .innerJoin(companies, eq(companies.id, projects.companyId))
            .where(and(eq(wakes.agentId, row.t.assigneeAgentId), eq(wakes.status, "deferred"), sql`${wakes.statusReason} like 'subscription %'`, ne(wakes.ticketId, id)))
            .limit(1);
          if (other) heldOther = { ref: ticketRef(other.prefix ?? row.prefix, other.number) ?? "", title: other.title };
        }
      }
      // Where it stands on the owner's sign-off, in one word for the page (BOS-503), so nobody guesses from a state note.
      const signoffNow = (await signoffState(db, row.t)).state;
      // signoffWaiting keeps its BOS-471 meaning: a card is open for the button to settle.
      const signoff = !!(await openSignoffCard(db, row.t.id));
      return { ...row.t, ref: ticketRef(row.prefix, row.t.number), project: row.project, repoUrl: row.repoUrl, defaultBranch: row.defaultBranch, landing: row.landing, verifyCommand: row.verifyCommand, ownerSignoff: ruleFor(await effectivePolicy(db, row.t), row.t.risk).ownerSignoff, assignee: row.assignee, quotaHeldUntil: held?.until?.toISOString() ?? null, quotaHeldReason: held?.reason ?? null, quotaHeldAgent: heldByAgent, quotaHeldSource: heldSource, quotaHeldOther: heldOther, signoffWaiting: signoff, signoff: signoffNow === "none" ? null : signoffNow, hold: row.t.systemState === "review" ? await holdView(db, id) : null };
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
      const { text, interrupt, agentId } = z.object({ text: z.string().trim().min(1).max(OWNER_MESSAGE_MAX), interrupt: z.boolean().optional(), agentId: z.string().uuid().optional() }).parse(req.body);
      return ticketChat
        .ownerSays(id, text, { interrupt, agentId })
        .then((m) => reply.code(201).send(m))
        .catch(ticketChatErrors(reply));
    });

    // Skills and packs (R71): routes/skills.ts, on this owner scope.
    skillRoutes(owner, db, { skillsSvc, skillProposals });

    // The company as one file (docs/11): set-up always; wiki and tickets when asked. Read-only.
    owner.get("/api/companies/:id/export", async (req, reply) => {
      const { id } = IdParam.parse(req.params);
      const q = z.object({ wiki: z.enum(["0", "1"]).optional(), tickets: z.enum(["none", "open", "all"]).optional() }).parse(req.query);
      const out = await exportCompany(db, id, { wiki: q.wiki === "1", tickets: q.tickets ?? "none" });
      if (!out) return reply.code(404).send({ error: "not_found" });
      return reply.header("content-type", "application/zip").header("content-disposition", `attachment; filename="${out.name}"`).send(Buffer.from(out.bytes));
    });

    // Import (docs/11, step 2): a package becomes a new company. Preview writes nothing.
    const ImportBody = z.object({ zip: z.string().min(1), name: z.string().trim().min(1).max(80).optional(), fundingSourceId: Uuid.nullable().optional(), allowStackServices: z.boolean().optional() });
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
        done = await applyPackage(db, readPackage(new Uint8Array(Buffer.from(b.zip, "base64"))), { name: b.name, fundingSourceId: b.fundingSourceId, allowStackServices: b.allowStackServices });
      } catch (err) {
        return importErrors(reply)(err);
      }
      for (const pageId of done.wikiPageIds) semantic.enqueue(done.companyId, pageId);
      // The company is already saved and its id is what the caller needs. A failure while raising the
      // checklist card must not turn a successful import into an error reply with no company id (BOS-927):
      // log it and still return the import's result.
      await decisionsSvc
        .raise({ companyId: done.companyId, agentId: null, question: `${done.name} was imported. Left to do:\n${done.checklist.map((x) => `- ${x}`).join("\n")}`, options: ["Done"], recommended: "Done" })
        .catch((err) => app.log.error({ err, companyId: done.companyId }, "import checklist card failed"));
      if (launch.enabled)
        void launch.start(done.companyId).catch((err) =>
          notes.notify({ companyId: done.companyId, agentId: null, level: "flag", title: `${done.name}'s runner didn't start`, body: (err as Error).message, link: "#/settings" }).catch(() => {}),
        );
      return reply.code(201).send({ companyId: done.companyId, name: done.name, checklist: done.checklist });
    });

    // The home screen (R74).
    owner.get("/api/companies/:id/dashboard", async (req) => dashboard.get(IdParam.parse(req.params).id));

    // The merge queue, read-only (BOS-587): what is running now, what waits and how the last ones ended.
    owner.get("/api/companies/:id/merge-queue", async (req) => mergeQueue.get(IdParam.parse(req.params).id));

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

    // The CEO-style brief, built when asked and never stored as a page (R84).
    owner.get("/api/companies/:id/brief", async (req, reply) => {
      const { id } = IdParam.parse(req.params);
      const [c] = await db.select({ id: companies.id }).from(companies).where(eq(companies.id, id));
      if (!c) return reply.code(404).send({ error: "not_found" });
      return { markdown: await buildBrief(db, { companyId: id, agentId: null, role: "ceo", since: null, now: opts.now?.() ?? new Date(), plain: true }) };
    });
    // The company wiki, semantic search settings and what each ticket produced (R69): routes/wiki.ts.
    wikiRoutes(owner, { wiki, semantic });
    // The model second opinion on permission cards (BOS-338). The key is picked from Secrets, never sent back.
    owner.get("/api/companies/:id/second-opinion", async (req) => secondOpinion.settings(IdParam.parse(req.params).id));
    owner.put("/api/companies/:id/second-opinion", async (req, reply) => {
      const { id } = IdParam.parse(req.params);
      const b = SecondOpinionSettings.parse(req.body);
      if (b.enabled && (!b.model || !b.baseUrl)) return reply.code(400).send({ error: "invalid_request", message: "Set the provider address and the model first." });
      return secondOpinion.setSettings(id, b);
    });
    owner.post("/api/companies/:id/second-opinion/test", async (req) => {
      IdParam.parse(req.params);
      return secondOpinion.test(SecondOpinionSettings.parse(req.body));
    });

    // A held wake can be run now: it gets high priority, which passes the quota hold, and starts on the next pass.
    owner.post("/api/tickets/:id/run-now", async (req, reply) => {
      const { id } = IdParam.parse(req.params);
      const [t] = await db.select({ companyId: tickets.companyId, title: tickets.title, assigneeAgentId: tickets.assigneeAgentId, systemState: tickets.systemState }).from(tickets).where(eq(tickets.id, id));
      if (!t) return reply.code(404).send({ error: "not_found" });
      const release = { status: "queued" as const, statusReason: null, notBefore: null, priority: sql`greatest(${wakes.priority}, ${DEFAULT_LIMITS.highPriority})` };
      const released = await db
        .update(wakes)
        .set(release)
        .where(and(eq(wakes.ticketId, id), eq(wakes.status, "deferred"), sql`${wakes.statusReason} like 'subscription %'`))
        .returning({ id: wakes.id });
      // The ticket's wake can be merged into another of its assignee's held wakes (BOS-253): with
      // none of its own, give it one now, so Run now starts this ticket rather than that other work.
      const canStart = t.assigneeAgentId && (t.systemState === "ready" || t.systemState === "in_progress");
      if (!released.length && canStart) {
        const [waiting] = await db
          .select({ id: wakes.id, priority: wakes.priority })
          .from(wakes)
          .where(and(eq(wakes.ticketId, id), inArray(wakes.status, ["queued", "deferred"]), isNull(wakes.runId)))
          .limit(1);
        if (waiting) await db.update(wakes).set(release).where(eq(wakes.id, waiting.id));
        else await scheduler.wake({ agentId: t.assigneeAgentId!, ticketId: id, reason: "woken by owner", priority: DEFAULT_LIMITS.highPriority, note: "The owner ran this ticket now, past the quota hold." });
        released.push({ id: waiting?.id ?? id });
      }
      if (released.length) await scheduler.tick();
      await record(db, { companyId: t.companyId, ticketId: id, kind: "quota", summary: `Owner ran it now past the quota hold (${released.length} wake${released.length === 1 ? "" : "s"})`, at: new Date() });
      return { released: released.length };
    });

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
      // Moving a ticket to the state it is already in must not re-run what entering that state does (DR-010).
      const [before] = await db.select({ state: tickets.systemState }).from(tickets).where(eq(tickets.id, id));
      const sameState = before?.state === state;
      const moved = await work.updateTicket(id, { state, ...(state === "blocked" ? { blockedUntil: blockedUntil ? new Date(blockedUntil) : null, blockedUntilReason: blockedUntil ? blockedUntilReason || null : null } : {}) });
      const label = ({ backlog: "Backlog", ready: "Ready", in_progress: "In progress", blocked: "Blocked", review: "In review", done: "Done" } as Record<string, string>)[state] ?? state;
      await record(db, { companyId: moved.companyId, ticketId: id, kind: "state", summary: `Owner moved it to ${label}`, at: new Date() });
      // Nobody should start work on a ticket the owner has parked or closed.
      if (state === "done" || state === "backlog" || state === "blocked")
        await db.update(wakes).set({ status: "dropped", statusReason: `The owner moved the ticket to ${label}.` }).where(and(eq(wakes.ticketId, id), inArray(wakes.status, ["queued", "deferred"])));
      if (state === "review" && !sameState) await scheduler.onTicketReview(id, null);
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
      description: z.string().max(OWNER_MESSAGE_MAX).nullable(),
      status: z.enum(FEATURE_STATUSES),
      areaId: Uuid.nullable(),
      parentId: Uuid.nullable(),
      effort: z.number().int().min(1).max(5).nullable(),
      rank: z.number().int().min(1).max(5).nullable(),
      horizon: z.enum(HORIZONS).nullable(),
      driverScores: z.record(Uuid, z.number().int().min(0).max(5).nullable()),
      milestoneId: Uuid.nullable(),
      objectiveId: Uuid.nullable(),
      portalVisible: z.boolean(),
      publicSummary: z.string().trim().max(2000).nullable(),
      showPublicly: z.boolean(),
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
      // An upload replaces any picture the CEO copied from a ticket image (BOS-265).
      await db.insert(agentAvatars).values({ agentId: id, bytes, type }).onConflictDoUpdate({ target: agentAvatars.agentId, set: { bytes, type, imageId: null } });
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
      const { text, agentId } = z.object({ text: z.string().trim().min(1).max(OWNER_MESSAGE_MAX), agentId: Uuid.optional() }).parse(req.body);
      return chat.send(id, text, agentId).then((m) => reply.code(201).send(m), chatErrors(reply));
    });

    // "Let the CEO question me first": the Board's add form sends its draft here instead of creating it.
    owner.post("/api/companies/:id/chat/grill", async (req, reply) => {
      const { id } = IdParam.parse(req.params);
      const b = z.object({ kind: z.enum(["task", "feature"]), title: z.string().trim().min(1).max(200), description: z.string().trim().max(OWNER_MESSAGE_MAX).nullable().optional(), projectId: Uuid.optional() }).parse(req.body);
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
    /** Features for the roadmap's Now / Next / Later columns, grouped by objective on the client. */
    owner.get("/api/roadmap/features", async () => {
      const cos = await db.select({ id: companies.id, name: companies.name }).from(companies).orderBy(asc(companies.name));
      return Promise.all(cos.map(async (c) => ({ ...c, features: await feedback.roadmapFeatures(c.id) })));
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
        .object({ name: z.string().trim().min(1).max(80), title: z.string().trim().max(80).nullable(), instructions: Instructions, model: z.string().nullable(), thinking: z.enum(THINKING_LEVELS).nullable(), fundingSourceId: Uuid.nullable(), agentKind: z.string().min(1), paused: z.boolean(), starred: z.boolean() })
        .partial()
        .parse(req.body);
      // Who reviews what is set only in Settings > Reviews now (BOS-198); say so rather than drop it quietly.
      if (req.body && typeof req.body === "object" && "reviewKind" in req.body) return reply.code(400).send({ error: "moved", message: "Reviewers are chosen in Settings > Reviews." });
      const patch = b;
      const [before] = await db.select().from(agents).where(eq(agents.id, id));
      if (!before) return reply.code(404).send({ error: "not_found" });
      // An agent with a standing job starts with no model; it needs one before it can run (R73).
      if (b.paused === false && before.duty && !(b.model !== undefined ? b.model : before.model)) {
        return reply.code(409).send({ error: "needs_model", message: `Choose a model for ${before.name} before starting it.` });
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
    owner.get("/api/companies/:id/watchdog/issues", async (req, reply) => {
      const { id } = IdParam.parse(req.params);
      return watchdog.issues(id).catch(watchdogErrors(reply));
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

    // Scheduling and kill switches, the runner update hold, self-deploy, restart and deploy targets (R30, R14, R15).
    serverAdminRoutes(owner, { scheduler, maintenance, runnerReport, launch, selfDeploy, deploysSvc });

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
    // Cards Boss Man closed by itself in the last couple of hours, with the notice and steps they showed
    // (BOS-739): Decisions puts them where the card was, so an owner part-way through the steps knows why.
    owner.get("/api/decisions/closed-notices", async () => recentClosedNotices(db));
    // The owner opened a card's steps (BOS-739): a later system close then also tells their feed.
    owner.post("/api/decisions/:id/opened", async (req) => {
      const { id } = IdParam.parse(req.params);
      return { ok: await markOwnerOpened(db, id) };
    });

    owner.post("/api/decisions/:id/answer", async (req, reply) => {
      const { id } = IdParam.parse(req.params);
      const { answer, assigneeAgentId, note, reasonLink, custom, picks, modelConfig, alwaysScope } = z
        .object({
          answer: z.string().trim().min(1).max(OWNER_MESSAGE_MAX),
          assigneeAgentId: Uuid.optional(),
          note: z.string().trim().max(2000).optional(),
          reasonLink: z.string().trim().max(400).optional(),
          custom: z.boolean().optional(),
          alwaysScope: z.enum(["agent", "company"]).optional(),
          picks: z.array(z.number().int().min(0)).max(20).optional(),
          modelConfig: z
            .object({ harness: z.string().trim().min(1).max(40), provider: z.string().trim().min(1).max(40), model: z.string().trim().min(1).max(200), fundingSourceId: Uuid })
            .optional(),
        })
        .parse(req.body);
      try {
        const result = await decisionsSvc.answer(id, answer, { assigneeAgentId, note, reasonLink, custom, picks, modelConfig, alwaysScope, by: await ownerName(req) });
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
    owner.get("/api/tickets/:id/landing", async (req) => ({ landing: await review.landing(IdParam.parse(req.params).id) }));
    // A reviewer's hold on the merge (BOS-808): the owner can release it (the normal approval and merge follow) or cancel it (the pass is withdrawn).
    owner.get("/api/tickets/:id/hold", async (req) => ({ hold: await holdView(db, IdParam.parse(req.params).id) }));
    owner.post("/api/tickets/:id/hold/release", async (req, reply) => {
      const { id } = IdParam.parse(req.params);
      const r = await review.releaseHold(id, { name: await ownerName(req) }, { background: true }).catch(reviewErrors(reply));
      if ((r as { approval?: { outcome?: string } } | undefined)?.approval?.outcome === "landing") reply.code(202);
      return r;
    });
    owner.post("/api/tickets/:id/hold/cancel", async (req, reply) => {
      const { id } = IdParam.parse(req.params);
      return review.cancelHold(id, { name: await ownerName(req) }).catch(reviewErrors(reply));
    });
    /**
     * "Approve and merge" on the ticket page (BOS-471): when the owner's sign-off card is open, this answers
     * it exactly as Decisions does (same answer path, so the sign-off is settled and any stale merge-retry
     * card is cleared) and then starts the tracked merge in the background, so the press returns at once
     * (BOS-559). Without a card it is the plain approval. On a ticket with no repo it marks it done, as before.
     */
    owner.post("/api/tickets/:id/approve-merge", async (req, reply) => {
      const { id } = IdParam.parse(req.params);
      const [t] = await db.select({ companyId: tickets.companyId, title: tickets.title, systemState: tickets.systemState }).from(tickets).where(eq(tickets.id, id));
      if (!t) return reply.code(404).send({ error: "not_found" });
      if (t.systemState !== "review") return reply.code(409).send({ error: "review", message: "This ticket isn't in review, so there's nothing to approve." });
      const [signoff] = await db
        .select({ id: decisions.id, question: decisions.question })
        .from(decisions)
        .where(and(eq(decisions.status, "open"), sql`${decisions.context}->>'type' = 'risk_review'`, sql`${decisions.context}->>'ticketId' = ${id}`))
        .limit(1);
      let signoffAnswered = false;
      if (signoff) {
        // The same path as answering it in Decisions: the card closes, its hold lifts, and the merge starts.
        // markDone when there is nothing to merge (no repo, or no code), so it finishes in the same press.
        const [row] = await db.select({ noCode: tickets.noCode, repoUrl: projects.repoUrl }).from(tickets).innerJoin(projects, eq(projects.id, tickets.projectId)).where(eq(tickets.id, id));
        const markDone = !row?.repoUrl || !!row?.noCode;
        try {
          const r = await decisionsSvc.answer(signoff.id, "Approve and merge", { by: await ownerName(req), merge: { markDone } });
          // null means another press or the CEO settled it first: the merge below still runs once, safely.
          signoffAnswered = r !== null;
        } catch (err) {
          if (err instanceof AnswerError) return reply.code(409).send({ error: "review", message: err.message });
          throw err;
        }
        try {
          // The answer's own hook (setLoopHooks.land above) now starts the merge in the background and
          // returns at once, so the card closes before the check finishes (BOS-559). It started a landing
          // only when it settled the sign-off, so hand that running landing back for the page to poll;
          // start nothing more, or it would merge twice (BOS-471). A press that found the sign-off already
          // settled (r === null) started no landing, so start one now.
          const landing = signoffAnswered ? await review.landing(id) : await review.startLanding(id, "the owner");
          return { outcome: "landing" as const, signoffAnswered, landing };
        } catch (err) {
          // A sign-off still open here is the owner's next answer, not a failed merge: say so, and raise no card.
          if (err instanceof ReviewError) return reply.code(err.status).send({ error: "review", message: err.message });
          throw err;
        }
      }
      // No sign-off card yet: the plain approval. With a repo, an approval that needs the owner's sign-off
      // raises that card (outcome owner_review) and nothing merges, so no retry card is raised for it (BOS-471).
      const r = (await review.submit(id, { verdict: "approved", reviewer: "the owner", background: true }).catch(reviewErrors(reply))) as
        | { outcome?: string; landing?: unknown }
        | undefined;
      if (!r) return r;
      if (r.outcome === "landing") reply.code(202);
      const landing = "landing" in r ? r.landing : r.outcome === "owner_review" ? null : await review.landing(id);
      return { ...r, signoffAnswered: r.outcome === "owner_review", landing };
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
      const b = z.object({ text: z.string().trim().min(1).max(OWNER_MESSAGE_MAX), interrupt: z.boolean().optional() }).parse(req.body);
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
    // End every run going now, in every company (BOS-837): the owner's emergency stop, behind the Runs page's confirm.
    owner.post("/api/runs/cancel-all", async () => runsSvc.cancelAll());
    owner.post("/api/runs/:id/cancel", async (req, reply) => runsSvc.cancel(IdParam.parse(req.params).id).catch(runErrors(reply)));

    // Stale-blocker, stalled-run and missed-work sweeps (R21, R32, R82); also run on a timer.
    owner.post("/api/sweep", async () => sweeps.run());
  });

  if (opts.webDir) await serveWeb(app, opts.webDir);

  const briefUpkeep = () => refreshBriefs(db, { work, gitHosts, gitToken: async (companyId) => (await secretsSvc.resolveCompanyEnv(companyId, "check")).GIT_TOKEN, log: (m) => app.log.warn(m) });
  return { app, launcher: launch, memory, serverHealth, checks, releaseLog, runnerWatch, briefUpkeep, retro, secrets: secretsSvc, funding, refreshSyntheticQuota, runners, decisions: decisionsSvc, selfDeploy, maintenance, runnerReport, scheduler, serverStatus, work, sweeps, watchdog, engagements: engagementsSvc, deploys: deploysSvc, runs: runsSvc, recovery, review, loops, alerts, disk, rules, notes, chapters, feedback, wiki, semantic, skills: skillsSvc, skillProposals, ticketChat, ownerReplies, mergeQueue };
}
