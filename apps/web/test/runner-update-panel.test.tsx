// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Company } from "../src/api";
import { Runner, SelfDeploy } from "../src/pages/Settings";
import { LiveState, historyTag, runnerProgress, type LiveRow, type MaintenanceView } from "../src/pages/settings/updates";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
const company: Company = { id: "c1", name: "Boss Man Co", mission: null, paused: false, agents: [] };

const live = { slug: "boss-man-co", name: "Boss Man Co", registered: true, connected: true, at: "2026-11-04T16:23:00.000Z", imageVersion: "202611040849", fault: null };
const problem = { at: "2026-11-04T08:50:00.000Z", title: "Runner update finished with problems", body: "boss-man-co: has not reconnected", todo: "A runner hasn't connected since: start it again from Settings → Runner." };

const selfDeploy = { enabled: true, pending: false, status: null, available: { tip: "a1", deployed: "a1", checkedAt: new Date().toISOString(), commits: [] }, deployer: { reportedAt: new Date().toISOString(), late: false } };
/** The Updates card with the given runner report; the card's Now running list replaced the old Runner update box (BOS-1238). */
const updatesCard = (report: unknown) => {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.endsWith("/api/self-deploy")) return json(selfDeploy);
    if (url.endsWith("/api/runner-report")) return json(report);
    if (url.endsWith("/api/maintenance")) return json({ on: false, last: null });
    if (url.includes("/api/self-deploy/wait")) return json({ on: false });
    return json([]);
  }));
  render(<SelfDeploy go={() => {}} />);
};

describe("Settings → Updates → Now running: the live state first (BOS-465, BOS-1238)", () => {
  it("shows the runner connected now, and the runner's last update line is gone", async () => {
    updatesCard({ live: [live], update: { ...problem, state: "resolved" } });
    const now = await screen.findByTestId("runner-live");
    await vi.waitFor(() => expect(now.textContent).toContain("Connected"));
    expect(now.textContent).toContain("Boss Man Co");
    expect(now.textContent).toContain("image 202611040849");
    expect(screen.queryByText("PROBLEM")).toBeNull();
  });

  it("shows Not connected for a runner that is down", async () => {
    updatesCard({ live: [{ ...live, connected: false, at: "2026-11-04T08:00:00.000Z" }], update: { ...problem, state: "problem" } });
    expect(await screen.findByText("Not connected")).toBeTruthy();
  });

  it("per company: the Runner box leads with the live state and drops its Last update line", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.includes("/runner")) return json({ registered: true, runnerId: "r1", connected: true, lastSeenAt: live.at, imageVersion: live.imageVersion, diskUsedBytes: null, addons: null, report: { live: { ok: true, text: "Runner connected since 16:23 · image 202611040849" }, last: { ...problem, state: "resolved" } } });
      return json([]);
    }));
    render(<Runner company={company} />);
    expect(await screen.findByText("Runner connected since 16:23 · image 202611040849")).toBeTruthy();
    expect(screen.queryByTestId("company-update-history")).toBeNull();
    expect(screen.queryByText(/Last update/)).toBeNull();
  });
});

