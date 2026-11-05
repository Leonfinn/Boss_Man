import { loadMasterKey } from "./crypto.js";
import { openPglite, openPostgres } from "./db/client.js";
import { buildApp } from "./app.js";
import { createLeader } from "./leader.js";
import { createBackground } from "./background.js";
import { buildPortalApp } from "./portal.js";
import { providerLiveValidator } from "./services/secrets.js";

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

const { app, launcher, memory, briefUpkeep, retro, scheduler, sweeps, watchdog, alerts, notes, feedback, review, semantic, selfDeploy, maintenance, runners, refreshSyntheticQuota } = await buildApp({
  db,
  master,
  liveValidator: providerLiveValidator,
  // Per request: Secure over https through the trusted proxy, plain http on the LAN still logs in. With a trusted proxy set this wins over BOSSMAN_INSECURE_COOKIES, so leaving that flag in place is harmless.
  secureCookies: trustedProxies.length ? "auto" : env.BOSSMAN_INSECURE_COOKIES === "1" ? false : true,
  trustedProxies,
  leader,
  logger: true,
  webDir: env.BOSSMAN_WEB_DIR,
  deployerDir: env.BOSSMAN_DEPLOYER_DIR,
  portalUrl: env.BOSSMAN_PORTAL_URL,
  drainMinutes: env.BOSSMAN_DRAIN_MINUTES ? Number(env.BOSSMAN_DRAIN_MINUTES) : undefined,
  // The runner launcher (R55): starts each company's runner, so no tokens are copied by hand.
  launcher: env.BOSSMAN_LAUNCHER === "1" ? { url: env.BOSSMAN_LAUNCHER_URL ?? "http://launcher:3105", keyFile: env.BOSSMAN_LAUNCHER_KEY_FILE ?? "/run/launcher/key" } : undefined,
  sweepLimits: {
    ...(env.BOSSMAN_STALE_BLOCKER_HOURS ? { staleAfterMs: Number(env.BOSSMAN_STALE_BLOCKER_HOURS) * 3_600_000 } : {}),
    ...(env.BOSSMAN_STALL_MINUTES ? { stallAfterMs: Number(env.BOSSMAN_STALL_MINUTES) * 60_000 } : {}),
  },
});

const bg = createBackground(
  [
    // Scheduling passes; run ends and new wakes also prompt one.
    { name: "scheduler tick", everyMs: Number(env.BOSSMAN_TICK_MS ?? 5000), run: () => scheduler.tick() },
    // New decisions reach the owner's notifications (R44).
    { name: "notification sync", everyMs: Number(env.BOSSMAN_NOTIFY_MS ?? 5000), run: () => notes.syncDecisions() },
    // Stale-blocker, stalled-run and missed-work sweeps.
    { name: "sweep", everyMs: Number(env.BOSSMAN_SWEEP_MS ?? 60_000), run: () => sweeps.run() },
    // The Scrum Master watchdog's rule checks (BOS-58): no model; wakes the Scrum Master only when a rule trips. Off per company until the owner switches it on.
    { name: "watchdog", everyMs: Number(env.BOSSMAN_WATCHDOG_MS ?? 5 * 60_000), run: () => watchdog.run() },
    // Workflow retros (docs/19): wakes the retro agent every 20 finished tickets or 7 days, whichever comes first. No model here.
    { name: "retro", everyMs: Number(env.BOSSMAN_RETRO_MS ?? 15 * 60_000), run: () => retro.sweep() },
    // Boss Man's own alerts that sat on the Scrum Master or the CEO past the time limit move up a rung (BOS-64).
    { name: "alert ladder", everyMs: Number(env.BOSSMAN_ALERT_LADDER_MS ?? 60_000), run: () => alerts.sweep() },
    // Pull requests waiting on the git host: merged there, or mergeable now (R59).
    { name: "pull request sync", everyMs: Number(env.BOSSMAN_PR_SYNC_MS ?? 120_000), run: () => review.syncPullRequests() },
    // Project briefs whose branch moved on the git host, merges made outside Boss Man included.
    { name: "brief upkeep", everyMs: Number(env.BOSSMAN_BRIEF_UPKEEP_MS ?? 30 * 60_000), run: briefUpkeep },
    // What the host deployer reports: raises "Deploy?" when main moves and tells the owner how a deploy went. // leader-only
    { name: "self-deploy sync", everyMs: Number(env.BOSSMAN_SELF_DEPLOY_MS ?? 5000), run: () => selfDeploy.sync() },
    // The runner update drain: starts when update-runner.sh asks, swaps each runner as its company goes idle, lifts the hold at the end. // leader-only
    // What each runner's add-ons say about their health (docs/12).
    { name: "add-on check", everyMs: Number(env.BOSSMAN_ADDON_CHECK_MS ?? 30 * 60_000), run: () => runners.checkAllAddons() },
    { name: "drain step", everyMs: Number(env.BOSSMAN_DRAIN_MS ?? 5000), run: () => maintenance.step() },
    // Synthetic's quota, cached and read at most every 5 minutes; warns the owner once per period at 80% and 100% (BOS-239).
    { name: "synthetic quota", everyMs: Number(env.BOSSMAN_SYNTHETIC_QUOTA_MS ?? 5 * 60_000), run: () => refreshSyntheticQuota() },
  ],
  (err, name) => app.log.error({ err }, `${name} failed`),
);
// Background work follows leadership; runner sockets are closed by buildApp on demotion.
leader.onPromote(() => {
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
  const portal = await buildPortalApp({ feedback, webDir: env.BOSSMAN_WEB_DIR, secureCookies: env.BOSSMAN_INSECURE_COOKIES !== "1" && !trustedProxies.length, logger: true });
  await portal.listen({ host: env.HOST ?? "0.0.0.0", port: Number(env.BOSSMAN_PORTAL_PORT) });
}
