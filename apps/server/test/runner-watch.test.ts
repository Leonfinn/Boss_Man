import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { openPglite } from "../src/db/client.js";
import { companies, decisions, runners } from "../src/db/schema.js";
import { DEPLOY_HEALTHY_MS, OFFLINE_REPORT_MS, runnerOfflineKey, runnerWatchService } from "../src/services/runner-watch.js";
import type { NotifyInput } from "../src/services/notifications.js";
import type { AlertInput } from "../src/services/alert-ladder.js";

let close: (() => Promise<unknown>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

async function setup(names: string[]) {
  const opened = await openPglite();
  close = opened.close;
  const { db } = opened;
  const seen = new Date(Date.now() - 60_000);
  const rows: Array<{ id: string; companyId: string; name: string }> = [];
  for (const name of names) {
    const [co] = await db.insert(companies).values({ name }).returning();
    const [r] = await db.insert(runners).values({ companyId: co!.id, tokenHash: "x", lastSeenAt: seen }).returning();
    rows.push({ id: r!.id, companyId: co!.id, name });
  }
  const up = new Set(rows.map((r) => r.id));
  const notes: NotifyInput[] = [];
  const alertsRaised: AlertInput[] = [];
  let t = Date.now();
  let hold = false;
  const watch = runnerWatchService(db, {
    isConnected: (id) => up.has(id),
    holdOn: async () => hold,
    notify: async (n) => void notes.push(n),
    alert: async (a) => {
      alertsRaised.push(a);
      await db.insert(decisions).values({ companyId: a.companyId, kind: "question", question: a.question, recommendedOption: "Got it", dedupeKey: a.dedupeKey });
    },
    now: () => new Date(t),
  });
  return { db, rows, up, notes, alertsRaised, watch, advance: (ms: number) => (t += ms), setHold: (v: boolean) => (hold = v) };
}

describe("runner watch (BOS-467)", () => {
  it("tells the CEO and the owner about every offline company's runner, then clears when it is back", async () => {
    const s = await setup(["Alpha", "Beta", "Gamma"]);
    await s.watch.step();
    s.up.delete(s.rows[1]!.id);
    s.up.delete(s.rows[2]!.id);
    s.advance(60_000);
    await s.watch.step();
    expect(s.notes.filter((n) => n.level === "page")).toHaveLength(0); // not yet
    s.advance(OFFLINE_REPORT_MS);
    await s.watch.step();
    await s.watch.step(); // said once
    const pages = s.notes.filter((n) => n.level === "page");
    expect(pages.map((p) => p.title).sort()).toEqual(["Beta's runner is offline", "Gamma's runner is offline"]);
    expect(pages[0]!.body).toContain("Reconnect runner");
    expect(s.alertsRaised.map((a) => a.companyId).sort()).toEqual([s.rows[1]!.companyId, s.rows[2]!.companyId].sort());
    expect(s.alertsRaised.every((a) => a.from === "ceo")).toBe(true);
    s.up.add(s.rows[1]!.id);
    await s.watch.step();
    const [card] = await s.db.select().from(decisions).where(eq(decisions.companyId, s.rows[1]!.companyId));
    expect(card!.status).toBe("withdrawn");
    const [still] = await s.db.select().from(decisions).where(eq(decisions.companyId, s.rows[2]!.companyId));
    expect(still!.status).toBe("open");
    expect(still!.dedupeKey).toBe(runnerOfflineKey(s.rows[2]!.id));
    expect(s.notes.some((n) => n.title === "Beta's runner is back")).toBe(true);
  });

  it("says a deploy is healthy only once every runner is back, and names who is missing", async () => {
    const ok = await setup(["Alpha", "Beta"]);
    await ok.watch.step();
    ok.advance(DEPLOY_HEALTHY_MS);
    await ok.watch.step();
    expect(ok.notes.map((n) => n.title)).toContain("Deploy healthy: every runner is back");
    await close?.();

    const bad = await setup(["Alpha", "Beta"]);
    bad.up.delete(bad.rows[1]!.id);
    await bad.watch.step();
    bad.advance(DEPLOY_HEALTHY_MS);
    await bad.watch.step();
    const page = bad.notes.find((n) => n.title === "Deploy not healthy: runners still offline");
    expect(page?.level).toBe("page");
    expect(page?.body).toContain("Beta");
    expect(page?.body).not.toContain("Alpha");
  });

  it("stays quiet during a runner update's hold, and for a runner nobody ever started", async () => {
    const s = await setup(["Alpha"]);
    await s.db.update(runners).set({ lastSeenAt: null });
    s.up.clear();
    await s.watch.step();
    s.advance(OFFLINE_REPORT_MS * 2);
    await s.watch.step();
    expect(s.notes).toHaveLength(0);
    await close?.();

    const h = await setup(["Alpha"]);
    h.setHold(true);
    h.up.clear();
    await h.watch.step();
    h.advance(OFFLINE_REPORT_MS * 2);
    await h.watch.step();
    expect(h.notes.filter((n) => n.level === "page")).toHaveLength(0);
  });

  it("stays quiet for a runner the owner stopped (lastSeenAt cleared), even after a restart", async () => {
    const s = await setup(["Alpha", "Beta"]);
    await s.watch.step();
    s.up.delete(s.rows[1]!.id);
    await s.db.update(runners).set({ lastSeenAt: null }).where(eq(runners.id, s.rows[1]!.id));
    s.advance(OFFLINE_REPORT_MS * 3);
    await s.watch.step();
    expect(s.notes.filter((n) => n.level === "page")).toHaveLength(0);
    expect(s.alertsRaised).toHaveLength(0);
  });

  it("alerts for a long-stable runner (lastSeenAt 3 days old) that drops, and counts it in the deploy check", async () => {
    const s = await setup(["Alpha", "Beta"]);
    const old = new Date(Date.now() - 3 * 86_400_000);
    await s.db.update(runners).set({ lastSeenAt: old });
    await s.watch.step();
    s.up.delete(s.rows[1]!.id);
    await s.watch.step();
    s.advance(OFFLINE_REPORT_MS);
    await s.watch.step();
    expect(s.notes.filter((n) => n.level === "page").map((p) => p.title)).toEqual(["Beta's runner is offline"]);
    s.advance(DEPLOY_HEALTHY_MS);
    await s.watch.step();
    expect(s.notes.some((n) => n.title === "Deploy not healthy: runners still offline" && n.body.includes("Beta"))).toBe(true);
  });

  it("after a server restart, an old-lastSeenAt runner that has not reconnected is counted as missing", async () => {
    const s = await setup(["Alpha", "Beta"]);
    await s.db.update(runners).set({ lastSeenAt: new Date(Date.now() - 3 * 86_400_000) });
    s.up.delete(s.rows[1]!.id); // down at the very first step
    await s.watch.step();
    s.advance(DEPLOY_HEALTHY_MS);
    await s.watch.step();
    expect(s.notes.some((n) => n.title === "Deploy not healthy: runners still offline" && n.body.includes("Beta"))).toBe(true);
  });
});
