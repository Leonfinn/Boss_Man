import { loadMasterKey } from "./crypto.js";
import { openPglite, openPostgres } from "./db/client.js";
import { buildApp } from "./app.js";
import { providerLiveValidator } from "./services/secrets.js";

const env = process.env;
const master = loadMasterKey(env);
const { db, close } = env.DATABASE_URL ? await openPostgres(env.DATABASE_URL) : await openPglite(env.BOSSMAN_PGLITE_DIR ?? "./data/pglite");

const { app } = await buildApp({
  db,
  master,
  liveValidator: providerLiveValidator,
  secureCookies: env.BOSSMAN_INSECURE_COOKIES !== "1",
  logger: true,
});

const shutdown = async () => {
  await app.close();
  await close();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

await app.listen({ host: env.HOST ?? "0.0.0.0", port: Number(env.PORT ?? 3100) });
