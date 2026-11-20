// @vitest-environment jsdom
// A date-only "Due" day on a decision card shows the same calendar day in every time zone
// (it used to read as midnight UTC, so owners west of UTC saw the day before).
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { Company, Decision } from "../src/api";
import { dayLabel } from "../src/age";
import { Decisions } from "../src/pages/Decisions";

const company: Company = { id: "c1", name: "App Co", mission: null, paused: false, agents: [] };
const decision = (dueDate: string | null): Decision => ({
  id: "d1",
  companyId: "c1",
  kind: "question",
  question: "Which one?",
  options: ["Ship it now", "Wait"],
  recommendedOption: "Wait",
  tier: "owner",
  createdAt: new Date().toISOString(),
  companyName: "App Co",
  agentName: "Moss",
  blocks: [],
  about: [],
  score: 0,
  parts: { blocking: 0, urgency: 0, age: 0, liveRun: 0 },
  reasons: [],
  ageReason: "",
  dueDate,
  context: { type: "question" },
} as Decision);
const show = (dueDate: string | null) => render(<Decisions decisions={[decision(dueDate)]} companies={[company]} loaded agentsWorking={0} onAnswered={() => {}} />);

const realTz = process.env.TZ;
afterEach(() => {
  cleanup();
  if (realTz === undefined) delete process.env.TZ;
  else process.env.TZ = realTz;
});

describe("Due day on a decision card", () => {
  for (const tz of ["America/New_York", "Asia/Tokyo"]) {
    it(`shows "Due 1 Dec" for 2026-12-01 with TZ=${tz}`, () => {
      process.env.TZ = tz;
      // Guard: the zone really changed, so the test would catch the old west-of-UTC bug.
      expect(new Date("2026-12-01").getTimezoneOffset() === 0).toBe(false);
      show("2026-12-01");
      expect(document.querySelector(".pill.tag:last-child")?.textContent).toMatch(/^Due (1 Dec|Dec 1)$/);
    });
  }
  it("shows no Due pill without a dueDate", () => {
    show(null);
    expect(screen.queryByText(/^Due /)).toBeNull();
  });
  it("returns an unreadable value unchanged", () => {
    expect(dayLabel("soon")).toBe("soon");
  });
});
