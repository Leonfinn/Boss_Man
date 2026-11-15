// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Company } from "../src/api";
import { Runner, RunnerUpdate } from "../src/pages/Settings";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
const company: Company = { id: "c1", name: "Boss Man Co", mission: null, paused: false, agents: [] };

const live = { slug: "boss-man-co", name: "Boss Man Co", registered: true, connected: true, at: "2026-11-04T16:23:00.000Z", imageVersion: "202611040849", fault: null };
const problem = { at: "2026-11-04T08:50:00.000Z", title: "Runner update finished with problems", body: "boss-man-co: has not reconnected", todo: "A runner hasn't connected since: start it again from Settings → Runner." };

describe("Settings → Runner update: the live state first, a past problem as history (BOS-465)", () => {
  it("shows the runner connected now, and an old problem as grey Resolved rather than red", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.endsWith("/api/runner-report")) return json({ live: [live], update: { ...problem, state: "resolved" } });
      if (url.endsWith("/api/maintenance")) return json({ on: false, last: null });
      return json([]);
    }));
    render(<RunnerUpdate />);
    const now = await screen.findByTestId("runner-live");
    expect(now.textContent).toContain("Boss Man Co");
    expect(now.textContent).toContain("Connected");
    expect(now.textContent).toContain("image 202611040849");
    const history = screen.getByTestId("update-history");
    expect(history.textContent).toContain("Resolved");
    expect(history.textContent).not.toContain("PROBLEM");
    expect(screen.queryByText("PROBLEM")).toBeNull();
  });

  it("shows red with what to do only when something is wrong now", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.endsWith("/api/runner-report")) return json({ live: [{ ...live, connected: false, at: "2026-11-04T08:00:00.000Z" }], update: { ...problem, state: "problem" } });
      if (url.endsWith("/api/maintenance")) return json({ on: false, last: null });
      return json([]);
    }));
    render(<RunnerUpdate />);
    expect(await screen.findByText("Not connected")).toBeTruthy();
    const history = await screen.findByTestId("update-history");
    expect(history.textContent).toContain("PROBLEM");
    expect(history.textContent).toContain("start it again");
  });

  it("per company: the same rule, leading with the live state", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.includes("/runner")) return json({ registered: true, runnerId: "r1", connected: true, lastSeenAt: live.at, imageVersion: live.imageVersion, diskUsedBytes: null, addons: null, report: { live: { ok: true, text: "Runner connected since 16:23 · image 202611040849" }, last: { ...problem, state: "resolved" } } });
      return json([]);
    }));
    render(<Runner company={company} />);
    expect(await screen.findByText("Runner connected since 16:23 · image 202611040849")).toBeTruthy();
    const history = await screen.findByTestId("company-update-history");
    expect(history.textContent).toContain("Resolved");
    expect(history.textContent).not.toContain("PROBLEM");
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
    render(<RunnerUpdate />);
    expect(await screen.findByText(/this install doesn't have one/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "how to set it up" }).getAttribute("href")).toMatch(/self-deploy\.md$/);
  });

  it("with a host deployer it still points at Build and update runners", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.endsWith("/api/runner-report")) return json({ live: [live], update: null });
      if (url.endsWith("/api/maintenance")) return json({ on: false, last: null });
      if (url.endsWith("/api/self-deploy")) return json({ enabled: true });
      return json([]);
    }));
    render(<RunnerUpdate />);
    expect(await screen.findByText(/Build and update runners under Updates/)).toBeTruthy();
    expect(screen.queryByText(/this install doesn't have one/)).toBeNull();
  });

  it("the fleet list tags a swapping runner Updating and a frozen one Paused", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.endsWith("/api/runner-report")) return json({ live: [{ ...live, connected: false, swap: { retryAt: null, tries: 0 } }, { ...live, slug: "b", name: "B Co", connected: false, guard: { reason: "guard exited", since: null } }], update: null });
      if (url.endsWith("/api/maintenance")) return json({ on: true, deadline: "2026-11-06T12:30:00.000Z", runs: 0, companies: 0 });
      return json([]);
    }));
    render(<RunnerUpdate />);
    const now = await screen.findByTestId("runner-live");
    expect(now.textContent).toContain("Updating");
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
