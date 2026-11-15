// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CheckQueueSetting } from "../src/pages/Settings";

// Settings → Server and runner → Checks (BOS-798): the owner's switch for the server-owned check queue and its slots.

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
const view = { mode: "legacy", slots: 1, maxSlots: 8, defaultSlots: 1, runnersTooOld: [] as string[] };

describe("Checks in Settings", () => {
  it("shows both modes with a plain line each, and saves the switch to server with the slots", async () => {
    const calls: Array<{ method: string; body: unknown }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        calls.push({ method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : null });
        return json(init?.method === "PUT" ? { ...view, mode: "server", slots: 2, cancelled: 0 } : view);
      }),
    );
    render(<CheckQueueSetting />);
    const legacy = (await screen.findByRole("radio", { name: /Each agent runs its own/ })) as HTMLInputElement;
    const server = screen.getByRole("radio", { name: /Boss Man runs them/ }) as HTMLInputElement;
    expect(legacy.checked).toBe(true);
    expect(server.parentElement!.textContent).toContain("woken with the result");
    expect(server.parentElement!.textContent).toContain("merge check");
    const save = screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true); // nothing changed yet
    fireEvent.click(server);
    fireEvent.change(screen.getByLabelText(/Checks at once/), { target: { value: "2" } });
    fireEvent.click(save);
    await vi.waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true));
    expect(calls.find((c) => c.method === "PUT")!.body).toEqual({ mode: "server", slots: 2, train: false }); // the merge train switch (BOS-1366) is sent as shown: off
  });

  it("won't save slots outside 1 to 8, and warns about a runner too old for queued checks", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ ...view, runnersTooOld: ["App Co"] })));
    render(<CheckQueueSetting />);
    expect((await screen.findByTestId("check-queue-old-runner")).textContent).toContain("App Co");
    fireEvent.change(screen.getByLabelText(/Checks at once/), { target: { value: "9" } });
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("BOS-1602: the owner sets the company runner's split (2 of 3 kept for merges), and each worker row says what it takes", async () => {
    const calls: Array<{ method: string; body: unknown }> = [];
    const worker = { id: "w1", name: "NAS", enabled: true, connected: true, slots: 2, reportedSlots: null, limit: 2, takes: "checks", mergeKept: 0, checkThreads: null, checkMemoryMb: null, imageCommit: null, toolchain: null, lastSeenAt: null, companies: [], reason: null };
    const v = { ...view, mode: "server", slots: 3, runnerPolicy: { takes: "both", mergeKept: 0 }, workers: [worker] };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : null });
        return json(String(url).includes("/api/companies") ? [] : v);
      }),
    );
    render(<CheckQueueSetting />);
    expect((await screen.findByTestId("check-runner-split")).textContent).toContain("Merges and quick checks");
    expect(screen.getByTestId("check-worker-split").textContent).toContain("Quick checks only");
    const kept = screen.getByLabelText(/Kept for merges/);
    fireEvent.change(kept, { target: { value: "4" } });
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true); // more than the 3 slots
    fireEvent.change(kept, { target: { value: "2" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await vi.waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true));
    expect(calls.find((c) => c.method === "PUT")!.body).toEqual({ mode: "server", slots: 3, train: false, runnerPolicy: { takes: "both", mergeKept: 2 } });
  });

  it("BOS-1498: shows what memory the runners are given and why", async () => {
    const memoryLine = "11 GB: 6 agents at once and 1 check, on a 16 GB machine.";
    const runner = { slots: 1, memoryBytes: 11 * 1024 ** 3, reason: null, pending: 0, applying: false, runnerCount: 1 };
    vi.stubGlobal("fetch", vi.fn(async () => json({ ...view, runner: { ...runner, memoryLine } })));
    render(<CheckQueueSetting />);
    expect((await screen.findByTestId("runner-memory-line")).textContent).toBe(memoryLine);
    cleanup();
    // An older launcher sends no line: the panel shows the limit alone.
    vi.stubGlobal("fetch", vi.fn(async () => json({ ...view, runner })));
    render(<CheckQueueSetting />);
    expect((await screen.findByTestId("check-runner-limit")).textContent).toContain("11 GB memory limit");
    expect(screen.queryByTestId("runner-memory-line")).toBeNull();
  });
});
