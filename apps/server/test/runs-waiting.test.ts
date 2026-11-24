// BOS-2320: the Runs page's "Waiting to start": queued and deferred wakes of one company, in launch order, without notes.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openPglite } from "../src/db/client.js";
import { agents, companies, projects, tickets, wakes } from "../src/db/schema.js";
import { runsService } from "../src/services/runs.js";

let close: () => Promise<void>;
let svc: ReturnType<typeof runsService>;
let companyId: string;
let otherId: string;

beforeAll(async () => {
  const pg = await openPglite(undefined, { fresh: true });
  close = pg.close;
  const [co] = await pg.db.insert(companies).values({ name: "Example Co", ticketPrefix: "BOS" }).returning();
  const [other] = await pg.db.insert(companies).values({ name: "Other Co", ticketPrefix: "OTH" }).returning();
  companyId = co!.id;
  otherId = other!.id;
  const [p] = await pg.db.insert(projects).values({ companyId, name: "Dev" }).returning();
  const [a] = await pg.db.insert(agents).values({ companyId, name: "Ada", role: "worker", agentKind: "claude" }).returning();
  const [b] = await pg.db.insert(agents).values({ companyId: otherId, name: "Bo", role: "worker", agentKind: "claude" }).returning();
  const [t] = await pg.db.insert(tickets).values({ companyId, projectId: p!.id, title: "Fix login", number: 12 }).returning();
  const at = (min: number) => new Date(Date.now() - min * 60_000);
  await pg.db.insert(wakes).values([
    { companyId, agentId: a!.id, ticketId: t!.id, reason: "assigned", note: "secret decision answer", priority: 2, createdAt: at(10) },
    { companyId, agentId: a!.id, reason: "chat", priority: 3, createdAt: at(1) },
    { companyId, agentId: a!.id, reason: "review", priority: 2, status: "deferred", statusReason: "quiet hours", notBefore: at(-30), createdAt: at(20) },
    { companyId, agentId: a!.id, reason: "old", status: "launched" },
    { companyId, agentId: a!.id, reason: "gone", status: "dropped", statusReason: "x" },
    { companyId: otherId, agentId: b!.id, reason: "assigned" },
  ]);
  svc = runsService(pg.db, { runners: {} as never });
});
afterAll(async () => close?.());

describe("runsService.waiting", () => {
  it("lists only this company's queued and deferred wakes, by priority then age", async () => {
    const rows = await svc.waiting(companyId);
    expect(rows.map((r) => r.reason)).toEqual(["chat", "review", "assigned"]);
    expect((await svc.waiting(otherId)).map((r) => r.reason)).toEqual(["assigned"]);
  });

  it("gives agent, ticket ref and title, status, why and until when", async () => {
    const rows = await svc.waiting(companyId);
    const assigned = rows.find((r) => r.reason === "assigned")!;
    expect(assigned).toMatchObject({ agent: "Ada", ticket: "Fix login", ticketRef: "BOS-12", status: "queued" });
    const review = rows.find((r) => r.reason === "review")!;
    expect(review).toMatchObject({ status: "deferred", statusReason: "quiet hours", ticketRef: null });
    expect(review.notBefore).toBeInstanceOf(Date);
  });

  it("never returns the note", async () => {
    expect(JSON.stringify(await svc.waiting(companyId))).not.toContain("secret decision answer");
  });
});
