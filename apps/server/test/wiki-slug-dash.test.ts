import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { and, asc, eq, sql } from "drizzle-orm";
import { openPglite } from "../src/db/client.js";
import { activity, companies, wikiPages, wikiRevisions } from "../src/db/schema.js";
import { normalSlug, pageSlug, slugify, wikiService } from "../src/services/wiki.js";

// BOS-1324: a long title made a slug ending in "-", and a write to it landed on the slug without the "-"
// (overwriting another page) while a read showed the "-" page. DR-058 ended up as two pages.

// Found by name, not number: the merge gate renumbers the migration when main takes its number first.
const drizzleDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../drizzle");
const migrationFile = readdirSync(drizzleDir).find((f) => /^\d{4}_trim_wiki_slug_dash\.sql$/.test(f));
if (!migrationFile) throw new Error("the trim_wiki_slug_dash migration is missing from drizzle/");
const migration = path.join(drizzleDir, migrationFile);
const by = { agentId: null, runId: null };

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

async function setup() {
  const o = await openPglite();
  close = o.close;
  const [co] = await o.db.insert(companies).values({ name: "Wiki Co" }).returning();
  return { db: o.db, wiki: wikiService(o.db), companyId: co!.id };
}

describe("slugify on a long title", () => {
  // 79 letters then a space: the cut at 80 lands just after the "-" the space became.
  const long = `${"a".repeat(79)} bcd`;

  it("never ends in -", () => {
    expect(slugify(long)).toBe("a".repeat(79));
    expect(pageSlug("Decisions", long)).toBe(`decisions/${"a".repeat(79)}`);
    expect(slugify("DR-058: merge gate waits for GitHub CI to pass on the branch head before it merges anything at all")).not.toMatch(/-$/);
  });

  it("is unchanged by a second pass, so a stored slug normalises to itself", () => {
    for (const t of [long, "Hello, world!", "  --x--  ", "ünïcode café"]) expect(slugify(slugify(t))).toBe(slugify(t));
    expect(normalSlug(" Research/Agent-landscape- ")).toBe("research/agent-landscape");
  });
});

describe('read and write agree on which page "x-" is', () => {
  it("with no page yet, write x- makes x and read x- finds it", async () => {
    const { wiki, companyId } = await setup();
    const w = await wiki.write(companyId, { slug: "x-", title: "X", body: "one", ...by });
    expect(w.page.slug).toBe("x");
    expect((await wiki.get(companyId, "x-")).id).toBe(w.page.id);
  });

  it("with only x, write x- updates x and read x- shows it", async () => {
    const { wiki, companyId } = await setup();
    const x = await wiki.write(companyId, { slug: "x", title: "X", body: "one", ...by });
    const w = await wiki.write(companyId, { slug: "x-", title: "X", body: "one two", ...by });
    expect(w.page.id).toBe(x.page.id);
    expect((await wiki.get(companyId, "x-")).body).toBe("one two");
  });

  it("with an old x- page beside x, every action on x- reaches the x- page and leaves x alone", async () => {
    const { db, wiki, companyId } = await setup();
    const x = await wiki.write(companyId, { slug: "x", title: "Real", body: "real text", ...by });
    // A page saved before the fix, at a slug that now normalises elsewhere.
    const [dash] = await db.insert(wikiPages).values({ companyId, slug: "x-", title: "Dash", body: "# Log\n\ndash text" }).returning();
    await db.insert(wikiRevisions).values({ pageId: dash!.id, title: "Dash", body: "# Log\n\ndash text" });

    expect((await wiki.get(companyId, "x-")).id).toBe(dash!.id);
    const w = await wiki.write(companyId, { slug: "x-", title: "Dash", body: "# Log\n\ndash text, more", ...by });
    expect(w.page.id).toBe(dash!.id);
    const a = await wiki.append(companyId, { slug: "x-", entry: "- entry", heading: "Log", ...by });
    expect(a.page.id).toBe(dash!.id);
    const h = await wiki.history(companyId, "x-");
    expect(h.slug).toBe("x-");
    const oldest = h.revisions.at(-1)!;
    const r = await wiki.restore(companyId, { slug: "x-", revisionId: oldest.id, isCeo: true, ...by });
    expect(r.page.id).toBe(dash!.id);
    expect((await wiki.get(companyId, "x-")).body).toBe("# Log\n\ndash text");

    const real = await wiki.get(companyId, "x");
    expect(real.id).toBe(x.page.id);
    expect(real.body).toBe("real text");
    await wiki.remove(companyId, "x-");
    expect((await wiki.get(companyId, "x")).id).toBe(x.page.id);
  });
});

