// BOS-198: migration 0075 turns every "marked" review cell into the agent it meant, losing nothing.
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { DEFAULT_REVIEW_POLICY, type ReviewPolicy } from "@boss-man/shared";
import { openPglite } from "../src/db/client.js";
import { agents, companies, projects } from "../src/db/schema.js";

const SQL = readFileSync(new URL("../drizzle/0075_reviewer_marks_to_policy.sql", import.meta.url), "utf8");

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

describe("migration 0075: reviewer marks into Settings > Reviews", () => {
  it("names the marked agent, a list when several, the CEO when none; leaves everything else alone", async () => {
    const opened = await openPglite();
    close = opened.close;
    const { db } = opened;
    const policy = (kinds: NonNullable<ReviewPolicy["medium"]["kinds"]>): ReviewPolicy => ({ ...structuredClone(DEFAULT_REVIEW_POLICY), medium: { ...DEFAULT_REVIEW_POLICY.medium, kinds }, high: { ...DEFAULT_REVIEW_POLICY.high, kinds: { ...kinds, adversarial: "marked" } } });
    const [co] = await db.insert(companies).values({ name: "Co", reviewPolicy: policy({ security: "marked", infra: "marked" }) }).returning();
    const [sec] = await db.insert(agents).values({ companyId: co!.id, name: "Sec", role: "worker", agentKind: "claude", reviewKind: "security" }).returning();
    // Two infra marks (an old import could do that), one paused; a retired one never counted.
    const [i1] = await db.insert(agents).values({ companyId: co!.id, name: "I1", role: "worker", agentKind: "claude", reviewKind: "infra", paused: true, createdAt: new Date(Date.now() - 2000) }).returning();
    const [i2] = await db.insert(agents).values({ companyId: co!.id, name: "I2", role: "worker", agentKind: "claude", reviewKind: "infra" }).returning();
    await db.insert(agents).values({ companyId: co!.id, name: "Old", role: "worker", agentKind: "claude", reviewKind: "adversarial", retiredAt: new Date() });
    const [proj] = await db.insert(projects).values({ companyId: co!.id, name: "P", reviewPolicy: policy({ security: "marked", infra: i2!.id }) }).returning();
    const [plain] = await db.insert(projects).values({ companyId: co!.id, name: "Q" }).returning();
    // Another company's marks never leak across.
    const [other] = await db.insert(companies).values({ name: "Other", reviewPolicy: policy({ security: "marked" }) }).returning();

    await db.execute(sql.raw(SQL));
    const pol = async (id: string) => (await db.select().from(companies).where(eq(companies.id, id)))[0]!.reviewPolicy;
    const c = await pol(co!.id);
    expect(c.medium.kinds).toEqual({ security: sec!.id, infra: [i1!.id, i2!.id] });
    expect(c.high.kinds).toEqual({ security: sec!.id, infra: [i1!.id, i2!.id], adversarial: "ceo" });
    expect(c.low).toEqual(DEFAULT_REVIEW_POLICY.low);
    const p = (await db.select().from(projects).where(eq(projects.id, proj!.id)))[0]!.reviewPolicy!;
    expect(p.medium.kinds).toEqual({ security: sec!.id, infra: i2!.id });
    expect((await db.select().from(projects).where(eq(projects.id, plain!.id)))[0]!.reviewPolicy).toBeNull();
    expect((await pol(other!.id)).medium.kinds).toEqual({ security: "ceo" });

    // Running it again changes nothing.
    await db.execute(sql.raw(SQL));
    expect(await pol(co!.id)).toEqual(c);
  });
});
