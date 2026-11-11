import { describe, expect, it } from "vitest";
import { movableFailures, type Criterion } from "../src/acceptance.js";

// The stuck-review card may offer to move a failed criterion to after the merge only when every
// failure reads like a live check and the reviewer left no line comments (BOS-422, BOS-1109).

describe("movableFailures", () => {
  it("returns the live-check criteria a review failed", () => {
    const criteria: Criterion[] = ["Dashboard loads once it is deployed", "Backups restore on the owner's host"];
    const review = "1 fail: dashboard did not load. 2 fail: backups were not tried.";
    expect(movableFailures(criteria, [], review)).toEqual(["Dashboard loads once it is deployed", "Backups restore on the owner's host"]);
  });

  it("gives an empty list when the review has any line comment", () => {
    const criteria: Criterion[] = ["Dashboard loads once it is deployed"];
    const review = "1 fail: dashboard did not load.";
    const comments = [{ path: "apps/web/src/dashboard.ts", line: 12, body: "The query is missing a filter." }];
    expect(movableFailures(criteria, comments, review)).toEqual([]);
  });

  it("gives an empty list when a criterion that must hold before merge failed", () => {
    const criteria: Criterion[] = ["Health check returns 200"];
    const review = "1 fail: health check returns 500.";
    expect(movableFailures(criteria, [], review)).toEqual([]);
  });

  it("gives an empty list when the failed criterion is already marked after merge", () => {
    const criteria: Criterion[] = [{ text: "Dashboard loads once it is deployed", after: "merge" }];
    const review = "1 fail: dashboard did not load.";
    expect(movableFailures(criteria, [], review)).toEqual([]);
  });

  it("gives an empty list when the review fails nothing", () => {
    const criteria: Criterion[] = ["Dashboard loads once it is deployed", "Health check returns 200"];
    expect(movableFailures(criteria, [], "Everything looks good, no problems found.")).toEqual([]);
    expect(movableFailures(criteria, [], "")).toEqual([]);
  });

  it("gives an empty list when a live-check fail and a normal fail are mixed", () => {
    const criteria: Criterion[] = ["Dashboard loads once it is deployed", "Health check returns 200"];
    const review = "1 fail: dashboard did not load. 2 fail: health check returns 500.";
    expect(movableFailures(criteria, [], review)).toEqual([]);
  });
});