describe("migration trim_wiki_slug_dash: pages whose slug ends in -", () => {
  const run = async (db: Awaited<ReturnType<typeof setup>>["db"]) => {
    for (const s of readFileSync(migration, "utf8").split("--> statement-breakpoint")) await db.execute(sql.raw(s));
  };

  it("moves a lone - page, merges a pair keeping the newer text and every version, and logs each", async () => {
    const { db, wiki, companyId } = await setup();
    const t = (m: number) => new Date(Date.UTC(2026, 10, 12, 10, m));
    const page = async (slug: string, body: string, at: Date, ticketId: string | null = null) => {
      const [p] = await db.insert(wikiPages).values({ companyId, slug, title: slug, body, updatedAt: at, ticketId }).returning();
      await db.insert(wikiRevisions).values({ pageId: p!.id, title: slug, body, createdAt: at });
      return p!;
    };
    // DR-058's case: the real page is newer (it was restored after the bad write), the "-" one older.
    const real = await page("decisions/dr-058-gate", "real", t(5));
    const dup = await page("decisions/dr-058-gate-", "dup", t(1));
    // The other way round: the "-" page holds the newer text.
    const older = await page("notes", "old notes", t(1));
    const newer = await page("notes-", "new notes", t(5));
    const lone = await page("solo-", "solo", t(1));
    const inFolder = await page("research-/paper", "paper", t(1));
    const untouched = await page("plain", "plain", t(1));

    await run(db);

    const rows = await db.select().from(wikiPages).where(eq(wikiPages.companyId, companyId)).orderBy(asc(wikiPages.slug));
    expect(rows.map((r) => r.slug)).toEqual(["decisions/dr-058-gate", "notes", "plain", "research/paper", "solo"]);
    const of = (slug: string) => rows.find((r) => r.slug === slug)!;
    expect(of("decisions/dr-058-gate")).toMatchObject({ id: real.id, body: "real" });
    expect(of("notes")).toMatchObject({ id: older.id, body: "new notes" });
    expect(of("solo")).toMatchObject({ id: lone.id, body: "solo" });
    expect(of("research/paper").id).toBe(inFolder.id);
    expect(of("plain").id).toBe(untouched.id);

    // Nothing lost: the dropped page's versions are in the kept page's history.
    const revs = async (id: string) => (await db.select().from(wikiRevisions).where(eq(wikiRevisions.pageId, id)).orderBy(asc(wikiRevisions.createdAt))).map((r) => r.body);
    expect(await revs(real.id)).toEqual(["dup", "real"]);
    expect(await revs(older.id)).toEqual(["old notes", "new notes"]);
    expect(await db.select().from(wikiPages).where(eq(wikiPages.id, dup.id))).toEqual([]);
    expect(await db.select().from(wikiPages).where(eq(wikiPages.id, newer.id))).toEqual([]);

    const log = await db.select().from(activity).where(and(eq(activity.companyId, companyId), eq(activity.kind, "wiki_slug_fix")));
    expect(log.map((l) => (l.detail as { from: string }).from).sort()).toEqual(["decisions/dr-058-gate-", "notes-", "research-/paper", "solo-"]);
    expect(log.find((l) => (l.detail as { from: string }).from === "notes-")!.summary).toContain("its text was newer");

    // And the tools now reach the merged page by either slug.
    expect((await wiki.get(companyId, "notes-")).id).toBe(older.id);
  });
});
