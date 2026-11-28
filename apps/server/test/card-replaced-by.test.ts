// BOS-2867: resolveReplacedBy turns replacedBy "card:<short id>" into "card:<full id>"
// before a card is closed as replaced. This reads a real PGlite database directly, as
// sizing-guide.test.ts does: the pass-through forms, a unique short id, an ambiguous one,
// an unknown one, and a card that belongs to another company.
import { afterAll, describe, expect, it } from "vitest";
import { openPglite } from "../src/db/client.js";
import { companies, decisions } from "../src/db/schema.js";
import { resolveReplacedBy } from "../src/services/card-id.js";

const shared = openPglite();
afterAll(async () => (await shared).close());

let seq = 0;
const unique = (prefix: string) => `${prefix} ${++seq}`;

/** A company to resolve cards in. */
async function makeCompany() {
  const { db } = await shared;
  const [co] = await db.insert(companies).values({ name: unique("Card Co"), ticketPrefix: "TST" }).returning();
  return { db, companyId: co!.id };
}

/** A card in `companyId` with a chosen id, so short prefixes are predictable. */
async function makeCard(companyId: string, id: string) {
  const { db } = await shared;
  const [row] = await db
    .insert(decisions)
    .values({
      id,
      companyId,
      kind: "question",
      question: "Publish the launch announcement?",
      options: ["Yes", "No"],
      recommendedOption: "Yes",
      tier: "owner",
      context: { type: "question" },
    })
    .returning();
  return row!;
}

describe("forms that pass through unchanged", () => {
  it("keeps undefined, an empty string and a non-card form exactly as given", async () => {
    const { db, companyId } = await makeCompany();
    expect(await resolveReplacedBy(db, companyId, undefined)).toEqual({ ok: true, value: undefined });
    expect(await resolveReplacedBy(db, companyId, "")).toEqual({ ok: true, value: "" });
    expect(await resolveReplacedBy(db, companyId, "ticket:BOS-1")).toEqual({ ok: true, value: "ticket:BOS-1" });
  });
});

describe("a card: form with a short id", () => {
  it("turns card:<unique short id> into card:<full id>", async () => {
    const { db, companyId } = await makeCompany();
    const full = "11111111-1111-4222-8333-444455556666";
    await makeCard(companyId, full);
    expect(await resolveReplacedBy(db, companyId, "card:11111111")).toEqual({ ok: true, value: `card:${full}` });
  });

  it("accepts a longer prefix and a full id too", async () => {
    const { db, companyId } = await makeCompany();
    const full = "33333333-1111-4222-8333-444455556666";
    await makeCard(companyId, full);
    expect(await resolveReplacedBy(db, companyId, "card:33333333-1111")).toEqual({ ok: true, value: `card:${full}` });
    expect(await resolveReplacedBy(db, companyId, `card:${full}`)).toEqual({ ok: true, value: `card:${full}` });
  });
});

describe("refusals", () => {
  it("refuses a short id that matches two cards", async () => {
    const { db, companyId } = await makeCompany();
    const first = "ab12cd34-1111-4222-8333-444455556666";
    const second = "ab12cd34-9999-4222-8333-444455556666";
    await makeCard(companyId, first);
    await makeCard(companyId, second);
    const r = await resolveReplacedBy(db, companyId, "card:ab12cd34");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.startsWith("replacedBy: ")).toBe(true);
    expect(r.error).toContain(first);
    expect(r.error).toContain(second);
  });

  it("refuses an unknown short id", async () => {
    const { db, companyId } = await makeCompany();
    const r = await resolveReplacedBy(db, companyId, "card:abcdef");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.startsWith("replacedBy: ")).toBe(true);
  });

  it("does not find a card in another company", async () => {
    const mine = await makeCompany();
    const other = await makeCompany();
    await makeCard(other.companyId, "fe00aa11-1111-4222-8333-444455556666");
    const r = await resolveReplacedBy(mine.db, mine.companyId, "card:fe00aa11");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.startsWith("replacedBy: ")).toBe(true);
    expect(r.error).toContain("No card in your company");
  });
});
