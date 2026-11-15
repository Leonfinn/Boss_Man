import { loadMasterKey } from "./crypto.js";
import { openPglite, openPostgres } from "./db/client.js";
import { buildApp } from "./app.js";
import { createLeader } from "./leader.js";
import { createBackground } from "./background.js";
import { buildPortalApp } from "./portal.js";
import { parseClientHeader, parseTrustedProxies } from "./portal-ip.js";
import { failureSignaturesDays, pruneFailureSignatures, pruneRunnerEvents, runnerEventsDays } from "./services/housekeeping.js";
import { providerLiveValidator } from "./services/secrets.js";
import { checkLimitReconciler } from "./services/check-limit.js";
import { checkQueue } from "./services/check-queue.js";
import { getHold } from "./services/maintenance.js";

const env = process.env;
const master = loadMasterKey(env);
// BOSSMAN_MIGRATE_ON_START=0: a separate step (node dist/migrate.js) migrates; this server only checks the database is current.
const { db, close } = env.DATABASE_URL ? await openPostgres(env.DATABASE_URL, { migrate: env.BOSSMAN_MIGRATE_ON_START !== "0" }) : await openPglite(env.BOSSMAN_PGLITE_DIR ?? "./data/pglite");

// Who is in charge (leader.ts). BOSSMAN_LEADER_LOCK=0 turns the lock off; PGlite has none. Both mean "always the leader".
const leader = createLeader({
  url: env.DATABASE_URL,
  enabled: env.BOSSMAN_LEADER_LOCK !== "0",
  role: env.BOSSMAN_ROLE === "standby" ? "standby" : "auto",
  // Heartbeats in a row with no reply before stepping down (BOS-432). 1 = the old step-down-at-once behaviour.
  maxMisses: Number(env.BOSSMAN_LEADER_MISSES) >= 1 ? Number(env.BOSSMAN_LEADER_MISSES) : 2,
  log: (m) => console.warn(m),
});

const trustedProxies = (env.BOSSMAN_TRUSTED_PROXIES ?? "").split(",").map((s) => s.trim()).filter(Boolean);

const { app, launcher, memory, serverHealth, checks, runnerWatch, briefUpkeep, retro, scheduler, sweeps, watchdog, alerts, notes, feedback, review, semantic, selfDeploy, deployWait, maintenance, runners, refreshSyntheticQuota, deploys } = await buildApp({
  db,
  master,
  liveValidator: providerLiveValidator,
  // Per request: Secure over https through the trusted proxy, plain http on the LAN still logs in. With a trusted proxy set this wins over BOSSMAN_INSECURE_COOKIES, so leaving that flag in place is harmless.
  secureCookies: trustedProxies.length ? "auto" : env.BOSSMAN_INSECURE_COOKIES === "1" ? false : true,
  trustedProxies,
  leader,
  // DR-049 point 1: an agent run starts only when its runner has proven the fence and the network guard (or the owner chose otherwise).
  requireRunnerProof: true,
  logger: true,
  webDir: env.BOSSMAN_WEB_DIR,
  deployerDir: env.BOSSMAN_DEPLOYER_DIR,
  portalUrl: env.BOSSMAN_PORTAL_URL,
  drainMinutes: env.BOSSMAN_DRAIN_MINUTES ? Number(env.BOSSMAN_DRAIN_MINUTES) : undefined,
  // The runner launcher (R55): starts each company's runner, so no tokens are copied by hand.
  launcher: env.BOSSMAN_LAUNCHER === "1" ? { url: env.BOSSMAN_LAUNCHER_URL ?? "http://launcher:3105", keyFile: env.BOSSMAN_LAUNCHER_KEY_FILE ?? "/run/launcher/key" } : undefined,
  sweepLimits: {
    ...(env.BOSSMAN_STALE_BLOCKER_HOURS ? { staleAfterMs: Number(env.BOSSMAN_STALE_BLOCKER_HOURS) * 3_600_000 } : {}),
    ...(env.BOSSMAN_RESUME_MERGES_MAX && Number(env.BOSSMAN_RESUME_MERGES_MAX) > 0 ? { resumeRestartsAtOnce: Number(env.BOSSMAN_RESUME_MERGES_MAX) } : {}),
    ...(env.BOSSMAN_STALL_MINUTES ? { stallAfterMs: Number(env.BOSSMAN_STALL_MINUTES) * 60_000 } : {}),
  },
});

