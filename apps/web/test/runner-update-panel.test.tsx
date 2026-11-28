// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Company } from "../src/api";
import { Runner, SelfDeploy } from "../src/pages/Settings";

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
      if (url.endsWith("/api/release-watch")) return json({ active: false });
      return json([]);
    }));
    render(<SelfDeploy go={() => {}} />);
    expect(await screen.findByText(/this install doesn't have one/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Update runners (finish runs first)" })).toBeTruthy();
    // The setup steps are in docs/30 (BOS-1572); docs/09 is how the deployer works, not how to install it.
    expect(screen.getByRole("link", { name: "how to set it up" }).getAttribute("href")).toMatch(/30-in-app-updates\.md$/);
  });

  // BOS-2821 (F27): an image install has the updater and no host deployer, so none of the build-from-source words apply.
  it("on an image install with no host deployer it shows the release notice, one plain line and the update guide, and no deployer text or button", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.endsWith("/api/runner-report")) return json({ live: [live], update: null });
      if (url.endsWith("/api/maintenance")) return json({ on: false, last: null });
      if (url.endsWith("/api/self-deploy")) return json({ enabled: false });
      if (url.endsWith("/api/release-watch")) return json({ active: true, current: "202611280514", channel: "stable", enabled: true, ntfy: false, checkedAt: null, couldntCheck: false, available: null, install: { linked: true, updater: null } });
      return json([]);
    }));
    render(<SelfDeploy go={() => {}} />);
    const line = await screen.findByTestId("updates-image-line");
    expect(line.textContent).toBe("You run 202611280514. New releases appear here; nothing to do now.");
    expect(screen.queryByText(/this install doesn't have one/)).toBeNull();
    expect(screen.queryByText(/scripts\/update-runner\.sh/)).toBeNull();
    expect(screen.queryByText(/host deployer/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Update runners (finish runs first)" })).toBeNull();
    // The release notice (BOS-2713) is there, and the "What happens in an update?" guide link follows the plain line.
    expect(screen.getByTestId("release-notice")).toBeTruthy();
    expect(screen.getByRole("link", { name: /What happens in an update\?/ }).getAttribute("href")).toMatch(/\/guides\/how-updates-work$/);
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
