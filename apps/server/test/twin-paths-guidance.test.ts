import { describe, expect, it } from "vitest";
import { TWIN_PATHS_GUIDANCE } from "../src/services/scheduler.js";

// BOS-1465: every review run tells the reviewer to list the twin paths of an owner-reported fault.
describe("twin paths reviewer guidance", () => {
  it("names the twins and the two ways to cover each", () => {
    expect(TWIN_PATHS_GUIDANCE).toMatch(/twin paths and states/);
    expect(TWIN_PATHS_GUIDANCE).toMatch(/covered by test X/);
    expect(TWIN_PATHS_GUIDANCE).toMatch(/follow-up BOS-n/);
    for (const twin of ["server and runner", "chat and ticket run", "every company", "restart or rebuild", "every form of that kind", "the state the owner presses it in"])
      expect(TWIN_PATHS_GUIDANCE).toContain(twin);
  });

  it("stays one short line with no company details", () => {
    expect(TWIN_PATHS_GUIDANCE).not.toContain("\n");
    expect(TWIN_PATHS_GUIDANCE.length).toBeLessThan(400);
  });
});
