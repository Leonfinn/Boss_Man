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
    expect(line.textContent).toContain("Press Build and update runners to queue the runner update");
    expect(line.textContent).toContain("in about 6 minutes");
    expect(line.className).toContain("muted");
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
          return json({ queued: true, startsAt: "2026-11-09T15:33:00Z", message: "Runners will update at 15:33, when this server update's 15-minute trial ends. You don't need to press again." });
        }
        return json([]);
      }),
    );
    const go = vi.fn();
    render(<SelfDeploy go={go} />);
    (await screen.findByRole("button", { name: "Build and update runners" })).click();
    expect(await screen.findByText(/Runners will update at 15:33, when this server update's 15-minute trial ends\./)).toBeTruthy();
    // A queued press stays on the Settings page: there is no card to go to.
    expect(go).not.toHaveBeenCalled();
  });
});

describe("Settings → Updates says what holds the runner update (BOS-1086)", () => {
  const now = Date.parse("2026-11-10T17:00:00Z");
  it("says when a queued runner update starts, in plain words", () => {
    render(<TrialLines trial={{ endsAt: "2026-11-10T17:04:00Z" }} wait={null} now={now} queue={{ startsAt: "2026-11-10T17:04:00Z", why: "the trial" }} />);
    const line = screen.getByTestId("runner-trial");
    expect(line.textContent).toContain("Runners will update at");
    expect(line.textContent).toContain("when this server update's trial ends");
    expect(line.className).toContain("muted");
  });

  it("names the other hold when the queued update waits for something besides the trial", () => {
    render(<TrialLines trial={null} wait={null} now={now} queue={{ startsAt: null, why: "a server update is running now, so the runners can't be updated until it finishes." }} />);
    expect(screen.getByTestId("runner-queue").textContent).toContain("waiting for a server update is running now");
  });

  it("shows a deploy held behind the runner update and a cancelled queue with its reason", () => {
    render(<TrialLines trial={null} wait={null} now={now} held={{ commit: "cccccccc1234" }} cancelled={{ why: "The server update was switched back, so the runner update you queued was cancelled." }} />);
    expect(screen.getByTestId("deploy-held").textContent).toContain("waits for the runner update to finish");
    expect(screen.getByTestId("queue-cancelled").textContent).toContain("switched back");
  });

  it("offers Cancel queued runner update only while one is queued, and posts the cancel", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (init?.method === "POST") calls.push(url);
        if (url.endsWith("/api/self-deploy")) return json(view({ runnerQueue: { pressedAt: "2026-11-10T17:00:00Z", startsAt: null, why: "the host's wait" } }));
        return json([]);
      }),
    );
    render(<SelfDeploy go={() => {}} />);
    (await screen.findByRole("button", { name: "Cancel queued runner update" })).click();
    expect(await screen.findByText("The queued runner update is cancelled.")).toBeTruthy();
    expect(calls.some((u) => u.endsWith("/api/self-deploy/cancel-runner-queue"))).toBe(true);
  });
});
