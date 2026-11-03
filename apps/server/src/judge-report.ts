// `tsx src/judge-report.ts [--days N | --from YYYY-MM-DD --to YYYY-MM-DD] [--company ID] [--json]`
// Read-only: one SELECT over answered permission cards that carry a judge reading (BOS-379). Needs DATABASE_URL.
import { openPostgres } from "./db/client.js";
import { formatReport, judgeReport } from "./services/judge-report.js";

const args = process.argv.slice(2);
const opt = (n: string) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
const url = process.env.DATABASE_URL;
if (!url) { console.error("DATABASE_URL is required."); process.exit(1); }
const to = opt("to") ? new Date(`${opt("to")}T00:00:00Z`) : new Date();
const from = opt("from") ? new Date(`${opt("from")}T00:00:00Z`) : new Date(to.getTime() - Number(opt("days") ?? 14) * 86_400_000);
if (Number.isNaN(+from) || Number.isNaN(+to)) { console.error("Bad date."); process.exit(1); }
// openPostgres still checks that the schema is up to date (assertMigrated) but, with migrate:false, never changes it.
const { db, close } = await openPostgres(url, { migrate: false });
try {
  const r = await judgeReport(db, { from, to, companyId: opt("company") });
  console.log(args.includes("--json") ? JSON.stringify(r, null, 2) : formatReport(r));
} finally { await close(); }
