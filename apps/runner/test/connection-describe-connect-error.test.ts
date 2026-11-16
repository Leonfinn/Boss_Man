// BOS-1601: what a failed dial means in plain words, pinned here (BOS-1617). A name that does not resolve is the usual
// first-install slip, and the wording differs for a Tailscale name. The token is never in the URL, so nothing but the
// host may be printed.
import { describe, expect, it } from "vitest";
import { describeConnectError } from "../src/connection.js";

const LAN_ADVICE = "use the server's LAN address instead (BOSSMAN_URL=ws://<server LAN address>:<port>/api/check-worker/connect), or check this host's DNS.";

describe("describeConnectError", () => {
  it("names the unresolved Tailscale address and the tailnet case", () => {
    const out = describeConnectError(
      "getaddrinfo ENOTFOUND boss-man.example.ts.net",
      "wss://boss-man.example.ts.net:8443/api/check-worker/connect",
    );
    expect(out).toBe(
      "getaddrinfo ENOTFOUND boss-man.example.ts.net. Can't find the address boss-man.example.ts.net:8443 from this machine. It is a Tailscale name and this host is not on your tailnet: " +
        LAN_ADVICE,
    );
    expect(out).toContain("Can't find the address boss-man.example.ts.net:8443 from this machine");
  });

  it("treats EAI_AGAIN like ENOTFOUND", () => {
    const out = describeConnectError("getaddrinfo EAI_AGAIN boss.example.ts.net", "wss://boss.example.ts.net/api/check-worker/connect");
    expect(out).toContain("Can't find the address boss.example.ts.net from this machine");
    expect(out).toContain("It is a Tailscale name and this host is not on your tailnet");
  });

  it("matches the .ts.net ending whatever its case", () => {
    const out = describeConnectError("getaddrinfo ENOTFOUND boss.example.TS.NET", "wss://boss.example.TS.NET/api/check-worker/connect");
    expect(out).toContain("It is a Tailscale name and this host is not on your tailnet");
  });

  it("offers the 'if it is a Tailscale name' wording for a name that is not one", () => {
    const out = describeConnectError("getaddrinfo ENOTFOUND boss.example.com", "wss://boss.example.com/api/check-worker/connect");
    expect(out).toContain("Can't find the address boss.example.com from this machine");
    expect(out).toContain("If it is a Tailscale name, this host is not on your tailnet");
    expect(out).not.toContain("It is a Tailscale name and this host is not on your tailnet");
    expect(out).toContain(LAN_ADVICE);
  });

  it("does not mistake a .ts.net prefix inside a longer name for Tailscale", () => {
    const out = describeConnectError("getaddrinfo ENOTFOUND boss.example.ts.net.evil.test", "wss://boss.example.ts.net.evil.test/api/check-worker/connect");
    expect(out).toContain("If it is a Tailscale name, this host is not on your tailnet");
  });

  it("leaves other network errors exactly as they came", () => {
    const message = "connect ECONNREFUSED 192.168.1.50:3100";
    expect(describeConnectError(message, "ws://192.168.1.50:3100/api/check-worker/connect")).toBe(message);
  });

  it("leaves an error alone when the address is not a URL at all", () => {
    const message = "getaddrinfo ENOTFOUND boss.example.ts.net";
    expect(describeConnectError(message, "boss.example.ts.net:3100")).toBe(message);
    expect(describeConnectError(message, "")).toBe(message);
  });

  it("leaves an error alone for a URL with no host", () => {
    const message = "getaddrinfo ENOTFOUND something";
    expect(describeConnectError(message, "file:///tmp/boss-man")).toBe(message);
  });

  it("prints only the host, never a token that rides in the URL", () => {
    const out = describeConnectError(
      "getaddrinfo ENOTFOUND boss.example.ts.net",
      "wss://boss.example.ts.net/api/check-worker/connect?token=not-a-real-token&id=42",
    );
    expect(out).toContain("Can't find the address boss.example.ts.net from this machine");
    expect(out).not.toContain("not-a-real-token");
    expect(out).not.toContain("token=");
  });
});
