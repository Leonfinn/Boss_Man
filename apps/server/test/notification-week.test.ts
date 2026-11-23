import { randomBytes } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { agents, companies, notifications } from "../src/db/schema.js";
import { signIn } from "./helpers.js";
import { dayIn, lastSevenDays, summarizeWeek, type WeekRow } from "../src/services/notification-week.js";

const NOW = new Date("2026-11-23T01:30:00Z");
const row = (o: Partial<Omit<WeekRow, "createdAt" | "pushedAt">> & { createdAt: string; pushedAt?: string }): WeekRow => ({
  id: o.id ?? "n1",
  createdAt: new Date(o.createdAt),
  pushedAt: o.pushedAt ? new Date(o.pushedAt) : null,
  demotedBy: o.demotedBy ?? null,
  pushError: o.pushError ?? null,
  agentId: o.agentId ?? null,
  agentName: o.agentName ?? null,
  link: o.link ?? "#/runs/1",
  title: o.title ?? "t",
});

it("groups by day in the owner's time zone, not UTC", () => {
  // 01:30 UTC on the 23rd is still the 22nd in New York.
  expect(dayIn("America/New_York", NOW)).toBe("2026-11-22");
  expect(lastSevenDays("America/New_York", NOW).at(-1)).toBe("2026-11-22");
  expect(lastSevenDays("UTC", NOW)).toHaveLength(7);
});

it("counts pushed, quiet-hours, cap and failed per day and in total", () => {
  const s = summarizeWeek(
    [
      row({ id: "a", createdAt: "2026-11-23T00:10:00Z", pushedAt: "2026-11-23T00:10:01Z", agentId: "x", agentName: "Ann" }),
      row({ id: "b", createdAt: "2026-11-22T10:00:00Z", demotedBy: "quiet hours", agentId: "x", agentName: "Ann" }),
      row({ id: "c", createdAt: "2026-11-22T11:00:00Z", demotedBy: "cap", agentId: "y", agentName: "Bo" }),
      row({ id: "d", createdAt: "2026-11-22T12:00:00Z", pushError: "502 from ntfy", link: "#/notifications/d", agentId: "y", agentName: "Bo" }),
      row({ id: "old", createdAt: "2026-11-01T12:00:00Z", agentId: "z", agentName: "Old" }),
    ],
    "UTC",
    NOW,
  );
  expect(s.totals).toEqual({ notices: 4, pushed: 1, quiet: 1, cap: 1, failed: 1 });
  expect(s.days.find((d) => d.day === "2026-11-22")).toMatchObject({ notices: 3, quiet: 1, cap: 1, failed: 1, pushed: 0 });
  expect(s.topAgents.map((a) => [a.name, a.notices, a.pushed])).toEqual([["Ann", 2, 1], ["Bo", 2, 0]]);
  expect(s.lastFailure).toMatchObject({ id: "d", error: "502 from ntfy", link: "#/notifications/d" });
});

it("an empty week has zero totals and no failure", () => {
  const s = summarizeWeek([], "UTC", NOW);
  expect(s.totals.notices).toBe(0);
  expect(s.days).toHaveLength(7);
  expect(s.lastFailure).toBeNull();
});

let close: (() => Promise<void>) | undefined;
afterEach(async () => void (await close?.()));

