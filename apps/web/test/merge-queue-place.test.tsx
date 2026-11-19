// @vitest-environment jsdom
// BOS-1942: both Merge queue tabs say where a check runs, in one wording from one helper.
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Company } from "../src/api";
import { checkDoneOnText, runningOnText } from "../src/check-place";
import { MergeQueue } from "../src/pages/MergeQueue";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.location.hash = "";
});

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const company: Company = { id: "c1", name: "App Co", mission: null, paused: false, agents: [] };
const running = (ticketId: string, ref: string, extra: object = {}) => ({ ticketId, ref, title: `Merging ${ref}`, phase: "checking", startedAt: new Date(Date.now() - 4 * 60_000).toISOString(), startedBy: "the merge gate", minutes: 4, what: "merge_check", slot: 1, overLimit: false, ...extra });
const base = { companyId: "c1", mode: "server", slots: 5, serverHost: "docker-01", waiting: [], recent: [], waitingCount: 0, lineCount: 2, stuckCount: 0 };

describe("checkPlace helper (BOS-1942)", () => {
  it("says the worker by name, the server by its host name, and nothing when unknown", () => {
    expect(runningOnText("Truenas")).toBe("Running on the check worker Truenas.");
    expect(runningOnText("company runner", "docker-01")).toBe("Running on this server (docker-01).");
    expect(runningOnText("company runner", null)).toBe("Running on this server.");
    expect(runningOnText(null, "docker-01")).toBeNull();
    expect(checkDoneOnText("company runner", "docker-01")).toBe("Check done on this server (docker-01).");
  });
});

describe("Merges tab says where each running merge check runs (BOS-1942)", () => {
  it("shows a worker, the server, and the stage with no check running", async () => {
    const view = {
      ...base,
      running: [running("t1", "APP-1", { ranOn: "Truenas" }), running("t2", "APP-2", { ranOn: "company runner" }), running("t4", "APP-4")],
      waiting: [{ ticketId: "t3", ref: "APP-3", title: "Waiting for CI", minutes: 9, state: "waiting_for_ci", label: "waiting for GitHub CI", stuck: false, next: null, actor: "system", decisionId: null, risk: "low", urgent: false, failedCheck: false, ranOn: "company runner" }],
    };
    vi.stubGlobal("fetch", vi.fn(async (url: string) => json(String(url).includes("check-queue") ? { mode: "server", slots: 5, running: 0, rows: [] } : view)));
    const { container } = render(<MergeQueue companies={[company]} companyId="c1" />);
    await screen.findByText(/Merging APP-1/);
    expect(container.textContent).toContain("Running on the check worker Truenas.");
    expect(container.textContent).toContain("Running on this server (docker-01).");
    expect(container.textContent).toContain("Check done on this server (docker-01). Waiting for GitHub CI.");
    // A merge with no check job on record names no place rather than guessing one.
    expect(container.querySelectorAll("[data-check-ran-on]").length).toBe(3);
    // The slot figures say what they count.
    expect(container.textContent).toContain("3 merge checks running · 5 check slots in all, shared with quick checks");
  });
});

describe("Quick checks tab uses the same wording (BOS-1942)", () => {
  it("a check on the server says so with its host name", async () => {
    window.location.hash = "#/merge-queue/c1/checks";
    const row = { id: "q1", ticketId: "tq", ref: "APP-71", title: "Quick one", kind: "quick", requestedBy: "Bungle", state: "running", position: null, minutes: 3, fixesMain: false, heldBy: null, heldByMain: false, ranOn: "company runner" };
    vi.stubGlobal("fetch", vi.fn(async (url: string) => json(String(url).includes("check-queue") ? { mode: "server", slots: 5, running: 1, serverHost: "docker-01", rows: [row] } : { ...base, running: [] })));
    const { container } = render(<MergeQueue companies={[company]} companyId="c1" />);
    await screen.findByText("APP-71");
    expect(container.textContent).toContain("Running on this server (docker-01).");
  });
});
