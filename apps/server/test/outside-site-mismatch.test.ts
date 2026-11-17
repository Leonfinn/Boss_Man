// R19b: the record of which outside sites' docs misled this company's owner, read from the cards themselves.
import { afterEach, describe, expect, it } from "vitest";
import { openPglite } from "../src/db/client.js";
import { companies, decisions } from "../src/db/schema.js";
import { screenMismatchSites } from "../src/services/outside-site-mismatch.js";
import { SCREEN_DIFFERENT_OPTION } from "../src/services/steps.js";

const NOW = new Date("2026-11-15T12:00:00Z");
const DOC = "https://developers.cloudflare.com/fundamentals/api/get-started/create-token/";
const CF_STEPS = [`Open https://dash.cloudflare.com (not seen: ${DOC}, 2026-11-12) and press Create Token.`];
const SERVER = "boss.example.net";

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

async function setup() {
  const p = await openPglite();
  close = p.close;
  const [co] = await p.db.insert(companies).values({ name: `Co ${Math.random()}` }).returning();
  const [other] = await p.db.insert(companies).values({ name: `Other ${Math.random()}` }).returning();
  const card = async (companyId: string, v: { status: "answered" | "withdrawn"; at: string; answer?: string; note?: string; steps?: string[]; triedFirst?: string; question?: string; id?: string }) => {
    const [d] = await p.db
      .insert(decisions)
      .values({
        ...(v.id ? { id: v.id } : {}),
        companyId, kind: "question", question: v.question ?? "Make a token?", options: ["Done", SCREEN_DIFFERENT_OPTION], recommendedOption: "Done",
        status: v.status, answer: v.answer ?? null, answeredAt: new Date(v.at), createdAt: new Date(v.at),
        context: { type: "question", ...(v.steps ? { steps: v.steps } : {}), ...(v.triedFirst ? { triedFirst: v.triedFirst } : {}), ...(v.note ? { withdrawn: { by: "ceo", note: v.note, at: v.at } } : {}) },
      })
      .returning();
    return d!;
  };
  return { db: p.db, co: co!, other: other!, card };
}

describe("screenMismatchSites", () => {
  it("records the vendor when the owner answered 'My screen looks different' on a card with an outside-site step", async () => {
    const s = await setup();
    await s.card(s.co.id, { status: "answered", at: "2026-11-12T09:00:00Z", answer: SCREEN_DIFFERENT_OPTION, steps: CF_STEPS });
    expect(await screenMismatchSites(s.db, s.co.id, CF_STEPS, SERVER, NOW)).toEqual({ cloudflare: "2026-11-12T09:00:00.000Z" });
  });

  it("does not record an ordinary answer, a card with no outside site, another company's card, or another vendor", async () => {
    const s = await setup();
    await s.card(s.co.id, { status: "answered", at: "2026-11-12T09:00:00Z", answer: "Done", steps: CF_STEPS });
    await s.card(s.co.id, { status: "answered", at: "2026-11-12T09:00:00Z", answer: SCREEN_DIFFERENT_OPTION, steps: ["Open Settings → Secrets and press Save."] });
    await s.card(s.other.id, { status: "answered", at: "2026-11-12T09:00:00Z", answer: SCREEN_DIFFERENT_OPTION, steps: CF_STEPS });
    expect(await screenMismatchSites(s.db, s.co.id, CF_STEPS, SERVER, NOW)).toBeUndefined();
    await s.card(s.co.id, { status: "answered", at: "2026-11-12T09:00:00Z", answer: SCREEN_DIFFERENT_OPTION, steps: CF_STEPS });
    // Asked about GitHub only, the Cloudflare record is not returned.
    expect(await screenMismatchSites(s.db, s.co.id, ["Open https://github.com/settings/tokens and press New."], SERVER, NOW)).toBeUndefined();
  });

  it("records a card withdrawn citing a mismatch, and one replaced by a card that cites it", async () => {
    const s = await setup();
    await s.card(s.co.id, { status: "withdrawn", at: "2026-11-13T09:00:00Z", note: "The owner's screen doesn't match these steps", steps: CF_STEPS });
    expect(await screenMismatchSites(s.db, s.co.id, CF_STEPS, SERVER, NOW)).toEqual({ cloudflare: "2026-11-13T09:00:00.000Z" });

    const t = await setup();
    const replacement = await t.card(t.co.id, { status: "answered", at: "2026-11-14T09:00:00Z", answer: "Done", triedFirst: "The last card's click path did not match the owner's screen, so I asked for a screenshot." });
    await t.card(t.co.id, { status: "withdrawn", at: "2026-11-14T08:00:00Z", note: `superseded by ${replacement.id}`, steps: CF_STEPS });
    expect(await screenMismatchSites(t.db, t.co.id, CF_STEPS, SERVER, NOW)).toEqual({ cloudflare: "2026-11-14T08:00:00.000Z" });

    // A plain replacement (no mismatch cited) records nothing.
    const u = await setup();
    const plain = await u.card(u.co.id, { status: "answered", at: "2026-11-14T09:00:00Z", answer: "Done", triedFirst: "Reworded the steps." });
    await u.card(u.co.id, { status: "withdrawn", at: "2026-11-14T08:00:00Z", note: `superseded by ${plain.id}`, steps: CF_STEPS });
    expect(await screenMismatchSites(u.db, u.co.id, CF_STEPS, SERVER, NOW)).toBeUndefined();
  });

  it("lapses by itself after 30 days, and costs no query for a card with no outside site", async () => {
    const s = await setup();
    await s.card(s.co.id, { status: "answered", at: "2026-10-10T09:00:00Z", answer: SCREEN_DIFFERENT_OPTION, steps: CF_STEPS });
    expect(await screenMismatchSites(s.db, s.co.id, CF_STEPS, SERVER, NOW)).toBeUndefined();
    expect(await screenMismatchSites(s.db, s.co.id, ["Open Settings → Secrets."], SERVER, NOW)).toBeUndefined();
  });
});
