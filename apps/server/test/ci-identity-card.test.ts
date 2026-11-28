// BOS-2285: the gate asks the owner once for a second account's GIT_CI_TOKEN, and stops asking when it is set.
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { openPglite } from "../src/db/client.js";
import { companies, decisions } from "../src/db/schema.js";
import { randomBytes } from "node:crypto";
import { secretsService } from "../src/services/secrets.js";
import { SCREEN_DIFFERENT_OPTION } from "../src/services/steps.js";
import { CI_KEEP_EMAILS, ciIdentityKey, ensureCiIdentityCard, watchCiTokenGrant } from "../src/services/ci-identity-card.js";

describe("ensureCiIdentityCard", () => {
  it("raises one owner card without a GIT_CI_TOKEN, never a second, and closes it once the token is granted", async () => {
    const { db, close } = await openPglite();
    try {
      const [co] = await db.insert(companies).values({ name: "Card Co", slug: "card-co" } as never).returning();
      const cards = () => db.select().from(decisions).where(eq(decisions.companyId, co!.id));

      expect(await ensureCiIdentityCard(db, co!.id, undefined)).toBe("raised");
      expect(await ensureCiIdentityCard(db, co!.id, undefined)).toBe("none");
      const open = await cards();
      expect(open).toHaveLength(1);
      expect(open[0]!.tier).toBe("owner");
      expect(open[0]!.dedupeKey).toBe(ciIdentityKey(co!.id));
      const steps = (open[0]!.context as { steps: string[] }).steps.join("\n");
      expect(steps).toContain("Settings → Secrets");
      // BOS-2335: a collaborator can't make a fine-grained token for the repo, so the card asks for a classic one.
      expect(steps).toContain("Tokens (classic) → Generate new token → Generate new token (classic)");
      expect(steps).toContain("scopes repo and workflow");
      expect(steps).toContain("Why classic");
      expect(steps).toContain("No expiration");
      expect(steps).not.toContain("Fine-grained tokens. Repository access");
      expect(JSON.stringify(open[0])).not.toMatch(/ghp_|github_pat_/);

      expect(await ensureCiIdentityCard(db, co!.id, "made-up-token")).toBe("cleared");
      expect((await cards())[0]!.status).toBe("answered");
      // With the token set nothing is raised.
      expect(await ensureCiIdentityCard(db, co!.id, "made-up-token")).toBe("none");
    } finally {
      await close();
    }
  });

  it("closes the card when GIT_CI_TOKEN is granted, with no merge run (BOS-2335)", async () => {
    const { db, close } = await openPglite();
    try {
      const [co] = await db.insert(companies).values({ name: "Grant Co", slug: "grant-co" } as never).returning();
      const secrets = secretsService(db, { version: 1, key: randomBytes(32) });
      watchCiTokenGrant(secrets, db);
      expect(await ensureCiIdentityCard(db, co!.id, undefined)).toBe("raised");
      const status = async () => (await db.select().from(decisions).where(eq(decisions.companyId, co!.id)))[0]!.status;

      // A different grant leaves the card open.
      const other = await secrets.create({ name: "Other", kind: "generic", value: "made-up-other" } as never);
      await secrets.grant(other.secret.id, co!.id, "SOME_OTHER_ENV");
      expect(await status()).toBe("open");

      const made = await secrets.create({ name: "Merge gate token (second account)", kind: "generic", value: "made-up-token" } as never);
      await secrets.grant(made.secret.id, co!.id, "GIT_CI_TOKEN");
      // The listener works in the background: wait for the card to answer, with a deadline.
      const deadline = Date.now() + 10_000;
      while ((await status()) !== "answered" && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
      expect(await status()).toBe("answered");
    } finally {
      await close();
    }
  });

  it("does not ask again after the owner answered it (keep the emails)", async () => {
    const { db, close } = await openPglite();
    try {
      const [co] = await db.insert(companies).values({ name: "Keep Co", slug: "keep-co" } as never).returning();
      expect(await ensureCiIdentityCard(db, co!.id, undefined)).toBe("raised");
      const [card] = await db.select().from(decisions).where(eq(decisions.companyId, co!.id));
      // "Keep the emails" is its own answer; "A step failed" is not the way to stop the asking.
      expect(card!.options).toEqual(["Done, it's applied", CI_KEEP_EMAILS, SCREEN_DIFFERENT_OPTION, "A step failed"]);
      expect(card!.question).toContain('answer "Keep the emails"');
      expect(card!.question).not.toContain('answer "A step failed": Boss Man will not ask again');
      await db.update(decisions).set({ status: "answered", answer: CI_KEEP_EMAILS }).where(eq(decisions.companyId, co!.id));
      expect(await ensureCiIdentityCard(db, co!.id, undefined)).toBe("none");
      expect(await db.select().from(decisions).where(eq(decisions.companyId, co!.id))).toHaveLength(1);
    } finally {
      await close();
    }
  });
});