describe("Settings → Runner during a planned swap (BOS-382 slice D)", () => {
  const launcher = { slug: "boss-man-co", container: { state: "running", status: "Up 5 seconds", image: "boss-man-runner:latest" } };
  const panel = (liveRow: object) => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.includes("/runner")) return json({ registered: true, runnerId: "r1", connected: false, lastSeenAt: live.at, imageVersion: live.imageVersion, diskUsedBytes: null, addons: null, launcher, report: { live: liveRow, last: null } });
      return json([]);
    }));
    render(<Runner company={company} />);
  };

  it("says Updating and keeps Start, Restart and Stop disabled while the swap runs", async () => {
    panel({ ok: true, state: "updating", text: "Updating: swapping to the new runner. It starts by itself; no need to press anything." });
    expect(await screen.findByText(/^Updating: swapping to the new runner/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Reconnect runner" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Restart" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Stop" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("a failed swap says so, and Start is pressable again", async () => {
    panel({ ok: false, state: "failed", text: "Update failed: the new runner would not start. Press Start runner below." });
    const line = await screen.findByText(/^Update failed:/);
    expect(line.className).toContain("red");
    expect((screen.getByRole("button", { name: "Reconnect runner" }) as HTMLButtonElement).disabled).toBe(false);
  });

  // BOS-1486: the Build and update runners button is in the Updates card, which only exists with a host deployer.
  it("without a host deployer it says in-app updates need one and links to how to set it up", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.endsWith("/api/runner-report")) return json({ live: [live], update: null });
      if (url.endsWith("/api/maintenance")) return json({ on: false, last: null });
      if (url.endsWith("/api/self-deploy")) return json({ enabled: false });
      return json([]);
    }));
    render(<SelfDeploy go={() => {}} />);
    expect(await screen.findByText(/this install doesn't have one/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Update runners (finish runs first)" })).toBeTruthy();
    // The setup steps are in docs/30 (BOS-1572); docs/09 is how the deployer works, not how to install it.
    expect(screen.getByRole("link", { name: "how to set it up" }).getAttribute("href")).toMatch(/30-in-app-updates\.md$/);
  });

  it("the fleet list tags a swapping runner Updating and a frozen one Paused", async () => {
    updatesCard({ live: [{ ...live, connected: false, swap: { retryAt: null, tries: 0 } }, { ...live, slug: "b", name: "B Co", connected: false, guard: { reason: "guard exited", since: null } }], update: null });
    const now = await screen.findByTestId("runner-live");
    await vi.waitFor(() => expect(now.textContent).toContain("Updating"));
    expect(now.textContent).toContain("Paused: network guard");
    expect(now.textContent).toContain("guard exited");
    expect(now.textContent).not.toContain("Not connected");
  });
});

