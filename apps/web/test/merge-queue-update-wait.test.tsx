// @vitest-environment jsdom
// BOS-2861: while an update drains, both Merge queue tabs say for each running check whether the update waits for it, from
// the server's own list (updateWait: the drain's waited and not-waited sets). On 27 Nov the owner saw a worker's new quick
// check shown only as "Running" and read it as 20 more minutes of the runner update. Rows and names are made up.
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Company } from "../src/api";
import { MergeQueue, placeAndUpdateText, type UpdateWait } from "../src/pages/MergeQueue";
import { stubFetchByUrl } from "./stub-fetch";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.location.hash = "";
});

const company: Company = { id: "c1", name: "App Co", mission: null, paused: false, agents: [] };
const base = { companyId: "c1", mode: "server", slots: 5, serverHost: "docker-01", waiting: [], recent: [], waitingCount: 0, lineCount: 2, stuckCount: 0 };
const merging = (ticketId: string, ref: string, ranOn: string) => ({ ticketId, ref, title: `Merging ${ref}`, phase: "checking", startedAt: new Date(Date.now() - 4 * 60_000).toISOString(), startedBy: "the merge gate", minutes: 4, what: "merge_check", slot: 1, overLimit: false, ranOn });
const quick = (id: string, ref: string, ranOn: string | null, state = "running") => ({ id, ticketId: `t-${id}`, ref, title: `Quick ${ref}`, kind: "quick", requestedBy: "Bungle", state, position: state === "waiting" ? 1 : null, minutes: 3, fixesMain: false, heldBy: null, heldByMain: false, ranOn });

describe("placeAndUpdateText (BOS-2861)", () => {
  const holds = { jobId: "j1", ticketId: "t1", kind: "pre_review", holdsUpdate: true };
  const free = { ...holds, holdsUpdate: false };
  it("says the update waits for a check it waits for, after where it runs", () => {
    expect(placeAndUpdateText("company runner", "docker-01", holds, "runner")).toBe("Running on this server (docker-01). The runner update waits for this.");
    expect(placeAndUpdateText("Worker-B", null, holds, "server")).toBe("Running on the check worker Worker-B. The server update waits for this.");
  });
  it("names any check worker that doesn't hold the update up", () => {
    expect(placeAndUpdateText("Worker-A", "docker-01", free, "runner")).toBe("Running on the check worker Worker-A: doesn't hold up the runner update.");
    expect(placeAndUpdateText("Some other name", null, free, "server")).toBe("Running on the check worker Some other name: doesn't hold up the server update.");
  });
  it("is the plain place line with no update waiting, and says only the update part with no known place", () => {
    expect(placeAndUpdateText("Worker-A", "docker-01", undefined, undefined)).toBe("Running on the check worker Worker-A.");
    expect(placeAndUpdateText(null, null, free, "runner")).toBe("Doesn't hold up the runner update.");
    expect(placeAndUpdateText(null, null, undefined, undefined)).toBeNull();
  });
});

describe("Merge queue tabs during a runner update (BOS-2861)", () => {
  const updateWait: UpdateWait = {
    update: "runner",
    checks: [
      { jobId: "q1", ticketId: "t-q1", kind: "pre_review", holdsUpdate: true },
      { jobId: "q2", ticketId: "t-q2", kind: "pre_review", holdsUpdate: false },
      { jobId: "m1", ticketId: "t1", kind: "merge", holdsUpdate: true },
      { jobId: "m2", ticketId: "t2", kind: "merge", holdsUpdate: false },
    ],
  };
  const checkQueue = (wait?: UpdateWait) => ({ mode: "server", slots: 5, running: 2, serverHost: "docker-01", rows: [quick("q1", "APP-71", "company runner"), quick("q2", "APP-72", "Worker-A"), quick("q3", "APP-73", null, "waiting")], ...(wait ? { updateWait: wait } : {}) });
  const mergeQueue = (wait?: UpdateWait) => ({ ...base, running: [merging("t1", "APP-1", "company runner"), merging("t2", "APP-2", "Worker-A")], ...(wait ? { updateWait: wait } : {}) });

  it("Quick checks tab: marks each running check waited for or not, and leaves a waiting one alone", async () => {
    window.location.hash = "#/merge-queue/c1/checks";
    stubFetchByUrl({ "/api/companies/c1/check-queue": checkQueue(updateWait), "/api/companies/c1/merge-queue": mergeQueue(updateWait) });
    const { container } = render(<MergeQueue companies={[company]} companyId="c1" />);
    await screen.findByText("APP-71");
    expect(container.querySelector('[data-update-wait="waits"]')?.textContent).toContain("Running on this server (docker-01). The runner update waits for this.");
    expect(container.querySelector('[data-update-wait="not-waited"]')?.textContent).toContain("Running on the check worker Worker-A: doesn't hold up the runner update.");
    expect(container.querySelectorAll("[data-update-wait]")).toHaveLength(2);
  });

  it("Merges tab: marks each running merge check by its ticket", async () => {
    stubFetchByUrl({ "/api/companies/c1/check-queue": checkQueue(updateWait), "/api/companies/c1/merge-queue": mergeQueue(updateWait) });
    const { container } = render(<MergeQueue companies={[company]} companyId="c1" />);
    await screen.findByText(/Merging APP-1/);
    const marks = [...container.querySelectorAll("[data-update-wait]")].map((e) => [e.getAttribute("data-update-wait"), e.textContent]);
    expect(marks).toEqual([
      ["waits", "Running on this server (docker-01). The runner update waits for this."],
      ["not-waited", "Running on the check worker Worker-A: doesn't hold up the runner update."],
    ]);
  });

  it("with no update waiting (or an older server) shows only where each check runs", async () => {
    window.location.hash = "#/merge-queue/c1/checks";
    stubFetchByUrl({ "/api/companies/c1/check-queue": checkQueue(), "/api/companies/c1/merge-queue": mergeQueue() });
    const { container } = render(<MergeQueue companies={[company]} companyId="c1" />);
    await screen.findByText("APP-71");
    expect(container.querySelectorAll("[data-update-wait]")).toHaveLength(0);
    expect(container.textContent).toContain("Running on the check worker Worker-A.");
    expect(container.textContent).not.toMatch(/update/);
  });
});
