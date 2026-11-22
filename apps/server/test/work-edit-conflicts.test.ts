// The pure edit-conflicts check (BOS-905): a save is refused only for a text field the page edited,
// when what the page loaded no longer matches what the ticket now stores.
import { describe, expect, it } from "vitest";
import { editConflicts } from "../src/services/work.js";
import type { tickets } from "../src/db/schema.js";

type TicketRow = typeof tickets.$inferSelect;

/** Only the three fields editConflicts reads matter here; the rest of a ticket row is irrelevant. */
const ticket = (overrides: Partial<Pick<TicketRow, "title" | "body" | "acceptanceCriteria">> = {}): TicketRow =>
  ({ title: "Add rate limiting", body: "Original body", acceptanceCriteria: [], ...overrides }) as unknown as TicketRow;

describe("editConflicts", () => {
  it("reports nothing for an empty patch", () => {
    expect(editConflicts(ticket(), {})).toEqual([]);
  });

  it("reports nothing when every edited field's loaded value still matches the stored one", () => {
    const t = ticket({ acceptanceCriteria: ["Health check returns 200"] });
    expect(
      editConflicts(t, {
        title: "The owner's title",
        titleLoaded: "Add rate limiting",
        body: "The owner's words",
        bodyLoaded: "Original body",
        acceptanceCriteria: ["The owner's own line"],
        acceptanceCriteriaLoaded: ["Health check returns 200"],
      }),
    ).toEqual([]);
  });

  it("reports a title conflict when someone else renamed the ticket", () => {
    const conflicts = editConflicts(ticket({ title: "Renamed by an agent" }), { title: "The owner's title", titleLoaded: "Add rate limiting" });
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.field).toBe("title");
    expect(conflicts[0]!.message).toMatch(/The title was changed by someone else/i);
  });

  it("reports a description conflict when someone else changed the body", () => {
    const conflicts = editConflicts(ticket({ body: "Changed by the CEO" }), { body: "The owner's new words", bodyLoaded: "Original body" });
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.field).toBe("body");
    expect(conflicts[0]!.message).toMatch(/The description was changed by someone else/i);
  });

  it("reports an acceptance-criteria conflict when someone else added a criterion", () => {
    const t = ticket({ acceptanceCriteria: ["Health check returns 200", "Added by an agent"] });
    const conflicts = editConflicts(t, {
      acceptanceCriteria: ["The owner's own line"],
      acceptanceCriteriaLoaded: ["Health check returns 200"],
    });
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.field).toBe("acceptanceCriteria");
    expect(conflicts[0]!.message).toMatch(/The acceptance criteria was changed by someone else/i);
  });

  it("reports every conflicting field, in title, description, acceptance-criteria order", () => {
    const t = ticket({ title: "A", body: "B", acceptanceCriteria: ["C"] });
    const conflicts = editConflicts(t, {
      title: "Owner's title",
      titleLoaded: "Old title",
      body: "Owner's body",
      bodyLoaded: "Old body",
      acceptanceCriteria: ["Owner's line"],
      acceptanceCriteriaLoaded: ["Old line"],
    });
    expect(conflicts.map((c) => c.field)).toEqual(["title", "body", "acceptanceCriteria"]);
  });

  it("treats an empty stored description and a loaded null as the same", () => {
    expect(editConflicts(ticket({ body: null }), { body: "Now there is one", bodyLoaded: null })).toEqual([]);
  });

  it("reports a conflict when the description was emptied elsewhere and the page loaded text", () => {
    const conflicts = editConflicts(ticket({ body: null }), { body: "The owner's words", bodyLoaded: "Original body" });
    expect(conflicts.map((c) => c.field)).toEqual(["body"]);
  });

  it("treats a loaded empty criteria list as matching an empty stored list", () => {
    expect(editConflicts(ticket(), { acceptanceCriteria: ["A new line"], acceptanceCriteriaLoaded: [] })).toEqual([]);
  });

  it("does not check a field whose loaded value the caller did not send", () => {
    const t = ticket({ title: "Renamed elsewhere", body: "Body changed elsewhere", acceptanceCriteria: ["Added elsewhere"] });
    expect(editConflicts(t, { title: "New title", body: "New body" })).toEqual([]);
  });

  it("does not check acceptance criteria when the save does not touch them", () => {
    const t = ticket({ acceptanceCriteria: ["Added elsewhere"] });
    expect(editConflicts(t, { title: "New title", titleLoaded: "Add rate limiting" })).toEqual([]);
  });
});
