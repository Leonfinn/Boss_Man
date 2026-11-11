// Server-health alerts (BOS-640, DR-016): memory to the CEO, freezes to the owner, one card per rule while
// it is open, each naming what to press and closing itself after 30 calm minutes. All readings are made up.
import { randomBytes } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { eq, like } from "drizzle-orm";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { decisions } from "../src/db/schema.js";
import type { AlertInput } from "../src/services/alert-ladder.js";
import { CALM_MS, readMemoryLimit, serverHealthService, type MemoryLimit } from "../src/services/server-health.js";

const MIN = 60_000;
const GiB = 1024;

function fake(o: { limit?: MemoryLimit | null; updateCard?: { id: string; question: string } | null } = {}) {
  let t = Date.parse("2026-11-07T10:00:00Z");
  let rss = 2 * GiB;
  let freezes = 0;
  const raised: AlertInput[] = [];
  const open = new Set<string>();
  const svc = serverHealthService({
    now: () => t,
    rssMb: () => rss,
    memoryLimit: async () => (o.limit === undefined ? { mb: 16 * GiB, source: "container limit" } : o.limit),
    stallsSince: () => ({ count: freezes, worstMs: freezes ? 4200 : 0, thresholdMs: 1000 }),
    homeCompany: async () => "co-1",
    openUpdateCard: async () => o.updateCard ?? null,
    isOpen: async (key) => open.has(key),
    raise: async (input) => {
      raised.push(input);
      open.add(input.dedupeKey!);
      return { id: `card-${raised.length}` };
    },
  });
  return {
    svc,
    raised,
    open,
    set: (v: { rss?: number; freezes?: number }) => ((rss = v.rss ?? rss), (freezes = v.freezes ?? freezes)),
    /** Checks once a minute for `minutes` minutes. */
    async run(minutes: number, each?: (i: number) => void) {
      for (let i = 0; i < minutes; i++) {
        each?.(i);
        await svc.check();
        t += MIN;
      }
    },
  };
}

describe("freeze rule: more than 10 freezes in 10 minutes reaches the owner (BOS-640)", () => {
  it("raises one owner card naming the restart, and none for 10", async () => {
    const f = fake();
    f.set({ freezes: 10 });
    await f.run(3);
    expect(f.raised).toHaveLength(0);
    f.set({ freezes: 11 });
    await f.run(5);
    expect(f.raised).toHaveLength(1);
    const card = f.raised[0]!;
    expect(card).toMatchObject({ kind: "server_freezes", from: "owner", dedupeKey: "alert:server-freezes", clearWhen: [{ kind: "serverCalm", rule: "freezes" }] });
    expect(card.question).toContain("froze 11 times");
    expect(card.question).toContain("restart the server");
    // BOS-647: the card names the Settings button, not a step on the host.
    expect(card.question).toContain("Settings → Server and runner → Updates → Restart the server");
    expect(card.question).not.toContain("server container");
    expect(card.question).toMatch(/closes itself once there have been 10 or fewer freezes in 10 minutes for 30 minutes/);
  });

  it("names the open server update card when there is one", async () => {
    const f = fake({ updateCard: { id: "d-1", question: "Deploy Boss Man 1234 -> 5678? 3 files changed.\n\nmore" } });
    f.set({ freezes: 20 });
    await f.run(1);
    expect(f.raised[0]!.question).toContain('approve the open server update card ("Deploy Boss Man 1234 -> 5678? 3 files changed.")');
    expect(f.raised[0]!.question).not.toContain("restart Boss Man's server container");
  });

  it("clears only after 30 minutes under the level, and a new episode raises a new card", async () => {
    const f = fake();
    f.set({ freezes: 15 });
    await f.run(2);
    expect(f.svc.calmReason("freezes")).toBeNull();
    f.set({ freezes: 3 });
    // The last reading over the level was a minute in; 28 more checks leave it 29 minutes calm.
    await f.run(28);
    expect(f.svc.calmReason("freezes")).toBeNull();
    await f.run(2);
    expect(f.svc.calmReason("freezes")).toMatch(/10 or fewer freezes in every 10 minutes for 3\d minutes/);
    // The owner answered it while it was still over: no second card in the same episode.
    const g = fake();
    g.set({ freezes: 15 });
    await g.run(1);
    g.open.clear();
    await g.run(10);
    expect(g.raised).toHaveLength(1);
    // Calm for 30 minutes ends the episode; freezing again is a new card.
    g.set({ freezes: 0 });
    await g.run(31);
    g.set({ freezes: 12 });
    await g.run(1);
    expect(g.raised).toHaveLength(2);
  });

  it("never calls a rule calm when nothing is being measured", async () => {
    const f = fake();
    expect(f.svc.calmReason("freezes")).toBeNull();
    await f.run(31);
    expect(f.svc.calmReason("freezes")).not.toBeNull();
    // Readings stopped (this process lost the lead): no calm on stale readings.
    const g = fake();
    await g.run(31);
    const late = serverHealthService({ now: () => Date.now() + 3_600_000, stallsSince: () => ({ count: 0, worstMs: 0, thresholdMs: 1000 }), homeCompany: async () => null, openUpdateCard: async () => null, isOpen: async () => false, raise: async () => null });
    expect(late.calmReason("freezes")).toBeNull();
  });
});

