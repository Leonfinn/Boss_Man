// BOS-1946 (Background lane): the pure helper behind the Dashboard's "Needs you" queue had no direct
// test. needsList keeps the cards that need the owner now and puts the oldest first.
import { describe, expect, it } from "vitest";
import type { Decision } from "../src/api";
import { needsList } from "../src/components/DashboardPanels";

const card = (id: string, createdAt: string, waiting: string | null = null): Decision => ({
  id,
  companyId: "c1",
  kind: "permission",
  question: `Card ${id}`,
  options: ["Allow once", "Deny"],
  recommendedOption: "Allow once",
  tier: "owner",
  createdAt,
  companyName: "App Co",
  agentName: "Moss",
  blocks: [],
  about: [],
  score: 0,
  parts: { blocking: 0, urgency: 0, age: 0, liveRun: 0 },
  reasons: [],
  ageReason: "",
  dueDate: null,
  waiting,
});

describe("needsList", () => {
  it("has nothing to show when there are no cards", () => {
    expect(needsList([])).toEqual([]);
  });

  it("keeps a single card that needs the owner", () => {
    const only = card("d1", "2026-11-10T09:00:00.000Z");
    expect(needsList([only])).toEqual([only]);
  });

  it("leaves out a card that is waiting on the team", () => {
    const waiting = card("d1", "2026-11-10T09:00:00.000Z", "The CEO has this");
    const ready = card("d2", "2026-11-10T10:00:00.000Z");
    expect(needsList([waiting, ready])).toEqual([ready]);
    expect(needsList([waiting])).toEqual([]);
  });

  it("puts several cards oldest first", () => {
    const newest = card("newest", "2026-11-12T09:00:00.000Z");
    const oldest = card("oldest", "2026-11-09T09:00:00.000Z");
    const middle = card("middle", "2026-11-11T09:00:00.000Z");
    expect(needsList([newest, oldest, middle]).map((d) => d.id)).toEqual(["oldest", "middle", "newest"]);
  });

  it("sorts the cards that need the owner and drops the waiting ones in one pass", () => {
    const a = card("a", "2026-11-12T09:00:00.000Z");
    const b = card("b", "2026-11-10T09:00:00.000Z", "Waiting");
    const c = card("c", "2026-11-11T09:00:00.000Z");
    expect(needsList([a, b, c]).map((d) => d.id)).toEqual(["c", "a"]);
  });
});
