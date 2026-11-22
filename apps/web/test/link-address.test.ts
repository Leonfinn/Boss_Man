import { describe, expect, it } from "vitest";
import { defaultLinkAddress } from "../src/link-address";

const pub = (value: string) => ({ "network.publicAddress": { value } });

describe("defaultLinkAddress (BOS-1603)", () => {
  it("prefers the confirmed public address over the browser's", () => {
    const r = defaultLinkAddress({ origin: "https://box.example-tailnet.ts.net", facts: pub("portal.example.com"), who: "clients" });
    expect(r.url).toBe("https://portal.example.com");
  });
  it("uses the browser address only when it is a public https name", () => {
    expect(defaultLinkAddress({ origin: "https://boss.example.com", who: "phone" }).url).toBe("https://boss.example.com");
  });
  it.each(["https://box.example-tailnet.ts.net", "http://192.168.1.50:3100", "http://localhost:3100", "https://nas.local", "http://boss.example.com"])(
    "guesses nothing from %s and says so",
    (origin) => {
      const r = defaultLinkAddress({ origin, who: "clients" });
      expect(r.url).toBe("");
      expect(r.note).toMatch(/No public address is known/);
    },
  );
  it("names the Tailscale case", () => {
    expect(defaultLinkAddress({ origin: "https://box.example-tailnet.ts.net", who: "phone" }).note).toMatch(/Tailscale/);
  });
});
