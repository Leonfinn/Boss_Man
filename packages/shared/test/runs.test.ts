import { describe, expect, it } from "vitest";
import { nudgeLabel, RUN_LABEL_REASON_MAX, runLabel, shortReason } from "../src/runs.js";

describe("what a run without a ticket was doing (BOS-118)", () => {
  it("names a nudge's sender and why", () => {
    expect(runLabel({ origin: "nudge", originFrom: "CEO", originNote: "re-check the add-a-skill build" })).toEqual({
      text: "Nudged by CEO: re-check the add-a-skill build",
      unknown: false,
      ticketId: null,
    });
    // A nudge with no words still says who sent it.
    expect(nudgeLabel("Radagast - Tester", "  ")).toBe("Nudged by Radagast - Tester");
    expect(nudgeLabel("", null)).toBe("Nudged by a colleague");
  });

  it("cuts a long nudge reason short, on one line", () => {
    const long = `first line\n${"x".repeat(500)}`;
    const shown = shortReason(long)!;
    expect(shown).toHaveLength(RUN_LABEL_REASON_MAX);
    expect(shown.endsWith("…")).toBe(true);
    expect(shown).not.toContain("\n");
    expect(shortReason("short why")).toBe("short why");
  });

  it("links the ticket a nudge named without the run being on it", () => {
    const label = runLabel({ origin: "nudge", originFrom: "CEO", originNote: "take this on", runTicketId: "11111111-1111-4111-8111-111111111111" });
    expect(label.ticketId).toBe("11111111-1111-4111-8111-111111111111");
  });

  it("labels each kind of scheduled or routine start", () => {
    expect(runLabel({ origin: "wiki upkeep" }).text).toBe("Wiki sweep (scheduled)");
    expect(runLabel({ origin: "missed work" }).text).toBe("A missed-work sweep (scheduled)");
    expect(runLabel({ origin: "ticket watch" }).text).toBe("A missed-work sweep (scheduled)");
    expect(runLabel({ origin: "watchdog" }).text).toBe("A routine check (scheduled)");
    expect(runLabel({ origin: "check due" }).text).toBe("A scheduled check");
  });

  it("labels a decision, a chat answer and a review request", () => {
    expect(runLabel({ origin: "decision" }).text).toBe("Answering a decision");
    expect(runLabel({ origin: "decision answered" }).text).toBe("Your answer to its question");
    expect(runLabel({ origin: "owner_chat", endedAt: null }).text).toBe("Answering the owner in chat");
    expect(runLabel({ origin: "owner_chat", endedAt: "2026-10-27T10:00:00Z" }).text).toBe("Answered the owner in chat");
    // Runs from before `origin` were marked only by their chat purpose.
    expect(runLabel({ purpose: "chat", endedAt: "2026-10-27T10:00:00Z" }).text).toBe("Answered the owner in chat");
    expect(runLabel({ origin: "review requested", originNote: '- abc "Ready for a look"' }).text).toBe("Asked to review");
    expect(runLabel({ origin: "review requested", originNote: '- 11111111-1111-4111-8111-111111111111 "Fix the build": ready\n- 22222222-2222-4222-8222-222222222222 "Fix the tests": ready' }).text).toBe('Asked to review "Fix the build", "Fix the tests"');
    // In production a review run has no nudge, so the tickets come from the wake's note.
    expect(runLabel({ origin: "review requested", reason: "review requested", wakeNote: '- 11111111-1111-4111-8111-111111111111 "Fix the build": ready' }).text).toBe('Asked to review "Fix the build"');
  });

  it("names only the tickets under review, not refs inside their titles or notes", () => {
    // A ticket's title mentions another ticket; that reference must not become the label.
    const note = [
      '- 11111111-1111-4111-8111-111111111111 "QA: regression tests (BOS-111 adversarial round 4)": Ready.',
      "  Your code review, round 2: look at the change.",
      "Acceptance criteria:",
      "  - [pass] Covers BOS-111 as well.",
    ].join("\n");
    expect(runLabel({ origin: "review requested", wakeNote: note }).text).toBe('Asked to review "QA: regression tests (BOS-111 adversarial round 4)"');
  });

  it("counts the extra tickets and cuts a long title short", () => {
    const items = ["One", "Two", "Three", "Four"].map((t, i) => `- ${String(i + 1).repeat(8)}-1111-4111-8111-111111111111 "${t}": ready`);
    expect(runLabel({ origin: "review requested", wakeNote: items.join("\n") }).text).toBe('Asked to review "One", "Two" and 2 more');
    const long = "x".repeat(200);
    const label = runLabel({ origin: "review requested", wakeNote: `- 11111111-1111-4111-8111-111111111111 "${long}": ready` }).text;
    expect(label).toHaveLength('Asked to review ""'.length + 60);
    expect(label.endsWith('…"')).toBe(true);
  });

  it("falls back honestly only when nothing recorded the reason", () => {
    expect(runLabel({})).toEqual({ text: "Run without a ticket (reason not recorded)", unknown: true, ticketId: null });
    expect(runLabel({ origin: null, purpose: null })).toMatchObject({ unknown: true });
    // A runner-launched run with no wake behind it says so too.
    expect(runLabel({ reason: "run" }).text).toBe("Run without a ticket (reason not recorded)");
    // A label nobody wrote yet still reads.
    expect(runLabel({ origin: "something_new" }).text).toBe("Something new");
  });
});
