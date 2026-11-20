import { describe, expect, it } from "vitest";
import { normaliseAddress, parseClientHeader, parseTrustedProxies, portalClientAddress } from "../src/portal-ip.js";

const proxy = "203.0.113.10";
const m = (raw: string) => parseTrustedProxies(raw).matcher;
const who = (peer: string, headers: Record<string, string | string[]>, list = proxy) => portalClientAddress(peer, headers, m(list));

describe("normaliseAddress (BOS-1948)", () => {
  it("keeps a plain IPv4 address, ignoring surrounding whitespace", () => {
    expect(normaliseAddress("192.168.1.50")).toBe("192.168.1.50");
    expect(normaliseAddress("  192.168.1.50  ")).toBe("192.168.1.50");
  });

  it("lower-cases IPv6 so one address has one spelling", () => {
    expect(normaliseAddress("2001:db8::1")).toBe("2001:db8::1");
    expect(normaliseAddress("2001:DB8::1")).toBe("2001:db8::1");
    expect(normaliseAddress("  2001:DB8::1  ")).toBe("2001:db8::1");
  });

  it("unwraps an IPv4-mapped IPv6 address to the plain IPv4 one", () => {
    expect(normaliseAddress("::ffff:192.168.1.50")).toBe("192.168.1.50");
    expect(normaliseAddress("::FFFF:192.168.1.50")).toBe("192.168.1.50");
    expect(normaliseAddress("  ::ffff:192.168.1.50  ")).toBe("192.168.1.50");
  });

  it("leaves a port on, and does not pretend to understand junk", () => {
    expect(normaliseAddress("192.168.1.50:443")).toBe("192.168.1.50:443");
    expect(normaliseAddress("[2001:db8::1]:443")).toBe("[2001:db8::1]:443");
    expect(normaliseAddress("not-an-address")).toBe("not-an-address");
    expect(normaliseAddress("999.1.1.1")).toBe("999.1.1.1");
    // Only a dotted IPv4 tail is unwrapped; a plain IPv6 tail is left as it is.
    expect(normaliseAddress("::ffff:2001:db8::1")).toBe("::ffff:2001:db8::1");
  });

  it("turns blank input into an empty string", () => {
    expect(normaliseAddress("")).toBe("");
    expect(normaliseAddress("   ")).toBe("");
    expect(normaliseAddress("\t\n")).toBe("");
  });
});

describe("portalClientAddress (BOS-1386)", () => {
  it("takes CF-Connecting-IP from a trusted proxy only when that header is chosen", () => {
    expect(portalClientAddress(proxy, { "cf-connecting-ip": "198.51.100.7" }, m(proxy), "cf-connecting-ip")).toBe("198.51.100.7");
  });
  it("ignores a forged CF-Connecting-IP from a trusted non-Cloudflare proxy (default header)", () => {
    expect(who(proxy, { "cf-connecting-ip": "6.6.6.6" })).toBe(proxy);
    expect(who(proxy, { "cf-connecting-ip": "6.6.6.6", "x-forwarded-for": "198.51.100.7" })).toBe("198.51.100.7");
    expect(portalClientAddress(proxy, { "cf-connecting-ip": "6.6.6.6", "x-forwarded-for": "198.51.100.7" }, m(proxy), "x-forwarded-for")).toBe("198.51.100.7");
  });
  it("with cf-connecting-ip chosen, ignores X-Forwarded-For and a peer that is not trusted", () => {
    expect(portalClientAddress(proxy, { "x-forwarded-for": "198.51.100.7" }, m(proxy), "cf-connecting-ip")).toBe(proxy);
    expect(portalClientAddress("198.51.100.99", { "cf-connecting-ip": "198.51.100.7" }, m(proxy), "cf-connecting-ip")).toBe("198.51.100.99");
  });
  it("reads the header setting: empty and unknown values mean X-Forwarded-For", () => {
    expect(parseClientHeader(undefined)).toEqual({ header: "x-forwarded-for", bad: null });
    expect(parseClientHeader(" CF-Connecting-IP ")).toEqual({ header: "cf-connecting-ip", bad: null });
    expect(parseClientHeader("x-real-ip")).toEqual({ header: "x-forwarded-for", bad: "x-real-ip" });
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
      expect([bad, portalClientAddress(proxy, { "cf-connecting-ip": bad }, m(proxy), "cf-connecting-ip")]).toEqual([bad, proxy]);
    }
  });
  it("with cf-connecting-ip chosen, a bad one does not fall through to X-Forwarded-For", () => {
    expect(portalClientAddress(proxy, { "cf-connecting-ip": "garbage", "x-forwarded-for": "192.0.2.1" }, m(proxy), "cf-connecting-ip")).toBe(proxy);
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