// The route, over a seeded database: 9 days of notices, a non-UTC zone, six agents, a second company.
it("the route returns 7 days cut at midnight in the owner's zone, the top 5 agents, the latest failure, and only that company's notices", async () => {
  const { db, close: closeDb } = await openPglite(undefined, { fresh: true });
  const clock = new Date("2026-11-23T01:30:00Z");
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false, now: () => clock });
  close = async () => {
    await built.app.close();
    await closeDb();
  };
  const { cookie } = await signIn({ ...built, db } as never);
  const [co, other] = await db.insert(companies).values([{ name: "Example Co" }, { name: "Other Co" }]).returning();
  const names = ["Ann", "Bo", "Cy", "Di", "Ed", "Flo"];
  const ag = await db.insert(agents).values(names.map((name) => ({ companyId: co!.id, name, role: "worker" as const, agentKind: "claude" }))).returning();
  const put = await built.app.inject({ method: "PUT", url: "/api/notification-settings", headers: { cookie }, payload: { quietHours: { start: "22:00", end: "07:00", timeZone: "America/New_York" }, agentHourlyCap: 6, ntfy: null, publicUrl: null } });
  expect(put.statusCode).toBe(200);
  const base = { requested: "note" as const, level: "note" as const, link: "#/runs/1", title: "t" };
  const at = (s: string) => new Date(s);
  await db.insert(notifications).values([
    // 01:30 UTC on the 23rd is 20:30 on the 22nd in New York: these two belong to the 22nd.
    { ...base, companyId: co!.id, agentId: ag[0]!.id, createdAt: at("2026-11-23T00:30:00Z"), pushedAt: at("2026-11-23T00:30:05Z") },
    { ...base, companyId: co!.id, agentId: ag[0]!.id, createdAt: at("2026-11-22T10:00:00Z"), demotedBy: "quiet hours" },
    { ...base, companyId: co!.id, agentId: ag[1]!.id, createdAt: at("2026-11-21T10:00:00Z"), demotedBy: "cap" },
    { ...base, companyId: co!.id, agentId: ag[1]!.id, createdAt: at("2026-11-20T10:00:00Z"), pushError: "first failure", link: "#/n/1" },
    { ...base, companyId: co!.id, agentId: ag[2]!.id, createdAt: at("2026-11-21T12:00:00Z"), pushError: "latest failure", link: "#/n/2" },
    { ...base, companyId: co!.id, agentId: ag[3]!.id, createdAt: at("2026-11-19T12:00:00Z") },
    { ...base, companyId: co!.id, agentId: ag[4]!.id, createdAt: at("2026-11-18T12:00:00Z") },
    { ...base, companyId: co!.id, agentId: ag[5]!.id, createdAt: at("2026-11-17T12:00:00Z") },
    // 9 and 8 days old: out of the 7 days.
    { ...base, companyId: co!.id, agentId: ag[5]!.id, createdAt: at("2026-11-14T12:00:00Z") },
    { ...base, companyId: co!.id, agentId: ag[5]!.id, createdAt: at("2026-11-15T12:00:00Z") },
    // Another company's notices never count.
    { ...base, companyId: other!.id, createdAt: at("2026-11-22T12:00:00Z"), pushedAt: at("2026-11-22T12:00:01Z"), pushError: "other co" },
  ]);
  const res = await built.app.inject({ method: "GET", url: `/api/notifications/week?company=${co!.id}`, headers: { cookie } });
  expect(res.statusCode).toBe(200);
  const w = res.json();
  expect(w.timeZone).toBe("America/New_York");
  expect(w.days.map((d: { day: string }) => d.day)).toEqual(["2026-11-16", "2026-11-17", "2026-11-18", "2026-11-19", "2026-11-20", "2026-11-21", "2026-11-22"]);
  expect(w.days.at(-1)).toMatchObject({ notices: 2, pushed: 1, quiet: 1 });
  expect(w.days.find((d: { day: string }) => d.day === "2026-11-21")).toMatchObject({ notices: 2, cap: 1, failed: 1 });
  expect(w.totals).toEqual({ notices: 8, pushed: 1, quiet: 1, cap: 1, failed: 2 });
  expect(w.topAgents).toHaveLength(5);
  expect(w.topAgents.map((a: { name: string }) => a.name)).toEqual(["Ann", "Bo", "Cy", "Di", "Ed"]);
  expect(w.topAgents[0]).toMatchObject({ notices: 2, pushed: 1 });
  expect(w.lastFailure).toMatchObject({ error: "latest failure", link: "#/n/2" });
  const none = await built.app.inject({ method: "GET", url: `/api/notifications/week?company=${other!.id}`, headers: { cookie } });
  expect(none.json().totals.notices).toBe(1);
  expect(none.json().topAgents).toEqual([]);
  const bad = await built.app.inject({ method: "GET", url: "/api/notifications/week", headers: { cookie } });
  expect(bad.statusCode).toBe(400);
});
