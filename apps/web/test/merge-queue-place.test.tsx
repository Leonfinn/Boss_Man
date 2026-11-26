// @vitest-environment jsdom
// BOS-1942: both Merge queue tabs say where a check runs, in one wording from one helper.
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Company } from "../src/api";
import { checkDoneOnText, runningOnText, slotSplitText } from "../src/check-place";
import { MergeQueue, quickCheckPlaces } from "../src/pages/MergeQueue";

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

describe("slotSplitText (BOS-1942, BOS-2129)", () => {
  it("names each place and its slot count for a mix of server and worker", () => {
    const split = [{ ranOn: "company runner", slots: 3 }, { ranOn: "Truenas", slots: 2 }];
    expect(slotSplitText(split, "docker-01")).toBe("3 on this server (docker-01), 2 on the check worker Truenas");
  });

  it("says this server with no host name by default", () => {
    const split = [{ ranOn: "company runner", slots: 3 }, { ranOn: "Truenas", slots: 2 }];
    expect(slotSplitText(split)).toBe("3 on this server, 2 on the check worker Truenas");
    expect(slotSplitText(split, null)).toBe("3 on this server, 2 on the check worker Truenas");
  });

  it("keeps the order and the counts it is given, including zero", () => {
    const split = [{ ranOn: "Truenas", slots: 1 }, { ranOn: "company runner", slots: 0 }, { ranOn: "Docker", slots: 4 }];
    expect(slotSplitText(split, "docker-01")).toBe(
      "1 on the check worker Truenas, 0 on this server (docker-01), 4 on the check worker Docker",
    );
  });

  it("says nothing when all slots are one kind or there is no split", () => {
    expect(slotSplitText([{ ranOn: "company runner", slots: 5 }], "docker-01")).toBeNull();
    expect(slotSplitText([{ ranOn: "Truenas", slots: 2 }], "docker-01")).toBeNull();
    expect(slotSplitText([])).toBeNull();
    expect(slotSplitText(undefined)).toBeNull();
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

  it("says what the slot total is made of when a worker holds slots", async () => {
    const view = { ...base, slotSplit: [{ ranOn: "company runner", slots: 3 }, { ranOn: "Truenas", slots: 2 }], running: [running("t1", "APP-1", { ranOn: "Truenas" })] };
    vi.stubGlobal("fetch", vi.fn(async (url: string) => json(String(url).includes("check-queue") ? { mode: "server", slots: 5, running: 0, rows: [] } : view)));
    const { container } = render(<MergeQueue companies={[company]} companyId="c1" />);
    await screen.findByText(/Merging APP-1/);
    expect(container.textContent).toContain("5 check slots in all (3 on this server (docker-01), 2 on the check worker Truenas), shared with quick checks");
  });
});

// BOS-2638: the number beside a waiting quick check is its place in the line shown, not the server's
// position (which counts merge checks too). Rows are made up; no server or clock is involved.
type CheckRow = Parameters<typeof quickCheckPlaces>[0][number];
const check = (over: Partial<CheckRow> & { id: string }): CheckRow => ({
  ticketId: `ticket-${over.id}`,
  ref: "APP-1",
  title: `Made-up check ${over.id}`,
  kind: "quick",
  requestedBy: "an agent",
  state: "waiting",
  position: null,
  minutes: 3,
  fixesMain: false,
  heldBy: null,
  heldByMain: false,
  ...over,
});

describe("quickCheckPlaces (BOS-2507, BOS-2638)", () => {
  it("leaves running checks unnumbered and numbers waiting checks after them, in list order", () => {
    const rows = [
      check({ id: "run-1", state: "running", position: 1 }),
      check({ id: "wait-1", state: "waiting", position: 9 }),
      check({ id: "run-2", state: "running" }),
      check({ id: "wait-2", state: "waiting", position: 2 }),
    ];
    const places = quickCheckPlaces(rows);
    expect([...places.keys()]).toEqual(["wait-1", "wait-2"]);
    expect(places.get("wait-1")).toBe(3);
    expect(places.get("wait-2")).toBe(4);
    expect(places.has("run-1")).toBe(false);
    expect(places.has("run-2")).toBe(false);
  });

  it("gives a held waiting check with no position no number", () => {
    const rows = [
      check({ id: "run-1", state: "running" }),
      check({ id: "held", state: "waiting", position: null }),
      check({ id: "wait-1", state: "waiting", position: 1 }),
    ];
    const places = quickCheckPlaces(rows);
    expect([...places.keys()]).toEqual(["wait-1"]);
    expect(places.get("wait-1")).toBe(2);
  });

  it("makes the last number running checks plus numbered waiting checks", () => {
    const rows = [
      check({ id: "run-1", state: "running" }),
      check({ id: "run-2", state: "running" }),
      check({ id: "held", state: "waiting", position: null }),
      check({ id: "wait-1", state: "waiting", position: 5 }),
      check({ id: "wait-2", state: "waiting", position: 1 }),
    ];
    const places = quickCheckPlaces(rows);
    const numbered = [...places.values()];
    expect(numbered).toEqual([3, 4]);
    expect(Math.max(...numbered)).toBe(2 + 2);
  });

  it("has no places for an empty queue", () => {
    expect(quickCheckPlaces([]).size).toBe(0);
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
