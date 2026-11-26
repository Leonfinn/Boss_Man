// BOS-2674: a host warning seen in 2 different host reports tells the CEO once; it closes when the host stops reporting it.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openPglite } from "../src/db/client.js";
import { settings } from "../src/db/schema.js";
import { clearWhenOf } from "../src/services/alert-clearing.js";
import { kindCeiling } from "../src/services/alert-kinds.js";
import { HOST_FACTS_KEY, type HostFactsRecord } from "../src/services/host-facts.js";
import { hostWarningGoneReason, hostWarningService, warningKeys } from "../src/services/host-warnings.js";

let db: Awaited<ReturnType<typeof openPglite>>["db"];
let close: () => Promise<void>;
beforeEach(async () => {
  ({ db, close } = await openPglite());
});
afterEach(async () => {
  await close();
});

const NOW = new Date("2026-11-26T12:00:00Z");
const fact = (value: string) => ({ value, source: "host" as const, at: "x" });
const rec = (reportedAt: string, facts: Record<string, string>): HostFactsRecord => ({ hostName: "host-a", reportedAt, facts: Object.fromEntries(Object.entries(facts).map(([k, v]) => [k, fact(v)])) });

function setup(open = false) {
  const raised: Array<Record<string, unknown>> = [];
  let current = rec("2026-11-26T11:59:00Z", {});
  const svc = hostWarningService(db, {
    now: () => NOW,
    facts: async () => current,
    homeCompany: async () => "co-1",
    isOpen: async () => open || raised.length > 0,
    raise: async (i) => (raised.push(i), { id: "card" }),
  });
  return { svc, raised, report: (at: string, facts: Record<string, string>) => (current = rec(at, facts)) };
}

describe("warningKeys", () => {
  it("lists failing checks and add-ons that are not running, and nothing else", () => {
    const f = Object.fromEntries(Object.entries({ "check.container_status.unhealthy": "1", "check.container_status.total": "9", "addon.ntfy": "stopped", "addon.penpot": "running", "repo.probe": "ok" }).map(([k, v]) => [k, { value: v }]));
    expect(warningKeys(f)).toEqual(["addon.ntfy", "check.container_status.unhealthy"]);
  });
});

describe("host warning watch", () => {
  it("waits for a second host report, then tells the CEO once", async () => {
    const t = setup();
    t.report("2026-11-26T11:58:00Z", { "check.container_status.unhealthy": "1" });
    expect(await t.svc.check()).toEqual([]);
    expect(await t.svc.check()).toEqual([]); // the same report again is not a second report
    expect((await t.svc.handling())["check.container_status.unhealthy"]).toMatchObject({ state: "watching", reports: 1 });
    t.report("2026-11-26T11:59:00Z", { "check.container_status.unhealthy": "1" });
    expect(await t.svc.check()).toEqual(["check.container_status.unhealthy"]);
    expect(t.raised[0]).toMatchObject({ kind: "host_warning", from: "ceo", dedupeKey: "alert:host-warning:check.container_status.unhealthy", clearWhen: [{ kind: "hostWarningGone", key: "check.container_status.unhealthy" }] });
    expect(String(t.raised[0]!.question)).not.toMatch(/\bowner must\b/i);
    t.report("2026-11-26T11:59:30Z", { "check.container_status.unhealthy": "1" });
    expect(await t.svc.check()).toEqual([]); // the card is open: no second one
    expect(t.raised).toHaveLength(1);
    expect((await t.svc.handling())["check.container_status.unhealthy"]).toMatchObject({ state: "ceo_told", reports: 3 });
  });

  it("starts the count again when the warning goes away between reports", async () => {
    const t = setup();
    t.report("2026-11-26T11:50:00Z", { "addon.ntfy": "stopped" });
    await t.svc.check();
    t.report("2026-11-26T11:51:00Z", {});
    await t.svc.check();
    t.report("2026-11-26T11:52:00Z", { "addon.ntfy": "stopped" });
    expect(await t.svc.check()).toEqual([]);
  });

  it("ignores a report that is too old to trust", async () => {
    const t = setup();
    t.report("2026-11-26T09:00:00Z", { "addon.ntfy": "stopped" });
    expect(await t.svc.check()).toEqual([]);
  });
});

describe("the closer", () => {
  it("holds while the host still reports the warning and lets go when it does not", async () => {
    const put = (facts: Record<string, string>) => db.insert(settings).values({ key: HOST_FACTS_KEY, value: rec("2026-11-26T11:59:00Z", facts) }).onConflictDoUpdate({ target: settings.key, set: { value: rec("2026-11-26T11:59:00Z", facts) } });
    await put({ "addon.ntfy": "stopped" });
    expect(await hostWarningGoneReason(db, "addon.ntfy")).toBeNull();
    await put({ "addon.ntfy": "running" });
    expect(await hostWarningGoneReason(db, "addon.ntfy")).toContain("no longer reports");
  });

  it("is a CEO-ceiling kind whose clearWhen survives a round trip", () => {
    expect(kindCeiling("host_warning", undefined)).toBe("ceo");
    expect(clearWhenOf({ clearWhen: [{ kind: "hostWarningGone", key: "addon.ntfy" }] })).toEqual([{ kind: "hostWarningGone", key: "addon.ntfy" }]);
  });
});
