// BOS-2866: similarTickets' database rules. A ticket is a possible duplicate when it is open, or
// done (not cancelled) in the last 14 days, in the same company and project, with a similar title.
// This calls the function directly against an in-memory database.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openPglite } from "../src/db/client.js";
import { companies, projects, tickets } from "../src/db/schema.js";
import { similarTickets } from "../src/services/duplicate-titles.js";

const DAY = 24 * 3_600_000;
const now = new Date("2026-11-28T12:00:00Z");

let db: Awaited<ReturnType<typeof openPglite>>["db"];
let close: (() => Promise<void>) | undefined;
let serial = 0;

beforeAll(async () => {
  const opened = await openPglite(undefined, { fresh: true });
  db = opened.db;
  close = opened.close;
});
afterAll(async () => void (await close?.()));

async function makeCompany(prefix = "DUP") {
  const [c] = await db.insert(companies).values({ name: `Dup Co ${++serial}`, ticketPrefix: prefix }).returning();
  return c!;
}

async function makeProject(companyId: string) {
  const [p] = await db.insert(projects).values({ companyId, name: `Project ${++serial}` }).returning();
  return p!;
}

async function makeTicket(companyId: string, projectId: string, patch: Partial<typeof tickets.$inferInsert>) {
  const [t] = await db.insert(tickets).values({ companyId, projectId, title: "Untitled", number: ++serial, ...patch }).returning();
  return t!;
}

const TITLE = "Board shows stuck cards in review column";
const SIMILAR = "Board stuck cards in review column again";

describe("similarTickets", () => {
  it("returns an open ticket with its ref, title and state", async () => {
    const co = await makeCompany("DUP");
    const project = await makeProject(co.id);
    const t = await makeTicket(co.id, project.id, { title: TITLE, systemState: "in_progress", number: 42 });

    const found = await similarTickets(db, co.id, project.id, SIMILAR, now);

    expect(found).toEqual([{ id: t.id, ref: "DUP-42", title: TITLE, state: "in_progress" }]);
  });

  it("includes a ticket done 13 days ago and leaves out one done 15 days ago", async () => {
    const co = await makeCompany();
    const project = await makeProject(co.id);
    const recent = await makeTicket(co.id, project.id, {
      title: "Stuck cards in review column on board",
      systemState: "done",
      outcome: "completed",
      stateChangedAt: new Date(now.getTime() - 13 * DAY),
      number: 101,
    });
    const old = await makeTicket(co.id, project.id, {
      title: "Stuck cards in review column on board, old",
      systemState: "done",
      outcome: "completed",
      stateChangedAt: new Date(now.getTime() - 15 * DAY),
      number: 102,
    });

    const found = await similarTickets(db, co.id, project.id, SIMILAR, now);

    expect(found.map((r) => r.id)).toEqual([recent.id]);
    expect(found.map((r) => r.id)).not.toContain(old.id);
  });

  it("leaves out a cancelled ticket done yesterday", async () => {
    const co = await makeCompany();
    const project = await makeProject(co.id);
    await makeTicket(co.id, project.id, {
      title: "Stuck cards in review column on board",
      systemState: "done",
      outcome: "cancelled",
      stateChangedAt: new Date(now.getTime() - 1 * DAY),
    });

    expect(await similarTickets(db, co.id, project.id, SIMILAR, now)).toEqual([]);
  });

  it("leaves out a similar title in another project or another company", async () => {
    const co = await makeCompany();
    const project = await makeProject(co.id);
    const otherProject = await makeProject(co.id);
    await makeTicket(co.id, otherProject.id, { title: TITLE, systemState: "in_progress" });

    const otherCo = await makeCompany();
    const otherCoProject = await makeProject(otherCo.id);
    await makeTicket(otherCo.id, otherCoProject.id, { title: TITLE, systemState: "in_progress" });

    expect(await similarTickets(db, co.id, project.id, SIMILAR, now)).toEqual([]);
  });

  it("leaves out a dissimilar title", async () => {
    const co = await makeCompany();
    const project = await makeProject(co.id);
    await makeTicket(co.id, project.id, { title: "Website release notes feed", systemState: "in_progress" });

    expect(await similarTickets(db, co.id, project.id, SIMILAR, now)).toEqual([]);
  });
});
