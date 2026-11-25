// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Engagements } from "../src/pages/Engagements";

// BOS-2492: "Download CSV" saves the rows shown under the current state filter, nothing else.

const row = (id: string, title: string, status: string) => ({ id, title, status, requester: "Acme", provider: "Pixel Co", budgetCapUsd: 10, stateSince: "2026-11-20T10:00:00.000Z" });
const ALL = [row("e1", "Logo", "in_progress"), row("e2", "Audit", "signed_off"), row("e3", "Report", "signed_off")];

let blobs: Blob[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  localStorage.setItem("bm.engagements.show", "all");
  blobs = [];
  // The server does the filtering; the stub answers by the status in the URL as it would.
  vi.stubGlobal("fetch", vi.fn((url: string) => {
    const status = /status=([a-z_]+)/.exec(String(url))?.[1];
    const body = status ? ALL.filter((r) => r.status === status) : ALL;
    return Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }));
  }));
  URL.createObjectURL = vi.fn((b: Blob) => { blobs.push(b); return "blob:x"; });
  URL.revokeObjectURL = vi.fn();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  localStorage.removeItem("bm.engagements.show");
});

const settle = () => act(async () => { await vi.advanceTimersByTimeAsync(1300); });

describe("Engagements Download CSV", () => {
  it("with a state filter leaving 2 of 3 rows, the file holds exactly those 2", async () => {
    const { container, getByText } = render(<Engagements />);
    await settle();
    expect(container.querySelectorAll("tbody tr")).toHaveLength(3);
    await act(async () => { fireEvent.change(container.querySelector("select")!, { target: { value: "signed_off" } }); });
    await settle();
    expect(container.querySelectorAll("tbody tr")).toHaveLength(2);
    fireEvent.click(getByText("Download CSV"));
    expect(blobs).toHaveLength(1);
    const lines = (await blobs[0]!.text()).trim().split("\r\n");
    expect(lines).toHaveLength(3);
    expect(lines[1]).toMatch(/^Audit,/);
    expect(lines[2]).toMatch(/^Report,/);
    expect(lines.join("\n")).not.toContain("Logo");
  });
});
