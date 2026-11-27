// @vitest-environment jsdom
// BOS-2701: the panel never invites a "Build and update runners" press the server would refuse. The server queues a
// press at every stage of an update, including the minute after a deploy while the host's offer file is gone; it
// refuses only while the host deployer never reported or is late. Then the button is disabled with one plain line,
// and the trial line doesn't say "Press".
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SelfDeploy, TrialLines } from "../src/pages/Settings";
import { runnerPressBlocked, type SelfDeployView } from "../src/pages/settings/updates";
import { stubFetchByUrl } from "./stub-fetch";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const NOW = "2026-11-26T13:19:00.000Z";
const view = (over: Record<string, unknown> = {}) =>
  ({
    enabled: true,
    pending: false,
    status: { target: "server", result: "deployed", message: "Deployed.", from_commit: "a".repeat(40), to_commit: "b".repeat(40), started: "2026-11-26T13:14:00.000Z", ended: "2026-11-26T13:18:00.000Z" },
    available: null,
    deployer: { reportedAt: "2026-11-26T13:18:30.000Z", late: false },
    trial: { endsAt: "2026-11-26T13:33:00.000Z", seconds: 900 },
    deployWait: null,
    ...over,
  }) as unknown as SelfDeployView;

describe("Build and update runners is never invited and then refused (BOS-2701)", () => {
  it("can be pressed in the minute after a deploy, while the host's offer file is gone but it reported", () => {
    expect(runnerPressBlocked(view())).toBeNull();
  });

  it("can't be pressed while the deployer is late or never reported, and says when it will be ready", () => {
    expect(runnerPressBlocked(view({ deployer: { reportedAt: "2026-11-26T12:00:00.000Z", late: true } }))).toContain("ready again once the host deployer reports");
    expect(runnerPressBlocked(view({ deployer: { reportedAt: null, late: true } }))).toBe("Build and update runners is ready once the host deployer has reported for the first time.");
    // An offer to read means the deployer is there, whatever the stamp says.
    expect(runnerPressBlocked(view({ available: { tip: "b".repeat(40), deployed: "b".repeat(40), checkedAt: NOW, commits: [] }, deployer: { reportedAt: null, late: true } }))).toBeNull();
  });

  it("the trial line drops its \"Press\" when the button can't take one", () => {
    const now = Date.parse(NOW);
    const { rerender } = render(<TrialLines trial={{ endsAt: "2026-11-26T13:33:00.000Z" }} now={now} />);
    expect(screen.getByTestId("runner-trial").textContent).toContain("Press Build and update runners");
    rerender(<TrialLines trial={{ endsAt: "2026-11-26T13:33:00.000Z" }} now={now} pressBlocked />);
    expect(screen.getByTestId("runner-trial").textContent).not.toContain("Press");
  });

  it("the panel disables the button with one line while the deployer is late, and enables it in the post-deploy minute", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(NOW));
    const routes = (v: SelfDeployView) => ({
      "/api/self-deploy": v,
      "/api/self-deploy/wait": { on: false },
      "/api/maintenance": { on: false },
      "/api/runner-report": { live: [] },
      "/api/self-deploy/history": [],
      "/api/release-watch": { active: false },
      "/api/maintenance/history": { holds: [] },
    });
    stubFetchByUrl(routes(view({ deployer: { reportedAt: "2026-11-26T12:00:00.000Z", late: true } })));
    render(<SelfDeploy go={() => {}} />);
    const line = await screen.findByTestId("runners-not-ready");
    expect(line.textContent).toContain("ready again once the host deployer reports");
    expect((screen.getByRole("button", { name: "Build and update runners" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByTestId("runner-trial")?.textContent ?? "").not.toContain("Press");
    cleanup();

    stubFetchByUrl(routes(view()));
    render(<SelfDeploy go={() => {}} />);
    expect((await screen.findByTestId("runner-trial")).textContent).toContain("Press Build and update runners");
    expect((screen.getByRole("button", { name: "Build and update runners" }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByTestId("runners-not-ready")).toBeNull();
  });
});
