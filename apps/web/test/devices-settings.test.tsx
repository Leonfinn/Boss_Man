// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// The "Your devices" section (BOS-641): it lists recorded profiles and posts a fresh measurement
// from this browser when the owner presses Record.

const collect = vi.fn();
vi.mock("../src/devices", () => ({ collect: () => collect() }));

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

  it("explains there are none yet when the list is empty", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json([])));
    render(<Devices />);
    expect(await screen.findByText(/No devices recorded yet/)).toBeTruthy();
  });
});
