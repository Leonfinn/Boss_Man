// BOS-2336: Boss Man's own owner cards (raiseOwnerTodo) pass the same step check as an agent's card: a refused step list
// is held and the CEO gets a card with the findings; the owner never sees unchecked steps.
import { describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { openPglite } from "../src/db/client.js";
import { companies, decisions } from "../src/db/schema.js";
import { ownerTodoFixKey, raiseOwnerTodo } from "../src/services/decisions.js";
import { ensureCiIdentityCard, ciIdentityKey } from "../src/services/ci-identity-card.js";
import { screenMismatchSites } from "../src/services/outside-site-mismatch.js";
import { SCREEN_DIFFERENT_OPTION } from "../src/services/steps.js";

async function setup() {
  const { db, close } = await openPglite();
  const [co] = await db.insert(companies).values({ name: "Todo Co", slug: "todo-co" } as never).returning();
  return { db, close, companyId: co!.id };
}
const todo = (key: string, steps: string[], facts?: Parameters<typeof raiseOwnerTodo>[1]["facts"]) => ({ question: "Do the thing by hand.", key, steps, ofDecisionId: "system", ...(facts ? { facts } : {}) });

describe("raiseOwnerTodo runs the card check", () => {
  it("holds a to-do whose host token can't be filled, raises a CEO card, and sends the owner's card once the steps pass", async () => {
    const c = await setup();
    try {
      const steps = ["On the machine that runs Boss Man, open the file `{{host.env.file}}` in an editor and check it is not empty."];
      // Old code inserted the owner's card whatever the steps said; now nothing reaches the owner.
      expect(await raiseOwnerTodo(c.db, { companyId: c.companyId, ...todo("owner-todo:test:1", steps, { values: {} }) })).toBeNull();
      const all = await c.db.select().from(decisions).where(eq(decisions.companyId, c.companyId));
      expect(all.filter((d) => d.tier === "owner")).toHaveLength(0);
      const fix = all.filter((d) => d.dedupeKey === ownerTodoFixKey("owner-todo:test:1"));
      expect(fix).toHaveLength(1);
      expect(fix[0]!.tier).toBe("ceo");
      expect(fix[0]!.question).toContain("has {{host.env.file}}");
      expect((fix[0]!.context as { ladder?: { topRung?: string } }).ladder?.topRung).toBe("ceo");

      // The host reports the fact: the same steps pass, go out filled in, and the CEO's card is closed.
      const row = await raiseOwnerTodo(c.db, { companyId: c.companyId, ...todo("owner-todo:test:1", steps, { values: { "env.file": "/srv/example/.env" } }) });
      expect(row).not.toBeNull();
      const [card] = await c.db.select().from(decisions).where(eq(decisions.id, row!.id));
      expect((card!.context as { steps: string[] }).steps.join("\n")).toContain("/srv/example/.env");
      expect(card!.tier).toBe("owner");
      const [closed] = await c.db.select().from(decisions).where(eq(decisions.id, fix[0]!.id));
      expect(closed!.status).toBe("answered");
    } finally {
      await c.close();
    }
  });

  it("a to-do with a step on an outside site offers 'My screen looks different', and answering it is what R19b reads", async () => {
    const c = await setup();
    try {
      const steps = [
        `On GitHub, open the repo's page. You should see a "Settings" tab under the repo's name. Click Settings. (not seen: https://docs.github.com/en/repositories, 2026-11-24)`,
      ];
      const row = await raiseOwnerTodo(c.db, { companyId: c.companyId, ...todo("owner-todo:test:2", steps, {}) });
      expect(row).not.toBeNull();
      const [card] = await c.db.select().from(decisions).where(eq(decisions.id, row!.id));
      expect(card!.options).toContain(SCREEN_DIFFERENT_OPTION);
      // A card with no outside site does not offer it.
      const plain = await raiseOwnerTodo(c.db, { companyId: c.companyId, ...todo("owner-todo:test:3", ["In Boss Man, open Settings → Server and runner → This server and read the Role."], {}) });
      const [plainCard] = await c.db.select().from(decisions).where(eq(decisions.id, plain!.id));
      expect(plainCard!.options).not.toContain(SCREEN_DIFFERENT_OPTION);

      expect(await screenMismatchSites(c.db, c.companyId, steps, null)).toBeUndefined();
      await c.db.update(decisions).set({ status: "answered", answer: SCREEN_DIFFERENT_OPTION, answeredAt: new Date() }).where(eq(decisions.id, row!.id));
      expect(Object.keys((await screenMismatchSites(c.db, c.companyId, steps, null)) ?? {})).toEqual(["github"]);
    } finally {
      await c.close();
    }
  });

  it("the CI-identity card is held while GitHub's docs have misled the owner in the last 30 days, and the owner sees nothing", async () => {
    const c = await setup();
    try {
      // An earlier GitHub card the owner answered "My screen looks different" a week ago.
      await c.db.insert(decisions).values({
        companyId: c.companyId,
        kind: "question",
        question: "An earlier GitHub step",
        options: ["Done", SCREEN_DIFFERENT_OPTION],
        recommendedOption: "Done",
        tier: "owner",
        status: "answered",
        answer: SCREEN_DIFFERENT_OPTION,
        answeredAt: new Date(Date.now() - 7 * 86_400_000),
        context: { type: "owner_todo", ofDecisionId: "system", steps: ["On GitHub, open Settings."], ownerMustDo: true },
      } as never);
      // The old code raised the card whatever the record said.
      expect(await ensureCiIdentityCard(c.db, c.companyId, undefined)).toBe("none");
      const cards = await c.db.select().from(decisions).where(and(eq(decisions.companyId, c.companyId), eq(decisions.status, "open")));
      expect(cards.filter((d) => d.dedupeKey === ciIdentityKey(c.companyId))).toHaveLength(0);
      const fix = cards.filter((d) => d.dedupeKey === ownerTodoFixKey(ciIdentityKey(c.companyId)));
      expect(fix).toHaveLength(1);
      expect(fix[0]!.tier).toBe("ceo");
      expect(fix[0]!.question).toContain("docs didn't match the owner's screen");
    } finally {
      await c.close();
    }
  });
});
