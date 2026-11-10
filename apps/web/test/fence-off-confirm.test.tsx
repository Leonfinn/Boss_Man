// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FENCE_OFF_CONSEQUENCE } from "@boss-man/shared";
import type { Company } from "../src/api";
import { FenceSetting } from "../src/pages/Settings";

// Settings → Agent fence (BOS-940): Off is an explicit choice, made after reading what it means, and an Off
// nobody chose says why it is Off.

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
const company = (over: Partial<Company> = {}): Company => ({ id: "c1", name: "Acme", mission: null, paused: false, agents: [], fenceMode: "watch", fenceModeChosenAt: null, ...over });
const runner = (level: "full" | "unavailable") => ({ registered: true, sandbox: { level, missing: [], probe: true }, sandboxCheckedAt: "2026-11-09T10:00:00Z" });

function stub(level: "full" | "unavailable" = "full") {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : null });
      return json(url.endsWith("/runner") ? runner(level) : {});
    }),
  );
  return calls;
}
const patches = (calls: ReturnType<typeof stub>) => calls.filter((c) => c.method === "PATCH");

describe("Agent fence in Settings", () => {
  it("asks before turning the fence off, with the plain-words consequence, and saves nothing on Cancel", async () => {
    const calls = stub();
    const confirm = vi.fn(() => false);
    vi.stubGlobal("confirm", confirm);
    render(<FenceSetting company={company()} onChanged={() => {}} />);
    fireEvent.change(await screen.findByLabelText("Fence"), { target: { value: "off" } });
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining(FENCE_OFF_CONSEQUENCE));
    expect(FENCE_OFF_CONSEQUENCE).toContain("agents can read the runner's key and this company's git login");
    await new Promise((r) => setTimeout(r, 20));
    expect(patches(calls)).toHaveLength(0);
  });

  it("saves Off once the owner confirms, and switching to Watch asks nothing", async () => {
    const calls = stub();
    vi.stubGlobal("confirm", vi.fn(() => true));
    const { rerender } = render(<FenceSetting company={company()} onChanged={() => {}} />);
    fireEvent.change(await screen.findByLabelText("Fence"), { target: { value: "off" } });
    await vi.waitFor(() => expect(patches(calls)).toEqual([expect.objectContaining({ url: "/api/companies/c1", body: { fenceMode: "off" } })]));
    const confirm = vi.fn(() => false);
    vi.stubGlobal("confirm", confirm);
    rerender(<FenceSetting company={company({ fenceMode: "off", fenceModeChosenAt: "2026-11-09T10:00:00Z" })} onChanged={() => {}} />);
    fireEvent.change(screen.getByLabelText("Fence"), { target: { value: "watch" } });
    await vi.waitFor(() => expect(patches(calls)).toHaveLength(2));
    expect(confirm).not.toHaveBeenCalled();
  });

  it("says why the fence is Off: the owner's choice, the host, or the old default", async () => {
    stub("unavailable");
    const { unmount } = render(<FenceSetting company={company({ fenceMode: "off" })} onChanged={() => {}} />);
    expect(await screen.findByText(`The fence is Off because this host can't fence agents. ${FENCE_OFF_CONSEQUENCE}`)).toBeTruthy();
    unmount();
    stub("full");
    render(<FenceSetting company={company({ fenceMode: "off" })} onChanged={() => {}} />);
    expect(await screen.findByText(`Nobody chose Off: it was Boss Man's old default. ${FENCE_OFF_CONSEQUENCE}`)).toBeTruthy();
    cleanup();
    render(<FenceSetting company={company({ fenceMode: "off", fenceModeChosenAt: "2026-11-09T10:00:00Z" })} onChanged={() => {}} />);
    expect(await screen.findByText(`You chose Off. ${FENCE_OFF_CONSEQUENCE}`)).toBeTruthy();
  });
});
