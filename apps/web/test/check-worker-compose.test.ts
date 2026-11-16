// BOS-1550: the compose file Boss Man shows for a new check worker is the repo's deploy/check-worker/compose.yaml, filled in.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import template from "../src/pages/settings/check-worker-compose.yaml?raw";
import { workerAddressChoices, workerComposeFile, workerSocketUrl } from "../src/pages/settings/check-worker-compose";

describe("check worker compose file (BOS-1550)", () => {
  it("the web copy is identical to deploy/check-worker/compose.yaml", () => {
    expect(template).toBe(readFileSync(new URL("../../../deploy/check-worker/compose.yaml", import.meta.url), "utf8"));
  });

  it("fills in the address, the slots and the token, and has no commit for the owner to keep up to date (BOS-1570)", () => {
    const out = workerComposeFile({ url: workerSocketUrl("https://boss.example.org/"), slots: 3, token: "bmw_example" });
    expect(out).toContain("wss://boss.example.org/api/check-worker/connect");
    expect(out).toContain("Boss_Man.git#main");
    expect(out).not.toContain("BOSSMAN_IMAGE_COMMIT");
    expect(out).not.toContain("CHANGE THIS (commit");
    expect(out).not.toMatch(/[0-9a-f]{40}/);
    expect(out).toContain('BOSSMAN_CHECK_SLOTS: "3"');
    expect(out).toContain('content: "bmw_example"');
    expect(out).not.toContain("PASTE-THE-WORKER-TOKEN-HERE");
    expect(out).not.toContain("boss.example.com");
    expect(out).not.toContain("0".repeat(40));
    // The hardening is still there, and the token is never in the environment.
    for (const line of ["cap_drop: [ALL]", 'security_opt: ["no-new-privileges:true"]', "oom_score_adj: 500", "mem_limit: 8g"]) expect(out).toContain(line);
    expect(out).not.toMatch(/\n\s+ports:/);
    expect(out).not.toContain("docker.sock");
    expect(out).not.toMatch(/BOSSMAN_CHECK_WORKER_TOKEN:/);
  });

  it("builds the image with a browser and without the agent harness (BOS-1553)", () => {
    const out = workerComposeFile({ url: "wss://x/api/check-worker/connect", slots: 1, token: "t" });
    expect(out).toContain("RUNNER_ADDONS: agent-browser");
    expect(out).toContain('WITH_HARNESS: "0"');
  });

  it("offers the local network address first and says where each address works (BOS-1601)", () => {
    const facts = { "network.addresses": { value: "192.168.1.50" }, "network.port.BOSSMAN_HOST_PORT": { value: "3199" }, "network.port.BOSSMAN_BIND": { value: "0.0.0.0" } };
    const c = workerAddressChoices({ origin: "https://boss-man.tailexample.ts.net", facts });
    expect(c[0]!.url).toBe("ws://192.168.1.50:3199/api/check-worker/connect");
    expect(c[0]!.worksFrom).toContain("Any machine on the same network");
    expect(c[0]!.warning).toContain("not encrypted");
    const ts = c.find((x) => x.url.startsWith("wss://boss-man.tailexample.ts.net"))!;
    expect(ts.worksFrom).toContain("Only machines on your Tailscale network");
    expect(ts.warning).toBeUndefined();
  });

  it("warns when Boss Man only listens on its own machine, and falls back to the page's address with no host facts", () => {
    const closed = workerAddressChoices({ origin: "https://x.example.com", facts: { "network.addresses": { value: "192.168.1.50" } } });
    expect(closed[0]!.url).toBe("ws://192.168.1.50:3100/api/check-worker/connect");
    expect(closed[0]!.worksFrom).toContain("BOSSMAN_BIND");
    expect(workerAddressChoices({ origin: "https://x.example.com" }).map((x) => x.url)).toEqual(["wss://x.example.com/api/check-worker/connect"]);
  });

  const bridges = ["172.17.0.1", "172.18.0.1", "172.19.0.1", "172.20.0.1", "172.21.0.1", "172.22.0.1", "172.23.0.1", "172.24.0.1", "172.25.0.1", "172.26.0.1"];
  const host = (bind: string, addrs: string[]) => ({
    "network.addresses": { value: addrs.join(",") },
    "network.port.BOSSMAN_HOST_PORT": { value: "3100" },
    "network.port.BOSSMAN_BIND": { value: bind },
  });

  it("a host with one LAN address and ten Docker bridges, in either order, offers and defaults to the LAN address only (BOS-1601)", () => {
    for (const addrs of [["192.168.1.50", ...bridges], [...bridges, "192.168.1.50"]]) {
      for (const bind of ["192.168.1.50", "0.0.0.0"]) {
        const c = workerAddressChoices({ origin: "https://boss-man.tailexample.ts.net", facts: host(bind, addrs) });
        expect(c[0]!.url).toBe("ws://192.168.1.50:3100/api/check-worker/connect");
        expect(c.filter((x) => x.kind === "lan")).toHaveLength(1);
        expect(c.some((x) => x.url.includes("172."))).toBe(false);
      }
    }
  });

  it("offers only the specific address Boss Man is bound to, not other private addresses on the host", () => {
    const c = workerAddressChoices({ origin: "http://192.168.1.50:3100", facts: host("192.168.1.50", ["10.0.0.5", "192.168.1.50"]) });
    expect(c.filter((x) => x.kind === "lan").map((x) => x.url)).toEqual(["ws://192.168.1.50:3100/api/check-worker/connect"]);
  });

  it("with the page open at a Tailscale name and a LAN address reported, the default is the LAN address, not the browser's", () => {
    const c = workerAddressChoices({ origin: "https://boss-man.tailexample.ts.net", facts: host("0.0.0.0", ["192.168.1.50"]) });
    expect(c[0]!.url).toBe("ws://192.168.1.50:3100/api/check-worker/connect");
    expect(c[0]!.kind).toBe("lan");
  });

  it("with no usable LAN address there is no 'lan' choice, so the form can say so", () => {
    const c = workerAddressChoices({ origin: "https://boss-man.tailexample.ts.net", facts: host("0.0.0.0", bridges) });
    expect(c.some((x) => x.kind === "lan")).toBe(false);
  });

  it("never tells the owner to set BOSSMAN_BIND=0.0.0.0", () => {
    const c = workerAddressChoices({ origin: "https://x.example.com", facts: host("127.0.0.1", ["192.168.1.50"]) });
    expect(c[0]!.worksFrom).toContain("not 0.0.0.0");
    expect(c[0]!.worksFrom).not.toContain("BOSSMAN_BIND=0.0.0.0");
  });

  it("quotes a token so it cannot break out of the YAML string", () => {
    expect(workerComposeFile({ url: "wss://x/api/check-worker/connect", slots: 1, token: 'a"b\nc' })).toContain('content: "a\\"b\\nc"');
  });
});
