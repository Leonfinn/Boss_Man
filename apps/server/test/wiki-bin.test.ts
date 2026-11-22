import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { strFromU8, unzipSync } from "fflate";
import { openPglite } from "../src/db/client.js";
import { activity, companies, wikiPages, wikiRevisions } from "../src/db/schema.js";
import { BIN_DAYS, wikiService } from "../src/services/wiki.js";
import { exportCompany } from "../src/services/company-export.js";

// BOS-2197: deleting a wiki page hides it for 30 days (Deleted pages list, Restore) instead of erasing it.

const by = { agentId: null, runId: null };
const DAY = 86_400_000;

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

async function setup() {
  const o = await openPglite();
  close = o.close;
  const [co] = await o.db.insert(companies).values({ name: "Wiki Co" }).returning();
  const wiki = wikiService(o.db);
  const companyId = co!.id;
  await wiki.write(companyId, { slug: "research/spec", folder: "Research", title: "Spec", body: "# Spec\n\nuniquewordzebra first version", ...by });
  await wiki.write(companyId, { slug: "research/spec", title: "Spec", body: "# Spec\n\nuniquewordzebra second version", replace: true, ...by });
  return { db: o.db, wiki, companyId };
}

describe("deleting a wiki page", () => {
  it("keeps the page row and its versions, and writes an activity line", async () => {
    const { db, wiki, companyId } = await setup();
    await wiki.remove(companyId, "research/spec");
    const [row] = await db.select().from(wikiPages).where(eq(wikiPages.slug, "research/spec"));
    expect(row?.deletedAt).toBeInstanceOf(Date);
    expect(await db.select().from(wikiRevisions).where(eq(wikiRevisions.pageId, row!.id))).toHaveLength(2);
    const lines = await db.select().from(activity).where(eq(activity.companyId, companyId));
    expect(lines.some((a) => a.summary.includes("Deleted wiki page"))).toBe(true);
  });

  it("is gone from list, search, links and agent reads (not found)", async () => {
    const { wiki, companyId } = await setup();
    await wiki.write(companyId, { slug: "other", title: "Other", body: "see [[research/spec]]", ...by });
    await wiki.remove(companyId, "research/spec");
    expect((await wiki.list(companyId)).map((p) => p.slug)).toEqual(["other"]);
    expect(await wiki.list(companyId, "uniquewordzebra")).toEqual([]);
    expect(await wiki.search(companyId, "uniquewordzebra")).toEqual([]);
    expect((await wiki.links(companyId, "other", "see [[research/spec]]")).links).toEqual([]);
    await expect(wiki.get(companyId, "research/spec")).rejects.toMatchObject({ status: 404 });
    await expect(wiki.history(companyId, "research/spec")).rejects.toMatchObject({ status: 404 });
  });

  it("shows the owner a deleted stub with who and when, and the Deleted pages list", async () => {
    const { wiki, companyId } = await setup();
    await wiki.remove(companyId, "research/spec");
    const stub = await wiki.deletedStub(companyId, "research/spec");
    expect(stub).toMatchObject({ deleted: true, slug: "research/spec", folder: "Research", title: "Spec", deletedBy: null });
    expect(await wiki.deletedStub(companyId, "no-such")).toBeNull();
    const list = await wiki.listDeleted(companyId);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ slug: "research/spec", title: "Spec", folder: "Research" });
  });

  it("holds the slug: writing or appending to it is refused and says why", async () => {
    const { wiki, companyId } = await setup();
    await wiki.remove(companyId, "research/spec");
    await expect(wiki.write(companyId, { slug: "research/spec", title: "Spec", body: "new", ...by })).rejects.toMatchObject({ status: 409, message: expect.stringContaining("Deleted pages") });
    await expect(wiki.append(companyId, { slug: "research/spec", entry: "more", ...by })).rejects.toMatchObject({ status: 409, message: expect.stringContaining("Deleted pages") });
    // A new page whose address a deleted page holds is refused too, not duplicated.
    await expect(wiki.write(companyId, { folder: "Research", title: "Spec", body: "new", ...by })).rejects.toMatchObject({ status: 409 });
  });

  it("is restored with its body, folder and versions, and is searchable again", async () => {
    const { wiki, companyId } = await setup();
    await wiki.remove(companyId, "research/spec");
    await wiki.restoreDeleted(companyId, "research/spec");
    const p = await wiki.get(companyId, "research/spec");
    expect(p.body).toContain("second version");
    expect(p.folder).toBe("Research");
    expect(p.revisionCount).toBe(2);
    expect((await wiki.list(companyId, "uniquewordzebra")).map((x) => x.slug)).toEqual(["research/spec"]);
    expect(await wiki.listDeleted(companyId)).toEqual([]);
    await expect(wiki.restoreDeleted(companyId, "research/spec")).rejects.toMatchObject({ status: 404 });
  });

  it("is left out of a company export", async () => {
    const { db, wiki, companyId } = await setup();
    await wiki.remove(companyId, "research/spec");
    const out = await exportCompany(db, companyId, { wiki: true, tickets: "none" });
    const files = unzipSync(out!.bytes);
    expect(Object.keys(files).filter((f) => f.startsWith("wiki/"))).toEqual([]);
    expect(Object.values(files).map((f) => strFromU8(f)).join("\n")).not.toContain("uniquewordzebra");
  });
});

describe("the daily purge", () => {
  it("removes only pages deleted more than 30 days ago, with their versions", async () => {
    const { db, wiki, companyId } = await setup();
    await wiki.write(companyId, { slug: "recent", title: "Recent", body: "r", ...by });
    await wiki.write(companyId, { slug: "live", title: "Live", body: "l", ...by });
    await wiki.remove(companyId, "research/spec");
    await wiki.remove(companyId, "recent");
    const now = new Date();
    // The spec was deleted 31 days ago, "recent" 29 days ago.
    await db.update(wikiPages).set({ deletedAt: new Date(now.getTime() - (BIN_DAYS + 1) * DAY) }).where(eq(wikiPages.slug, "research/spec"));
    await db.update(wikiPages).set({ deletedAt: new Date(now.getTime() - (BIN_DAYS - 1) * DAY) }).where(eq(wikiPages.slug, "recent"));
    expect(await wiki.purgeDeleted(now)).toBe(1);
    const left = (await db.select().from(wikiPages)).map((p) => p.slug).sort();
    expect(left).toEqual(["live", "recent"]);
    expect(await db.select().from(wikiRevisions)).toHaveLength(2); // recent + live; the spec's two versions went with it
  });
});