describe("memory rule: 60% of the memory the server may use, or 1 GiB an hour for 2 hours, reaches the CEO (BOS-640)", () => {
  it("raises one CEO card above 60% of the reported limit, none at or below it", async () => {
    const f = fake({ limit: { mb: 10_000, source: "container limit" } });
    f.set({ rss: 6000 });
    await f.run(3);
    expect(f.raised).toHaveLength(0);
    f.set({ rss: 6100 });
    await f.run(10);
    expect(f.raised).toHaveLength(1);
    expect(f.raised[0]).toMatchObject({ kind: "server_memory", from: "ceo", dedupeKey: "alert:server-memory", clearWhen: [{ kind: "serverCalm", rule: "memory" }] });
    expect(f.raised[0]!.question).toContain("61% of the 9.8 GB it may use (container limit)");
    expect(f.raised[0]!.question).toMatch(/closes itself once memory has stayed under 60%.*for 30 minutes/);
  });

  it("raises on more than 1 GiB an hour for 2 hours, not on 1 hour or a slower climb", async () => {
    // Far below 60% of a large host, so only the rise can trip it. Samples every minute.
    const steep = fake({ limit: { mb: 1024 * GiB, source: "host memory" } });
    await steep.run(121, (i) => steep.set({ rss: 2 * GiB + Math.round((i * 1.2 * GiB) / 60) }));
    expect(steep.raised).toHaveLength(1);
    expect(steep.raised[0]!.question).toContain("grown more than 1.0 GB in each of the last two hours");

    const slow = fake({ limit: { mb: 1024 * GiB, source: "host memory" } });
    await slow.run(181, (i) => slow.set({ rss: 2 * GiB + Math.round((i * 0.8 * GiB) / 60) }));
    expect(slow.raised).toHaveLength(0);

    // One steep hour after a flat one is a jump, not a climb.
    const oneHour = fake({ limit: { mb: 1024 * GiB, source: "host memory" } });
    await oneHour.run(121, (i) => oneHour.set({ rss: i < 60 ? 2 * GiB : 2 * GiB + Math.round(((i - 60) * 3 * GiB) / 60) }));
    expect(oneHour.raised).toHaveLength(0);
  });

  it("with no limit reported, only the rise rule applies", async () => {
    const f = fake({ limit: null });
    f.set({ rss: 900 * GiB });
    await f.run(5);
    expect(f.raised).toHaveLength(0);
  });

  it("clears 30 minutes after memory falls back under the level", async () => {
    const f = fake({ limit: { mb: 10_000, source: "container limit" } });
    f.set({ rss: 7000 });
    await f.run(5);
    f.set({ rss: 3000 });
    await f.run(CALM_MS / MIN - 2);
    expect(f.svc.calmReason("memory")).toBeNull();
    await f.run(2);
    expect(f.svc.calmReason("memory")).toMatch(/memory has stayed under the alert level/);
  });
});

