import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { openPglite } from "../src/db/client.js";
import { companies, decisions } from "../src/db/schema.js";
import { mergeContext } from "../src/services/decision-context.js";

// BOS-899 (BOS-298 step 13): a card's context is written key by key, so two writers at once can't wipe each other's.
let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

async function card(context: object) {
  const opened = await openPglite();
  close = opened.close;
  const { db } = opened;
  const [co] = await db.insert(companies).values({ name: "Ctx Co" }).returning();
  const [d] = await db.insert(decisions).values({ companyId: co!.id, kind: "question", question: "Q?", recommendedOption: "Yes", context }).returning();
  const row = async () => (await db.select().from(decisions).where(eq(decisions.id, d!.id)))[0]!;
  return { db, id: d!.id, row };
}

describe("mergeContext", () => {
  it("adds a key and keeps the others", async () => {
    const { db, id, row } = await card({ type: "question", ladder: { rung: "ceo" } });
    await db.update(decisions).set({ context: mergeContext({ withdrawn: { by: "system" } }) }).where(eq(decisions.id, id));
    expect((await row()).context).toEqual({ type: "question", ladder: { rung: "ceo" }, withdrawn: { by: "system" } });
  });

  it("replaces a key it sets, whole, and leaves the rest", async () => {
    const { db, id, row } = await card({ type: "question", advice: { state: "asking", note: "n" }, repeats: [1] });
    await db.update(decisions).set({ context: mergeContext({ advice: { state: "clarified" } }) }).where(eq(decisions.id, id));
    expect((await row()).context).toEqual({ type: "question", advice: { state: "clarified" }, repeats: [1] });
  });

  it("drops undefined values and works on an empty context", async () => {
    const { db, id, row } = await card({});
    await db.update(decisions).set({ context: mergeContext({ a: 1, b: undefined }) }).where(eq(decisions.id, id));
    expect((await row()).context).toEqual({ a: 1 });
  });

  it("a writer holding an old read cannot wipe a key written in between (the old read-spread-write did)", async () => {
    const { db, id, row } = await card({ type: "question" });
    const stale = (await row()).context as object; // writer A reads the card
    await db.update(decisions).set({ context: mergeContext({ withdrawn: { by: "ceo" } }) }).where(eq(decisions.id, id)); // writer B lands
    await db.update(decisions).set({ context: mergeContext({ ladder: { rung: "owner" }, seen: Object.keys(stale).length }) }).where(eq(decisions.id, id)); // writer A lands
    expect((await row()).context).toEqual({ type: "question", withdrawn: { by: "ceo" }, ladder: { rung: "owner" }, seen: 1 });
  });

  it("can have keys removed from the whole card (the failed to-do reopen), not from the patch", async () => {
    const { db, id, row } = await card({ type: "owner_todo", settled: { by: "ceo" }, advice: { state: "handled" } });
    await db.update(decisions).set({ context: sql`${mergeContext({ lastFailure: { note: "n" } })} - 'settled' - 'advice'` }).where(eq(decisions.id, id));
    expect((await row()).context).toEqual({ type: "owner_todo", lastFailure: { note: "n" } });
    // and when the patch itself carries the advice, it survives while settled goes
    await db.update(decisions).set({ context: { type: "owner_todo", settled: { by: "ceo" }, advice: { state: "handled" } } }).where(eq(decisions.id, id));
    await db.update(decisions).set({ context: sql`${mergeContext({ advice: { state: "reissued" } })} - 'settled'` }).where(eq(decisions.id, id));
    expect((await row()).context).toEqual({ type: "owner_todo", advice: { state: "reissued" } });
  });
});

describe("card paths never write the whole context back", () => {
  for (const file of ["decisions.ts", "alert-ladder.ts", "alert-clearing.ts", "signoff.ts"]) {
    it(`${file} has no spread-and-write of context`, async () => {
      const lines = (await readFile(new URL(`../src/services/${file}`, import.meta.url), "utf8")).split("\n");
      // An insert builds a fresh object (`context: { type: ...`); a spread of an old value is the lost-update pattern.
      const bad = lines.map((l, i) => ({ l, n: i + 1 })).filter(({ l }) => /\bcontext: \{ \.\.\./.test(l));
      expect(bad.map((b) => `${b.n}: ${b.l.trim().slice(0, 100)}`)).toEqual([]);
    });
  }
});
