// BOS-2185: permission decisions are stored (redacted), answered, listed per run and pruned at 60 days.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { openPglite } from "../src/db/client.js";
import { permissionDecisions } from "../src/db/schema.js";
import { permissionLogDays, prunePermissionDecisions } from "../src/services/housekeeping.js";
import { createPermissionLog } from "../src/services/permission-log.js";
import { permissionsForRun, permissionStore, PERMISSION_TITLE_MAX } from "../src/services/permission-store.js";

const DAY = 86_400_000;
const flush = () => new Promise((r) => setTimeout(r, 0));
const ids = () => ({ companyId: randomUUID(), runId: randomUUID(), agentId: randomUUID(), ticketId: randomUUID() });
// Built at run time so the file holds no secret-shaped literal (the commit scan blocks those).
const SECRET = ["sk", "ant", "api03", "abcdefghijklmnopqrstuvwxyz0123456789"].join("-");

async function waitForRows(db: Awaited<ReturnType<typeof openPglite>>["db"], n: number) {
  for (let i = 0; i < 200; i++) {
    const [r] = await db.select({ c: sql<number>`count(*)::int` }).from(permissionDecisions);
    if ((r?.c ?? 0) >= n) return;
    await flush();
  }
  throw new Error("rows never arrived");
}

describe("permission store", () => {
  it("stores each decision, then who answered the card, and lists one run's rows", async () => {
    const { db, close } = await openPglite();
    const base = ids();
    const card = randomUUID();
    const p = createPermissionLog({ store: permissionStore(db) });
    p.decision({ ...base, title: "Bash: ls", kind: "execute", rule: "Read-only shell", position: 3, outcome: "allow", tier: "allow" });
    p.decision({ ...base, title: "Bash: make", kind: "execute", rule: "Anything else", position: 0, outcome: "owner", tier: "owner", decisionId: card });
    p.decision({ ...base, title: "Bash: rm -rf x", kind: "execute", rule: "Destructive commands", position: 1, outcome: "deny", tier: "deny" });
    p.decision({ ...ids(), title: "Other run", kind: "execute", rule: "x", position: 1, outcome: "deny", tier: "deny" });
    await waitForRows(db, 4);
    p.answer({ ...base, decisionId: card, answeredBy: "owner", answer: "allow" });
    for (let i = 0; i < 200; i++) {
      const got = await permissionsForRun(db, base.runId);
      if (got.entries.some((e) => e.answeredBy)) break;
      await flush();
    }
    const got = await permissionsForRun(db, base.runId);
    expect(got.truncated).toBe(false);
    expect(got.entries.map((e) => [e.title, e.rule, e.outcome, e.answeredBy])).toEqual([
      ["Bash: ls", "Read-only shell", "allow", null],
      ["Bash: make", "Anything else", "owner", "owner"],
      ["Bash: rm -rf x", "Destructive commands", "deny", null],
    ]);
    // A restart: a new, empty log has no summary, but the stored rows are still returned.
    const restarted = createPermissionLog({ store: permissionStore(db) });
    expect(restarted.summary(base.companyId).rules).toEqual([]);
    expect((await permissionsForRun(db, base.runId)).entries).toHaveLength(3);
    await close();
  });

  it("never stores a credential that sits in a tool title", async () => {
    const { db, close } = await openPglite();
    const base = ids();
    const p = createPermissionLog({ store: permissionStore(db) });
    p.decision({ ...base, title: `Bash: curl -H "Authorization: Bearer ${SECRET}" https://example.com ${"x".repeat(400)}`, kind: "execute", rule: "r", position: 1, outcome: "ceo", tier: "ceo" });
    await waitForRows(db, 1);
    const [row] = (await permissionsForRun(db, base.runId)).entries;
    expect(row!.title).not.toContain(SECRET);
    expect(row!.title).not.toContain("abcdefghijklmnop");
    expect(row!.title!.length).toBeLessThanOrEqual(PERMISSION_TITLE_MAX);
    await close();
  });

  it("a failing store never stops or changes the decision", () => {
    const lines: string[] = [];
    const store = { insert: () => Promise.reject(new Error("db down")), markAnswered: () => { throw new Error("sync boom"); } };
    const p = createPermissionLog({ log: (l) => lines.push(l), store });
    expect(() => p.decision({ ...ids(), title: "t", kind: null, rule: "r", position: 1, outcome: "allow", tier: "allow" })).not.toThrow();
    expect(() => p.answer({ ...ids(), decisionId: "d", answeredBy: "owner", answer: "allow" })).not.toThrow();
    expect(p.summary("nobody").rules).toEqual([]);
  });

  it("prunes rows older than 60 days and keeps newer ones", async () => {
    const { db, close } = await openPglite();
    const now = new Date("2026-11-21T00:00:00Z");
    const row = (ageDays: number) => ({ ...ids(), at: new Date(now.getTime() - ageDays * DAY), rule: "r", position: 1, outcome: "allow", tier: "allow" });
    await db.insert(permissionDecisions).values([row(90), row(61), row(59), row(1)]);
    expect(await prunePermissionDecisions(db, { days: 60, batch: 1, now })).toBe(2);
    const [r] = await db.select({ c: sql<number>`count(*)::int` }).from(permissionDecisions);
    expect(r!.c).toBe(2);
    expect(permissionLogDays(undefined)).toBe(60);
    expect(permissionLogDays("0")).toBe(60);
    expect(permissionLogDays("30")).toBe(30);
    await close();
  });
});
