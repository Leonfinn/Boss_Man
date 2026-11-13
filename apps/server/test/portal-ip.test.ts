import { describe, expect, it } from "vitest";
import { parseTrustedProxies, portalClientAddress } from "../src/portal-ip.js";

const proxy = "203.0.113.10";
const m = (raw: string) => parseTrustedProxies(raw).matcher;
const who = (peer: string, headers: Record<string, string | string[]>, list = proxy) => portalClientAddress(peer, headers, m(list));

describe("portalClientAddress (BOS-1386)", () => {
  it("takes CF-Connecting-IP from a trusted proxy", () => {
    expect(who(proxy, { "cf-connecting-ip": "198.51.100.7" })).toBe("198.51.100.7");
  });
  it("ignores both headers from an address that is not a trusted proxy", () => {
    expect(who("198.51.100.99", { "cf-connecting-ip": "198.51.100.7", "x-forwarded-for": "192.0.2.1" })).toBe("198.51.100.99");
    expect(who("198.51.100.99", { "x-forwarded-for": "192.0.2.1" })).toBe("198.51.100.99");
  });
  it("matches a CIDR (v4 and v6) and an IPv4-mapped peer", () => {
    expect(who("10.4.5.6", { "x-forwarded-for": "198.51.100.7" }, "10.0.0.0/8")).toBe("198.51.100.7");
    expect(who("11.4.5.6", { "x-forwarded-for": "198.51.100.7" }, "10.0.0.0/8")).toBe("11.4.5.6");
    expect(who("2001:db8::5", { "x-forwarded-for": "198.51.100.7" }, "2001:db8::/32")).toBe("198.51.100.7");
    expect(who("2001:db9::5", { "x-forwarded-for": "198.51.100.7" }, "2001:db8::/32")).toBe("2001:db9::5");
    expect(who("::ffff:10.4.5.6", { "x-forwarded-for": "198.51.100.7" }, "10.0.0.0/8")).toBe("198.51.100.7");
    expect(who("::ffff:198.51.100.99", {})).toBe("198.51.100.99");
  });
  it("walks an X-Forwarded-For chain from the right, skipping trusted hops and ignoring forged left entries", () => {
    expect(who(proxy, { "x-forwarded-for": "6.6.6.6, 198.51.100.7" })).toBe("198.51.100.7");
    expect(who(proxy, { "x-forwarded-for": "6.6.6.6, 198.51.100.7, 10.1.1.1, 10.2.2.2" }, `${proxy}, 10.0.0.0/8`)).toBe("198.51.100.7");
    expect(who(proxy, { "x-forwarded-for": "198.51.100.7, 203.0.113.10" })).toBe("198.51.100.7");
    expect(who(proxy, { "x-forwarded-for": "198.51.100.7", })).toBe("198.51.100.7");
  });
  it("never reads entries left of the first untrusted one", () => {
    expect(who(proxy, { "x-forwarded-for": "garbage,198.51.100.7" })).toBe("198.51.100.7");
  });
  it("joins repeated X-Forwarded-For header lines", () => {
    expect(who(proxy, { "x-forwarded-for": ["6.6.6.6", "198.51.100.7"] })).toBe("198.51.100.7");
  });
  it("falls back to the connecting address when every hop is trusted", () => {
    expect(who(proxy, { "x-forwarded-for": "10.1.1.1, 10.2.2.2" }, `${proxy}, 10.0.0.0/8`)).toBe(proxy);
  });
  it("falls back on a garbage, empty, port-suffixed or over-long header", () => {
    for (const bad of ["garbage", "", " ", "198.51.100.7:443", "198.51.100.7, garbage", "198.51.100.7,", "999.1.1.1", "x".repeat(5000), `${"1.1.1.1,".repeat(400)}198.51.100.7`]) {
      expect([bad.slice(0, 20), who(proxy, { "x-forwarded-for": bad })]).toEqual([bad.slice(0, 20), proxy]);
    }
    for (const bad of ["garbage", "", "198.51.100.7, 198.51.100.8", "198.51.100.7:1"]) {
      expect([bad, who(proxy, { "cf-connecting-ip": bad })]).toEqual([bad, proxy]);
    }
  });
  it("lets CF-Connecting-IP win over X-Forwarded-For, and a bad one does not fall through to it", () => {
    expect(who(proxy, { "cf-connecting-ip": "198.51.100.7", "x-forwarded-for": "192.0.2.1" })).toBe("198.51.100.7");
    expect(who(proxy, { "cf-connecting-ip": "garbage", "x-forwarded-for": "192.0.2.1" })).toBe(proxy);
  });
  it("uses the connecting address when a trusted proxy sends no header", () => {
    expect(who(proxy, {})).toBe(proxy);
  });
  it("gives one key to one visitor however the address is written", () => {
    expect(who(proxy, { "x-forwarded-for": "::FFFF:198.51.100.7" })).toBe("198.51.100.7");
    expect(who(proxy, { "x-forwarded-for": "2001:DB8::7" })).toBe("2001:db8::7");
  });
  it("trusts nobody when the setting is empty, blank or only bad entries", () => {
    for (const raw of ["", "   ", ",", "nonsense", "0.0.0.0/0", "::/0", "10.0.0.0/33", "10.0.0.0/abc", "1.2.3.4/8/9"]) {
      expect([raw, m(raw).size]).toEqual([raw, 0]);
      expect([raw, portalClientAddress(proxy, { "cf-connecting-ip": "198.51.100.7", "x-forwarded-for": "198.51.100.7" }, m(raw))]).toEqual([raw, proxy]);
    }
  });
  it("reports bad entries and keeps the good one beside them", () => {
    const r = parseTrustedProxies("nonsense, 203.0.113.10 0.0.0.0/0");
    expect(r.ignored).toEqual(["nonsense", "0.0.0.0/0"]);
    expect(r.matcher.has("203.0.113.10")).toBe(true);
    expect(r.matcher.has("203.0.113.11")).toBe(false);
  });
});
