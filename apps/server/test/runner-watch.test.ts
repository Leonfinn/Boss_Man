import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { openPglite } from "../src/db/client.js";
import { companies, decisions, runners, settings } from "../src/db/schema.js";
import { DEPLOY_HEALTHY_MS, handRunKey, OFFLINE_REPORT_MS, runnerOfflineKey, runnerPagedKey, runnerWatchService } from "../src/services/runner-watch.js";
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
  const launcherState: { wanted: Set<string> | null | "down" } = { wanted: null };
  const watch = runnerWatchService(db, {
    isConnected: (id) => up.has(id),
    holdOn: async () => hold,
    wantedCompanies: async () => {
      if (launcherState.wanted === "down") throw new Error("launcher down");
      return launcherState.wanted;
    },
    notify: async (n) => void notes.push(n),
    alert: async (a) => {
      alertsRaised.push(a);
      await db.insert(decisions).values({ companyId: a.companyId, kind: "question", question: a.question, recommendedOption: "Got it", dedupeKey: a.dedupeKey });
    },
    now: () => new Date(t),
  });
  return { launcherState, db, rows, up, notes, alertsRaised, watch, advance: (ms: number) => (t += ms), setHold: (v: boolean) => (hold = v) };
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
    expect(s.notes.some((n) => n.title === "Deploy not healthy: runners still offline" && n.body?.includes("Beta"))).toBe(true);
  });

  it("after a server restart, an old-lastSeenAt runner that has not reconnected is counted as missing", async () => {
    const s = await setup(["Alpha", "Beta"]);
    await s.db.update(runners).set({ lastSeenAt: new Date(Date.now() - 3 * 86_400_000) });
    s.up.delete(s.rows[1]!.id); // down at the very first step
    await s.watch.step();
    s.advance(DEPLOY_HEALTHY_MS);
    await s.watch.step();
    expect(s.notes.some((n) => n.title === "Deploy not healthy: runners still offline" && n.body?.includes("Beta"))).toBe(true);
  });

  it("stays quiet for old runners the launcher no longer wants, but pages for a wanted one and when the launcher can't answer", async () => {
    const s = await setup(["Alpha", "Beta", "Gamma"]);
    await s.db.update(runners).set({ lastSeenAt: new Date(Date.now() - 20 * 86_400_000) });
    s.up.clear();
    // Only Gamma is wanted by the launcher (Alpha and Beta were stopped or removed before this check existed).
    s.launcherState.wanted = new Set([s.rows[2]!.companyId]);
    await s.watch.step();
    s.advance(OFFLINE_REPORT_MS);
    await s.watch.step();
    expect(s.notes.filter((n) => n.level === "page").map((p) => p.title)).toEqual(["Gamma's runner is offline"]);
    s.advance(DEPLOY_HEALTHY_MS);
    await s.watch.step();
    const deploy = s.notes.find((n) => n.title === "Deploy not healthy: runners still offline");
    expect(deploy?.body).toContain("Gamma");
    expect(deploy?.body).not.toContain("Alpha");
    expect(deploy?.body).not.toContain("Beta");
    await close?.();

    const down = await setup(["Alpha", "Beta"]);
    await down.db.update(runners).set({ lastSeenAt: new Date(Date.now() - 20 * 86_400_000) });
    down.up.clear();
    down.launcherState.wanted = "down";
    await down.watch.step();
    down.advance(OFFLINE_REPORT_MS);
    await down.watch.step();
    expect(down.notes.filter((n) => n.level === "page")).toHaveLength(2);
  });
});