// BOS-2532 (G2, pins BOS-2525): on 24 Nov the swap badge read "0 of 3 companies done" with 2 of 3 already
// connected on the new image. The badge and the "Now running" list now share one test, so they can't disagree.
describe("Settings → Updates: the swap badge counts the list it sits above (BOS-2532)", () => {
  const runnerImage = "202611241722";
  const three = [
    { slug: "a", name: "HolidayHours", registered: true, connected: true, at: "2026-11-24T17:22:00.000Z", imageVersion: runnerImage, fault: null },
    // The waiting company still carries its swap mark; it is on the old image, so it shows waiting for its runs.
    { slug: "c", name: "Boss Man Co", registered: true, connected: true, at: "2026-11-24T17:12:01.000Z", imageVersion: "202611241201", fault: null, swap: { retryAt: null, tries: 0 } },
    // A second company already on the new image, connected.
    { slug: "b", name: "Stainbeck Homelab", registered: true, connected: true, at: "2026-11-24T17:22:30.000Z", imageVersion: runnerImage, fault: null },
  ];
  const mount = (liveRows: object[], newestHint?: string) => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.endsWith("/api/self-deploy")) return json({ ...selfDeploy, ...(newestHint ? { runnerImage: { running: null, needed: newestHint } } : {}) });
      if (url.endsWith("/api/runner-report")) return json({ live: liveRows, update: null });
      if (url.endsWith("/api/maintenance")) return json({ on: true, kind: "update", deadline: new Date(Date.now() + 600_000).toISOString(), runs: 1, companies: 1, phase: "swapping" });
      if (url.includes("/api/self-deploy/wait")) return json({ on: false });
      if (url.includes("/api/self-deploy/history")) return json([{ id: "h1", target: "runner", commit: "abc", changes: 0, result: "deployed", message: null, at: "2026-11-24T17:22:00.000Z" }]);
      return json([]);
    }));
    render(<SelfDeploy go={() => {}} />);
  };

  it("2 of 3 connected on the new image reads '2 of 3', while the third still waits", async () => {
    mount(three);
    const recent = await screen.findByTestId("recent-updates");
    await vi.waitFor(() => expect(recent.textContent).toContain("Swapping (2 of 3 companies done)"));
    // The list under the badge: two Connected, one waiting for runs to finish.
    const now = screen.getByTestId("runner-live");
    expect((now.textContent ?? "").match(/Connected/g) ?? []).toHaveLength(2);
    expect(now.textContent).toContain("Waiting for runs to finish");
  });

  it("0 of 3, 2 of 3 and 3 of 3 are the counts the badge's own rule gives the rows shown", () => {
    const maint = { on: true, kind: "update", deadline: new Date(Date.now() + 600_000).toISOString(), runs: 1, companies: 1, phase: "swapping" } as MaintenanceView;
    // Everyone still on the old image while the update is for `runnerImage`: 0 of 3, and no row says Connected.
    const waiting = three.map((r) => ({ ...r, imageVersion: "202611241201" })) as unknown as LiveRow[];
    const p0 = runnerProgress(waiting, maint, runnerImage);
    expect(p0).toMatchObject({ inProgress: true, done: 0, total: 3 });
    expect(historyTag({ id: "h1", target: "runner", commit: "abc", changes: 0, result: "deployed", message: null, at: "" }, p0).tag).toBe("Swapping (0 of 3 companies done)");
    // Every row the badge counts as done says Connected in the list under it, row by row.
    const tags = (live: LiveRow[], p: ReturnType<typeof runnerProgress>) => live.map((r) => renderToStaticMarkup(createElement(LiveState, { r, progress: p })).includes(">Connected<"));
    const p2 = runnerProgress(three as unknown as LiveRow[], maint);
    expect(p2).toMatchObject({ done: 2 });
    expect(tags(three as unknown as LiveRow[], p2)).toEqual([true, false, true]);
    // All on the new image, and the update is for that image: 3 of 3, every row Connected.
    const p3 = runnerProgress(three.map((r) => ({ ...r, imageVersion: runnerImage })) as unknown as LiveRow[], maint, runnerImage);
    expect(p3).toMatchObject({ done: 3 });
    expect(tags(three.map((r) => ({ ...r, imageVersion: runnerImage })) as unknown as LiveRow[], p3)).toEqual([true, true, true]);
    expect(tags(waiting, p0)).toEqual([false, false, false]);
  });
});

describe("Settings → Runner: the network guard warning (BOS-335)", () => {
  const launched = (guard: "on" | "off" | "unavailable" | "down") => ({
    registered: true, runnerId: "r1", connected: true, lastSeenAt: live.at, imageVersion: live.imageVersion, diskUsedBytes: null, addons: null,
    launcher: { slug: "boss-man-co", container: { state: "running", status: "Up 1 hour (healthy)", image: "img", guard } },
  });
  const mount = (guard: "on" | "off" | "unavailable" | "down") => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => (url.includes("/runner") ? json(launched(guard)) : json([]))));
    render(<Runner company={company} />);
  };

  it("warns plainly when the guard is off", async () => {
    mount("off");
    const warn = await screen.findByTestId("guard-warning");
    expect(warn.textContent).toContain("turned off");
    expect(warn.textContent).toContain("private addresses");
    expect(warn.textContent).toContain("Ask your admin");
  });

  it("warns plainly when the guard is unavailable on the host", async () => {
    mount("unavailable");
    const warn = await screen.findByTestId("guard-warning");
    expect(warn.textContent).toContain("unavailable on this host");
    expect(warn.textContent).toContain("Ask your admin");
  });

  it("warns plainly when the guard is down (BOS-709)", async () => {
    mount("down");
    const warn = await screen.findByTestId("guard-warning");
    expect(warn.textContent).toContain("down");
    expect(warn.textContent).toContain("private addresses");
    expect(warn.textContent).toContain("after a minute");
  });

  it("shows no warning when the guard is on", async () => {
    mount("on");
    expect(await screen.findByTestId("runner-now")).toBeTruthy();
    expect(screen.queryByTestId("guard-warning")).toBeNull();
  });
});
