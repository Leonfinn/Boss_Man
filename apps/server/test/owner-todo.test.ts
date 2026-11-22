// BOS-1576: an owner to-do always has a card. The wording check and the hourly backup sweep.
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { openPglite } from "../src/db/client.js";
import { companies, decisions, projects, tickets } from "../src/db/schema.js";
import { ownerWaitWatch, waitsOnOwnerNote } from "../src/services/owner-todo.js";

describe("waitsOnOwnerNote", () => {
  it.each([
    "Waiting on the owner to say keep or drop.",
    "Waiting for the owner's answer on the Cloudflare steps",
    "Needs the owner to run the deploy",
    "Parked: keep or drop is the owner's call",
  ])("flags %j", (note) => expect(waitsOnOwnerNote(note)).toBe(true));

  it.each([
    "Nothing is waiting on the owner; building the footer.",
    "No longer waiting for the owner: they answered.",
    "Passed review and waits on the owner's sign-off.",
    "Waiting on the CEO to pick a reviewer.",
    "The owner asked for a darker footer; done.",
    "",
    null,
  ])("leaves %j", (note) => expect(waitsOnOwnerNote(note)).toBe(false));
});

describe("ownerWaitWatch (hourly backup)", () => {
  it("tells the CEO once about an old owner-wait note with no card, and not about one with a card or a fresh one", async () => {
    const { db, close } = await openPglite();
    try {
      const [co] = await db.insert(companies).values({ name: "Sweep Co", slug: "sweep-co" } as never).returning();
      const [p] = await db.insert(projects).values({ companyId: co!.id, name: "App" } as never).returning();
      const t0 = new Date("2026-11-15T10:00:00Z");
      const mk = async (title: string, note: string, at: Date) =>
        (await db.insert(tickets).values({ companyId: co!.id, projectId: p!.id, title, systemState: "backlog", stateNote: note, stateNoteAt: at } as never).returning())[0]!;
      const old = await mk("Old", "Waiting on the owner to say keep or drop.", t0);
      const carded = await mk("Carded", "Waiting on the owner to say keep or drop.", t0);
      await mk("Fresh", "Waiting on the owner.", new Date("2026-11-15T11:50:00Z"));
      await db.insert(decisions).values({ companyId: co!.id, kind: "question", question: "Keep or drop?", options: ["Keep", "Drop"], recommendedOption: "Keep", status: "open", context: { ticketId: carded.id } } as never);

      let clock = new Date("2026-11-15T12:00:00Z");
      const told: string[] = [];
      const watch = ownerWaitWatch(db, async (_c, note) => void told.push(note), () => clock);
      expect(await watch.run()).toEqual({ flagged: 1 });
      expect(told).toHaveLength(1);
      expect(told[0]).toContain(old.id);
      // Within the hour the sweep does nothing; the next hour it doesn't repeat itself for the same note.
      expect(await watch.run()).toEqual({ flagged: 0 });
      clock = new Date("2026-11-15T13:05:00Z");
      // The note that was fresh at noon is now over an hour old and is flagged; the old one is not repeated.
      expect(await watch.run()).toEqual({ flagged: 1 });
      expect(told).toHaveLength(2);
      // Once the note changes to a new owner-wait, it is flagged again.
      await db.update(tickets).set({ stateNote: "Waiting for the owner's answer.", stateNoteAt: new Date("2026-11-15T12:10:00Z") }).where(eq(tickets.id, old.id));
      clock = new Date("2026-11-15T14:10:00Z");
      expect(await watch.run()).toEqual({ flagged: 1 });
    } finally {
      await close();
    }
  });
});
