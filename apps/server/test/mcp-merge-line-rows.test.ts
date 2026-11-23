// BOS-2306: direct unit tests for the two pure row builders behind merge_line_records.
// They were only reached through the MCP tool in merge-line-export.test.ts; these pin each
// field, the wording of ran_on/ran and the null edges without any database setup.
import { describe, expect, it } from "vitest";
import { jobRow, reusedRow } from "../src/mcp-merge-line.js";

const queued = new Date("2026-11-09T00:00:00.000Z");
const started = new Date("2026-11-09T00:04:00.000Z");
const ended = new Date("2026-11-09T00:07:00.000Z");

const job = (over: Partial<Parameters<typeof jobRow>[0]> = {}) => ({
  ticketId: "t-1",
  kind: "pre_review",
  scope: "quick",
  state: "passed",
  queuedAt: queued,
  startedAt: started,
  endedAt: ended,
  ...over,
});

describe("jobRow", () => {
  it("maps a check job's own fields and times", () => {
    expect(
      jobRow(
        job({
          workerId: "w-1",
          worker: "alpha worker",
          busyAtStart: 3,
          ranFull: true,
          stages: JSON.stringify([
            { name: "typecheck", seconds: 90 },
            { name: "related tests", seconds: 120 },
          ]),
        }),
      ),
    ).toEqual({
      ticket_id: "t-1",
      kind: "pre_review",
      scope: "quick",
      queued: "2026-11-09T00:00:00.000Z",
      started: "2026-11-09T00:04:00.000Z",
      finished: "2026-11-09T00:07:00.000Z",
      outcome: "passed",
      reused: null,
      ran_on: "alpha worker",
      busy_at_start: 3,
      ran: "quick+full",
      steps: "typecheck=90 related_tests=120",
    });
  });

  it("says where a started job ran: the worker's name, a check worker, or the company runner", () => {
    expect(jobRow(job({ workerId: "w-1", worker: "alpha worker" })).ran_on).toBe("alpha worker");
    expect(jobRow(job({ workerId: "w-1" })).ran_on).toBe("a check worker");
    expect(jobRow(job({ workerId: null, worker: "alpha worker" })).ran_on).toBe("company runner");
  });

  it("leaves a job that never started without a start, finish or place it ran", () => {
    expect(jobRow(job({ startedAt: null, endedAt: null, workerId: "w-1", worker: "alpha worker" }))).toMatchObject({
      started: null,
      finished: null,
      ran_on: null,
    });
  });

  it("reads ran from ranFull, and says nothing when it is unknown", () => {
    expect(jobRow(job({ ranFull: true })).ran).toBe("quick+full");
    expect(jobRow(job({ ranFull: false })).ran).toBe("quick");
    expect(jobRow(job({ ranFull: null })).ran).toBeNull();
    expect(jobRow(job()).ran).toBeNull();
  });

  it("keeps busy_at_start only as a number, including zero", () => {
    expect(jobRow(job({ busyAtStart: 0 })).busy_at_start).toBe(0);
    expect(jobRow(job()).busy_at_start).toBeNull();
  });

  it("turns stages into name=seconds pairs, in order, and drops what is not one", () => {
    expect(
      jobRow(job({ stages: JSON.stringify([{ name: "type check", seconds: 12 }, { name: "lint", seconds: 3.5 }, { name: 5, seconds: 1 }, { name: "no seconds" }]) })).steps,
    ).toBe("type_check=12 lint=3.5");
    expect(jobRow(job({ stages: JSON.stringify([]) })).steps).toBeNull();
    expect(jobRow(job({ stages: null })).steps).toBeNull();
    expect(jobRow(job({ stages: "not json" })).steps).toBeNull();
  });
});

describe("reusedRow", () => {
  it("maps a reused request: its queue time, the answering outcome, and no start or finish", () => {
    expect(
      reusedRow({ ticketId: "t-2", at: new Date("2026-11-09T00:03:00.000Z"), detail: { reused: "passed", scope: "quick", outcome: "passed" } }),
    ).toEqual({
      ticket_id: "t-2",
      kind: "pre_review",
      scope: "quick",
      queued: "2026-11-09T00:03:00.000Z",
      started: null,
      finished: null,
      outcome: "passed",
      reused: "passed",
      ran_on: null,
      busy_at_start: null,
      ran: null,
      steps: null,
    });
  });

  it("leaves missing detail empty, keeping only the request's own time and kind", () => {
    expect(reusedRow({ ticketId: null, at: new Date(0), detail: null })).toEqual({
      ticket_id: null,
      kind: "pre_review",
      scope: null,
      queued: "1970-01-01T00:00:00.000Z",
      started: null,
      finished: null,
      outcome: null,
      reused: null,
      ran_on: null,
      busy_at_start: null,
      ran: null,
      steps: null,
    });
  });

  it("ignores values of the wrong type", () => {
    expect(reusedRow({ ticketId: "t-3", at: queued, detail: { reused: 5, scope: {}, outcome: ["x"] } })).toMatchObject({
      reused: null,
      scope: null,
      outcome: null,
    });
  });
});
