// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RunLimits } from "../src/pages/Settings";
import { healthLines } from "../src/components/DashboardPanels";

// BOS-1634: Settings → Agents at once and the dashboard never show a saved number that differs silently from the
// one in force. The server's object (saved, inForce, because, since, until) is shown as it comes.

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
const base = { instance: 16, company: 12, background: 2, defaults: { instance: 8, company: 4, background: 2 } };
const none = { because: null, since: null, until: null };
const held = { because: "a server update is waiting for a quiet machine", since: "2026-11-16T10:00:00.000Z", until: "2026-11-16T13:00:00.000Z" };
const holdOn = { allCompanies: { saved: 16, inForce: 3, ...held }, background: { saved: 2, inForce: 0, ...held }, mergeChecks: { paused: true, ...held } };
const holdOff = { allCompanies: { saved: 16, inForce: 16, ...none }, background: { saved: 2, inForce: 2, ...none }, mergeChecks: { paused: false, ...none } };

describe("Agents at once: saved and in force", () => {
  it("during a server update's hold: saved 16 · in force 3, why, since and until when, a link to the update, and background and merge checks too", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ ...base, inForce: holdOn })));
    render(<RunLimits updatesHref="#/settings/c1/updates" />);
    const line = await screen.findByTestId("run-limits-in-force");
    expect(line.textContent).toContain("Saved 16 · in force 3 until the update goes in");
    expect(line.textContent).toContain("Lower because a server update is waiting for a quiet machine since ");
    expect(line.textContent).toContain("goes back to 16 by");
    expect(line.textContent).toContain("Nothing to change");
    expect(line.querySelector("a")?.getAttribute("href")).toBe("#/settings/c1/updates");
    expect(screen.getByTestId("run-limits-background-in-force").textContent).toContain("Saved 2 · in force 0");
    expect(screen.getByTestId("run-limits-merge-checks").textContent).toContain("New merge checks wait too, because a server update is waiting for a quiet machine");
    // The saved number stays in the field: the owner has nothing to redo.
    expect((screen.getByLabelText(/Across all companies/) as HTMLInputElement).value).toBe("16");
  });

  it("shows no such line with the hold off, or from an older server without inForce", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ ...base, inForce: holdOff })));
    render(<RunLimits />);
    await screen.findByLabelText(/Across all companies/);
    for (const id of ["run-limits-in-force", "run-limits-background-in-force", "run-limits-merge-checks"]) expect(screen.queryByTestId(id)).toBeNull();
    cleanup();
    vi.stubGlobal("fetch", vi.fn(async () => json(base)));
    render(<RunLimits />);
    await screen.findByLabelText(/Across all companies/);
    expect(screen.queryByTestId("run-limits-in-force")).toBeNull();
  });
});

describe("Dashboard Right now: the update line carries the run limit in force", () => {
  const input = (runLimit: unknown) => ({ health: { runner: null, usage: null, update: { waiting: true, phase: "waiting", deadline: "2026-11-16T10:30:00.000Z" }, runLimit } as never, merges: null, stuck: null, running: 3, companyId: "c1" });

  it("hold on: says saved 16 · in force 3 with the reason and links to the waiting update", () => {
    const line = healthLines(input(holdOn.allCompanies)).find((l) => l.key === "update")!;
    expect(line.tone).toBe("warn");
    expect(line.state).toBe("Agents at once: Saved 16 · in force 3 until the update goes in");
    expect(line.text).toContain("Lower because a server update is waiting for a quiet machine");
    expect(line.href).toBe("#/settings/c1/updates");
  });

  it("hold off, or an older server: the update line is unchanged", () => {
    for (const r of [holdOff.allCompanies, undefined]) expect(healthLines(input(r)).find((l) => l.key === "update")!.state).toBe("Update waiting");
  });
});
