// BOS-2317: the Runs page's "Search by ticket": /api/runs/recent takes q, a ticket ref (any case) or words in the title.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openPglite } from "../src/db/client.js";
import { companies, projects, runs, tickets } from "../src/db/schema.js";
import { runsService } from "../src/services/runs.js";

let close: () => Promise<void>;
let svc: ReturnType<typeof runsService>;
let companyId: string;
const ids: Record<string, string> = {};

beforeAll(async () => {
  const pg = await openPglite(undefined, { fresh: true });
  close = pg.close;
  const [co] = await pg.db.insert(companies).values({ name: "Example Co", ticketPrefix: "BOS" }).returning();
  companyId = co!.id;
  const [p] = await pg.db.insert(projects).values({ companyId, name: "Dev" }).returning();
  const mk = async (key: string, number: number, title: string, minutesAgo: number) => {
    const [t] = await pg.db.insert(tickets).values({ companyId, projectId: p!.id, title, number }).returning();
    const [r] = await pg.db
      .insert(runs)
      .values({ companyId, ticketId: t!.id, startedAt: new Date(Date.now() - (minutesAgo + 1) * 60_000), endedAt: new Date(Date.now() - minutesAgo * 60_000) })
      .returning();
    ids[key] = r!.id;
  };
  await mk("a", 2250, "Fix the 100% login_bug", 5);
  await mk("b", 22501, "Another ticket", 4);
  await mk("c", 7, "Login page polish", 3);
  svc = runsService(pg.db, { runners: {} as never });
});
afterAll(async () => close?.());

const found = async (q?: string, extra: { before?: Date } = {}) => (await svc.recent(50, companyId, { q, ...extra })).map((r) => r.id);

describe("runsService.recent with q", () => {
  it("returns every run with no q", async () => {
    expect((await found()).length).toBe(3);
  });

  it("finds runs on a ticket by ref in any case, and not a ticket whose number only starts the same", async () => {
    expect(await found("BOS-2250")).toEqual([ids.a]);
    expect(await found("bos-2250")).toEqual([ids.a]);
    expect(await found("OTHER-2250")).toEqual([]);
  });

  it("matches the title case-insensitively, treating % and _ as plain characters", async () => {
    expect(await found("LOGIN")).toEqual([ids.c, ids.a]);
    expect(await found("100% login_bug")).toEqual([ids.a]);
    expect(await found("%")).toEqual([ids.a]);
    expect(await found("login_b")).toEqual([ids.a]);
    expect(await found("loginXbug")).toEqual([]);
  });

  it("combines with before", async () => {
    // The run on "Login page polish" ended 3 minutes ago, the one on 2250 five minutes ago.
    expect(await found("login", { before: new Date(Date.now() - 3.5 * 60_000) })).toEqual([ids.a]);
  });
});
