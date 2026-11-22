import path from "node:path";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest, type FastifyServerOptions } from "fastify";
import cookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import websocket from "@fastify/websocket";
import { and, asc, count, desc, eq, gt, inArray, isNull, lte, ne, or, sql } from "drizzle-orm";
import { readFileSync } from "node:fs";
import { z, ZodError } from "zod";
import { RISK_TIERS, SECRET_KINDS, SYSTEM_STATES, featureHorizon, formatDate, usdToMicros, ruleFor, PERMISSION_JUDGE_MODES, FENCE_MODES, FENCE_ENFORCE_AVAILABLE } from "@boss-man/shared";
import { BLOCKED_UNTIL_MAX_DAYS, BLOCKED_UNTIL_MAX_MS, BLOCKED_UNTIL_REASON_MAX, CEO_TEMPLATE, timeZoneOr, WatchdogSettings } from "@boss-man/shared";
import { THINKING_LEVELS, TICKET_PREFIX, defaultTicketPrefix, parseRepoUrl, ticketRef, type MergeResult, type WorkspaceDiff } from "@boss-man/shared";
import { FUNDING_KINDS, FUNDING_PROVIDERS, fundingComboError, windowLabel } from "@boss-man/shared";
import { OWNER_MESSAGE_MAX, DAEMON_ONLY_SECRET_REFUSAL, isDaemonOnlySecret } from "@boss-man/shared";
import { hashPassword, hashToken, newSessionToken, SESSION_COOKIE, SESSION_DAYS, verifyPassword } from "./auth.js";
import type { MasterKey } from "./crypto.js";
import type { Db } from "./db/client.js";
import { agents, checkJobs, companies, decisions, engagements, features as featuresTable, fundingSources, mcpServers, owners, projects, runners as runnersTable, runs as runsTable, sessions, settings, tickets, wakes } from "./db/schema.js";
import { fundingService } from "./services/funding.js";
import { AGENT_APPROVALS, AgentError, agentsService } from "./services/agents.js";
import { notesService } from "./services/agent-notes.js";
import { modelsService } from "./services/models.js";
import { modelProbeService } from "./services/model-probe.js";
import { assetPathOf, PRECOMPRESSED_SUFFIX_LIST } from "@boss-man/shared";
import { gitHostService } from "./services/git-hosts.js";
import { setupService } from "./services/setup.js";
import { secretGrants, secrets as secretsTable, watchdogActions, checkWorkers } from "./db/schema.js";
import { runnersService } from "./services/runners.js";
import { allowsPrivate, type HostLookup, LauncherError, launcherService, type LauncherOptions } from "./services/launcher.js";
import { AnswerError, clearOwnerTodo, decisionsService, setDecisionSettledListener } from "./services/decisions.js";
import { githubWatchService, WATCH_TOKEN_ENV } from "./services/github-watch.js";
import { markOwnerOpened, recentClosedNotices } from "./services/closed-notice.js";
import { getHold, holdBlocksStarts, maintenanceService, runnerCardHold } from "./services/maintenance.js";
import { serverWaitChecks, updateWaitCountsRun } from "./services/runner-busy.js";
import { activeWaits, runnerHoldWait } from "./services/update-waits.js";
import { runnerWatchService } from "./services/runner-watch.js";
import { runnerReportService } from "./services/runner-report.js";
import { createErrorBuffer, logCompany, logMessage } from "./services/error-buffer.js";
import { serverStatusService } from "./services/server-status.js";
import { failuresForStatus } from "./services/merge-failures.js";
import { raiseCostAlert } from "./services/cost-check.js";
import { addonsService, mergeHostAddons, unknownAddons } from "./services/addons.js";
import { probeColours } from "./services/bluegreen.js";
import { createStallMonitor } from "./services/stall-monitor.js";
import { serverHealthService, type ServerHealth, type ServerHealthDeps } from "./services/server-health.js";
import { createPermissionLog } from "./services/permission-log.js";
import { selfDeployService } from "./services/self-deploy.js";
import { deployWaitService } from "./services/deploy-wait.js";
import { hostFactsService, OWNER_FACTS } from "./services/host-facts.js";
import { gitTokenActionsProbe } from "./services/owner-record.js";
import { netguardAllowReport } from "./services/netguard-allow.js";
import { deviceProfilesService } from "./services/device-profiles.js";
import { releaseLogService } from "./services/release-log.js";
import { ownerSetupFacts } from "./services/owner-setup-check.js";
import { closeStallAlertForRun, sweepService, type SweepLimits } from "./services/sweeps.js";
import { alertClearing } from "./services/alert-clearing.js";
import { recheckDeadlines, runnerRebuilt, securityAlertChanged, ticketStateChanged } from "./services/stale-requests.js";
import { closeInvalidCards } from "./services/card-validity.js";
import { WatchdogError, watchdogService } from "./services/watchdog.js";
import { alertLadder, GOT_IT } from "./services/alert-ladder.js";
import { EngagementError, engagementsService } from "./services/engagements.js";
import { PageQuery } from "./services/list-page.js";
import { acceptanceCriteriaSchema, isTaskSize, SIZE_SCALE } from "@boss-man/shared";
import { deploysService } from "./services/deploys.js";
import { runsService } from "./services/runs.js";
import { recoveryService } from "./services/recovery.js";
import { holdView } from "./services/review-holds.js";
import { type CI_TIMING, isSignoffPending, MERGE_WAIT_MS, ReviewError, ReviewHeldError, reviewService } from "./services/review.js";
import { CI_TIMING as CI_PUBLISH_TIMING } from "./services/ci-publish.js";
import { ciPreflightService } from "./services/ci-preflight.js";
import { checkPolicy as checkPolicyIn, effectivePolicy } from "./services/review-policy.js";
import { listReviews } from "./services/review-kinds.js";
import { openSignoffCard, signoffState } from "./services/signoff.js";
import { loopGuards, type LoopLimits } from "./services/loop-guards.js";
import { limitRequeue } from "./services/limit-requeue.js";
import { record } from "./services/activity.js";
import { branchOverlapView } from "./services/branch-overlaps.js";
import { chooseFence, chooseGuard, closeFenceCard, closeFenceUnavailableCard, featureStates } from "./services/fence-default.js";
import { workService, WorkError } from "./services/work.js";
import { refreshBriefs } from "./services/project-brief.js";
import { planningService } from "./services/planning.js";
import { chaptersService } from "./services/chapters.js";
import { FeedbackError, feedbackService } from "./services/feedback.js";
import { portalRoutes, sendLogo, type PortalLimits } from "./portal.js";
import { TicketImageError, ticketImagesService } from "./services/ticket-images.js";
import { ChatError, chatService } from "./services/chat.js";
import { chatTraceService } from "./services/chat-trace.js";
import type { TraceUpdate } from "./services/chat-trace.js";
import { paService } from "./services/pa.js";
import { dashboardService } from "./services/dashboard.js";
import { mergeQueueService, runningCheckJobs, endedMergePlaces } from "./services/merge-queue.js";
import { setStartHoldCounts } from "./services/agent-wip.js";
import { mergeJamService } from "./services/merge-jam.js";
import { checkHoldService } from "./services/check-hold.js";
import { mainCiService } from "./services/main-ci.js";
import { secretScanService } from "./services/secret-scan.js";
import { PRIORITY_WATCH_REASON, priorityWatchService } from "./services/priority-watch.js";
import { checkIdleService, IDLE_CHECK_SLOT_REASON, idleView } from "./services/check-idle.js";
import { MERGE_STALL_REASON, mergeStallService, mergeTrainStatus } from "./services/merge-stall.js";
import { softHold } from "./services/deploy-wait-hold.js";
import { checkGate } from "./services/check-gate.js";
import { RetroError, retroService } from "./services/retro.js";
import { workflowService } from "./services/workflow.js";
import { skillsService } from "./services/skills.js";
import { skillProposalsService } from "./services/skill-proposals.js";
import { TicketChatError, ticketChatService } from "./services/ticket-chat.js";
import { ownerRepliesService } from "./services/owner-replies.js";
import { buildBrief } from "./services/brief.js";
import { wikiSemanticService } from "./services/wiki-semantic.js";
import { ownerAnswerEmbedLoop } from "./services/owner-answers.js";
import { meaningBriefLines, ticketMeaningEmbedLoop } from "./services/ticket-meaning.js";
import { SecondOpinionSettings, secondOpinionService } from "./services/second-opinion.js";
import { wikiService } from "./services/wiki.js";
import { UPDATE_ALERT_REASON, DEFAULT_LIMITS, OWNER_OVERRIDE_PRIORITY, schedulerService, type Limits } from "./services/scheduler.js";
import { memoryLine, readRunnerAgents } from "./services/check-limit.js";
import { exportCompany } from "./services/company-export.js";
import { applyPackage, ImportError, previewPackage, readPackage } from "./services/company-import.js";
import { mcpRoutes } from "./mcp.js";
import { PrivateDetailsRejected, privateDetailsService } from "./services/private-details.js";
import { scanListReader, type ScanListWarning } from "./services/scan-list.js";
import { SecretRejected, secretsService, type LiveValidator } from "./services/secrets.js";
import { checkDispatcher } from "./services/check-dispatcher.js";
import { checkWorkersService } from "./services/check-workers.js";
import { checkWorkerSocketRoutes } from "./routes/check-worker-socket.js";
import { checkBundleRoutes } from "./routes/check-bundles.js";
import { checkBundleStore } from "./services/check-bundles.js";
import { CheckBundleInfo, type GoLiveWait } from "@boss-man/shared";
import { goLiveNote, openUpdateCards } from "./services/go-live-note.js";
import { checkRequestService } from "./services/check-request.js";
import { checkQueue, type CheckQueueMode } from "./services/check-queue.js";
import { retierWaiting } from "./services/merge-train.js";
import { runnerIngestWaiting, runnerSocketRoutes } from "./routes/runner-socket.js";
import { serverAdminRoutes } from "./routes/server-admin.js";
import { settingsLimitsRoutes } from "./routes/settings-limits.js";
import { emailSettingsRoutes } from "./routes/email-settings.js";
import { PENPOT_ENV, penpotRoutes } from "./routes/penpot.js";
import { mailerService } from "./services/mailer.js";
import { wikiRoutes } from "./routes/wiki.js";
import { skillRoutes } from "./routes/skills.js";
import { policyRoutes } from "./routes/policy.js";
import { projectRoutes } from "./routes/projects.js";
import { featureRoutes } from "./routes/features.js";
import { DateStr, objectiveRoutes, roadmapRoutes } from "./routes/roadmap.js";
import { deviceRoutes, notificationRoutes, notificationSettingsRoutes, ntfySetupSaver, phoneApproveRoutes } from "./routes/devices-notifications.js";
import { agentRunsRoutes } from "./routes/agents-runs.js";
import { ticketRecordRoutes } from "./routes/ticket-record.js";
import { createMemorySampler, readRssAndPeak } from "./services/memory-sampler.js";
import { readNativeDetail } from "./services/native-memory.js";
import { createLeader, type Leader } from "./leader.js";
import { diskService, type DiskLimits } from "./services/disk.js";
import { opencodeVacuumAlerts } from "./services/opencode-vacuum.js";
import { DEFAULT_LOGIN_LIMITS, loginLimiter, type LoginLimits } from "./login-limit.js";
import { policyRulesService } from "./services/policy-rules.js";
import { notificationsService } from "./services/notifications.js";
import { phoneApproveService } from "./services/phone-approve.js";
import { phoneLoginService } from "./services/phone-login.js";

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
  /** Tests only: extra TLS options for the outgoing mail connection (a test CA). */
  mailTlsOptions?: import("node:tls").ConnectionOptions;
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
  /** BOS-1436: where check bundles wait for their worker (else BOSSMAN_CHECK_BUNDLE_DIR, else under the OS temp folder); tests give their own. */
  checkBundleDir?: string;
  /** Launch-safety limits (R30); defaults in DEFAULT_LIMITS. */
  limits?: Partial<Limits>;
  /** Start a scheduler pass as soon as a wake is queued; on unless a test turns it off (R85). */
  tickOnWake?: boolean;
  /** Hold every run until its runner's report proves the fence and the network guard (DR-049 point 1). main.ts sets it; most tests build without a runner report. */
  requireRunnerProof?: boolean;
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
  /** BOS-1070: shorter waits for GitHub CI at the merge gate; tests only. */
  ciTiming?: Partial<typeof CI_TIMING>;
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
  /** BOS-1954: how long a drain pass waits for a scheduling pass to end (tests make it short). */
  drainSettleMs?: number;
  /** Who is in charge (leader.ts). Default: a lone server that always leads. */
  leader?: Leader;
};

