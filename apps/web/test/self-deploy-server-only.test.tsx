// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SelfDeploy } from "../src/pages/Settings";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });

const view = {
  enabled: true,
  pending: false,
  status: null,
  available: { tip: "aaaaaaa1", deployed: "aaaaaaa1", checkedAt: "2026-11-09T06:00:00.000Z", commits: [] },
  deployer: { reportedAt: "2026-11-09T06:00:00.000Z", late: false },
};

describe("Settings → Updates says Deploy latest is the server only (BOS-868)", () => {
  it("shows one line under the buttons saying runner changes need Build and update runners", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => (url.endsWith("/api/self-deploy") ? json(view) : json([]))));
    render(<SelfDeploy go={() => {}} />);
    const line = await screen.findByText(/Deploy latest updates the server only/);
    expect(line.textContent).toContain("If an update changed the runners, press Build and update runners afterwards.");
    expect(line.className).toContain("muted");
  });

  it("gives Deploy latest a tooltip saying the same", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => (url.endsWith("/api/self-deploy") ? json(view) : json([]))));
    render(<SelfDeploy go={() => {}} />);
    const button = await screen.findByRole("button", { name: "Deploy latest" });
    expect(button.getAttribute("title")).toBe("Updates the server only. If the update changed the runners, press Build and update runners afterwards.");
  });

  it("sends the same requests as today, and stays hidden when the host deployer is off", async () => {
    const calls: { url: string; method: string; body: unknown }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined });
        return url.endsWith("/api/self-deploy") ? json(view) : json([]);
      }),
    );
    const { unmount } = render(<SelfDeploy go={() => {}} />);
    const deploy = await screen.findByRole("button", { name: "Deploy latest" });
    const runners = await screen.findByRole("button", { name: "Build and update runners" });
    deploy.click();
    await vi.waitFor(() => expect(calls.some((c) => c.url.startsWith("/api/self-deploy/deploy-latest"))).toBe(true));
    await waitFor(() => expect((runners as HTMLButtonElement).disabled).toBe(false));
    runners.click();
    await vi.waitFor(() => expect(calls.some((c) => c.url.startsWith("/api/self-deploy/update-runners"))).toBe(true));
    const sent = calls.filter((c) => c.url.startsWith("/api/self-deploy/") && c.method === "POST");
    expect(sent.map((c) => c.url)).toEqual(["/api/self-deploy/deploy-latest", "/api/self-deploy/update-runners"]);
    expect(sent.every((c) => JSON.stringify(c.body) === "{}")).toBe(true);
    unmount();

    calls.length = 0;
    vi.mocked(fetch).mockImplementation(async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined });
      return url.endsWith("/api/self-deploy") ? json({ ...view, enabled: false }) : json([]);
    });
    render(<SelfDeploy go={() => {}} />);
    await vi.waitFor(() => expect(calls.some((c) => c.url.endsWith("/api/self-deploy"))).toBe(true));
    expect(screen.queryByRole("button", { name: "Deploy latest" })).toBeNull();
    expect(screen.queryByText(/Deploy latest updates the server only/)).toBeNull();
  });
});
