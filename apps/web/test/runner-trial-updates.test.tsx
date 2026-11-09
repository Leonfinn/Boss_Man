// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SelfDeploy, TrialLines } from "../src/pages/Settings";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });

const view = (over: Record<string, unknown> = {}) => ({
  enabled: true,
  pending: false,
  status: null,
  available: { tip: "bbbbbbb2", deployed: "aaaaaaa1", checkedAt: "2026-11-09T06:00:00.000Z", commits: [] },
  deployer: { reportedAt: "2026-11-09T06:00:00.000Z", late: false },
  trial: null,
  deployWait: null,
  ...over,
});

describe("Settings → Updates shows the runner trial and rate-limit wait from the real time (BOS-953)", () => {
  it("says when runners can be updated while the trial is really running", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-09T15:27:00Z"));
    vi.stubGlobal("fetch", vi.fn(async (url: string) => (url.endsWith("/api/self-deploy") ? json(view({ trial: { endsAt: "2026-11-09T15:33:00Z", seconds: 900 } })) : json([]))));
    render(<SelfDeploy go={() => {}} />);
    const line = await screen.findByTestId("runner-trial");
    expect(line.textContent).toContain("Runners can be updated from");
    expect(line.textContent).toContain("in about 6 minutes");
    expect(line.className).toContain("error");
  });

  it("drops the trial line once the end time has passed, by itself, without a new poll", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    vi.setSystemTime(new Date("2026-11-09T15:32:00Z"));
    vi.stubGlobal("fetch", vi.fn(async (url: string) => (url.endsWith("/api/self-deploy") ? json(view({ trial: { endsAt: "2026-11-09T15:33:00Z", seconds: 900 } })) : json([]))));
    render(<SelfDeploy go={() => {}} />);
    expect(await screen.findByTestId("runner-trial")).toBeTruthy();
    // The clock ticks past the end with no further request: the line goes.
    vi.setSystemTime(new Date("2026-11-09T15:33:05Z"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(screen.queryByTestId("runner-trial")).toBeNull();
  });

  it("counts the rate-limit wait down and says you can deploy now once it is over", () => {
    const now = Date.parse("2026-11-09T15:27:00Z");
    const { rerender } = render(<TrialLines trial={null} wait={{ until: "2026-11-09T15:31:00Z" }} now={now} />);
    const line = screen.getByTestId("deploy-wait");
    expect(line.textContent).toContain("You can deploy again from");
    expect(line.textContent).toContain("in about 4 minutes");
    expect(line.className).toContain("error");
    // Twelve minutes later, still the same wait info from the server: the line now says the owner can deploy.
    rerender(<TrialLines trial={null} wait={{ until: "2026-11-09T15:31:00Z" }} now={Date.parse("2026-11-09T15:39:00Z")} />);
    expect(screen.getByTestId("deploy-wait").textContent).toBe("You can deploy now.");
    expect(screen.getByTestId("deploy-wait").className).toContain("muted");
  });

  it("shows the server's plain reply with the time when Build and update runners is pressed during the trial", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-09T15:27:00Z"));
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith("/api/self-deploy")) return json(view({ trial: { endsAt: "2026-11-09T15:33:00Z", seconds: 900 } }));
        if (url.includes("/update-runners") && init?.method === "POST") {
          return json({ error: "cannot_update_runners", message: "Runners can be updated from 15:33, in about 6 minutes.", retryAt: "2026-11-09T15:33:00Z" }, 409);
        }
        return json([]);
      }),
    );
    render(<SelfDeploy go={() => {}} />);
    (await screen.findByRole("button", { name: "Build and update runners" })).click();
    expect(await screen.findByText(/Runners can be updated from 15:33, in about 6 minutes\./)).toBeTruthy();
  });
});