describe("the memory the server may use is read, never assumed (BOS-640)", () => {
  const dirs: string[] = [];
  afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));
  const cg = (files: Record<string, string>) => {
    const d = mkdtempSync(join(tmpdir(), "health-cg-"));
    dirs.push(d);
    for (const [f, text] of Object.entries(files)) {
      mkdirSync(join(d, f, ".."), { recursive: true });
      writeFileSync(join(d, f), text);
    }
    return d;
  };
  const total = 32 * 1024 ** 3;

  it("uses a cgroup v2 limit below the machine's total", async () => {
    expect(await readMemoryLimit({ dir: cg({ "memory.max": "8589934592\n" }), totalBytes: total })).toEqual({ mb: 8192, source: "container limit" });
  });
  it("uses the machine's total when the limit is max (v2) or the v1 no-limit value", async () => {
    expect(await readMemoryLimit({ dir: cg({ "memory.max": "max\n" }), totalBytes: total })).toEqual({ mb: 32768, source: "host memory" });
    expect(await readMemoryLimit({ dir: cg({ "memory/memory.limit_in_bytes": "9223372036854771712\n" }), totalBytes: total })).toEqual({ mb: 32768, source: "host memory" });
  });
  it("uses a cgroup v1 limit, and a smaller host-reported total wins", async () => {
    expect(await readMemoryLimit({ dir: cg({ "memory/memory.limit_in_bytes": "4294967296" }), totalBytes: total })).toEqual({ mb: 4096, source: "container limit" });
    expect(await readMemoryLimit({ dir: cg({}), totalBytes: total, hostTotalMb: async () => 12_000 })).toEqual({ mb: 12_000, source: "host-reported memory" });
  });
});

describe("through the app: the owner's freeze card and its closer (BOS-640)", () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await close?.();
    close = undefined;
  });

  it("puts one freeze card on the owner's queue and closes it by itself after 30 calm minutes", async () => {
    const { db, close: closeDb } = await openPglite();
    let offset = 0;
    const clock = () => new Date(Date.now() + offset);
    let freezes = 14;
    const built = await buildApp({
      db,
      master: { version: 1, key: randomBytes(32) },
      secureCookies: false,
      tickOnWake: false,
      workspaceRoot: "/ws",
      now: clock,
      serverHealth: { rssMb: () => 3000, memoryLimit: async () => ({ mb: 16_000, source: "container limit" }), stallsSince: () => ({ count: freezes, worstMs: 6100, thresholdMs: 1000 }) },
    });
    close = async () => (await built.app.close(), await closeDb());
    const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
    const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
    const req = (method: "GET" | "POST", url: string, payload?: object) => built.app.inject({ method, url, headers: { cookie }, ...(payload ? { payload } : {}) });
    await req("POST", "/api/companies", { name: "Home Co" });

    await built.serverHealth.check();
    offset += MIN;
    await built.serverHealth.check();
    const queue = (await req("GET", "/api/decisions")).json() as Array<{ id: string; tier: string; question: string }>;
    const mine = queue.filter((d) => d.question.includes("froze 14 times"));
    expect(mine).toHaveLength(1);
    expect(mine[0]!.tier).toBe("owner");
    expect(mine[0]!.question).toContain("restart the server");
    expect(mine[0]!.question).toContain("closes itself");

    // Freezes stop. Not closed before 30 minutes, closed after, with the reason.
    freezes = 0;
    for (let i = 0; i < 20; i++) {
      offset += MIN;
      await built.serverHealth.check();
    }
    await req("POST", "/api/sweep");
    expect((await db.select().from(decisions).where(eq(decisions.id, mine[0]!.id)))[0]!.status).toBe("open");
    for (let i = 0; i < 12; i++) {
      offset += MIN;
      await built.serverHealth.check();
    }
    await req("POST", "/api/sweep");
    const [row] = await db.select().from(decisions).where(eq(decisions.id, mine[0]!.id));
    expect(row!.status).toBe("withdrawn");
    expect((row!.context as { withdrawn?: { note?: string } }).withdrawn?.note).toMatch(/10 or fewer freezes/);
    // Only ever the one card.
    expect(await db.select().from(decisions).where(like(decisions.question, "%froze%"))).toHaveLength(1);
  });
});
