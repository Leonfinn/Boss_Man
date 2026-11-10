import { describe, expect, it } from "vitest";
import { STOPPED_CONTAINERS_KEY, problemText, stoppedContainerNames, type HostFactsView } from "../src/host-facts-display";

// BOS-986: the "This host" panel says in plain words what is missing and what failed, rather than the raw
// dotted key ("check.container_status.notRunning" told the owner nothing). These tests pin the wording the
// owner sees, and keep it in step with the keys the deployer and the server report.

const view = (facts: Record<string, string>, ownerFacts: string[] = []): HostFactsView => ({
  hostName: "Docker01",
  reportedAt: "2026-11-09T15:20:00Z",
  ownerFacts,
  facts: Object.fromEntries(Object.entries(facts).map(([k, value]) => [k, { value, source: "host" as const, at: "2026-11-09T15:20:00Z" }])),
});

describe("This host: plain words for what is wrong (BOS-986)", () => {
  it("a missing fact only the owner gives says what it is, what needs it, and where to enter it", () => {
    const t = problemText("network.publicAddress", view({}), [], "");
    expect(t).toContain("Address you reach Boss Man at from outside is missing");
    expect(t).toContain("enter it in Facts only you can give");
    const k = problemText("repo.deployKeyAdded", view({}), [], "");
    expect(k).toContain("Deploy key added to the code host");
    expect(k).toContain("press Confirm");
  });

  it("a failing container check names the stopped containers, how many of the stack, and what to do", () => {
    const d = view({ "check.container_status.total": "18", "check.container_status.notRunning": "2" });
    const t = problemText("check.container_status.notRunning", d, ["bm-worker-1 (exited, exit 137, 2 hours ago)", "bm-cache-1 (restarting, exit 255, 5 minutes ago)"], "");
    expect(t).toContain("the containers bm-worker-1 (exited, exit 137, 2 hours ago); bm-cache-1 (restarting, exit 255, 5 minutes ago) are not running (of 18 in the Boss Man stack)");
    expect(t).toContain("Build and update runners");
    // Without names (an older deployer) it still says the count, never a raw key.
    const bare = problemText("check.container_status.notRunning", d, [], "");
    expect(bare).toContain("2 containers are not running");
    expect(bare).not.toContain("notRunning");
  });

  it("a failing code-host read quotes the host's own reason, and says deploys still work", () => {
    const d = view({ "repo.probe": "failed" });
    const t = problemText("repo.probe", d, [], "ssh: connect to host <code host> port 22: Connection timed out");
    expect(t).toContain("could not read the code host: ssh: connect to host <code host> port 22: Connection timed out");
    expect(t).toContain("deploys that already have the code still work");
    const bare = problemText("repo.probe", d, [], "");
    expect(bare).toContain("could not read the code host. deploys");
  });

  it("never prints a raw dotted key for the checks it knows", () => {
    for (const k of ["check.container_status.notRunning", "check.container_status.unhealthy", "repo.probe", "check.restart_counts.max"]) {
      const t = problemText(k, view({ [k]: "1" }), ["x (exited, exit 1, 1 minute ago)"], "");
      expect(t).not.toContain(k);
    }
  });

  it("the stopped-container names use the key the server flattens them into", () => {
    expect(STOPPED_CONTAINERS_KEY).toBe("check.container_status.stopped.names");
  });

  it("splits a flattened list back into whole entries, never on the commas inside one", () => {
    // A real report joins entries with "; ". Each entry contains ", " (exit code, since when), so splitting on
    // ", " used to print fragments ("bm-worker-1 (exited" and "exit 137" as separate containers), failing criterion 1.
    const flat = "bm-worker-1 (exited, exit 137, 2 hours ago); bm-cache-1 (restarting, exit 255, 5 minutes ago)";
    expect(stoppedContainerNames(flat)).toEqual([
      "bm-worker-1 (exited, exit 137, 2 hours ago)",
      "bm-cache-1 (restarting, exit 255, 5 minutes ago)",
    ]);
    expect(stoppedContainerNames("")).toEqual([]);
    // The split entries are what the line names, and no fragment sneaks in.
    const t = problemText("check.container_status.notRunning", view({ "check.container_status.notRunning": "2" }), stoppedContainerNames(flat), "");
    expect(t).toContain("the containers bm-worker-1 (exited, exit 137, 2 hours ago); bm-cache-1 (restarting, exit 255, 5 minutes ago) are not running");
  });
});
