// The runner's own network-guard probe (DR-049 point 2). The route parsing and the classification are
// checked everywhere; the live case runs a real connect to this host's gateway and pins the errno and
// timing the guard gives (EHOSTUNREACH in well under a second) when this host has the guard.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { classify, defaultGateway, probeGuard, probeGuardWhenReady, tryConnect } from "../src/guard-probe.js";

const HEADER = "Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT\n";

describe("default gateway from the routing table", () => {
  it("reads the little-endian gateway of the default route", () => {
    const route = HEADER + "eth0\t00000000\t010012AC\t0003\t0\t0\t0\t00000000\t0\t0\t0\neth0\t000012AC\t00000000\t0001\t0\t0\t0\t0000FFFF\t0\t0\t0\n";
    expect(defaultGateway(route)).toBe("172.18.0.1");
  });
  it("takes the lowest metric and ignores routes without a gateway", () => {
    const route = HEADER + "eth1\t00000000\t0100A8C0\t0003\t0\t0\t100\t00000000\t0\t0\t0\neth0\t00000000\t0100000A\t0003\t0\t0\t10\t00000000\t0\t0\t0\neth2\t00000000\t00000000\t0001\t0\t0\t1\t00000000\t0\t0\t0\n";
    expect(defaultGateway(route)).toBe("10.0.0.1");
  });
  it("returns null with no default route", () => {
    expect(defaultGateway(HEADER + "eth0\t000012AC\t00000000\t0001\t0\t0\t0\t0000FFFF\t0\t0\t0\n")).toBeNull();
    expect(defaultGateway("")).toBeNull();
  });
});

describe("classification", () => {
  it("only an EHOSTUNREACH error is the guard", () => {
    expect(classify({ outcome: "error", errno: "EHOSTUNREACH", ms: 1 })).toBe("on");
    expect(classify({ outcome: "error", errno: "EHOSTUNREACH", ms: 3000 })).toBe("absent"); // slow = ARP failure, not the guard
    expect(classify({ outcome: "error", errno: "ECONNREFUSED", ms: 1 })).toBe("absent");
    expect(classify({ outcome: "error", errno: "ENETUNREACH", ms: 1 })).toBe("absent");
    expect(classify({ outcome: "timeout", errno: null, ms: 3000 })).toBe("absent");
    expect(classify({ outcome: "connected", errno: null, ms: 1 })).toBe("absent");
  });
  it("sees a real connect, a real refusal", async () => {
    const server = net.createServer((s) => s.destroy());
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as net.AddressInfo).port;
    expect((await tryConnect("127.0.0.1", port, 2000)).outcome).toBe("connected");
    await new Promise((r) => server.close(r));
    const refused = await tryConnect("127.0.0.1", port, 2000);
    expect(refused).toMatchObject({ outcome: "error", errno: "ECONNREFUSED" });
  });
  it("reports absent when there is no gateway", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "bm-guard-"));
    try {
      writeFileSync(path.join(dir, "route"), HEADER);
      expect(await probeGuard({ routeFile: path.join(dir, "route") })).toMatchObject({ state: "absent", reason: "no default gateway found" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("probe right after a runner swap (BOS-1362)", () => {
  const LOOPBACK_GW = "eth0\t00000000\t0100007F\t0003\t0\t0\t0\t00000000\t0\t0\t0\n";
  it("waits for the default route the launcher adds after the guard loads, then probes", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "bm-guard-"));
    const server = net.createServer((s) => s.destroy());
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as net.AddressInfo).port;
    try {
      const route = path.join(dir, "route");
      writeFileSync(route, HEADER); // runner started with no network
      setTimeout(() => writeFileSync(route, HEADER + LOOPBACK_GW), 150); // network attached a moment later
      const report = await probeGuardWhenReady({ routeFile: route, port, pollMs: 20, waitMs: 10_000 });
      // It got past "no default gateway": it probed the gateway (which here accepts, so not the guard: absent, for that reason).
      expect(report.reason).toBe("connect to the gateway succeeded");
    } finally {
      await new Promise((r) => server.close(r));
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("still says absent when the network never arrives", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "bm-guard-"));
    try {
      writeFileSync(path.join(dir, "route"), HEADER);
      const report = await probeGuardWhenReady({ routeFile: path.join(dir, "route"), pollMs: 10, waitMs: 100 });
      expect(report.state).toBe("absent");
      expect(report.reason).toMatch(/^no default gateway found after /);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe.runIf(process.platform === "linux" && existsSync("/proc/net/route") && defaultGateway(readFileSync("/proc/net/route", "utf8")) !== null)("live probe on this host", () => {
  it("gives a verdict that matches the errno, and a guard refusal is immediate", async () => {
    const report = await probeGuard({ timeoutMs: 3000 });
    // Surface the probe output (vitest hides console.log).
    if (report.state === "on") {
      expect(report.errno).toBe("EHOSTUNREACH");
      expect(report.ms).toBeLessThan(1000);
    } else {
      expect(report.errno).not.toBe("EHOSTUNREACH");
    }
    if (process.env.BOSSMAN_EXPECT_GUARD === "on") expect(report).toMatchObject({ state: "on", errno: "EHOSTUNREACH" });
  });
});
