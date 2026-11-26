import { describe, expect, it } from "vitest";
import { flattenHostRecord, type HostRecord } from "../src/services/host-facts.js";

// flattenHostRecord (BOS-1314): which host facts are kept or dropped when the deployer's report is flattened.
// Its last line silently drops any key outside [A-Za-z0-9_.]{1,80} and any value over 500 characters, so these
// tests pin the drop rules and the optional sections the other host-facts tests don't reach.

/** A host record with nothing but the always-present fields; each test adds the section it is about. */
const base = (): HostRecord => ({ version: 1, name: "box1", writtenAt: "2026-11-12T00:00:00Z", ownership: [] });

const repo = (origin: string): NonNullable<HostRecord["repo"]> => ({
  origin,
  originHost: "example.com",
  embeddedCredentials: false,
  probe: "ok",
  probedAt: "2026-11-12T00:00:00Z",
  probeWhy: "",
});

const SHA = "0123456789abcdef".repeat(4); // 64 hex characters, the only shape the deployer fingerprint accepts

describe("flattenHostRecord: fact names", () => {
  it("keeps a port named BOSSMAN_HOST_PORT and drops a hyphenated port name", () => {
    const flat = flattenHostRecord({ ...base(), network: { addresses: [], ports: { BOSSMAN_HOST_PORT: "3100", "my-port": "3101" } } });
    expect(flat["network.port.BOSSMAN_HOST_PORT"]).toBe("3100");
    // "-" is not allowed in a fact key, so a port named "my-port" is dropped. That is not a bug unless a
    // deployer reports hyphenated names; it reports the compose service names it is given.
    expect(flat["network.port.my-port"]).toBeUndefined();
  });

  it("keeps a plain add-on name and drops a hyphenated one", () => {
    const flat = flattenHostRecord({ ...base(), addons: { ntfy: "running", "my-addon": "running" } });
    expect(flat["addon.ntfy"]).toBe("running");
    expect(flat["addon.my-addon"]).toBeUndefined();
  });
});

describe("flattenHostRecord: value length", () => {
  it("keeps a 500-character value and drops a 501-character one without touching other keys", () => {
    const atLimit = flattenHostRecord({ ...base(), repo: repo("a".repeat(500)) });
    expect(atLimit["repo.origin"]).toBe("a".repeat(500));
    expect(atLimit["repo.originHost"]).toBe("example.com");

    const overLimit = flattenHostRecord({ ...base(), repo: repo("a".repeat(501)) });
    expect(overLimit["repo.origin"]).toBeUndefined();
    // Only the over-long fact goes; the rest of the same section stays.
    expect(overLimit["repo.originHost"]).toBe("example.com");
    expect(overLimit["repo.probe"]).toBe("ok");
  });
});

describe("flattenHostRecord: deployer fingerprints", () => {
  it("leaves out an empty scriptSha and repoSha", () => {
    const flat = flattenHostRecord({ ...base(), deployer: { scriptSha: "", repoSha: "" } });
    expect(flat["deployer.scriptSha"]).toBeUndefined();
    expect(flat["deployer.repoSha"]).toBeUndefined();
  });

  it("keeps a 64-hex scriptSha and repoSha", () => {
    const flat = flattenHostRecord({ ...base(), deployer: { scriptSha: SHA, repoSha: SHA } });
    expect(flat["deployer.scriptSha"]).toBe(SHA);
    expect(flat["deployer.repoSha"]).toBe(SHA);
  });

  it("keeps only the fingerprint the host could read", () => {
    const flat = flattenHostRecord({ ...base(), deployer: { scriptSha: "", repoSha: SHA } });
    expect(flat["deployer.scriptSha"]).toBeUndefined();
    expect(flat["deployer.repoSha"]).toBe(SHA);
  });
});

describe("flattenHostRecord: ntfy section", () => {
  it("keeps baseUrl and container when the host reports them", () => {
    const flat = flattenHostRecord({ ...base(), ntfy: { baseUrl: "https://ntfy.example.com", container: "ntfy" } });
    expect(flat["ntfy.baseUrl"]).toBe("https://ntfy.example.com");
    expect(flat["ntfy.container"]).toBe("ntfy");
  });

  it("keeps serverReach, including false (ntfy runs but the server can't reach it)", () => {
    expect(flattenHostRecord({ ...base(), ntfy: { serverReach: false } })["ntfy.serverReach"]).toBe("false");
    expect(flattenHostRecord({ ...base(), ntfy: { serverReach: true } })["ntfy.serverReach"]).toBe("true");
  });

  it("gives no ntfy keys when the section reports neither field", () => {
    const flat = flattenHostRecord({ ...base(), ntfy: {} });
    expect(Object.keys(flat).filter((k) => k.startsWith("ntfy."))).toEqual([]);
  });
});

describe("flattenHostRecord: check lists", () => {
  it("keeps only the count for a list under a check other than container_status.stopped", () => {
    const flat = flattenHostRecord({
      ...base(),
      checks: { other_check: { items: [{ name: "thing", status: "up", exit: "", since: "" }] } },
    });
    expect(flat["check.other_check.items"]).toBe("1");
    expect(flat["check.other_check.items.names"]).toBeUndefined();
  });

  it("carries the unhealthy container names, and leaves an empty list out so it never reads as missing (BOS-2481)", () => {
    const some = flattenHostRecord({ ...base(), checks: { container_status: { unhealthy: 1, unhealthyNames: "runner" } } });
    expect(some["check.container_status.unhealthyNames"]).toBe("runner");
    const none = flattenHostRecord({ ...base(), checks: { container_status: { unhealthy: 0, unhealthyNames: "" } } });
    expect("check.container_status.unhealthyNames" in none).toBe(false);
  });

  it("carries the last health-probe reason, and leaves an empty one out (BOS-2680)", () => {
    const some = flattenHostRecord({ ...base(), checks: { container_status: { unhealthyReason: "runner (exit 1, 3 failed in a row)" } } });
    expect(some["check.container_status.unhealthyReason"]).toBe("runner (exit 1, 3 failed in a row)");
    const none = flattenHostRecord({ ...base(), checks: { container_status: { unhealthyReason: "" } } });
    expect("check.container_status.unhealthyReason" in none).toBe(false);
    const where = flattenHostRecord({ ...base(), checks: { container_status: { unhealthyWhere: "runner-x (stack staging)" } } });
    expect(where["check.container_status.unhealthyWhere"]).toBe("runner-x (stack staging)");
    const noWhere = flattenHostRecord({ ...base(), checks: { container_status: { unhealthyWhere: "" } } });
    expect("check.container_status.unhealthyWhere" in noWhere).toBe(false);
  });

  it("reports an empty stopped list as 0 and adds no names key", () => {
    const flat = flattenHostRecord({ ...base(), checks: { container_status: { stopped: [] } } });
    expect(flat["check.container_status.stopped"]).toBe("0");
    expect(flat["check.container_status.stopped.names"]).toBeUndefined();
  });
});

describe("flattenHostRecord: absent sections", () => {
  it("gives no memory, network or compose keys when the host reports those sections not at all", () => {
    const flat = flattenHostRecord(base());
    expect(Object.keys(flat).filter((k) => /^(memory|network|compose)\./.test(k))).toEqual([]);
    expect(flat["compose.cmd"]).toBeUndefined();
  });
});
