import { loadMasterKey } from "./crypto.js";
import { openPglite, openPostgres } from "./db/client.js";
import { buildApp } from "./app.js";
import { providerLiveValidator } from "./services/secrets.js";

const env = process.env;
const master = loadMasterKey(env);
const { db, close } = env.DATABASE_URL ? await openPostgres(env.DATABASE_URL) : await openPglite(env.BOSSMAN_PGLITE_DIR ?? "./data/pglite");

const { app, scheduler, sweeps, notes, feedback } = await buildApp({
  db,
  master,
  liveValidator: providerLiveValidator,
  secureCookies: env.BOSSMAN_INSECURE_COOKIES !== "1",
  logger: true,
  webDir: env.BOSSMAN_WEB_DIR,
  sweepLimits: {
    ...(env.BOSSMAN_STALE_BLOCKER_HOURS ? { staleAfterMs: Number(env.BOSSMAN_STALE_BLOCKER_HOURS) * 3_600_000 } : {}),
    ...(env.BOSSMAN_STALL_MINUTES ? { stallAfterMs: Number(env.BOSSMAN_STALL_MINUTES) * 60_000 } : {}),
  },
});

// Scheduling passes; run ends and new wakes also prompt one.
const tick = setInterval(() => void scheduler.tick().catch((err) => app.log.error({ err }, "scheduler tick failed")), Number(env.BOSSMAN_TICK_MS ?? 5000));
// New decisions reach the owner's notifications (R44).
const notify = setInterval(() => void notes.syncDecisions().catch((err) => app.log.error({ err }, "notification sync failed")), Number(env.BOSSMAN_NOTIFY_MS ?? 5000));
// Features follow the tickets that deliver them.
const featureSync = setInterval(() => void feedback.syncStatuses().catch((err) => app.log.error({ err }, "feature status sync failed")), Number(env.BOSSMAN_FEATURE_SYNC_MS ?? 30_000));
// Stale-blocker and stalled-run sweeps.
const sweep = setInterval(() => void sweeps.run().catch((err) => app.log.error({ err }, "sweep failed")), Number(env.BOSSMAN_SWEEP_MS ?? 60_000));

const shutdown = async () => {
  clearInterval(tick);
  clearInterval(sweep);
  clearInterval(featureSync);
  clearInterval(notify);
  await app.close();
  await close();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

await app.listen({ host: env.HOST ?? "0.0.0.0", port: Number(env.PORT ?? 3100) });
