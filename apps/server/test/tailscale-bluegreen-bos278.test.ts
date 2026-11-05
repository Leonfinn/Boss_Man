import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// BOS-278: the blue/green overlay puts Caddy (not a colour) behind Tailscale Serve, on :3100 only.
const read = (p: string) => readFileSync(new URL(`../../../${p}`, import.meta.url), "utf8");

describe("BOS-278 tailscale-bluegreen overlay", () => {
  const overlay = read("deploy/tailscale-bluegreen.yml");
  const serve = read("deploy/tailscale/serve.json");
  it("joins the proxy to edge under the name server, pinned", () => {
    expect(overlay).toMatch(/proxy:\s*\n\s*networks:[\s\S]*edge:\s*\n\s*#[^\n]*\n\s*ipv4_address: \$\{BOSSMAN_EDGE_PROXY_IP:-172\.30\.0\.3\}\s*\n\s*aliases: \[server\]/);
  });
  it("makes Caddy trust only the Tailscale container", () => {
    expect(overlay).toContain("BOSSMAN_CADDY_TRUSTED_PROXIES: ${BOSSMAN_EDGE_IP:-172.30.0.2}/32");
  });
  it("waits for the proxy, not the parked server", () => {
    expect(overlay).toContain("depends_on: !override [proxy]");
  });
  it("serve.json reaches only :3100 and never opens Funnel", () => {
    expect(serve).toContain("http://server:3100");
    expect(serve).not.toContain("3101");
    expect(serve).not.toContain("AllowFunnel");
  });
});
