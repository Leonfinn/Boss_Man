import { loadMasterKey } from "./crypto.js";
import { openPglite, openPostgres } from "./db/client.js";
import { buildApp } from "./app.js";
import { providerLiveValidator } from "./services/secrets.js";

const env = process.env;
const master = loadMasterKey(env);
const { db, close } = env.DATABASE_URL ? await openPostgres(env.DATABASE_URL) : await openPglite(env.BOSSMAN_PGLITE_DIR ?? "./data/pglite");

const { app, scheduler, sweeps } = await buildApp({
  db,
  master,
  liveValidator: providerLiveValidator,
  secureCookies: env.BOSSMAN_INSECURE_COOKIES !== "1",
  logger: true,
  sweepLimits: {
    ...(env.BOSSMAN_STALE_BLOCKER_HOURS ? { staleAfterMs: Number(env.BOSSMAN_STALE_BLOCKER_HOURS) * 3_600_000 } : {}),
    ...(env.BOSSMAN_STALL_MINUTES ? { stallAfterMs: Number(env.BOSSMAN_STALL_MINUTES) * 60_000 } : {}),
  },
});

// Scheduling passes; run ends and new wakes also prompt one.
const tick = setInterval(() => void scheduler.tick().catch((err) => app.log.error({ err }, "scheduler tick failed")), Number(env.BOSSMAN_TICK_MS ?? 5000));
// Stale-blocker and stalled-run sweeps.
const sweep = setInterval(() => void sweeps.run().catch((err) => app.log.error({ err }, "sweep failed")), Number(env.BOSSMAN_SWEEP_MS ?? 60_000));

const shutdown = async () => {
  clearInterval(tick);
  clearInterval(sweep);
  await app.close();
  await close();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

await app.listen({ host: env.HOST ?? "0.0.0.0", port: Number(env.PORT ?? 3100) });
