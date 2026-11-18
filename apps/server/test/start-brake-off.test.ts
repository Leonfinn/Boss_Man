// R47: the start brake has no limit and the merge line has grown for an hour: the banner's words and one CEO wake per stretch.
import { afterEach, describe, expect, it } from "vitest";
import { openPglite } from "../src/db/client.js";
import { companies } from "../src/db/schema.js";
import { startBrakeOff, startBrakeText } from "../src/services/merge-line-health.js";
import { BRAKE_OFF_REASON, mergeJamService } from "../src/services/merge-jam.js";
import { WAKE_CLASS } from "../src/services/wake-classes.js";

const NOW = new Date("2026-11-17T12:00:00Z");
const ago = (min: number) => NOW.getTime() - min * 60_000;
// 24 landings in the day: 1 an hour, so 2.5 h of rate rounds to 3 (the floor), unless more landed.
const landings = (n: number) => Array.from({ length: n }, (_, i) => ago(30 + i * 20));

describe("startBrakeOff", () => {
  it("says nothing when a limit is set, however long the line", () => {
    const waiting = Array.from({ length: 40 }, () => ({ minutes: 5 }));
    expect(startBrakeOff({ brakeLimit: 20, waiting, landed: [], now: NOW })).toBeNull();
  });

  it("warns with a suggested limit of about 2.5 h of today's landing rate", () => {
    // 48 landings in 24 h = 2 an hour: 2.5 h = 5. 10 joined the line in the last hour, 2 landed.
    const waiting = Array.from({ length: 12 }, (_, i) => ({ minutes: i < 10 ? 10 : 300 }));
    const landed = [...landings(46), ago(10), ago(20)];
    const w = startBrakeOff({ brakeLimit: null, waiting, landed, now: NOW });
    expect(w).toEqual({ waiting: 12, suggestedLimit: 5 });
    expect(startBrakeText(w!)).toBe("Start brake off, 12 waiting; suggested limit 5");
  });

  it("says nothing while the line has not grown for an hour (as many landed as joined)", () => {
    const waiting = Array.from({ length: 30 }, (_, i) => ({ minutes: i < 3 ? 10 : 300 }));
    expect(startBrakeOff({ brakeLimit: null, waiting, landed: [ago(5), ago(20), ago(40)], now: NOW })).toBeNull();
  });

  it("says nothing for a short line the suggested limit would not hold", () => {
    expect(startBrakeOff({ brakeLimit: null, waiting: [{ minutes: 5 }, { minutes: 6 }], landed: [], now: NOW })).toBeNull();
  });

  it("uses no host-specific value: the floor is 3 with no landings at all", () => {
    const waiting = Array.from({ length: 6 }, () => ({ minutes: 5 }));
    expect(startBrakeOff({ brakeLimit: null, waiting, landed: [], now: NOW })?.suggestedLimit).toBe(3);
  });
});

describe("the CEO's wake", () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await close?.();
    close = undefined;
  });

  it("is a never-dropped waiting wake, sent once per stretch and again after the warning clears", async () => {
    expect(WAKE_CLASS[BRAKE_OFF_REASON]).toBe("waiting");
    const opened = await openPglite();
    close = opened.close;
    const { db } = opened;
    const [co] = await db.insert(companies).values({ name: "Co" }).returning();
    const view = { current: null as unknown };
    const waiting = [{ ticketId: "t1", minutes: 5 }];
    const warn = { waiting: 12, suggestedLimit: 5 };
    const woken: Array<{ ticketId: string; reason?: string; note: string }> = [];
    const svc = mergeJamService(db, {
      view: async () => view.current as never,
      notify: async () => null,
      tellCeo: async (i) => void woken.push(i),
      now: () => NOW,
    });
    view.current = { companyId: co!.id, waiting, running: [], recent: [], slots: 3, startBrakeOff: warn, line: { state: "healthy" } };
    await svc.run();
    await svc.run();
    expect(woken).toHaveLength(1);
    expect(woken[0]!.reason).toBe(BRAKE_OFF_REASON);
    expect(woken[0]!.note).toContain("Start brake off, 12 waiting; suggested limit 5");
    // The owner sets a limit: the warning goes, and says nothing.
    view.current = { ...(view.current as object), startBrakeOff: null };
    await svc.run();
    expect(woken).toHaveLength(1);
    // A new stretch wakes once more.
    view.current = { ...(view.current as object), startBrakeOff: warn };
    await svc.run();
    expect(woken).toHaveLength(2);
  });
});