describe("runner watch follow-ups (BOS-497)", () => {
  const pages = (s: { notes: NotifyInput[] }) => s.notes.filter((n) => n.level === "page" && n.title.endsWith("runner is offline"));

  it("pages for a runner registered by hand on a launcher server: seen connected while the launcher doesn't run it", async () => {
    const s = await setup(["Alpha", "Beta"]);
    // The launcher runs Alpha only; Beta's runner was registered by hand (it may still have a slug from the Settings page).
    s.launcherState.wanted = new Set([s.rows[0]!.companyId]);
    await s.watch.step();
    const [mark] = await s.db.select().from(settings).where(eq(settings.key, handRunKey(s.rows[1]!.companyId)));
    expect(mark).toBeDefined();
    const [none] = await s.db.select().from(settings).where(eq(settings.key, handRunKey(s.rows[0]!.companyId)));
    expect(none).toBeUndefined();
    s.up.delete(s.rows[1]!.id);
    await s.watch.step();
    s.advance(OFFLINE_REPORT_MS);
    await s.watch.step();
    expect(pages(s).map((p) => p.title)).toEqual(["Beta's runner is offline"]);
    expect(s.alertsRaised.map((a) => a.companyId)).toEqual([s.rows[1]!.companyId]);
    // Its lastSeenAt is kept: it is not treated as an old stop.
    const [row] = await s.db.select().from(runners).where(eq(runners.id, s.rows[1]!.id));
    expect(row!.lastSeenAt).not.toBeNull();
  });

  it("gives a runner offline at the end of an update hold 3 minutes from the lift, and starts the deploy window then", async () => {
    const s = await setup(["Alpha", "Beta"]);
    s.setHold(true);
    await s.watch.step();
    s.up.delete(s.rows[1]!.id); // swapped by the update, not back yet
    await s.watch.step(); // seen offline from minute 0
    s.advance(4 * 60_000);
    await s.watch.step();
    s.setHold(false); // the hold lifts at minute 4
    await s.watch.step();
    expect(pages(s)).toHaveLength(0); // offline 4 minutes, but the grace counts from the lift
    expect(s.notes.some((n) => n.title.startsWith("Deploy"))).toBe(false);
    s.advance(OFFLINE_REPORT_MS - 1000);
    await s.watch.step();
    expect(pages(s)).toHaveLength(0);
    s.advance(1000);
    await s.watch.step();
    expect(pages(s).map((p) => p.title)).toEqual(["Beta's runner is offline"]);
    // Boot was at minute 0; the deploy check waits for 5 minutes after the lift (minute 9), not minute 5.
    expect(s.notes.some((n) => n.title.startsWith("Deploy"))).toBe(false);
    s.advance(DEPLOY_HEALTHY_MS - OFFLINE_REPORT_MS);
    await s.watch.step();
    expect(s.notes.find((n) => n.title === "Deploy not healthy: runners still offline")?.body).toContain("Beta");
  });

  it("retries the CEO card on the next pass when raising it failed, without paging the owner again", async () => {
    const s = await setup(["Alpha"]);
    let fails = 1;
    let offset = 0;
    const watch = runnerWatchService(s.db, {
      isConnected: (id) => s.up.has(id),
      holdOn: async () => false,
      notify: async (n) => void s.notes.push(n),
      alert: async (a) => {
        if (fails-- > 0) throw new Error("database busy");
        s.alertsRaised.push(a);
      },
      now: () => new Date(Date.now() + offset),
    });
    await watch.step();
    s.up.clear();
    await watch.step();
    offset += OFFLINE_REPORT_MS;
    await watch.step();
    expect(s.alertsRaised).toHaveLength(0);
    await watch.step();
    expect(s.alertsRaised).toHaveLength(1);
    expect(s.alertsRaised[0]!.dedupeKey).toBe(runnerOfflineKey(s.rows[0]!.id));
    await watch.step();
    expect(s.alertsRaised).toHaveLength(1);
    expect(pages(s)).toHaveLength(1);
  });

  it("does not page the owner twice for one outage across a server restart, but does for a new outage", async () => {
    const s = await setup(["Alpha"]);
    await s.watch.step();
    s.up.clear();
    await s.watch.step();
    s.advance(OFFLINE_REPORT_MS);
    await s.watch.step();
    expect(pages(s)).toHaveLength(1);
    // The server restarts: a fresh watch on the same database, the runner still offline.
    let t = Date.now() + OFFLINE_REPORT_MS;
    const notes2: NotifyInput[] = [];
    const deps = { isConnected: (id: string) => s.up.has(id), holdOn: async () => false, notify: async (n: NotifyInput) => void notes2.push(n), alert: async () => undefined, now: () => new Date(t) };
    const after = runnerWatchService(s.db, deps);
    await after.step();
    t += OFFLINE_REPORT_MS * 2;
    await after.step();
    expect(pages({ notes: notes2 })).toHaveLength(0);
    // It comes back (the mark goes, and the owner hears it is back), then drops again: that is a new outage.
    s.up.add(s.rows[0]!.id);
    await after.step();
    expect(notes2.some((n) => n.title === "Alpha's runner is back")).toBe(true);
    expect(await s.db.select().from(settings).where(eq(settings.key, runnerPagedKey(s.rows[0]!.id)))).toHaveLength(0);
    await s.db.update(runners).set({ lastSeenAt: new Date(t) });
    s.up.clear();
    await after.step();
    t += OFFLINE_REPORT_MS;
    await after.step();
    expect(pages({ notes: notes2 })).toHaveLength(1);
  });

  it("clears an old pre-launcher-check stop once the launcher says it's unwanted, so it stays quiet when the launcher is down", async () => {
    const s = await setup(["Alpha", "Beta"]);
    await s.db.update(runners).set({ lastSeenAt: new Date(Date.now() - 20 * 86_400_000) });
    s.up.delete(s.rows[1]!.id); // Beta was stopped before stops cleared lastSeenAt
    s.launcherState.wanted = new Set([s.rows[0]!.companyId]);
    await s.watch.step();
    const [beta] = await s.db.select().from(runners).where(eq(runners.id, s.rows[1]!.id));
    expect(beta!.lastSeenAt).toBeNull();
    const [alpha] = await s.db.select().from(runners).where(eq(runners.id, s.rows[0]!.id));
    expect(alpha!.lastSeenAt).not.toBeNull();
    // Later the launcher can't be reached: every runner would count, but Beta's stop is now on record.
    s.launcherState.wanted = "down";
    s.advance(OFFLINE_REPORT_MS * 3);
    await s.watch.step();
    expect(pages(s)).toHaveLength(0);
    expect(s.alertsRaised).toHaveLength(0);
  });
});

