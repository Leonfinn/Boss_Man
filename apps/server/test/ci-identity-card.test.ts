// BOS-2285: the gate asks the owner once for a second account's GIT_CI_TOKEN, and stops asking when it is set.
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { openPglite } from "../src/db/client.js";
import { companies, decisions } from "../src/db/schema.js";
import { ciIdentityKey, ensureCiIdentityCard } from "../src/services/ci-identity-card.js";

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
      expect(steps).toContain("Settings → Money and access → Secrets");
      expect(JSON.stringify(open[0])).not.toMatch(/ghp_|github_pat_/);

      expect(await ensureCiIdentityCard(db, co!.id, "made-up-token")).toBe("cleared");
      expect((await cards())[0]!.status).toBe("answered");
      // With the token set nothing is raised.
      expect(await ensureCiIdentityCard(db, co!.id, "made-up-token")).toBe("none");
    } finally {
      await close();
    }
  });

  it("does not ask again after the owner answered it (keep the emails)", async () => {
    const { db, close } = await openPglite();
    try {
      const [co] = await db.insert(companies).values({ name: "Keep Co", slug: "keep-co" } as never).returning();
      expect(await ensureCiIdentityCard(db, co!.id, undefined)).toBe("raised");
      await db.update(decisions).set({ status: "answered", answer: "A step failed" }).where(eq(decisions.companyId, co!.id));
      expect(await ensureCiIdentityCard(db, co!.id, undefined)).toBe("none");
      expect(await db.select().from(decisions).where(eq(decisions.companyId, co!.id))).toHaveLength(1);
    } finally {
      await close();
    }
  });
});