const checkQueueSvc = checkQueue(db);
const checkLimit = checkLimitReconciler({
  slots: () => checkQueueSvc.slots(),
  launch: launcher,
  holdActive: async () => !!(await getHold(db)),
  startDrain: () => maintenance.start({ kind: "settings" }),
});
const bg = createBackground(
  [
    // Scheduling passes; run ends and new wakes also prompt one.
    { name: "scheduler tick", everyMs: Number(env.BOSSMAN_TICK_MS ?? 5000), run: () => scheduler.tick() },
    // Watchers' reports, scheduled checks that are due and quota notices (BOS-414). Watch intervals are in
    // minutes and schedule_check's minimum is 5 minutes, so 30 s is plenty.
    { name: "watch and monitor", everyMs: Number(env.BOSSMAN_SLOW_MS ?? 30_000), run: () => scheduler.slow() },
    // New decisions reach the owner's notifications (R44).
    { name: "notification sync", everyMs: Number(env.BOSSMAN_NOTIFY_MS ?? 5000), run: () => notes.syncDecisions() },
    // After a server takes charge: restart approved, unmerged merges (DR-026). Gives up after 30 minutes; the 66-minute merge sweep is the net after that. // leader-only
    { name: "resume merges", everyMs: Number(env.BOSSMAN_RESUME_MERGES_MS ?? 10_000), run: async () => {
      if (!resumeMergesSince) return;
      const r = await sweeps.resumeMergesOnPromotion(resumeMergesSince);
      // Merges held back by the restart cap (BOS-1371) keep being asked for, up to 6 hours; other waits give up after 30 minutes.
      const capped = "capped" in r && !!r.capped;
      const age = Date.now() - resumeMergesSince.getTime();
      if (!r.waiting || age > (capped ? 6 * 3_600_000 : 30 * 60_000)) {
        resumeMergesSince = null;
        sweeps.releaseHeldMerges();
      }
    } },
    // Stale-blocker, stalled-run and missed-work sweeps.
    { name: "sweep", everyMs: Number(env.BOSSMAN_SWEEP_MS ?? 60_000), run: () => sweeps.run() },
    // Deploy tag moves (DR-033) that a restart or a leader change cut off: picked up again; the runner's lease makes a repeat harmless. // leader-only
    { name: "deploy tags", everyMs: Number(env.BOSSMAN_DEPLOY_TAGS_MS ?? 60_000), run: () => deploys.resumeTags() },
    // The safety net for cards closed outside the decisions service: a feed read never writes (BOS-413).
    { name: "notification read sweep", everyMs: Number(env.BOSSMAN_NOTIFY_SWEEP_MS ?? 60_000), run: async () => { await notes.markAnsweredRead(); await notes.clearSettledPushes(); } },
    // The Scrum Master watchdog's rule checks (BOS-58): no model; wakes the Scrum Master only when a rule trips. Off per company until the owner switches it on.
    { name: "watchdog", everyMs: Number(env.BOSSMAN_WATCHDOG_MS ?? 5 * 60_000), run: () => watchdog.run() },
    // Workflow retros (docs/19): wakes the retro agent every 20 finished tickets or 7 days, whichever comes first. No model here.
    { name: "retro", everyMs: Number(env.BOSSMAN_RETRO_MS ?? 15 * 60_000), run: () => retro.sweep() },
    // Server health (BOS-640): rss against the memory the server may use, and freezes in the last 10 minutes; raises the memory card (CEO) and the freeze card (owner). // leader-only
    { name: "server health", everyMs: Number(env.BOSSMAN_SERVER_HEALTH_MS ?? 60_000), run: async () => { await serverHealth.check(); } },
    // Boss Man's own alerts that sat on the Scrum Master or the CEO past the time limit move up a rung (BOS-64).
    { name: "alert ladder", everyMs: Number(env.BOSSMAN_ALERT_LADDER_MS ?? 60_000), run: () => alerts.sweep() },
    // Pull requests waiting on the git host: merged there, or mergeable now (R59).
    { name: "pull request sync", everyMs: Number(env.BOSSMAN_PR_SYNC_MS ?? 120_000), run: () => review.syncPullRequests() },
    // Project briefs whose branch moved on the git host, merges made outside Boss Man included.
    { name: "brief upkeep", everyMs: Number(env.BOSSMAN_BRIEF_UPKEEP_MS ?? 30 * 60_000), run: briefUpkeep },
    // What the host deployer reports: raises "Deploy?" when main moves and tells the owner how a deploy went. // leader-only
    // The sync itself skips the pass when the deployer's files haven't changed (BOS-414), so polling this often costs a stat.
    { name: "self-deploy sync", everyMs: Number(env.BOSSMAN_SELF_DEPLOY_MS ?? 30_000), run: () => selfDeploy.sync() },
    // The runner update drain: starts when update-runner.sh asks, swaps each runner as its company goes idle, lifts the hold at the end. // leader-only
    // What each runner's add-ons say about their health (docs/12).
    { name: "add-on check", everyMs: Number(env.BOSSMAN_ADDON_CHECK_MS ?? 30 * 60_000), run: () => runners.checkAllAddons() },
    // BOS-1152: the runners follow "Checks at once" after any rebuild, swap or launcher restart, not only after the owner changes it. // leader-only
    { name: "check limit", everyMs: Number(env.BOSSMAN_CHECK_LIMIT_MS ?? 60_000), run: () => checkLimit.step() },
    { name: "drain step", everyMs: Number(env.BOSSMAN_DRAIN_MS ?? 5000), run: () => maintenance.step() },
    // A server update waiting for a quiet machine (BOS-420): sends it when quiet, asks the owner at 30 min, follows it through the standby window. // leader-only
    { name: "deploy wait", everyMs: Number(env.BOSSMAN_DEPLOY_WAIT_MS ?? 15_000), run: async () => { await deployWait.step(); } },
    // Every company's runner stays connected: tells that company's CEO and the owner when one does not, and checks a deploy brought them all back (BOS-467). // leader-only
    { name: "runner watch", everyMs: Number(env.BOSSMAN_RUNNER_WATCH_MS ?? 30_000), run: () => runnerWatch.step() },
    // The server-owned check queue (DR-003): starts due jobs and marks silent ones stuck, each with a recorded reason. Does nothing while check_queue_mode is legacy.
    { name: "check queue", everyMs: Number(env.BOSSMAN_CHECK_QUEUE_MS ?? 15_000), run: async () => { await checks.sweep(); } },
    // Synthetic's quota, cached and read at most every 5 minutes; warns the owner once per period at 80% and 100% (BOS-239).
    { name: "synthetic quota", everyMs: Number(env.BOSSMAN_SYNTHETIC_QUOTA_MS ?? 5 * 60_000), run: () => refreshSyntheticQuota() },
    // Housekeeping (BOS-416): deletes runner events older than BOSSMAN_RUNNER_EVENTS_DAYS (default 60), in small batches. // leader-only
    // First pass 15 min after start (clear of the start-up memory burst), then daily: this server restarts several times a day.
    { name: "runner events prune", everyMs: Number(env.BOSSMAN_RUNNER_EVENTS_PRUNE_MS ?? 24 * 3_600_000), firstAfterMs: Number(env.BOSSMAN_RUNNER_EVENTS_PRUNE_FIRST_MS ?? 15 * 60_000), run: () => pruneRunnerEvents(db, { days: runnerEventsDays(env.BOSSMAN_RUNNER_EVENTS_DAYS), stop: () => leader.role() !== "leader" }) },
    // Failure signatures are only read over the two-hour loop-guard window (loop-guards.ts, BOS-611); the rest go daily, in small batches. // leader-only
    { name: "failure signatures prune", everyMs: Number(env.BOSSMAN_FAILURE_SIGNATURES_PRUNE_MS ?? 24 * 3_600_000), firstAfterMs: Number(env.BOSSMAN_RUNNER_EVENTS_PRUNE_FIRST_MS ?? 15 * 60_000), run: () => pruneFailureSignatures(db, { days: failureSignaturesDays(env.BOSSMAN_FAILURE_SIGNATURES_DAYS), stop: () => leader.role() !== "leader" }) },
  ],
  (err, name) => app.log.error({ err }, `${name} failed`),
);
// Background work follows leadership; runner sockets are closed by buildApp on demotion.
// A server that takes charge holds no merges: it restarts every approved, unmerged one (DR-026). The loop below keeps asking until the update hold is off and the runners are connected.
// shortcut: real cross-request state, but lost on restart harmlessly: a restarted leader promotes again and resets this to now, then resumes merges from then (BOS-907).
let resumeMergesSince: Date | null = null;
leader.onPromote(() => {
  resumeMergesSince = new Date();
  bg.startBackground();
  void launcher.syncAll(); // once per promotion: runners that outlived a deploy get their allow list (git hosts) without a restart
});
leader.onDemote(() => bg.stopBackground());
// Host signals only (no HTTP endpoint changes the role): SIGUSR1 = hand over, SIGUSR2 = take over.
process.on("SIGUSR1", () => void leader.demote());
process.on("SIGUSR2", () => void leader.promote());

