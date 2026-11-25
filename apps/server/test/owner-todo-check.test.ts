// BOS-2336: Boss Man's own owner cards (raiseOwnerTodo) pass the same step check as an agent's card: a refused step list
// is held and the CEO gets a card with the findings; the owner never sees unchecked steps.
import { describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { openPglite } from "../src/db/client.js";
import { companies, decisions } from "../src/db/schema.js";
import { APPROVE_HAND_APPLY, ownerTodoFixKey, raiseHandApplyTodo, raiseOwnerTodo, reraiseHeldHandApply, setOwnerTodoFacts } from "../src/services/decisions.js";
import { ensureCiIdentityCard, ciIdentityKey } from "../src/services/ci-identity-card.js";
import { screenMismatchSites } from "../src/services/outside-site-mismatch.js";
import { SCREEN_DIFFERENT_OPTION, sh, step } from "../src/services/steps.js";

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

  // The hand-apply to-do (decisions.ts): its handSteps are code-written, but a host fact can still refuse them.
  describe("the hand-apply to-do of an approved infra update", () => {
    const HOSTS = [{ name: "example-host", ownership: [] }];
    const onHost = (host: string, cmd: string) => step("Run this on the machine that runs Boss Man:", sh(cmd, { host, as: "root" }));
    const approved = async (c: Awaited<ReturnType<typeof setup>>, handSteps: string[], commit = "c0ffee1") => {
      const [d] = await c.db
        .insert(decisions)
        .values({ companyId: c.companyId, kind: "question", question: "Apply the proxy change", options: ["Approve"], recommendedOption: "Approve", tier: "owner", status: "answered", answer: APPROVE_HAND_APPLY, answeredAt: new Date(), context: { type: "self_deploy", target: "server", commit, fromCommit: "f00d123", infra: true, handSteps } } as never)
        .returning();
      return d!;
    };
    const run = (c: Awaited<ReturnType<typeof setup>>, d: Awaited<ReturnType<typeof approved>>) => raiseHandApplyTodo(c.db, d, d.context as never, false);
    const ownerCards = async (c: Awaited<ReturnType<typeof setup>>) => (await c.db.select().from(decisions).where(eq(decisions.companyId, c.companyId))).filter((d) => d.tier === "owner" && (d.context as { type: string }).type === "owner_todo");
    const fixCards = async (c: Awaited<ReturnType<typeof setup>>) => (await c.db.select().from(decisions).where(eq(decisions.companyId, c.companyId))).filter((d) => d.dedupeKey?.startsWith("owner-todo-fix:"));
    const compose = { "compose.files": "docker-compose.yml,deploy/bluegreen.yml", "compose.bluegreen": "true", "compose.liveColour": "blue", "compose.cmd": "cd /opt/example/src && docker compose -f docker-compose.yml -f deploy/bluegreen.yml", "paths.src": "/opt/example/src" };

    it("is held on an R6 host fence refusal: a CEO card, none for the owner", async () => {
      const c = await setup();
      try {
        setOwnerTodoFacts(async () => ({ serverHost: "example-host", hosts: HOSTS }));
        const d = await approved(c, [onHost("other-host", "ls /opt/example")]);
        expect(await run(c, d)).toBeNull();
        expect(await ownerCards(c)).toHaveLength(0);
        const fix = await fixCards(c);
        expect(fix).toHaveLength(1);
        expect(fix[0]!.tier).toBe("ceo");
        expect(fix[0]!.question).toContain(`but Boss Man runs on "example-host"`);
      } finally {
        setOwnerTodoFacts(null);
        await c.close();
      }
    });

    it("is held on an R31 compose refusal: a CEO card, none for the owner", async () => {
      const c = await setup();
      try {
        setOwnerTodoFacts(async () => ({ serverHost: "example-host", hosts: HOSTS, values: compose }));
        const d = await approved(c, [onHost("example-host", "cd /opt/example/src && docker compose up -d")]);
        expect(await run(c, d)).toBeNull();
        expect(await ownerCards(c)).toHaveLength(0);
        const fix = await fixCards(c);
        expect(fix).toHaveLength(1);
        expect(fix[0]!.question).toContain("R31b");
      } finally {
        setOwnerTodoFacts(null);
        await c.close();
      }
    });

    it("a held card is raised again by the sweep once the steps pass, even after the CEO answered 'Got it' (it was stranded before)", async () => {
      const c = await setup();
      try {
        const d = await approved(c, [onHost("other-host", "ls /opt/example")]);
        setOwnerTodoFacts(async () => ({ serverHost: "example-host", hosts: HOSTS }));
        expect(await run(c, d)).toBeNull();
        expect(await reraiseHeldHandApply(c.db)).toBe(0);
        expect(await ownerCards(c)).toHaveLength(0);
        const [fix] = await fixCards(c);
        await c.db.update(decisions).set({ status: "answered", answer: "Got it", answeredAt: new Date() }).where(eq(decisions.id, fix!.id));
        // The host now reports the name the steps use.
        setOwnerTodoFacts(async () => ({ serverHost: "other-host", hosts: [{ name: "other-host", ownership: [] }] }));
        expect(await reraiseHeldHandApply(c.db)).toBe(1);
        expect(await ownerCards(c)).toHaveLength(1);
        // The sweep looks no further once the owner has the card.
        expect(await fixCards(c)).toHaveLength(0);
        expect(await reraiseHeldHandApply(c.db)).toBe(0);
        expect(await ownerCards(c)).toHaveLength(1);
      } finally {
        setOwnerTodoFacts(null);
        await c.close();
      }
    });

    it("the CEO is not asked again on every sweep after 'Got it', but is told again a day later if the steps still fail", async () => {
      const c = await setup();
      try {
        setOwnerTodoFacts(async () => ({ serverHost: "example-host", hosts: HOSTS }));
        const d = await approved(c, [onHost("other-host", "ls /opt/example")]);
        await run(c, d);
        const [fix] = await fixCards(c);
        await c.db.update(decisions).set({ status: "answered", answer: "Got it", answeredAt: new Date() }).where(eq(decisions.id, fix!.id));
        await reraiseHeldHandApply(c.db);
        await reraiseHeldHandApply(c.db);
        expect(await fixCards(c)).toHaveLength(1);
        await c.db.update(decisions).set({ answeredAt: new Date(Date.now() - 2 * 86_400_000) }).where(eq(decisions.id, fix!.id));
        await reraiseHeldHandApply(c.db);
        expect((await fixCards(c)).filter((x) => x.status === "open")).toHaveLength(1);
      } finally {
        setOwnerTodoFacts(null);
        await c.close();
      }
    });
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
