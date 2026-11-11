import { describe, expect, it } from "vitest";
import { isTaskSize, SIZE_SCALE, TASK_SIZES } from "../src/sizing.js";
import {
  CHECK_AFTER_DAYS,
  CHECK_CAP_DAYS,
  leverApprover,
  RETRO_FAILURE_LABEL,
  RETRO_FAILURES,
  WORKFLOW_LEVERS,
  WORKFLOW_METRICS,
} from "../src/retro.js";
import { OWNER_MESSAGE_COUNT_FROM, OWNER_MESSAGE_MAX, RUN_MESSAGE_MAX } from "../src/owner-message.js";

describe("isTaskSize: only the fixed scale is a task size", () => {
  it("accepts every size in TASK_SIZES", () => {
    for (const size of TASK_SIZES) expect(isTaskSize(size)).toBe(true);
  });

  it("rejects values off the scale", () => {
    for (const bad of [0, 4, 2.5, "3", null]) expect(isTaskSize(bad)).toBe(false);
  });

  it("SIZE_SCALE names every size in TASK_SIZES, in order", () => {
    const shown = SIZE_SCALE.match(/\d+/g)?.map(Number);
    expect(shown).toEqual([...TASK_SIZES]);
  });
});

describe("leverApprover: playbooks and brief lessons go to the CEO, the rest to the owner", () => {
  it("sends playbook and lesson to the CEO and every other lever to the owner", () => {
    for (const lever of WORKFLOW_LEVERS) {
      const expected = lever === "playbook" || lever === "lesson" ? "ceo" : "owner";
      expect(leverApprover(lever)).toBe(expected);
    }
  });
});

describe("retro lists stay consistent", () => {
  it("RETRO_FAILURE_LABEL labels every failure, with no empty or extra keys", () => {
    expect(Object.keys(RETRO_FAILURE_LABEL).sort()).toEqual([...RETRO_FAILURES].sort());
    for (const failure of RETRO_FAILURES) expect(RETRO_FAILURE_LABEL[failure].trim()).not.toBe("");
  });

  it("WORKFLOW_METRICS has no duplicates", () => {
    expect(new Set(WORKFLOW_METRICS).size).toBe(WORKFLOW_METRICS.length);
  });

  it("CHECK_CAP_DAYS is at least CHECK_AFTER_DAYS", () => {
    expect(CHECK_CAP_DAYS).toBeGreaterThanOrEqual(CHECK_AFTER_DAYS);
  });
});

describe("owner message limits leave room for the runner's prefix", () => {
  it("orders the count threshold, the owner cap and the runner cap", () => {
    expect(OWNER_MESSAGE_COUNT_FROM).toBeLessThan(OWNER_MESSAGE_MAX);
    expect(OWNER_MESSAGE_MAX).toBeLessThan(RUN_MESSAGE_MAX);
  });

  it("leaves at least the length of \"Message from the owner: \" above the owner cap", () => {
    expect(RUN_MESSAGE_MAX - OWNER_MESSAGE_MAX).toBeGreaterThanOrEqual("Message from the owner: ".length);
  });
});
