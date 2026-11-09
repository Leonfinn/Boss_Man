// BOS-957: migration 0133 turns existing open features on the portal once, unless they are sensitive or read as security
// work. The test reads the UPDATE straight out of the committed migration and runs it against real rows, so a typo in the
// SQL (or a rule that disagrees with the app's) fails here. It only turns features ON and never touches a sensitive mark.
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { companies, features, featureAreas } from "../src/db/schema.js";

const migrationPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../drizzle/0133_fuzzy_husk.sql");

/** The UPDATE on features from the migration file, on its own, ready to run. */
function featuresUpdate(): string {
  const body = readFileSync(migrationPath, "utf8");
  const start = body.indexOf('UPDATE "features"');
  const end = body.indexOf("--> statement-breakpoint", start);
  if (start < 0) throw new Error("0133_fuzzy_husk.sql has no features UPDATE statement");
  return (end < 0 ? body.slice(start) : body.slice(start, end)).trim();
}

let db: Awaited<ReturnType<typeof openPglite>>["db"];
let close: () => Promise<void>;
let companyId: string;

beforeEach(async () => {
  ({ db, close } = await openPglite());
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false });
  await built.app.close();
  companyId = (await db.insert(companies).values({ name: "Co" }).returning())[0]!.id;
});
afterEach(async () => {
  await close();
});

async function seed(rows: Array<{ title: string; description?: string; status?: "idea" | "considering" | "planned" | "in_progress" | "released" | "declined"; keepOff?: boolean; areaId?: string }>) {
  const area = (await db.insert(featureAreas).values({ companyId, name: "Security" }).returning())[0]!;
  await db.insert(features).values(rows.map((r) => ({ companyId, title: r.title, description: r.description ?? null, status: r.status ?? "idea", keepOffPortal: r.keepOff ?? false, areaId: r.areaId === "security" ? area.id : null })));
  await db.execute(sql.raw(featuresUpdate()));
  const out = await db.select({ title: features.title, portalVisible: features.portalVisible }).from(features).where(eq(features.companyId, companyId));
  return new Map(out.map((r) => [r.title, r.portalVisible]));
}

describe("migration 0133 puts existing open features on the portal by the default (BOS-957)", () => {
  it("turns on ordinary open features and leaves security work, sensitive marks and closed features off", async () => {
    const on = await seed([
      { title: "Dark mode", description: "A dark theme." },
      { title: "CSV export", status: "planned" },
      { title: "Rotate API keys", description: "Rotate the signing secrets." },
      { title: "Lock it down", description: "Manage credentials for connected apps." },
      { title: "Settings tidy-up", areaId: "security" },
      { title: "Private thing", keepOff: true },
      { title: "Sign-in", status: "released" },
      { title: "Not this", status: "declined" },
    ]);
    expect(on.get("Dark mode")).toBe(true);
    expect(on.get("CSV export")).toBe(true);
    expect(on.get("Rotate API keys")).toBe(false);
    expect(on.get("Lock it down")).toBe(false);
    expect(on.get("Settings tidy-up")).toBe(false);
    expect(on.get("Private thing")).toBe(false);
    expect(on.get("Sign-in")).toBe(false);
    expect(on.get("Not this")).toBe(false);
  });
});
