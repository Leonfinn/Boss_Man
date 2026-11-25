import { describe, expect, it } from "vitest";
import { NORMALLY_EMPTY_FACTS, STOPPED_CONTAINERS_KEY, UNHEALTHY_CONTAINERS_KEY, failingCheckText, problemText, stoppedContainerNames, type HostFactsView } from "../src/host-facts-display";

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

// failingCheckText is the single place that turns a failing check and its reported value into the two
// sentences the "Worth a look" block shows: what is wrong, and what to do. Pin each branch directly,
// so a key or a count rewritten in passing fails here rather than reaching the owner.
describe("failingCheckText: what a failing check says (BOS-986)", () => {
  it("names several stopped containers and how many of the stack they are out of", () => {
    const d = view({ "check.container_status.notRunning": "2", "check.container_status.total": "18" });
    const t = failingCheckText("check.container_status.notRunning", d, ["bm-worker-1 (exited, exit 137, 2 hours ago)", "bm-cache-1 (restarting, exit 255, 5 minutes ago)"], "");
    expect(t.what).toBe("the containers bm-worker-1 (exited, exit 137, 2 hours ago); bm-cache-1 (restarting, exit 255, 5 minutes ago) are not running (of 18 in the Boss Man stack)");
    expect(t.fix).toContain("pressing Build and update runners");
    expect(t.fix).toContain("starts the stack again");
    expect(t.fix).not.toContain("check.container_status");
  });

  it("says one stopped container in the singular, without a total when the host did not report one", () => {
    const t = failingCheckText("check.container_status.notRunning", view({ "check.container_status.notRunning": "1" }), [], "");
    expect(t.what).toBe("1 container is not running");
    expect(t.fix).toContain("the part of Boss Man it runs is down");
  });

  it("still gives the count and the stack total when an older deployer reports no names", () => {
    const d = view({ "check.container_status.notRunning": " 3 ", "check.container_status.total": "18" });
    const t = failingCheckText("check.container_status.notRunning", d, [], "");
    expect(t.what).toBe("3 containers are not running (of 18 in the Boss Man stack)");
    // The value is trimmed, so a padded report reads the same.
    expect(t.what).not.toContain(" 3 ");
  });

  it("says zero containers in the plural, so a cleared check cannot read 'is'", () => {
    const t = failingCheckText("check.container_status.notRunning", view({ "check.container_status.notRunning": "0" }), [], "");
    expect(t.what).toBe("0 containers are not running");
  });

  it("counts restarting or unhealthy containers in the singular and the plural", () => {
    const one = failingCheckText("check.container_status.unhealthy", view({ "check.container_status.unhealthy": "1" }), [], "");
    expect(one.what).toBe("1 container is restarting or unhealthy (this host's deployer is too old to name them)");
    expect(one.fix).toContain("failing its own health check");
    const several = failingCheckText("check.container_status.unhealthy", view({ "check.container_status.unhealthy": "3" }), [], "");
    expect(several.what).toContain("3 containers are restarting or unhealthy");
  });

  it("names the unhealthy containers the host reported (BOS-2481)", () => {
    const d = view({ "check.container_status.unhealthy": "2", [UNHEALTHY_CONTAINERS_KEY]: "runner; worker" });
    expect(failingCheckText("check.container_status.unhealthy", d, [], "").what).toBe("2 containers are restarting or unhealthy: runner, worker");
  });

  it("never shows a blank check name: an empty or unknown fact is named by its key (BOS-2481)", () => {
    const empty = problemText("check.something.new", view({ "check.something.new": "" }), [], "");
    expect(empty).toContain('"check.something.new"');
    expect(empty.startsWith(".")).toBe(false);
    expect(failingCheckText("check.something.new", view({ "check.something.new": "weird" }), [], "").what).toBe('The check "check.something.new" reports "weird"');
  });

  it("does not count a fact the host leaves empty when all is well as missing (BOS-2481)", () => {
    expect([...NORMALLY_EMPTY_FACTS].sort()).toEqual(["compose.liveColour", "repo.probeWhy"]);
  });

  it("quotes the code host's own reason when there is one, and omits the colon when there is not", () => {
    const withReason = failingCheckText("repo.probe", view({ "repo.probe": "failed" }), [], "ssh: connect to host <code host> port 22: Connection timed out");
    expect(withReason.what).toBe("Boss Man could not read the code host: ssh: connect to host <code host> port 22: Connection timed out");
    expect(withReason.fix).toContain("deploys that already have the code still work");
    const withoutReason = failingCheckText("repo.probe", view({ "repo.probe": "failed" }), [], "");
    expect(withoutReason.what).toBe("Boss Man could not read the code host");
  });

  it("says how many times a container restarted, in the singular and the plural", () => {
    const once = failingCheckText("check.restart_counts.max", view({ "check.restart_counts.max": "1" }), [], "");
    expect(once.what).toBe("a container has restarted 1 time");
    expect(once.fix).toContain("Settings → Server and runner → Updates");
    const many = failingCheckText("check.restart_counts.max", view({ "check.restart_counts.max": "4" }), [], "");
    expect(many.what).toBe("a container has restarted 4 times");
  });

  it("says the host's own record is out of date for either state-file key", () => {
    for (const key of ["check.state_file_sizes.ageSeconds", "check.state_file_sizes.stale"]) {
      const t = failingCheckText(key, view({ [key]: "600" }), [], "");
      expect(t.what, key).toBe("the host's own record is out of date");
      expect(t.fix, key).toContain("the host deployer runs every minute");
    }
  });

  it("falls back to the raw value and a generic line for a check it does not know", () => {
    const t = failingCheckText("check.something.new", view({ "check.something.new": "weird" }), [], "");
    expect(t.what).toBe('The check "check.something.new" reports "weird"');
    expect(t.fix).toBe("this is a check the host runs about itself; its log on the host says more.");
  });

  it("never leaks a raw dotted key for any check it knows", () => {
    for (const key of ["check.container_status.notRunning", "check.container_status.unhealthy", "repo.probe", "check.restart_counts.max", "check.state_file_sizes.ageSeconds"]) {
      const t = failingCheckText(key, view({ [key]: "1" }), [], "");
      expect(t.what, key).not.toContain(key);
      expect(t.fix, key).not.toContain(key);
    }
  });
});