// Memory logging runs on every process, leader or standby (BOS-410), so it is not background work.
memory.start();

const shutdown = async () => {
  memory.stop();
  await leader.stop();
  await bg.stopBackground();
  await semantic.drain(); // embed queued wiki pages instead of dropping them
  await app.close();
  await close();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

await leader.start(); // a lone server leads before it can be asked anything else
await app.listen({ host: env.HOST ?? "0.0.0.0", port: Number(env.PORT ?? 3100) });

// The feedback portal on its own port, serving nothing else, so it can be shared without the owner's side.
if (env.BOSSMAN_PORTAL_PORT) {
  // The portal is never fronted by Serve (plain http), so its voter cookie is not Secure once the sidecar is in use.
  // BOSSMAN_PORTAL_TRUSTED_PROXY (BOS-1386): the reverse proxy's own address(es), so each visitor gets their own limit.
  const portalProxy = parseTrustedProxies(env.BOSSMAN_PORTAL_TRUSTED_PROXY);
  if (portalProxy.ignored.length) console.warn(`BOSSMAN_PORTAL_TRUSTED_PROXY: ignoring ${portalProxy.ignored.length} entr${portalProxy.ignored.length === 1 ? "y" : "ies"} that are not an address or CIDR (or are a /0): ${portalProxy.ignored.join(", ")}`);
  // BOSSMAN_PORTAL_CLIENT_HEADER: which header names the visitor; default X-Forwarded-For, cf-connecting-ip only for Cloudflare.
  const portalHeader = parseClientHeader(env.BOSSMAN_PORTAL_CLIENT_HEADER);
  if (portalHeader.bad) console.warn(`BOSSMAN_PORTAL_CLIENT_HEADER: "${portalHeader.bad}" is not x-forwarded-for or cf-connecting-ip, using x-forwarded-for`);
  const portal = await buildPortalApp({ feedback, webDir: env.BOSSMAN_WEB_DIR, secureCookies: env.BOSSMAN_INSECURE_COOKIES !== "1" && !trustedProxies.length, logger: true, trustedProxies: (env.BOSSMAN_PORTAL_TRUSTED_PROXY ?? "").split(/[\s,]+/).filter(Boolean), clientHeader: portalHeader.header });
  await portal.listen({ host: env.HOST ?? "0.0.0.0", port: Number(env.BOSSMAN_PORTAL_PORT) });
}
