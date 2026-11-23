// `node dist/migrate.js`: applies pending migrations under the migrate lock, then exits (non-zero on failure).
import path from "node:path";
import { fileURLToPath } from "node:url";
import { databaseUrl } from "./database-url.js";
import { runMigrations } from "./db/migrate-lib.js";

const url = databaseUrl(process.env);
if (!url) {
  console.error("DATABASE_URL is required.");
  process.exit(1);
}
// src/ and dist/ both sit beside drizzle/.
const folder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../drizzle");
try {
  await runMigrations(url, { folder, lockTimeoutMs: Number(process.env.BOSSMAN_MIGRATE_LOCK_TIMEOUT_MS ?? 60_000) });
  console.log("Migrations are up to date.");
} catch (err) {
  console.error(`Migration failed: ${(err as Error).message}`);
  process.exit(1);
}