const Credentials = z.object({ username: z.string().trim().min(1).max(64), password: z.string().min(12).max(256) });
const Uuid = z.string().uuid();
const IdParam = z.object({ id: Uuid });
// An address for the activity log: no login, query or fragment, which could carry a secret.
function plainUrl(raw: string): string {
  try {
    const u = new URL(raw);
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return "address not shown";
  }
}

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
  const mailer = mailerService(db, { reveal: (id) => secretsSvc.reveal(id), tlsOptions: opts.mailTlsOptions });
  const privateDetails = privateDetailsService(db, master);
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
  const launch = launcherService(db, { runners, options: opts.launcher, fetch: opts.fetch, lookup: opts.lookup, penpotUrl: (companyId) => secretsSvc.grantedValue(companyId, PENPOT_ENV.url) });
  // BOS-1582: the guard opens the company's Penpot from its PENPOT_URL grant, so a change to that grant re-sends the list.
  secretsSvc.onGrantChange(({ companyId, envName }) => {
    if (envName === PENPOT_ENV.url) void launch.syncAllow(companyId);
  });
  const rules = policyRulesService(db);
  const notes = notificationsService(db, { reveal: (id) => secretsSvc.reveal(id), now: opts.now, fetch: opts.fetch, log: (m) => app.log.warn(m) });
  setDecisionSettledListener((decisionId) => notes.clearPush(decisionId));
  // Which add-ons are running (DR-023, BOS-521), for server_status and the card lint's R9. Every route that raises a
  // card reads it through addonFacts, and a failed read is "unknown" for all (warnings only), never a refused card.
  const addonsSvc = addonsService(db, { trustedProxies: opts.trustedProxies ?? [], notifySettings: () => notes.getSettings(), phoneTest: () => notes.testStatus(), now: opts.now });
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
    // Check bundles (BOS-1436) live in the leader's folder only, so a standby refuses their downloads too.
    const blocked = path.startsWith("/api/runner/") || path.startsWith("/api/check-worker/") || path.startsWith("/api/check-bundles/") || path === "/mcp" || (write && path.startsWith("/api/") && !STANDBY_WRITES.has(path));
    if (blocked) return reply.code(503).header("retry-after", "2").send({ error: "standby", message: "This server is on standby (another copy is in charge); changes go to the leader. Retry in a moment." });
  });
  // The server-owned check queue (DR-003, BOS-316). Off until the owner sets check_queue_mode to server; wake is filled in once the scheduler exists.
  let checkWake: ((agentId: string, w: { ticketId: string; reason: string; note: string; priority?: number }) => Promise<unknown>) | undefined;
  let checkHold: ReturnType<typeof checkHoldService> | undefined;
  // BOS-1093: a set private-details list that can't be read says so once, in the log and to the owner, and the scan runs its secret rules only.
  const scanListWarning: ScanListWarning = {
    log: (m) => app.log.warn(m),
    notify: (n) => notes.notify({ companyId: null, agentId: null, level: n.level, title: n.title, body: n.body, link: n.link }),
    isSet: () => privateDetails.isSet(),
  };
  // Check workers on other machines (DR-060, BOS-1435): their own table, token and socket; they take checks the runner has no slot for.
  const checkWorkersSvc = checkWorkersService(db);
  // BOS-1436: a worker's code comes as a git bundle the company runner packs and uploads here. Nothing in the folder
  // outlives a restart usefully (a worker asks again), so it starts empty.
  const bundleStore = checkBundleStore(opts.checkBundleDir ? { dir: opts.checkBundleDir } : {});
  bundleStore.clear();
  const checks = checkDispatcher(db, {
    // BOS-1471: while a runner drain is under way (image update or setting change) no new check goes to a runner about to be swapped.
    // BOS-2108: which wait it is, so the dispatcher stops only what that wait's WAIT_RULES row blocks (a worker keeps its quick checks).
    drainPending: async () => {
      const h = runnerCardHold(await getHold(db));
      return h && holdBlocksStarts(h, opts.now?.() ?? new Date()) ? runnerHoldWait(h) : null;
    },
    scanList: () => privateDetails.forRunner(),
    scanListWarning,
    send: (id, c) => runners.send(id, c),
    isConnected: (id) => runners.isConnected(id),
    can: (id) => runners.can(id, "check-jobs"),
    wake: (a, w) => checkWake?.(a, w) ?? Promise.resolve(),
    onEnded: (job) => checkHold?.onEnded(job),
    workers: checkWorkersSvc,
    bundles: {
      store: bundleStore,
      canPack: (id) => runners.can(id, "check-bundle"),
      // A first (full) bundle of a large repo takes a minute or two to pack and upload.
      pack: async (runnerId, cmd) => CheckBundleInfo.parse(await runners.request<unknown>(runnerId, (requestId) => ({ type: "check.bundle", requestId, ...cmd }), 10 * 60_000)),
    },
    isLeader: () => leader.isLeader(),
  });
  await checkWorkerSocketRoutes(app, checkWorkersSvc, { heartbeatMs: opts.heartbeatMs, isLeader: () => leader.isLeader(), checks });
  await checkBundleRoutes(app, db, { store: bundleStore, runners, workers: checkWorkersSvc, checks });
  // After-merge checks that waited for go-live (BOS-1021) start when the server commit or the runner image catches up; review exists further down.
  let releaseGoLive: ((companyId: string) => Promise<unknown>) | undefined;
  await runnerSocketRoutes(app, runners, secretsSvc, { heartbeatMs: opts.heartbeatMs, isLeader: () => leader.isLeader(), checks, onImage: (companyId) => releaseGoLive?.(companyId) ?? Promise.resolve(),
    // BOS-1161: a finished runner rebuild closes the cards that named it in clearsWhen and flags (and wakes the authors of) the rest that talk about the runners.
    onRebuilt: async (companyId) => {
      const closed = await clearing.check();
      await runnerRebuilt(db, { companyId, wake: (input) => scheduler.notify(input.agentId, input as { ticketId: string; reason: string; note: string; priority?: number }), now: opts.now?.() });
      if (closed) await notes.syncDecisions();
    } });
  // The live commit each company's server runs (BOS-284): a deploy, a switch-back, a rollback or a
  // restart after a hand-apply wakes the Release Manager. Its deps are filled in further down.
  const releaseLog = releaseLogService(db, {
    createTicket: (projectId, input) => work.createTicket(projectId, input),
    notify: (agentId, input) => scheduler.notify(agentId, input),
    closeTicket: (id) => work.updateTicket(id, { state: "done" }),
    notifyOwner: (n) => notes.notify({ ...n, agentId: null }),
    afterLive: (companyId) => releaseGoLive?.(companyId) ?? Promise.resolve(),
    // DR-052: go-live setup cards are filled and checked with the host's facts, like every other owner card.
    // hostFacts is created just below; this only runs on a later release pass.
    // BOS-1650: the values behind `[when <fact>]` steps come from the same record server_status shows; null when it can't be read.
    ownerSetupFacts: async () => ({ ...(await ownerSetupFacts(hostFacts)), when: { "network guard allow line can go": await netguardAllow().then((r) => (r ? r.lineCanGo : null)).catch(() => null) } }),
    log: (m) => app.log.warn(m),
  });
  // What each host says about itself (BOS-427), for the owner-card lint's R6 and the hand-apply cards' host line.
  const hostFacts = hostFactsService({ dir: opts.deployerDir, db, now: opts.now, log: (m) => app.log.warn(m) });
  const deviceProfiles = deviceProfilesService(db);
  const selfDeploy = selfDeployService(db, { dir: opts.deployerDir, notify: (n) => notes.notify(n), releaseLog, hosts: () => hostFacts.hosts(), deployerScript: () => hostFacts.deployerScript(), facts: async () => Object.fromEntries(Object.entries((await hostFacts.sync()).facts).map(([k, f]) => [k, f.value])), log: (m) => app.log.warn(m),
    // BOS-1648: the CEO is woken once when Boss Man can't tell whether a runner update is needed.
    wake: (agentId, input) => scheduler.notify(agentId, input),
    // Both colours, the same probe Settings shows: the runner trial ends as soon as the standby is stopped (BOS-953). `build` is defined further down; this only runs per request.
    colours: () => probeColours(colour(), build),
    // Quiet = no agent run in flight (an owner chat doesn't count) and no merge landing: a few seconds' outage of the database or proxy would cut them short (BOS-487).
    // DR-008's memory-headroom check is not built; this is the part that exists today.
    hostQuiet: async () => {
      // A run row left open by a restart must not hold the card back for ever: runs that started over 6 hours ago don't count.
      // BOS-2088: the one "an update waits for it" rule (runner-busy.ts updateWaitCountsRun).
      const [live] = await db.select({ n: count() }).from(runsTable).where(and(isNull(runsTable.endedAt), updateWaitCountsRun(), sql`${runsTable.startedAt} > now() - interval '6 hours'`));
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
    fetch: opts.fetch,
  });
  notes.setApproveHook(phoneApprove);
  // The optional model second opinion on permission cards (BOS-338): off until the owner sets it up.
  const secondOpinion = secondOpinionService(db, { reveal: (id) => secretsSvc.reveal(id), fetch: opts.fetch, workspaceRoot: opts.workspaceRoot ?? "/home/node/workspaces", now: opts.now });
  decisionsSvc.setSecondOpinion(secondOpinion);
  app.addHook("onClose", async () => decisionsSvc.drainSecondOpinions());
  const deploysSvc = deploysService(db, {
    now: opts.now,
    // DR-033: the runner resolves a deploy's commit and moves its tag; a tag it can't move goes to the CEO (`alerts` is built below).
    runners,
    alert: (input) => alerts.raise(input),
    log: (m) => app.log.warn(m),
    // BOS-1472: the host deployer's staging lane (its own files; off until the host sets STAGING_DIR).
    staging: { on: () => selfDeploy.stagingLane(), submit: (id, commit, by) => selfDeploy.writeStagingRequest(id, commit, by), origin: () => selfDeploy.stagingOrigin(), status: () => selfDeploy.stagingStatus(), pending: () => selfDeploy.stagingPending() },
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
  const trace = chatTraceService();
  const chat = chatService(db, {
    notify: (agentId, input) => scheduler.notify(agentId, input),
    workspaceRoot: opts.workspaceRoot ?? "/home/node/workspaces",
    trace,
    flag: (n) => notes.notify({ ...n, level: "flag" }),
    // DR-069 D2: read lazily, because the git host service and the host facts are made further down.
    // BOS-2116: lazy, because the semantic service is made further down.
    meaning: (companyId, ownerText) => meaningBriefLines(db, companyId, ownerText, { embedder: (c) => semantic.ticketEmbedder(c), wiki: (c, q) => semantic.similar(c, q) }),
    named: { addons: () => addonFacts(), serverHost: () => hostFacts.serverHost(), gitTokenProbe: (companyId) => gitTokenProbe(companyId), limits: async () => { const l = await scheduler.limitsInForce(); return { allCompanies: l.allCompanies, background: l.background }; }, now: opts.now },
  });
  const pa =paService(db, {
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
    landingMergeIds: () => review.landingMergeIds(), // `review` is built further down; this only runs during a drain
    quietHours: async () => (await notes.getSettings()).quietHours,
    notifyOwner: (n) => notes.notify({ ...n, agentId: null }),
    tickOnWake: opts.tickOnWake,
    requireRunnerProof: opts.requireRunnerProof,
    log: (m, companyId) => (companyId ? app.log.error({ companyId }, m) : app.log.error(m)),
    // Loop and runaway alerts go up the alert ladder (BOS-64): Scrum Master, CEO, then the owner.
    alert: (companyId, question, o) => alerts.raise({ companyId, question, ...o }),
  });
  decisionsSvc.setWakeHook((w) => scheduler.notify(w.agentId, w));
  // DR-058: a withdrawn owner card tells the feed (a quiet note) as well as Decisions.
  decisionsSvc.setNotifyHook((n) => notes.notify(n));
  const maintenance = maintenanceService(db, {
    fleet: async () => (launch.enabled ? launch.fleet() : []),
    rollback: (slug) => launch.rollback(slug),
    // BOS-993: the launcher is told "Checks at once" first, so a recreate always uses the current setting (it also covers a launcher that lost it).
    recreate: async (slug) => {
      await launch.setChecks(await checkQueueSvc.slots(), await readRunnerAgents(db, scheduler.limits)).catch(() => undefined); // an older launcher has no such call: the recreate still goes ahead
      return launch.recreate(slug);
    },
    connected: async (companyId) => {
      const [r] = await db.select({ id: runnersTable.id }).from(runnersTable).where(eq(runnersTable.companyId, companyId));
      return !!r && runners.isConnected(r.id);
    },
    settled: () => scheduler.settled(),
    passInfo: () => scheduler.passInfo(),
    // BOS-1645: `review` is built further down; this only runs during a drain pass.
    landingMerges: () => review.landingMergesByCompany(),
    landingMergeIds: () => review.landingMergeIds(),
    // BOS-2058: the owner's wrap-up pressed while a server update waits for a quiet machine belongs to it and lifts with it.
    serverUpdateWaiting: async () => (await deployWait.get())?.phase === "waiting", // `deployWait` is built further down; this only runs on a pass
    tick: () => scheduler.tick(),
    notify: (n) => notes.notify(n),
    // BOS-1377: the per-run Stop (runsSvc is built further down; this only runs when the owner answers a card).
    cancelRun: (runId) => runsSvc.cancel(runId, undefined, undefined),
    tellRunning: async (text) => {
      const live = await db.select({ id: runsTable.id, companyId: runsTable.companyId }).from(runsTable).where(and(isNull(runsTable.endedAt), sql`${runsTable.purpose} is distinct from 'chat'`));
      for (const r of live) {
        const [runner] = await db.select({ id: runnersTable.id }).from(runnersTable).where(eq(runnersTable.companyId, r.companyId));
        // steer (BOS-1016): an agent in one long step gets this now, inside its turn, not when the step ends.
        if (runner) runners.send(runner.id, { type: "run.message", runId: r.id, text: `Message from Boss Man: ${text}`, interrupt: false, steer: true });
      }
    },
    // BOS-988: the same message, only to the runs the drain has not told yet, answering with the ones it reached.
    tellRuns: async (text, runIds) => {
      const reached: string[] = [];
      for (const runId of runIds) {
        const [r] = await db.select({ companyId: runsTable.companyId }).from(runsTable).where(and(eq(runsTable.id, runId), isNull(runsTable.endedAt)));
        if (!r) continue;
        const [runner] = await db.select({ id: runnersTable.id }).from(runnersTable).where(eq(runnersTable.companyId, r.companyId));
        if (runner && runners.send(runner.id, { type: "run.message", runId, text: `Message from Boss Man: ${text}`, interrupt: false, steer: true })) reached.push(runId);
      }
      return reached;
    },
    // BOS-1954: the swap waited past its expected finish. Each affected company's CEO is woken once with only that
    // company's own work, through the reply lane (the only wake a drain lets through while work is going); the owner is not asked.
    wakeCeo: async (companyId, note) => {
      const [ceo] = await db.select({ id: agents.id }).from(agents).where(and(eq(agents.companyId, companyId), eq(agents.role, "ceo"), isNull(agents.retiredAt)));
      if (ceo) await scheduler.notify(ceo.id, { reason: UPDATE_ALERT_REASON, ticketId: null, priority: 4, note });
    },
    // `sweeps` is built further down; this only runs when a hold lifts.
    afterHold: (since) => sweeps.resumeAfterUpdate(since),
    dir: opts.deployerDir,
    drainMinutes: opts.drainMinutes,
    reconnectMs: opts.drainReconnectMs,
    settleWaitMs: opts.drainSettleMs,
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
    launcherOn: () => launch.enabled,
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
    updateWaits: () => currentUpdateWaits(),
    memory,
    netguardAllow,
    runLimits: (id) => scheduler.runLimits(id),
    mergeFailures: (id) => failuresForStatus(db, id),
    mergeTrain: (id) => mergeTrainStatus(db, id),
    // BOS-2119: read when server_status is asked, after `review` below is built.
    landingTurns: (id) => review.landingTurnStatus(id),
    idleCheckSlots: async (id) => (await checkIdle.view(id)).map(idleView),
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
    swapping: (companyId) => runnerReport.swappingFor(companyId),
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
  // Owner-answer meaning search (BOS-1593): embeds new owner answers every two minutes for companies that switched it on.
  const ownerAnswerEmbeds = ownerAnswerEmbedLoop(db, { companies: () => semantic.ownerAnswerCompanies(), embedder: (companyId) => semantic.ownerAnswerEmbedder(companyId), log: (m) => app.log.warn(m) });
  app.addHook("onClose", async () => (ownerAnswerEmbeds.stop(), await ownerAnswerEmbeds.drain()));
  const ticketMeaningEmbeds = ticketMeaningEmbedLoop(db, { companies: () => semantic.ticketMeaningCompanies(), embedder: (companyId) => semantic.ticketEmbedder(companyId), log: (m) => app.log.warn(m) });
  app.addHook("onClose", async () => (ticketMeaningEmbeds.stop(), await ticketMeaningEmbeds.drain()));
  const wiki = wikiService(db, semantic);
  const images = ticketImagesService(db, { runners });
  const dashboard = dashboardService(db, { now: opts.now, decisions: decisionsSvc, runnerConnected: (id) => runners.isConnected(id), updateWait: () => deployWait.status(), runLimit: async () => (await scheduler.limitsInForce()).allCompanies });
  const workflow = workflowService(db, { now: opts.now });
  // Read fresh on each import (BOS-1891): a token added or rotated in Settings → Secrets counts at once. With a run, that agent's grant limits apply.
  const skillsSvc = skillsService(db, { fetch: opts.fetch, gitToken: async (companyId, runId) => (await secretsSvc.resolveCompanyEnv(companyId, "skill_import", runId)).GIT_TOKEN });
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
        body: `It's at ${Math.round(f.utilization * 100)}% and, at the pace of this window so far, rising about ${Math.round((f.runsOutPerHour ?? f.perHour ?? 0) * 100)}% an hour${f.resetsAt ? `, and resets ${dayAt(f.resetsAt)}` : ""}. Boss Man holds new runs on it once it's nearly used up, until it resets; pause less urgent work, or move agents to another funding source, to keep the important work going.`,
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
    // The Thinking trace (BOS-1368): every step a run takes, kept for its owner-chat reply. The runner
    // clips and redacts before it emits, and runner_events redacts the same fields again as it stores
    // them (security review), so no raw secret is kept there; this service redacts once more for the
    // trace itself. A ticket run's steps are simply never asked for and dropped when the run ends.
    if (event.type === "run.started") trace.begin(event.runId);
    if (event.type === "run.update") trace.onUpdate(event.runId, event.update as TraceUpdate);
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
          // A run the account refused for a usage limit goes back in the queue, held to the real reset, once per window (BOS-1438).
          // A second refusal in the same window is the account card instead.
          const requeued = await limitRequeues.afterRun(event.runId);
          if (run && requeued.outcome === "second_refusal") {
            await alerts.raise({
              companyId: run.companyId,
              kind: "account_limit",
              question: `${requeued.account}: a run was refused again on ${requeued.window} after its work was already put back to wait for the reset.`,
              ticketId: run.ticketId,
              about: [run.agentId],
              cause: { account: { fundingSourceId: requeued.fundingSourceId, name: requeued.account, window: requeued.window }, agents: [run.agentId] },
            });
          }
        })
        .then(() => limitRequeues.releaseReady())
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
    freeSlots: (companyId) => scheduler.freeSlots(companyId),
    liveCommit: () => process.env.BOSSMAN_COMMIT || null,
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
    // BOS-2160: a background step that throws is logged (the error buffer reads app.log.error) and, if it keeps failing, raises one owner card.
    log: (message) => app.log.error(message),
    homeCompany: async () => (await db.select({ id: companies.id }).from(companies).orderBy(asc(companies.createdAt)).limit(1))[0]?.id ?? null,
    // The merge line jam alert (BOS-766) reads the same view the Merge queue screen does; `mergeQueue` is
    // built below, so this resolves it per pass.
    mergeJam: () => mergeJam.run(),
    checkHold: async () => {
      await checkHold?.sweepProgress().catch(() => undefined); // BOS-2114
      return checkHold?.sweep();
    },
    priorityWatch: () => priorityWatch.run(),
    mergeStall: () => mergeStall.run(),
    // R46: refresh what each free check slot declined (the pump), then tell on any that has sat idle with a job waiting.
    checkIdle: async () => {
      await checks.pump();
      return checkIdle.run();
    },
    // Also flags a card whose own ticket changed state since it was raised (BOS-1161); that never closes it.
    clearAlerts: async () => {
      const wakeAgent = (input: { agentId: string; reason: string; note: string; ticketId?: string | null; priority?: number }) => scheduler.notify(input.agentId, input as { ticketId: string; reason: string; note: string; priority?: number });
      let closed = await clearing.check();
      // BOS-1193: the validity table runs over every open agent card (a dead one closes by itself, which also
      // clears the leftovers older flagging left behind), then a stale one is flagged and its re-check clock moves.
      closed += await closeInvalidCards(db, { release: (ticketId) => decisionsSvc.release(ticketId), now: opts.now, notify: (n) => notes.notify(n) }).catch((err) => { app.log.error({ err }, "closing dead cards failed"); return 0; });
      await ticketStateChanged(db, { wake: wakeAgent, now: opts.now?.() }).catch((err) => app.log.error({ err }, "flagging cards after a ticket changed state failed"));
      await recheckDeadlines(db, { wake: wakeAgent, now: opts.now?.() }).catch((err) => app.log.error({ err }, "moving cards on in their re-check failed"));
      return closed;
    },
    // A feature the roadmap commits to but nothing is working on (BOS-595): the sweep raises one CEO
    // card, which the one closer above withdraws as soon as a ticket is linked to the feature.
    featuresWithoutTickets: async () => {
      let raised = 0;
      for (const companyId of [...new Set((await db.select({ id: featuresTable.companyId }).from(featuresTable)).map((r) => r.id))]) {
        // BOS-1388: the same pass deletes unconfirmed portal posts whose emailed link ran out.
        await feedback.purgeUnconfirmed().catch((err) => app.log.error({ err }, "deleting expired unconfirmed portal posts failed"));
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
    // BOS-1647: a push that landed but was never recorded is recorded, wherever the ticket sits now.
    recordLanded: (ticketId) => review.recordLanded(ticketId).then((r) => !!r),
    // An approved merge cut off (e.g. by a deploy's hand-over) is tried once more, in the background.
    retryLand: (ticketId) => review.startLanding(ticketId, "Boss Man (trying an interrupted merge again)"),
    resumeLand: (ticketId, adopt) => review.startLanding(ticketId, adopt ? "Boss Man (the server restarted; carrying on with the merge check that is still running)" : "Boss Man (the server restarted during this merge; starting it again)", undefined, adopt ? { adopt } : undefined),
    // Approved work held on a fix goes on once the fix is merged and live (BOS-1173); a repeat round on passed code is withdrawn.
    releaseHolds: () => review.releaseHolds(),
    withdrawRepeatRounds: (judged) => review.withdrawRepeatRounds(judged),
    releaseUnblocked: (ticketId) => scheduler.releaseIfUnblocked(ticketId),
    landingActive: (ticketId) => review.landingActive(ticketId),
    landingRunning: (ticketId) => review.runningMerges().some((m) => m.ticketId === ticketId),
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
    // Back in review on code its last round already passed: that round stands, no new one (BOS-1173).
    onReview: async (t) => {
      // BOS-2179: the overlap warning records the branch's files on every move to review; advisory, not awaited.
      void review.recordFiles(t.id).catch(() => undefined);
      return (await review.keptRound(t.id).catch(() => false)) ? undefined : scheduler.onTicketReview(t.id, null);
    },
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
  const limitRequeues = limitRequeue(db, { now: opts.now ?? (() => new Date()) });
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
    // A trip means the Scrum Master is the problem: it skips that rung and goes to the CEO, and reaches the owner only on escalation (BOS-1015).
    alert: (companyId, question) => alerts.raise({ companyId, kind: "watchdog_trip", question, from: "ceo", why: "the Scrum Master is the one that tripped", dedupeKey: `watchdog-trip:${companyId}:${Math.floor(Date.now() / 3_600_000)}` }),
    alertCeo: (input) => alerts.raise(input),
    // The idle-capacity rules (BOS-659): how many of the company's run slots are busy, and its limit.
    capacity: async (companyId) => {
      const { company } = await scheduler.runLimits(companyId);
      return { busy: company.running, limit: company.limit };
    },
    notifyOwner: (n) => notes.notify({ ...n, agentId: null }),
    hosts: () => hostFacts.hosts(),
    ownerAnswerEmbedder: (companyId) => semantic.ownerAnswerEmbedder(companyId),
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
  // Cost sanity check (BOS-1866): a run whose cost disagrees with its tokens at list price raises one CEO alert.
  runners.setCostAlertHook((a) => raiseCostAlert((input) => alerts.raise(input as Parameters<typeof alerts.raise>[0]), a));
  // The GitHub watcher (BOS-1393): main.ts runs runDue() on the leader's timer; the owner's routes save the setting and check now.
  const githubWatch = githubWatchService(db, {
    fetch: opts.fetch,
    now: opts.now,
    token: async (companyId) => (await secretsSvc.resolveCompanyEnv(companyId, "github_watch"))[WATCH_TOKEN_ENV],
    feedback,
    notify: (agentId, input) => scheduler.notify(agentId, input),
    alert: (input) => alerts.raise(input),
    clearCard: (key, summary) => clearOwnerTodo(db, key, summary),
    createTicket: (projectId, input) => work.createTicket(projectId, input),
    closeTicket: (ticketId, note) => work.updateTicket(ticketId, { state: "done", outcome: "completed", stateNote: note }),
    // BOS-2085 (R54): a security alert opening or closing sends the company's open go-live cards back for a re-check.
    alertChanged: (companyId, input) => securityAlertChanged(db, { companyId, ...input, wake: (w) => scheduler.notify(w.agentId, w as { ticketId: string; reason: string; note: string; priority?: number }), now: opts.now?.() }),
    log: (m) => app.log.warn(m),
  });
  // Offline runners and the post-deploy "every runner is back" check (BOS-467).
  const runnerWatch = runnerWatchService(db, { isConnected: (id) => runners.isConnected(id), holdOn: async () => !!(await getHold(db)), wantedCompanies: () => launch.wantedCompanies(), guardFault: async (companyId) => ((await launch.status(companyId))?.container?.guardReason ?? null), notify: (n) => notes.notify(n), alert: (input) => alerts.raise(input), now: opts.now, log: (m) => app.log.warn(m) });
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
  const gitTokenProbe = gitTokenActionsProbe({ db, gitHosts, gitToken: async (companyId) => (await secretsSvc.resolveCompanyEnv(companyId, "pull_request")).GIT_TOKEN, now: opts.now });
  const setup = setupService(db, { isConnected: (id) => runners.isConnected(id) });
  const review = reviewService(db, {
    runners,
    work,
    loops,
    gitHosts,
    gitToken: async (companyId) => (await secretsSvc.resolveCompanyEnv(companyId, "pull_request")).GIT_TOKEN,
    notes,
    onMerged: (ticketId) => scheduler.onTicketMerged(ticketId),
    scanList: () => privateDetails.forRunner(),
    scanListWarning,
    isLeader: () => leader.isLeader(),
    ciTiming: opts.ciTiming,
    cancelCheck: (jobId, reason) => checks.cancel(jobId, reason),
    // BOS-1602: train seats count only slots that can run a merge check.
    checkCapacity: (companyId) => checks.mergeCapacity(companyId),
    alert: (input) => alerts.raise(input as Parameters<typeof alerts.raise>[0]),
  });
  review.setWakeHook((agentId, w) => scheduler.notify(agentId, w));
  // The main-CI watcher (BOS-1072): a ticket for each distinct failing step of GitHub CI on main.
  const mainCi = mainCiService(db, {
    gitHosts,
    gitToken: async (companyId) => (await secretsSvc.resolveCompanyEnv(companyId, "pull_request")).GIT_TOKEN,
    createTicket: (projectId, input) => work.createTicket(projectId, input),
    notify: (agentId, input) => scheduler.notify(agentId, input),
    log: (m) => app.log.warn(m),
  });
  // The nightly whole-repo secrets pass (BOS-1932): one ticket per key-shaped match on main, for the security reviewer.
  const secretScan = secretScanService(db, {
    runners,
    createTicket: (projectId, input) => work.createTicket(projectId, input),
    notify: (agentId, input) => scheduler.notify(agentId, input),
    now: opts.now,
    log: (m) => app.log.warn(m),
  });
  checkWake = (agentId, w) => scheduler.notify(agentId, w);
  // BOS-1906: a held ticket ("Being checked") opens its reviews on a pass, or goes back to its agent on a failure; no agent run on a pass.
  checkHold = checkHoldService(db, {
    openReviews: async (ticketId) => ((await review.keptRound(ticketId).catch(() => false)) ? undefined : scheduler.onTicketReview(ticketId, null)),
    wake: (agentId, w) => scheduler.notify(agentId, w),
    now: opts.now,
    branchHead: opts.branchHead ?? ((ticketId) => review.diff(ticketId).then((d) => d.head)),
  });
  releaseGoLive = (companyId) => review.releaseGoLiveWaiters(companyId);
  // The owner's read-only merge queue screen (BOS-587): what runs, what waits, how the last ones ended.
  // In server mode (BOS-316, BOS-597) it reports the server-owned check queue's own mode, slots, and
  // running and waiting counts for the company, so the screen can show "waiting for a check slot".
  // The counts read only the live states, through check_jobs_state_queued: check_jobs has no company
  // index, so a company-only filter would read the whole table.
  const checkQueueSvc = checkQueue(db);
  const mergeQueue = mergeQueueService(db, {
    runningMerges: () => review.runningMerges(),
    limit: () => checkGate(db).limit(),
    // BOS-1942: where each running check runs, and where a finished merge check ran (read from the job records).
    runningChecks: (companyId) => runningCheckJobs(db, companyId),
    endedMergePlaces: (companyId, ticketIds) => endedMergePlaces(db, companyId, ticketIds),
    serverHost: () => hostFacts.serverHost(),
    // BOS-1942: which machine holds how many of the check slots (the server, then each ready worker), so the page can say what the total is made of.
    slotSplit: async (companyId) => {
      const ms = await checks.machines(companyId);
      const ids = ms.map((m) => m.workerId).filter((x): x is string => !!x);
      const names = ids.length ? await db.select({ id: checkWorkers.id, name: checkWorkers.name }).from(checkWorkers).where(inArray(checkWorkers.id, ids)) : [];
      return ms.map((m) => ({ ranOn: m.workerId ? (names.find((n) => n.id === m.workerId)?.name ?? "a check worker") : "company runner", slots: m.limit }));
    },
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
      // BOS-1435: slots across the runner and ready check workers (the slots setting when there are none).
      return { mode: mode as CheckQueueMode, slots: await checks.capacity(companyId), running: live?.running ?? 0, waiting: live?.waiting ?? 0 };
    },
    // BOS-1803: seat waiters (no check-queue place yet) come along too, for their train-seat place and lane.
    places: async (companyId) => new Map((await checkQueueSvc.list(companyId)).rows.filter((r) => r.kind === "merge" && r.state === "waiting" && (r.position || r.heldBySeat)).map((r) => [r.ticketId, { place: r.position, why: r.why, seatPlace: r.seatPlace, lane: r.lane }])),
    // BOS-1486: the live reasons a merge waits, so the screen never says "waiting for a slot" for another cause.
    runnerConnected: async (companyId) => {
      const [r] = await db.select({ id: runnersTable.id }).from(runnersTable).where(eq(runnersTable.companyId, companyId));
      return !!r && runners.isConnected(r.id);
    },
    runnerUpdateOn: async () => {
      const h = await getHold(db);
      return !!h && h.kind !== "wrapup";
    },
    launcherOn: () => launch.enabled,
    // BOS-1594: the stuck/over-capacity verdict's two live facts: an empty train seat (the restart seed wait excluded), and a check worker.
    emptySeatSince: async (companyId) => {
      const since = (await mergeTrainStatus(db, companyId).catch(() => [])).filter((p) => !p.seeding && p.emptySeatSince).map((p) => new Date(p.emptySeatSince!).getTime());
      return since.length ? Math.min(...since) : null;
    },
    workerReady: async (companyId) => (await checkWorkersSvc.list()).some((w) => w.enabled && w.connected && w.companies.some((c) => c.id === companyId && c.ready)),
    queueDetail: async (companyId) => {
      const q = await checkQueueSvc.list(companyId);
      const fix = q.rows.find((r) => r.fixesMain);
      return {
        slots: q.slots,
        busy: q.rows.filter((r) => r.state === "running").map((r) => ({ ref: r.ref, title: r.title, kind: r.kind === "merge" ? "merge check" : r.kind === "full" ? "full check" : "quick check" })),
        mainRed: q.rows.some((r) => r.heldByMain),
        fixRef: fix ? (fix.ref ?? fix.title) : null,
        seatWait: q.rows.filter((r) => r.heldBySeat).map((r) => r.ticketId),
        // BOS-1515: tickets the train holds to land on main alone, with the clash.
        heldAlone: (await mergeTrainStatus(db, companyId).catch(() => [])).flatMap((p) => p.heldAlone),
      };
    },
    now: opts.now,
  });
  // BOS-1489: the start hold's two counts. Merges: the Merge queue page's own figure. Quick checks: queued jobs that aren't a
  // merge or a full check, through check_jobs_state_queued (state first), counted for the company.
  // BOS-2196: cards that need the owner, the Dashboard's Needs you figure (queueTally().open), only when that limit is on.
  setStartHoldCounts(async (companyId, want) => {
    const [q] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(checkJobs)
      .where(and(eq(checkJobs.state, "queued"), eq(checkJobs.companyId, companyId), eq(checkJobs.scope, "quick"), ne(checkJobs.kind, "merge")));
    return { merges: await mergeQueue.waitingCount(companyId), quickChecks: q?.n ?? 0, ...(want?.owner ? { ownerWaiting: (await decisionsSvc.queueTally({ companyId })).open } : {}) };
  });
  // BOS-2058: every update wait that is on, for the owner's screens and the CEO's server_status (one list, update-waits.ts).
  const currentUpdateWaits = async () => {
    const landing = await review.landingWaitFacts().catch(() => ({ since: null, ids: [] as string[] }));
    return activeWaits(db, { landingSince: landing.since, landingNames: landing.ids.map((id) => id.slice(0, 8)) });
  };
  // An approved server update waits for a quiet machine (BOS-420): enough free memory, no merge check in flight,
  // few runs. Its soft hold parks new checks and caps runs until the standby window ends. main.ts steps it.
  const deployWait = deployWaitService(db, {
    headroom: () => selfDeploy.headroom(),
    checksRunning: async () => {
      // BOS-2058: only checks the hold itself stops from starting (not a worker's quick checks, which it lets through).
      return review.gateState().running + (await serverWaitChecks(db));
    },
    openRuns: async () => {
      // BOS-2088: the one "an update waits for it" rule (runner-busy.ts updateWaitCountsRun). It also leaves out the CEO's
      // reply lane, which this count alone used to include, so an "update alert" run no longer held the wait it reports on.
      const [{ n }] = (await db.select({ n: sql<number>`count(*)::int` }).from(runsTable).where(and(isNull(runsTable.endedAt), updateWaitCountsRun()))) as [{ n: number }];
      return n;
    },
    send: (ctx, id, o) => selfDeploy.send(ctx, id, o),
    takeBack: (id) => selfDeploy.takeBack(id),
    requestWaiting: (id) => selfDeploy.requestWaiting(id),
    status: () => selfDeploy.status(),
    available: () => selfDeploy.available(),
    trialUntil: () => selfDeploy.trialUntil(),
    runnerCardOpen: () => selfDeploy.runnerCardOpen(),
    drainOn: async () => !!(await getHold(db)),
    notify: (n) => notes.notify(n),
    tellCeo: (note) => selfDeploy.tellCeo(note),
    // BOS-2058: through the CEO's reply lane, which an update's hold never holds and no wait counts (wake-classes.ts PASSES_UPDATE_HOLD).
    wakeCeo: async (note) => {
      const [home] = await db.select({ id: companies.id }).from(companies).orderBy(asc(companies.createdAt)).limit(1);
      if (!home) return;
      const [ceo] = await db.select({ id: agents.id }).from(agents).where(and(eq(agents.companyId, home.id), eq(agents.role, "ceo"), isNull(agents.retiredAt)));
      if (ceo) await scheduler.notify(ceo.id, { reason: UPDATE_ALERT_REASON, ticketId: null, priority: 4, note });
    },
    released: async () => {
      await review.gatePump();
      await checks.sweep();
      await scheduler.tick();
    },
    now: opts.now,
    log: (m) => app.log.warn(m),
  });
  decisionsSvc.setDeployWaitHook(deployWait);
  // The merge line jam alert (BOS-766): the same view the Merge queue screen reads, and the owner's own
  // notification service, so quiet hours and caps apply as for every other notification.
  const mergeJam = mergeJamService(db, {
    view: (companyId) => mergeQueue.get(companyId),
    notify: (input) => notes.notify(input),
    // A card holding an approved merge that looks stale goes to the CEO once (BOS-1078).
    tellCeo: async ({ companyId, ticketId, note, reason }) => {
      const [ceo] = await db.select({ id: agents.id }).from(agents).where(and(eq(agents.companyId, companyId), eq(agents.role, "ceo"), isNull(agents.retiredAt)));
      if (ceo) await scheduler.notify(ceo.id, { reason: reason ?? "merge held by a stale card", ticketId, priority: 2, note });
    },
    now: opts.now,
  });
  // Priority watch (BOS-1514): the CEO is woken on a wake that is never dropped; the owner gets one notification per stop.
  const priorityWatch = priorityWatchService(db, {
    tellCeo: async ({ companyId, ticketId, note }) => {
      const [ceo] = await db.select({ id: agents.id }).from(agents).where(and(eq(agents.companyId, companyId), eq(agents.role, "ceo"), isNull(agents.retiredAt)));
      if (ceo) await scheduler.notify(ceo.id, { reason: PRIORITY_WATCH_REASON, ticketId, priority: 2, note });
    },
    notify: (input) => notes.notify(input),
    now: opts.now,
  });
  // Merge stall alarm (BOS-1515): an empty train seat or no landing while tickets wait; the CEO first, the owner as in fix A.
  const mergeStall = mergeStallService(db, {
    tellCeo: async ({ companyId, ticketId, note }) => {
      const [ceo] = await db.select({ id: agents.id }).from(agents).where(and(eq(agents.companyId, companyId), eq(agents.role, "ceo"), isNull(agents.retiredAt)));
      if (ceo) await scheduler.notify(ceo.id, { reason: MERGE_STALL_REASON, ticketId, priority: 2, note });
    },
    notify: (input) => notes.notify(input),
    now: opts.now,
    // BOS-1841: no empty-seat or no-landing alarm while new checks are paused on purpose for a server update.
    paused: async () => (await softHold(db, opts.now?.())).on,
  });
  // Idle check capacity (R46, BOS-1814): the CEO after 5 minutes, the owner after 30, once per machine and job.
  const checkIdle = checkIdleService({
    slots: () => checks.idleSlots(),
    // The slot kept for merges is expected while a merge check is queued or running, or an approved ticket is in the merge line (waiting on GitHub CI included).
    mergeActive: async (companyId) => {
      const [j] = await db.select({ id: checkJobs.id }).from(checkJobs).where(and(eq(checkJobs.companyId, companyId), eq(checkJobs.kind, "merge"), inArray(checkJobs.state, ["queued", "running"]))).limit(1);
      return !!j || (await mergeQueue.lineSize(companyId)) > 0;
    },
    tellCeo: async ({ companyId, ticketId, note }) => {
      const [ceo] = await db.select({ id: agents.id }).from(agents).where(and(eq(agents.companyId, companyId), eq(agents.role, "ceo"), isNull(agents.retiredAt)));
      if (ceo) await scheduler.notify(ceo.id, { reason: IDLE_CHECK_SLOT_REASON, ticketId, priority: 2, note });
    },
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
  // BOS-1664: GitHub's own jobs before review, for a branch that changes CI or image files (GitHub projects with a readable token only).
  const preflightScanList = scanListReader({ read: () => privateDetails.forRunner(), ...scanListWarning });
  const ciPreflight = ciPreflightService(db, {
    hosts: gitHosts,
    timing: { ...CI_PUBLISH_TIMING, ...opts.ciTiming },
    log: (m) => app.log.warn(m),
    wake: (agentId, w) => scheduler.notify(agentId, w),
    context: async (t) => {
      const [p] = await db.select({ repoUrl: projects.repoUrl, gitHost: projects.gitHost, gitApiBase: projects.gitApiBase, defaultBranch: projects.defaultBranch }).from(projects).where(eq(projects.id, t.projectId));
      const repo = p?.repoUrl ? parseRepoUrl(p.repoUrl) : null;
      if (!p || p.gitHost !== "github" || !p.gitApiBase || !repo) return null;
      const [runner] = await db.select({ id: runnersTable.id }).from(runnersTable).where(eq(runnersTable.companyId, t.companyId));
      // "ci-publish-scan": only a runner that applies the owner's private-details list before the push gets the early run;
      // an older one pushes unscanned (or without the list), and the push can't be undone (the sha stays readable).
      if (!runner || !runners.can(runner.id, "ci-publish") || !runners.can(runner.id, "ci-publish-scan")) return null;
      const token = (await secretsSvc.resolveCompanyEnv(t.companyId, "pull_request")).GIT_TOKEN;
      if (!token) return null;
      const merge = (phase: "prepare" | "publish" | "unpublish", extra: Record<string, unknown> = {}) =>
        runners.request<MergeResult>(runner.id, (requestId) => ({ type: "workspace.merge", requestId, projectId: t.projectId, ticketId: t.id, target: p.defaultBranch, message: phase === "prepare" ? "GitHub CI before review" : phase === "publish" ? "publish for CI" : "unpublish", phase, ...extra }) as never, MERGE_WAIT_MS);
      return {
        target: { cfg: { kind: "github" as const, apiBase: p.gitApiBase, owner: repo.owner, repo: repo.repo }, token },
        prepare: () => merge("prepare"),
        publish: async (commit) => {
          const scanList = await preflightScanList.forScan();
          // A list that is set but can't be read is not skipped: the push can't be taken back.
          if (!scanList && (await privateDetails.isSet().catch(() => true))) throw new Error("Not pushed to GitHub: the owner's private-details list couldn't be read, so the scan before the push couldn't run in full. Saving the list again in Settings fixes it.");
          return merge("publish", { commit, ...(scanList ? { scanList } : {}) });
        },
        unpublish: () => merge("unpublish"),
      };
    },
  });
  const checkRequests = checkRequestService(db, { preflight: ciPreflight, command: async (scope, projectId) => { if (scope === "quick") return "scripts/check-quick.sh"; const [p] = await db.select({ v: projects.verifyCommand }).from(projects).where(eq(projects.id, projectId)); return p?.v ?? "scripts/check-all.sh"; }, diff: (runnerId, projectId, ticketId) => runners.request<WorkspaceDiff>(runnerId, (requestId) => ({ type: "workspace.diff", requestId, projectId, ticketId }), 60_000) });
  // A restart loses the in-memory GitHub-CI pre-flight runs; start those again once runners have had time to reconnect.
  // Runners may come back later than 60 s after an update, so tickets skipped for want of one are retried every 2 minutes for 30 minutes.
  const stopPreflightRecover = ciPreflight.recoverRepeatedly({ firstMs: 60_000, everyMs: 120_000, forMs: 30 * 60_000 });
  app.addHook("onClose", async () => stopPreflightRecover());
  // BOS-1749: bossman-ci/* branches the gate's own cleanup missed (a restart mid-check, a refused delete) are deleted from GitHub.
  // First sweep 5 minutes after start (so old leftovers go without anyone asking), then every 30 minutes; branches under 6 hours old stay.
  const sweepCi = () => void review.sweepCiBranches().catch(() => undefined);
  const ciSweepFirst = setTimeout(sweepCi, 5 * 60_000);
  const ciSweepEvery = setInterval(sweepCi, 30 * 60_000);
  ciSweepFirst.unref();
  ciSweepEvery.unref();
  app.addHook("onClose", async () => { clearTimeout(ciSweepFirst); clearInterval(ciSweepEvery); });
  await mcpRoutes(app, db, { decisions: decisionsSvc, engagements: engagementsSvc, deploys: deploysSvc, runs: runsSvc, review, notes, chapters, work, feedback, ticketChat, wiki, skills: skillsSvc, skillProposals, agents: agentsSvc, pa, images, watchdog, alerts, retro, serverStatus, hostFacts, deviceProfiles, addons: addonFacts, selfDeployCards: () => selfDeploy.cardFacts(), checkRequests, githubWatch, ownerAnswerEmbedder: (companyId) => semantic.ownerAnswerEmbedder(companyId), ticketEmbedder: (companyId) => semantic.ticketEmbedder(companyId), gitTokenProbe }, { onTicketDone: (ticketId, runId) => Promise.all([scheduler.onTicketDone(ticketId, runId), decisionsSvc.withdrawMergeCardsForTicket(ticketId)]), onTicketReview: async (ticketId, agentId, runId) => ((await review.keptRound(ticketId).catch(() => false)) ? undefined : scheduler.onTicketReview(ticketId, agentId, runId)), nudge: (i) => scheduler.nudge(i), wake: (agentId, i) => scheduler.notify(agentId, i), onRunTicket: (ticketId, runId) => work.attachRun(ticketId, runId) });
  // The feedback portal's public API, on this listener too, so the owner can try it here.
  await portalRoutes(app, { feedback, secureCookies: opts.secureCookies ?? true, limits: opts.portalLimits, now: opts.now ? () => opts.now!().getTime() : undefined, mailer, portalUrl: opts.portalUrl });

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

  // BOS-2177: the first time sign-in locks, tell the owner once (an alert and one activity line, on the oldest
  // company, as sign-in belongs to no company). The text carries the address only: never a guessed name or password.
  const logins = loginLimiter(opts.loginLimits, () => (opts.now ? opts.now().getTime() : Date.now()), (e) => {
    const limits = opts.loginLimits ?? DEFAULT_LOGIN_LIMITS;
    const address = e.ip.replace(/[^0-9a-fA-F.:%]/g, "").slice(0, 64) || "an unknown address";
    const at = new Date(e.at);
    void (async () => {
      const [home] = await db.select({ id: companies.id }).from(companies).orderBy(asc(companies.createdAt)).limit(1);
      await notes.notify({
        companyId: null,
        agentId: null,
        level: "flag",
        title: e.byAddress
          ? `Sign-in was locked after ${limits.maxFailures} wrong passwords from ${address}`
          : `Sign-in for the owner's username was locked after ${limits.maxFailures} wrong passwords from several addresses, the latest ${address}`,
        body: "If this wasn't you, change your password in Settings → Account.",
        link: "#/settings",
      });
      if (home) await record(db, { companyId: home.id, kind: "security", summary: `Sign-in locked after ${limits.maxFailures} failed attempts from ${address} at ${at.toISOString()}`, detail: { address, at: at.toISOString(), byAddress: e.byAddress, byUsername: e.byUsername }, at });
    })().catch((err) => app.log.warn({ err }, "sign-in lockout alert failed"));
  });
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

  // Phone Approve (BOS-243 rules 3, 4, 8): its own scope, parsers and error handler, kept in
  // routes/devices-notifications.ts.
  await phoneApproveRoutes(app, { notes, phoneApprove });

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

    // Account (BOS-2159): the owner changes their password and ends every other login. Only valid behind requireOwner.
    /** Ends every login of this owner except the one in this request's cookie; returns how many it ended. */
    async function endOtherSessions(req: FastifyRequest, ownerId: string) {
      const keep = hashToken(req.cookies[SESSION_COOKIE] ?? "");
      const gone = await db.delete(sessions).where(and(eq(sessions.ownerId, ownerId), ne(sessions.tokenHash, keep))).returning({ h: sessions.tokenHash });
      return gone.length;
    }
    owner.post("/api/account/password", async (req, reply) => {
      const body = z.object({ currentPassword: z.string().min(1).max(256), newPassword: Credentials.shape.password }).parse(req.body);
      const ownerId = await currentOwnerId(req);
      const [me] = ownerId ? await db.select().from(owners).where(eq(owners.id, ownerId)) : [];
      if (!me) return reply.code(401).send({ error: "not_signed_in" });
      // A guess at the current password is a login guess: same limiter as /api/login.
      const wait = logins.retryAfter(req.ip, me.username);
      if (wait > 0) {
        const minutes = Math.ceil(wait / 60_000);
        return reply.code(429).header("retry-after", String(Math.ceil(wait / 1000))).send({ error: "too_many_attempts", message: `Too many failed attempts. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.` });
      }
      if (!(await verifyPassword(body.currentPassword, me.passwordHash))) {
        logins.failed(req.ip, me.username);
        return reply.code(403).send({ error: "wrong_current_password", message: "The current password is not right." });
      }
      if (body.newPassword === body.currentPassword) return reply.code(400).send({ error: "same_password", message: "Choose a password different from the current one." });
      await db.update(owners).set({ passwordHash: await hashPassword(body.newPassword) }).where(eq(owners.id, me.id));
      logins.succeeded(req.ip, me.username);
      return { ok: true, signedOut: await endOtherSessions(req, me.id) };
    });
    owner.post("/api/account/sign-out-others", async (req, reply) => {
      const ownerId = await currentOwnerId(req);
      if (!ownerId) return reply.code(401).send({ error: "not_signed_in" });
      return { ok: true, signedOut: await endOtherSessions(req, ownerId) };
    });

    // Device profiles (BOS-641): the owner's browsers report their measured screens.
    deviceRoutes(owner, { deviceProfiles, currentOwnerId });

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
      const b = z.object({ name: z.string().trim().min(1).max(80), mission: z.string().max(2000).nullable(), ownerApprovesEngagements: z.boolean(), goalCheckDays: z.number().int().min(1).max(365), nudgesPerHour: z.number().int().min(1).max(1000), adviceTimeoutMinutes: z.number().int().min(5).max(1440), maxRunMinutes: z.number().int().min(1).max(10_080).nullable(), permissionJudge: z.enum(PERMISSION_JUDGE_MODES), autoTempCleanup: z.boolean(), fenceMode: z.enum(FENCE_MODES), diskCapGb: z.number().positive().max(100_000).nullable(), holdStartsMergesWaiting: z.number().int().min(1).max(1000).nullable(), holdStartsQuickChecksQueued: z.number().int().min(1).max(1000).nullable(), holdStartsOwnerWaiting: z.number().int().min(1).max(1000).nullable(), ticketPrefix: z.string().trim().toUpperCase().regex(TICKET_PREFIX, "1 to 10 letters or digits") }).partial().parse(req.body);
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
      // A fence mode sent from Settings is the owner's choice (BOS-940): Boss Man never changes it, and its card goes.
      const chosenAt = b.fenceMode ? new Date() : null;
      const patch = { ...rest, ...(diskCapGb !== undefined ? { diskCapBytes: diskCapGb === null ? null : Math.round(diskCapGb * 1024 ** 3) } : {}), ...(chosenAt ? { fenceModeChosenAt: chosenAt, fenceOffFingerprint: null } : {}) };
      const [before] = await db.select({ fenceMode: companies.fenceMode, permissionJudge: companies.permissionJudge, maxRunMinutes: companies.maxRunMinutes }).from(companies).where(eq(companies.id, id));
      const [c] = await db.update(companies).set(patch).where(eq(companies.id, id)).returning();
      if (!c) return reply.code(404).send({ error: "not_found" });
      if (chosenAt) await closeFenceCard(db, id, chosenAt);
      // Choosing Off is one of the held card's two ways out (BOS-373).
      if (chosenAt && b.fenceMode === "off") await closeFenceUnavailableCard(db, id, chosenAt, "The owner chose Off in Settings.");
      // The disk cap is the owner's own setting (BOS-274): keep a record of who changed it and to what.
      if (diskCapGb !== undefined) {
        const gb = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(1)} GB`;
        await record(db, { companyId: id, kind: "settings", summary: diskCapGb === null ? "Owner reset the workspace disk cap to the server default (20 GB)" : `Owner set the workspace disk cap to ${gb(Math.round(diskCapGb * 1024 ** 3))}`, detail: { diskCapGb } });
      }
      // The start hold's limits (BOS-1489) change what starts, so keep a record of who set them and to what.
      for (const [key, label, offLabel] of [["holdStartsMergesWaiting", "merges waiting", "merges waiting"], ["holdStartsQuickChecksQueued", "quick checks queued", "quick checks queued"], ["holdStartsOwnerWaiting", "cards need you", "cards that need you"]] as const)
        if (b[key] !== undefined) await record(db, { companyId: id, kind: "settings", summary: b[key] === null ? `Owner turned off holding new starts on ${offLabel}` : `Owner set new starts to be held while ${b[key]} or more ${label}`, detail: { [key]: b[key] } });
      // The agent fence, permission-card advice and the run time limit change what agents may do (BOS-2063): record each one the request changed.
      const FENCE_WORDS = { off: "Off", watch: "Watch", enforce: "Enforce" } as const;
      const JUDGE_WORDS = { off: "Off", watch: "Watch", advise: "Advise" } as const;
      if (b.fenceMode !== undefined && b.fenceMode !== before?.fenceMode) await record(db, { companyId: id, kind: "settings", summary: `Owner set the agent fence to ${FENCE_WORDS[b.fenceMode]}`, detail: { fenceMode: b.fenceMode } });
      if (b.permissionJudge !== undefined && b.permissionJudge !== before?.permissionJudge) await record(db, { companyId: id, kind: "settings", summary: `Owner set permission-card advice to ${JUDGE_WORDS[b.permissionJudge]}`, detail: { permissionJudge: b.permissionJudge } });
      if (b.maxRunMinutes !== undefined && b.maxRunMinutes !== before?.maxRunMinutes) await record(db, { companyId: id, kind: "settings", summary: b.maxRunMinutes === null ? "Owner removed the run time limit" : `Owner set runs to end after ${b.maxRunMinutes} minutes`, detail: { maxRunMinutes: b.maxRunMinutes } });
      return c;
    });

    owner.get("/api/companies", async () => {
      const rows = await db.select().from(companies).orderBy(companies.name);
      // Retired agents (R62) only show on the Agents page, so they can't be given new work.
      const allAgents = await db.select().from(agents).where(isNull(agents.retiredAt));
      const allProjects = await db.select({ id: projects.id, companyId: projects.companyId, name: projects.name, starred: projects.starred }).from(projects).where(isNull(projects.archivedAt)).orderBy(projects.name);
      return rows.map((c) => ({ ...c, agents: allAgents.filter((a) => a.companyId === c.id), projects: allProjects.filter((p) => p.companyId === c.id) }));
    });

    // What each risk tier means (R61) is served from routes/settings-limits.ts, registered below with the limits.
    // Review routing, standing rules, permission rules and grants: routes/policy.ts, registered below.
    // This binding is shared with routes/projects.ts, which checks a project's own policy against its company's.
    const checkPolicy = (companyId: string, body: unknown) => checkPolicyIn(db, companyId, body);
    // A project's own review policy: routes/projects.ts, registered with the project routes below.

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

    // Notifications (R44): the feed.
    notificationRoutes(owner, { notes });
    // The run and WIP limits and the check-queue and merged-result settings: routes/settings-limits.ts, on this owner scope.
    // Private details the merge-line scan blocks (BOS-979). The list is write-only: reading it back gives a count per kind.
    owner.get("/api/private-details", async () => privateDetails.summary());
    owner.put("/api/private-details", async (req, reply) => {
      const { text } = z.object({ text: z.string().max(60_000) }).parse(req.body);
      try {
        return await privateDetails.save(text);
      } catch (err) {
        if (err instanceof PrivateDetailsRejected) return reply.code(400).send({ error: err.message });
        throw err;
      }
    });
    settingsLimitsRoutes(owner, { db, scheduler, checkQueueSvc, launch, maintenance, checks, review, runners, mainCi, checkWorkers: checkWorkersSvc });

    // BOS-419: Settings → This host. The facts the host reported (with source and any conflict) and the ones only the owner can give.
    owner.get("/api/host-facts", async () => ({ ...(await hostFacts.sync()), ownerFacts: [...OWNER_FACTS], deployerScript: await selfDeploy.deployerScript().catch(() => ({ state: "none" as const })) }));
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
    // Notification settings (R44, BOS-243): what is on, the ntfy server and topic, and a test push.
    notificationSettingsRoutes(owner, { notes, phoneApprove, secretsSvc, hostFacts, phoneLogin: phoneLoginService({ dir: opts.deployerDir, fact: (k) => hostFacts.value(k), now: () => (opts.now ? opts.now().getTime() : Date.now()), saveSetup: ntfySetupSaver({ notes, secretsSvc }) }) });
    // BOS-1387: Settings → Outgoing email.
    emailSettingsRoutes(owner, { mailer, secretsSvc });
    // BOS-1582: Settings → Tools → Penpot, one form for the four Penpot secrets.
    penpotRoutes(owner, { db, secretsSvc });

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
      // BOS-1498: what this company's runner is given and why, for the wizard's runner step.
      const memory = launcher ? memoryLine(await launch.checks(), launcher.slug) : null;
      if (!r) return { registered: false, launcher, memoryLine: memory };
      const report = await runnerReport.companyPanel(id);
      // One entry per safety feature for Settings' cards (DR-049 point 1): proven, or the owner chose to run without it on this platform.
      const [co] = await db.select().from(companies).where(eq(companies.id, id));
      const safety = co ? featureStates(co, r.sandbox) : null;
      return { registered: true, runnerId: r.id, connected: runners.isConnected(r.id), lastSeenAt: r.lastSeenAt, imageVersion: r.imageVersion, diskUsedBytes: r.diskUsedBytes, diskCheckedAt: r.diskCheckedAt, addons: r.addons, sandbox: r.sandbox, sandboxCheckedAt: r.sandboxCheckedAt, safety, launcher, report, memoryLine: memory };
    });

    // Settings → Server and runner: the two buttons on a safety-feature card (DR-049 point 1). "run" is "Run agents without ...";
    // false is "Keep agents stopped". The choice is kept with this runner's platform.
    owner.post("/api/companies/:id/safety-choice", async (req, reply) => {
      const { id } = IdParam.parse(req.params);
      const b = z.object({ feature: z.enum(["guard", "fence"]), run: z.boolean() }).parse(req.body);
      const [r] = await db.select({ id: runnersTable.id }).from(runnersTable).where(eq(runnersTable.companyId, id));
      if (!r) return reply.code(404).send({ error: "no_runner" });
      const at = new Date();
      if (b.feature === "guard") await chooseGuard(db, id, b.run, at);
      else await chooseFence(db, id, b.run, at);
      return { ok: true };
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
      // The git login is the daemon's alone: as a tool server's secret it would reach the agent's harness as a header (BOS-373).
      secretEnv: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/, "Use an environment variable name like SCRAPLING_MCP_TOKEN.").refine((n) => !isDaemonOnlySecret(n), DAEMON_ONLY_SECRET_REFUSAL).nullable().default(null),
      headerName: z.string().regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,100}$/, "Not a valid header name.").default("Authorization"),
      headerValue: z.string().max(200).default("Bearer {secret}"),
    }).refine((v) => !v.secretEnv || v.headerValue.includes("{secret}"), { path: ["headerValue"], message: "The header value must contain {secret}." });

    owner.get("/api/companies/:id/mcp-servers", async (req) => {
      const { id } = IdParam.parse(req.params);
      // Says whether each server's token secret is granted, since a mistyped name silently leaves the server out of every run.
      const granted = new Set((await db.select({ env: secretGrants.envName }).from(secretGrants).where(eq(secretGrants.companyId, id))).map((g) => g.env));
      return (await db.select().from(mcpServers).where(eq(mcpServers.companyId, id)).orderBy(mcpServers.name)).map((m) => ({ ...m, secretGranted: !m.secretEnv || granted.has(m.secretEnv), secretRefused: !!m.secretEnv && isDaemonOnlySecret(m.secretEnv) }));
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
      // Name and address only: no header, secret name or value, and no login or query part of the address.
      if (row) await record(db, { companyId: id, kind: "settings", summary: `Owner added tool server ${row.name} (${plainUrl(row.url)})` });
      return row ? reply.code(201).send(row) : reply.code(409).send({ error: "name_taken", message: "This company already has a tool server with that name." });
    });
    owner.delete("/api/mcp-servers/:id", async (req, reply) => {
      const [row] = await db.delete(mcpServers).where(eq(mcpServers.id, IdParam.parse(req.params).id)).returning({ id: mcpServers.id, companyId: mcpServers.companyId, name: mcpServers.name });
      if (row) void launch.syncAllow(row.companyId);
      if (row) await record(db, { companyId: row.companyId, kind: "settings", summary: `Owner removed tool server ${row.name}` });
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
      ownerSetupWhy: z.string().max(240).nullable(),
      ownerSetupIfSkipped: z.string().max(240).nullable(),
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

    // New scope from the owner: noted for the CEO's next run, which checks the team covers it (docs/13).
    // shortcut: read-modify-write of one settings row; two owner adds in the same instant could drop one line.
    const teamCheck = async (companyId: string, what: string) => {
      const key = `team-scope:${companyId}`;
      const [row] = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, key));
      const value = [...((row?.value as string[] | undefined) ?? []), what].slice(-10);
      await db.insert(settings).values({ key, value }).onConflictDoUpdate({ target: settings.key, set: { value } });
    };

    // Projects, their review policy, spend, checks and brief, and the setup wizard: routes/projects.ts, on this owner scope.
    projectRoutes(owner, db, { work, launch, gitHosts, setup, runners, secretsSvc, checkPolicy, teamCheck, githubWatch, now: opts.now });

    owner.get("/api/projects/:id/board", async (req) => work.board(IdParam.parse(req.params).id, { doneAll: (req.query as { done?: string }).done === "all" }));

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
      const liveNote = row.t.systemState !== "done" && row.t.goLiveWait ? goLiveNote(row.t.goLiveWait as GoLiveWait, await openUpdateCards(db, row.t.companyId)) : null;
      return { ...row.t, goLiveNote: liveNote, ref: ticketRef(row.prefix, row.t.number), project: row.project, repoUrl: row.repoUrl, defaultBranch: row.defaultBranch, landing: row.landing, verifyCommand: row.verifyCommand, ownerSignoff: ruleFor(await effectivePolicy(db, row.t), row.t.risk).ownerSignoff, assignee: row.assignee, quotaHeldUntil: held?.until?.toISOString() ?? null, quotaHeldReason: held?.reason ?? null, quotaHeldAgent: heldByAgent, quotaHeldSource: heldSource, quotaHeldOther: heldOther, signoffWaiting: signoff, signoff: signoffNow === "none" ? null : signoffNow, hold: row.t.systemState === "review" ? await holdView(db, id) : null, branchOverlaps: await branchOverlapView(db, row.t).catch(() => []) };
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

    // The newest 200 runs on a ticket, oldest first, for its activity feed (R76).
    owner.get("/api/tickets/:id/runs", async (req) => {
      const { id } = IdParam.parse(req.params);
      const newest = await db
        .select({ id: runsTable.id, agent: agents.name, agentId: runsTable.agentId, startedAt: runsTable.startedAt, endedAt: runsTable.endedAt, outcome: runsTable.outcome, purpose: runsTable.purpose })
        .from(runsTable)
        .leftJoin(agents, eq(agents.id, runsTable.agentId))
        .where(eq(runsTable.ticketId, id))
        .orderBy(desc(runsTable.startedAt))
        .limit(200);
      return newest.reverse();
    });

    // A ticket's conversation with the agents working it (R65).
    const ticketChatErrors = (reply: import("fastify").FastifyReply) => (err: unknown) => {
      if (err instanceof TicketChatError) return reply.code(err.status).send({ error: "ticket_chat", message: err.message });
      throw err;
    };
    owner.get("/api/tickets/:id/messages", async (req, reply) => {
      const { before } = z.object({ before: z.string().max(100).optional() }).parse(req.query);
      return ticketChat.list(IdParam.parse(req.params).id, { before }).catch(ticketChatErrors(reply));
    });
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

    // Permission and policy routes (review routing, standing rules, decision rules and grants):
    // routes/policy.ts, on this owner scope.
    policyRoutes(owner, db, { scheduler, secretsSvc, rules });

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
    // The live check queue, for the Merge queue page's "Queued checks" tab (BOS-1174). Read-only.
    owner.get("/api/companies/:id/check-queue", async (req) => {
      const id = IdParam.parse(req.params).id;
      const queue = await checkQueueSvc.list(id, new Date(), await checks.capacity(id), await checks.machines(id));
      // R46: "free, not taking X because …" for every machine with a free slot that declined a job it could take.
      // BOS-1942: the server's own host name, so "Running on this server (name)" reads the same as on the Merges tab.
      return { ...queue, serverHost: await hostFacts.serverHost().catch(() => null), idleSlots: (await checkIdle.view(id)).map(idleView) };
    });
    // BOS-1517: one ticket's status line for its page; null when it isn't in the merge pipeline.
    owner.get("/api/companies/:id/merge-queue/:ticketId/status", async (req) => {
      const { id, ticketId } = z.object({ id: z.string().uuid(), ticketId: z.string().uuid() }).parse(req.params);
      return { statusLine: await mergeQueue.statusLineFor(id, ticketId) };
    });
    // BOS-1384: the owner puts a waiting merge next in line. Only the order changes: the merge still runs its whole check.
    owner.post("/api/companies/:id/merge-queue/:ticketId/front", async (req, reply) => {
      const { id, ticketId } = z.object({ id: z.string().uuid(), ticketId: z.string().uuid() }).parse(req.params);
      const by = await ownerName(req);
      const job = await checkQueueSvc.moveToFront(id, ticketId, by, "owner chose Move to front");
      // BOS-1516: a ticket still waiting for a train seat has no job to mark: move it on the train instead.
      const seat = await checkQueueSvc.moveSeatWaiter(id, ticketId, by, "owner chose Move to front");
      if (!job && !seat) return reply.code(409).send({ error: "That merge isn't waiting for a check slot or a place in the merge train, so there is nothing to move." });
      return { ok: true };
    });

    // The workflow scorecard: how work moves between roles, and where features wait on their last tasks.
    owner.get("/api/companies/:id/workflow", async (req) => {
      const q = z.object({ days: z.coerce.number().int().min(1).max(90).default(14) }).parse(req.query);
      return workflow.scorecardWithPrevious(IdParam.parse(req.params).id, q.days);
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
    wikiRoutes(owner, { wiki, semantic, ownerAnswersNow: () => ownerAnswerEmbeds.run(), ticketMeaningNow: () => ticketMeaningEmbeds.run() });
    // The model second opinion on permission cards (BOS-338). The key is picked from Secrets, never sent back.
    owner.get("/api/companies/:id/second-opinion", async (req) => secondOpinion.settings(IdParam.parse(req.params).id));
    owner.put("/api/companies/:id/second-opinion", async (req, reply) => {
      const { id } = IdParam.parse(req.params);
      const b = SecondOpinionSettings.parse(req.body);
      if (b.enabled && (!b.model || !b.baseUrl)) return reply.code(400).send({ error: "invalid_request", message: "Set the provider address and the model first." });
      return secondOpinion.setSettings(id, b);
    });
    // BOS-1052: how often the model answered vs fell back to the rules judge in the last 24 h.
    owner.get("/api/companies/:id/second-opinion/stats", async (req) => secondOpinion.stats(IdParam.parse(req.params).id));
    owner.post("/api/companies/:id/second-opinion/test", async (req) => {
      IdParam.parse(req.params);
      return secondOpinion.test(SecondOpinionSettings.parse(req.body));
    });

    // A held wake can be run now: it gets high priority, which passes the quota hold, and starts on the next pass.
    owner.post("/api/tickets/:id/run-now", async (req, reply) => {
      const { id } = IdParam.parse(req.params);
      const [t] = await db.select({ companyId: tickets.companyId, title: tickets.title, assigneeAgentId: tickets.assigneeAgentId, systemState: tickets.systemState }).from(tickets).where(eq(tickets.id, id));
      if (!t) return reply.code(404).send({ error: "not_found" });
      const release = { status: "queued" as const, statusReason: null, notBefore: null, priority: sql`greatest(${wakes.priority}, ${OWNER_OVERRIDE_PRIORITY})` };
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
        else await scheduler.wake({ agentId: t.assigneeAgentId!, ticketId: id, reason: "woken by owner", priority: OWNER_OVERRIDE_PRIORITY, note: "The owner ran this ticket now, past the quota hold." });
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
      // BOS-1516: the owner's urgent switch is "Priority 1": it records that the owner set it, and a ticket already waiting for a
      // merge train seat moves up now (the landing's wait loop would also notice within a poll).
      const updated = await work.updateTicket(id, fields.urgent === undefined ? fields : { ...fields, urgentByOwner: fields.urgent });
      if (fields.urgent) retierWaiting(updated.projectId, id, 0);
      return updated;
    });

    // BOS-1516: the owner's "Priority 1" switch on a feature: every open ticket of it carries the owner's urgent mark (new ones
    // too, see createTicket). Turning it off clears only the marks the owner set; done and cancelled tickets are left alone.
    owner.put("/api/features/:id/priority-one", async (req, reply) => {
      const { id } = IdParam.parse(req.params);
      const { on } = z.object({ on: z.boolean() }).parse(req.body);
      const [f] = await db.select({ id: featuresTable.id, companyId: featuresTable.companyId, title: featuresTable.title }).from(featuresTable).where(eq(featuresTable.id, id));
      if (!f) return reply.code(404).send({ error: "not_found" });
      await db.update(featuresTable).set({ priorityOne: on }).where(eq(featuresTable.id, id));
      const open = and(eq(tickets.featureId, id), ne(tickets.systemState, "done"));
      const changed = on
        ? await db.update(tickets).set({ urgent: true, urgentByOwner: true, version: sql`${tickets.version} + 1` }).where(and(open, or(eq(tickets.urgent, false), eq(tickets.urgentByOwner, false)))).returning({ id: tickets.id, projectId: tickets.projectId })
        : await db.update(tickets).set({ urgent: false, urgentByOwner: false, version: sql`${tickets.version} + 1` }).where(and(open, eq(tickets.urgentByOwner, true))).returning({ id: tickets.id, projectId: tickets.projectId });
      if (on) for (const c of changed) retierWaiting(c.projectId, c.id, 0);
      // BOS-2090: urgent tasks get past the usage hold, so each task the switch changed leaves a line saying when and why.
      const at = new Date();
      const summary = on ? `Owner turned on Priority 1 for feature "${f.title}": this task now goes first` : `Owner turned off Priority 1 for feature "${f.title}"`;
      for (const c of changed) await record(db, { companyId: f.companyId, ticketId: c.id, kind: "quota", summary, at });
      return { ok: true, priorityOne: on, tickets: changed.length };
    });

    // The owner moves a ticket by hand (e.g. to unstick it). Done skips the merge: it is the owner's call.
    owner.post("/api/tickets/:id/state", async (req) => {
      const { id } = IdParam.parse(req.params);
      const { state, blockedUntil, blockedUntilReason } = z.object({ state: State, blockedUntil: z.string().datetime({ offset: true }).optional(), blockedUntilReason: z.string().trim().max(BLOCKED_UNTIL_REASON_MAX).regex(/^[^\r\n]*$/, "One line, please.").optional() }).parse(req.body);
      if ((blockedUntil || blockedUntilReason) && state !== "blocked") throw new WorkError(422, "A blocked-until time only goes with the Blocked status.");
      if (blockedUntilReason && !blockedUntil) throw new WorkError(422, "Give the date and time you are waiting for along with the reason.");
      if (blockedUntil && new Date(blockedUntil).getTime() <= Date.now()) throw new WorkError(422, "The blocked-until time must be in the future.");
      if (blockedUntil && new Date(blockedUntil).getTime() > Date.now() + BLOCKED_UNTIL_MAX_MS) throw new WorkError(422, `The blocked-until time can be at most ${BLOCKED_UNTIL_MAX_DAYS} days ahead.`);
      const label = ({ backlog: "Backlog", ready: "Ready", in_progress: "In progress", blocked: "Blocked", review: "In review", done: "Done" } as Record<string, string>)[state] ?? state;
      // One move, one history line, and a review round only on a real move into review (DR-010, DR-047): moveTicket does all three.
      const moved = await work.updateTicket(id, { state, moveReason: `Owner moved it to ${label}`, reviewRound: "new", ...(state === "blocked" ? { blockedUntil: blockedUntil ? new Date(blockedUntil) : null, blockedUntilReason: blockedUntil ? blockedUntilReason || null : null } : {}) });
      // Nobody should start work on a ticket the owner has parked or closed.
      if (state === "done" || state === "backlog" || state === "blocked")
        await db.update(wakes).set({ status: "dropped", statusReason: `The owner moved the ticket to ${label}.` }).where(and(eq(wakes.ticketId, id), inArray(wakes.status, ["queued", "deferred"])));
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

    // Objectives: routes/roadmap.ts, on this owner scope.
    objectiveRoutes(owner, db, { work, teamCheck });

    // Feature requests, feedback and the portal's owner settings: routes/features.ts, on this owner scope.
    featureRoutes(owner, db, { feedback, work, portalUrl: opts.portalUrl, mailer });

    // Agents, their lasting notes and runs: routes/agents-runs.ts, on this owner scope.
    agentRunsRoutes(owner, db, { agentsSvc, notesSvc, runsSvc, scheduler, log: app.log });
    ticketRecordRoutes(owner, db, { filesChanged: (tid) => review.diff(tid).then((d) => d.files.length) });

    // The owner chat (v1.1, R70): the CEO or any agent, in plain language; tickets and links out.
    const chatErrors = (reply: import("fastify").FastifyReply) => (err: unknown) => {
      if (err instanceof ChatError) return reply.code(err.status).send({ error: "rejected", message: err.message });
      throw err;
    };
    owner.get("/api/companies/:id/chat/threads", async (req) => chat.threads(IdParam.parse(req.params).id));
    owner.get("/api/companies/:id/chat", async (req, reply) => {
      const { id } = IdParam.parse(req.params);
      const { agentId, before } = z.object({ agentId: Uuid.optional(), before: Uuid.optional() }).parse(req.query);
      return chat.list(id, agentId, before).catch(chatErrors(reply));
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

    // The roadmap and plan views: routes/roadmap.ts, on this owner scope.
    roadmapRoutes(owner, db, { feedback, now: opts.now, planning: planningService(db, { release: (ticketId) => decisionsSvc.release(ticketId) }) });

    // Agents (R62): hire from a template, and undo any change (the other agent routes are in routes/agents-runs.ts).
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
    owner.put("/api/companies/:id/agent-approvals", async (req, reply) => {
      const { id } = IdParam.parse(req.params);
      const { approvals } = z.object({ approvals: z.enum(AGENT_APPROVALS) }).parse(req.body);
      const saved = await agentsSvc.setApprovals(id, approvals);
      return saved === null ? reply.code(404).send({ error: "not_found" }) : { approvals: saved };
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

    owner.post("/api/agent-changes/:id/undo", async (req, reply) => agentsSvc.undo(IdParam.parse(req.params).id).catch(agentErrors(reply)));

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
    serverAdminRoutes(owner, { db, scheduler, maintenance, runnerReport, launch, selfDeploy, deployWait, deploysSvc, cancelRun: (runId) => runsSvc.cancel(runId), activeWaits: () => currentUpdateWaits() });

    // The decision queue (R20), ranked, with what each row holds up.
    owner.get("/api/decisions", async () => decisionsSvc.queue());
    // The number for the menu badge (BOS-969): how many cards need the owner now, and how many are
    // folded into "Waiting, nothing to do yet", from the same rows and rule as the queue above.
    // (BOS-996) The page heading reads the same figures; it no longer sends its own, and any open or
    // waiting figures in the query are ignored, so the server's tally is the only source.
    owner.get("/api/decisions/tally", async (req) => {
      const q = z
        .object({ companyId: z.string().uuid().optional(), includeAll: z.string().optional() })
        .parse(req.query ?? {});
      return decisionsSvc.queueTally({
        ...(q.companyId ? { companyId: q.companyId } : {}),
        ...(q.includeAll ? { includeAll: true } : {}),
      });
    });
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
    owner.get("/api/engagements", async (req) => engagementsSvc.list(undefined, PageQuery.parse(req.query)));
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
    // The host's build result on the ticket's branch head (BOS-1418); null when there's nothing to show. Cached 30 s so page polls don't hammer the host.
    const ciCache = new Map<string, { at: number; value: unknown }>();
    owner.get("/api/tickets/:id/ci", async (req) => {
      const { id } = IdParam.parse(req.params);
      const hit = ciCache.get(id);
      if (hit && Date.now() - hit.at < 30_000) return { ci: hit.value };
      const r = await review.branchChecks(id);
      // A host that reported no checks ("none") has nothing to show either: the page renders nothing for null (BOS-1418).
      const value = r && r.state !== "none" ? { state: r.state, failing: r.failing, total: r.total ?? null, url: r.url ?? null, sha: r.sha } : null;
      ciCache.delete(id);
      ciCache.set(id, { at: Date.now(), value });
      // Bounded: past 200 tickets the oldest answer goes (Map keeps insertion order).
      if (ciCache.size > 200) ciCache.delete(ciCache.keys().next().value as string);
      return { ci: value };
    });
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

    // Stale-blocker, stalled-run and missed-work sweeps (R21, R32, R82); also run on a timer.
    owner.post("/api/sweep", async () => sweeps.run());
  });

  if (opts.webDir) await serveWeb(app, opts.webDir);

  const briefUpkeep = () => refreshBriefs(db, { work, gitHosts, gitToken: async (companyId) => (await secretsSvc.resolveCompanyEnv(companyId, "check")).GIT_TOKEN, log: (m) => app.log.warn(m) });
  /** BOS-2159: removes login rows past their expiry (they are refused already; this stops the table growing). Returns how many. */
  const sweepExpiredSessions = async () => (await db.delete(sessions).where(lte(sessions.expiresAt, new Date())).returning({ h: sessions.tokenHash })).length;
  return { app, sweepExpiredSessions, mailer, launcher: launch, githubWatch, memory, serverHealth, checks, releaseLog, mainCi, secretScan, runnerWatch, briefUpkeep, retro, secrets: secretsSvc, funding, refreshSyntheticQuota, runners, decisions: decisionsSvc, selfDeploy, deployWait, maintenance, runnerReport, scheduler, serverStatus, work, sweeps, watchdog, engagements: engagementsSvc, deploys: deploysSvc, runs: runsSvc, recovery, review, loops, alerts, disk, rules, notes, chapters, feedback, wiki, semantic, ownerAnswerEmbeds, ticketMeaningEmbeds, skills: skillsSvc, skillProposals, ticketChat, ownerReplies, mergeQueue, errors: errorBuffer };
}