describe("runner watch: stopping a runner withdraws its offline card (BOS-735)", () => {
  it("withdraws the card on the next tick after the owner stops a runner that was offline with one open", async () => {
    const s = await setup(["Alpha"]);
    await s.watch.step();
    s.up.clear();
    await s.watch.step();
    s.advance(OFFLINE_REPORT_MS);
    await s.watch.step();
    const [open] = await s.db.select().from(decisions).where(eq(decisions.dedupeKey, runnerOfflineKey(s.rows[0]!.id)));
    expect(open!.status).toBe("open");
    // The owner clicks Stop: the launcher clears lastSeenAt.
    await s.db.update(runners).set({ lastSeenAt: null }).where(eq(runners.id, s.rows[0]!.id));
    const before = s.notes.length;
    await s.watch.step();
    const [after] = await s.db.select().from(decisions).where(eq(decisions.companyId, s.rows[0]!.companyId));
    expect(after!.status).toBe("withdrawn");
    expect(after!.dedupeKey).toBeNull();
    // Quiet: no "is back" note, and no page or new card for a deliberate stop.
    expect(s.notes.slice(before).filter((n) => n.level === "page")).toHaveLength(0);
    expect(s.notes.slice(before).some((n) => n.title === "Alpha's runner is back")).toBe(false);
    expect(s.alertsRaised).toHaveLength(1);
    expect(await s.db.select().from(settings).where(eq(settings.key, runnerPagedKey(s.rows[0]!.id)))).toHaveLength(0);
    // A fresh watch (a restart) that only ever sees the stopped runner makes no note at all.
    const fresh: NotifyInput[] = [];
    const restarted = runnerWatchService(s.db, { isConnected: () => false, holdOn: async () => false, notify: async (n) => void fresh.push(n), alert: async () => undefined });
    await restarted.step();
    expect(fresh).toHaveLength(0);
  });
});
