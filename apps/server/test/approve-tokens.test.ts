// approve-tokens.ts (BOS-243): the two helpers that keep phone Approve links safe. Fixed clock, no sleeps.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { openPglite, type Db } from "../src/db/client.js";
import { approveTokens, companies, decisions, phoneActionHits } from "../src/db/schema.js";
import { revokeApproveTokens, sweepPhoneApprove } from "../src/services/approve-tokens.js";

const NOW = new Date("2026-11-02T12:00:00Z");
const DAY = 86_400_000;
const REVOKED_EARLIER = new Date("2026-11-02T09:00:00Z");
const USED_AT = new Date("2026-11-02T10:00:00Z");

let db: Db;
let close: () => Promise<void>;
let companyId: string;
let n = 0;

beforeEach(async () => {
  ({ db, close } = await openPglite());
  const [co] = await db.insert(companies).values({ name: "Approve Co" }).returning({ id: companies.id });
  companyId = co!.id;
});
afterEach(async () => {
  await close();
});

const card = async () => {
  const [d] = await db.insert(decisions).values({ companyId, kind: "question", question: `Q${n++}?`, options: ["Yes", "No"], recommendedOption: "Yes" }).returning({ id: decisions.id });
  return d!.id;
};
const token = async (decisionId: string, extra: Partial<typeof approveTokens.$inferInsert> = {}) => {
  const [t] = await db
    .insert(approveTokens)
    .values({ companyId, decisionId, answer: "Yes", tokenHash: `hash-${n++}`, decisionRev: "rev1", createdAt: NOW, expiresAt: new Date(NOW.getTime() + DAY), ...extra })
    .returning();
  return t!;
};
const row = async (id: string) => (await db.select().from(approveTokens).where(eq(approveTokens.id, id)))[0];

describe("revokeApproveTokens", () => {
  it("revokes the live link of that card at the given time", async () => {
    const d = await card();
    const t = await token(d);
    await revokeApproveTokens(db, d, NOW);
    expect((await row(t.id))!.revokedAt).toEqual(NOW);
  });

  it("leaves used and already-revoked links untouched, revokedAt not overwritten", async () => {
    const d = await card();
    const used = await token(d, { usedAt: USED_AT });
    const old = await token(d, { revokedAt: REVOKED_EARLIER });
    const live = await token(d);
    await revokeApproveTokens(db, d, NOW);
    expect((await row(used.id))!.revokedAt).toBeNull();
    expect((await row(used.id))!.usedAt).toEqual(USED_AT);
    expect((await row(old.id))!.revokedAt).toEqual(REVOKED_EARLIER);
    expect((await row(live.id))!.revokedAt).toEqual(NOW);
  });

  it("leaves other cards' links alone", async () => {
    const a = await card();
    const b = await card();
    await token(a);
    const other = await token(b);
    await revokeApproveTokens(db, a, NOW);
    expect((await row(other.id))!.revokedAt).toBeNull();
  });
});

describe("sweepPhoneApprove", () => {
  it("deletes tokens and tap records older than a day, keeps newer ones, returns the count", async () => {
    const d = await card();
    const cutoff = new Date(NOW.getTime() - DAY);
    const oldTok = await token(d, { createdAt: new Date(cutoff.getTime() - 1), usedAt: USED_AT });
    const edgeTok = await token(d, { createdAt: cutoff, usedAt: USED_AT });
    const newTok = await token(d, { createdAt: new Date(cutoff.getTime() + 1) });
    await db.insert(phoneActionHits).values([
      { ip: "192.168.1.50", companyId, at: new Date(cutoff.getTime() - 1) },
      { ip: "192.168.1.51", companyId, at: new Date(cutoff.getTime() - DAY) },
      { ip: "192.168.1.52", companyId, at: cutoff },
      { ip: "192.168.1.53", companyId, at: NOW },
    ]);

    expect(await sweepPhoneApprove(db, NOW)).toBe(3);

    expect(await row(oldTok.id)).toBeUndefined();
    expect(await row(edgeTok.id)).toBeDefined(); // exactly 24 h old is kept (strict less-than)
    expect(await row(newTok.id)).toBeDefined();
    const hits = (await db.select().from(phoneActionHits)).map((h) => h.ip).sort();
    expect(hits).toEqual(["192.168.1.52", "192.168.1.53"]);
  });

  it("returns 0 when nothing is old", async () => {
    const d = await card();
    await token(d);
    expect(await sweepPhoneApprove(db, NOW)).toBe(0);
  });
});
