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
  log: (m) => console.warn(m),
});

const { app, briefUpkeep, scheduler, sweeps, notes, feedback, review, semantic, selfDeploy, maintenance, runners } = await buildApp({
  db,
  master,
  liveValidator: providerLiveValidator,
  secureCookies: env.BOSSMAN_INSECURE_COOKIES !== "1",
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
  ],
  (err, name) => app.log.error({ err }, `${name} failed`),
);
// Background work follows leadership; runner sockets are closed by buildApp on demotion.
leader.onPromote(() => bg.startBackground());
leader.onDemote(() => bg.stopBackground());
// Host signals only (no HTTP endpoint changes the role): SIGUSR1 = hand over, SIGUSR2 = take over.
process.on("SIGUSR1", () => void leader.demote());
process.on("SIGUSR2", () => void leader.promote());

const shutdown = async () => {
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
  const portal = await buildPortalApp({ feedback, webDir: env.BOSSMAN_WEB_DIR, secureCookies: env.BOSSMAN_INSECURE_COOKIES !== "1", logger: true });
  await portal.listen({ host: env.HOST ?? "0.0.0.0", port: Number(env.BOSSMAN_PORTAL_PORT) });
}
