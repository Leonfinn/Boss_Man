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
  available: { tip: "bbbbbbb2", deployed: "aaaaaaa1", checkedAt: "2026-11-09T06:00:00.000Z", commits: [] },
  deployer: { reportedAt: "2026-11-09T06:00:00.000Z", late: false },
};

// BOS-868 said "Deploy latest updates the server only"; BOS-1238 moved that to the status box's sentence and the
// one main button, with the runner rebuild under Other actions. The requests sent stay the same.
describe("Settings → Updates: the main button and Other actions send the same requests as before (BOS-868, BOS-1238)", () => {
  it("shows one blue main button, and the runner rebuild under Other actions", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => (url.endsWith("/api/self-deploy") ? json(view) : json([]))));
    render(<SelfDeploy go={() => {}} />);
    const main = await screen.findByRole("button", { name: "Review and deploy" });
    expect(main.className).toContain("primary");
    expect(screen.getAllByRole("button").filter((b) => b.className.includes("primary"))).toHaveLength(1);
    const other = screen.getByTestId("other-actions");
    expect(other.textContent).toContain("Build and update runners");
  });

  it("posts deploy-latest and update-runners with an empty body, and stays hidden when the host deployer is off", async () => {
    const calls: { url: string; method: string; body: unknown }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined });
        return url.endsWith("/api/self-deploy") ? json(view) : json([]);
      }),
    );
    const { unmount } = render(<SelfDeploy go={() => {}} />);
    const deploy = await screen.findByRole("button", { name: "Review and deploy" });
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
    vi.mocked(fetch).mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined });
      return url.endsWith("/api/self-deploy") ? json({ ...view, enabled: false }) : json([]);
    });
    render(<SelfDeploy go={() => {}} />);
    await vi.waitFor(() => expect(calls.some((c) => c.url.endsWith("/api/self-deploy"))).toBe(true));
    expect(screen.queryByRole("button", { name: "Review and deploy" })).toBeNull();
    await waitFor(() => expect(screen.queryByTestId("update-status")).toBeNull());
  });
});
