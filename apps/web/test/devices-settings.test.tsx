// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// The "Your devices" section (BOS-641): it lists recorded profiles and posts a fresh measurement
// from this browser when the owner presses Record.

const collect = vi.fn();
const live = { width: 840, height: 900, pixelRatio: 2.6 };
vi.mock("../src/devices", () => ({ collect: () => collect(), fingerprint: () => "fp", measure: () => live }));

import { Devices } from "../src/pages/Settings";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });

const profile = {
  id: "d1",
  label: "Brave · 840px · touch",
  browser: "Brave",
  fingerprint: "fp",
  reportedAt: "2026-11-07T10:00:00Z",
  readings: [{ width: 840, height: 900, pixelRatio: 2.6, coarsePointer: true, displayMode: "standalone", units: { vh: 900, dvh: 780, svh: 780, lvh: 900, visual: 780 }, afterScroll: true }],
};

describe("Devices settings", () => {
  it("lists a recorded device with its measured figures", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json([profile])));
    render(<Devices />);
    expect(await screen.findByText(/100dvh 780/)).toBeTruthy();
    expect(screen.getByDisplayValue("Brave · 840px · touch")).toBeTruthy();
  });

  it("tags this browser, lists it first and says how long ago", async () => {
    const other = { ...profile, id: "d0", label: "Other phone", fingerprint: "zz", reportedAt: new Date().toISOString() };
    vi.stubGlobal("fetch", vi.fn(async () => json([other, { ...profile, reportedAt: new Date(Date.now() - 3 * 86_400_000).toISOString() }])));
    render(<Devices />);
    expect(await screen.findByText("This browser")).toBeTruthy();
    expect(screen.getByText("Recorded 3 days ago")).toBeTruthy();
    expect(screen.getByText("Recorded today")).toBeTruthy();
    const names = screen.getAllByLabelText(/^Name for/).map((e) => e.getAttribute("aria-label"));
    expect(names[0]).toBe(`Name for ${profile.label}`);
    expect(screen.queryByText(/isn't recorded yet/)).toBeNull();
    expect(screen.queryByText(/screen has changed/)).toBeNull();
  });

  it("says this browser isn't recorded when no fingerprint matches", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json([{ ...profile, fingerprint: "zz" }])));
    render(<Devices />);
    expect(await screen.findByText("This browser isn't recorded yet.")).toBeTruthy();
    expect(screen.queryByText("This browser")).toBeNull();
  });

  it("warns on the matching card when the screen has changed", async () => {
    live.width = 1000;
    vi.stubGlobal("fetch", vi.fn(async () => json([profile])));
    render(<Devices />);
    expect(await screen.findByText(/This screen has changed since it was recorded/)).toBeTruthy();
    live.width = 840;
  });

  it("records this device: posts the measurement and shows the new profile", async () => {
    const calls: string[] = [];
    collect.mockResolvedValue({ label: "New device", browser: "Brave", fingerprint: "fp2", readings: profile.readings });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push(`${init?.method ?? "GET"} ${url}`);
        return init?.method === "POST" ? json({ ...profile, id: "d2", label: "New device" }) : json([profile]);
      }),
    );
    render(<Devices />);
    fireEvent.click(screen.getByRole("button", { name: "Record this device" }));
    await vi.waitFor(() => expect(calls).toContain("POST /api/devices"));
    expect(collect).toHaveBeenCalledOnce();
  });

  it("does not say none recorded while loading", async () => {
    // Resolved at the end, so the shared in-flight request does not leak into the next test.
    let release: (r: Response) => void = () => {};
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((res) => (release = res))));
    render(<Devices />);
    expect(screen.queryByText(/No devices recorded yet/)).toBeNull();
    expect(screen.getByRole("status")).toBeTruthy(); // the shared Loader, which shows its words after 1 s
    release(json([profile]));
    expect(await screen.findByText(/100dvh 780/)).toBeTruthy();
  });

  it("after a failed load shows Retry, not 'none recorded', and Retry shows the devices", async () => {
    let n = 0;
    vi.stubGlobal("fetch", vi.fn(async () => (n++ === 0 ? new Response(JSON.stringify({ error: "boom" }), { status: 500, headers: { "content-type": "application/json" } }) : json([profile]))));
    render(<Devices />);
    const retry = await screen.findByRole("button", { name: "Retry" });
    expect(screen.queryByText(/No devices recorded yet/)).toBeNull();
    fireEvent.click(retry);
    expect(await screen.findByText(/100dvh 780/)).toBeTruthy();
  });

  it("explains there are none yet when the list is empty", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json([])));
    render(<Devices />);
    expect(await screen.findByText(/No devices recorded yet/)).toBeTruthy();
  });
});
