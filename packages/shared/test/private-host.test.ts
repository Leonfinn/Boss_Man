import { describe, expect, it } from "vitest";
import { inV4Ranges, inV6Ranges, isPrivateHost, mappedV4InRanges, NON_PUBLIC_V4, NON_PUBLIC_V6 } from "../src/policy.js";

// BOS-1143: the address checks behind the home-network guard (BOS-886). The permission check and the
// skill fetcher are already covered through isPrivateAddress in apps/server/test; this file pins the
// four helpers they are built from, and isPrivateHost, the one the permission check calls on a URL host.

const v4ToNumber = (ip: string): number => ip.split(".").reduce((n, part) => ((n << 8) | Number(part)) >>> 0, 0);

const numberToV4 = (n: number): string => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");

const v4Mask = (bits: number): number => (bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0);

/** The first and last address of an IPv4 table row. */
function v4Bounds([network, bits]: readonly [string, number]): [string, string] {
  const first = (v4ToNumber(network) & v4Mask(bits)) >>> 0;
  const last = (first | (~v4Mask(bits) >>> 0)) >>> 0;
  return [numberToV4(first), numberToV4(last)];
}

/** The first and last address of an IPv6 table row, written as full literals so isPrivateHost reads them as addresses. */
function v6Bounds([network, bits]: readonly [string, number]): [string, string] {
  const mask = (0xffff << (16 - bits)) & 0xffff;
  const first = parseInt(network, 16) & mask;
  const last = (first | (~mask & 0xffff)) & 0xffff;
  return [`${first.toString(16)}::1`, `${last.toString(16)}::1`];
}

describe("isPrivateHost: IPv4 non-public ranges", () => {
  it("is true for the first and last address of every NON_PUBLIC_V4 row", () => {
    for (const row of NON_PUBLIC_V4) {
      const [first, last] = v4Bounds(row);
      expect(isPrivateHost(first), `${row[0]}/${row[1]} first ${first}`).toBe(true);
      expect(isPrivateHost(last), `${row[0]}/${row[1]} last ${last}`).toBe(true);
    }
  });

  it("is true for the private, loopback, link-local and reserved addresses the ticket names", () => {
    for (const ip of ["10.1.2.3", "172.16.0.0", "172.31.255.255", "192.168.1.1", "127.0.0.1", "169.254.169.254", "0.0.0.0", "100.64.0.1", "224.0.0.251", "198.18.0.1"]) {
      expect(isPrivateHost(ip), ip).toBe(true);
    }
  });

  it("is true for localhost and a bare host name, which can only be local", () => {
    for (const host of ["localhost", "truenas", "some-host.local", "printer.lan", "router.home.arpa"]) expect(isPrivateHost(host), host).toBe(true);
  });

  it("is false just outside 172.16.0.0/12, just outside 100.64.0.0/10, and for public IPv4", () => {
    // 172.15/172.32 and 100.128 are the addresses either side of the rows, not in any other row.
    for (const ip of ["172.15.0.1", "172.15.255.255", "172.32.0.1", "172.32.0.0", "100.128.0.1", "198.20.0.1", "223.255.255.255", "8.8.8.8", "1.1.1.1"]) {
      expect(isPrivateHost(ip), ip).toBe(false);
    }
  });
});

describe("isPrivateHost: IPv6 non-public ranges", () => {
  it("is true for the first and last address of every NON_PUBLIC_V6 row", () => {
    for (const row of NON_PUBLIC_V6) {
      const [first, last] = v6Bounds(row);
      expect(isPrivateHost(first), `${row[0]}/${row[1]} first ${first}`).toBe(true);
      expect(isPrivateHost(last), `${row[0]}/${row[1]} last ${last}`).toBe(true);
    }
  });

  it("is true for ::, ::1 and the named IPv6 ranges", () => {
    for (const ip of ["::", "::1", "fc00::1", "fd12:3456::1", "fe80::1", "fec0::1", "ff02::1"]) expect(isPrivateHost(ip), ip).toBe(true);
  });

  it("is false for public IPv6 addresses, including one that starts like a table row", () => {
    // feed.com and fcbarcelona.com look like fec0::/10 and fc00::/7, but a name is not an address (BOS-896).
    for (const ip of ["2606:4700:4700::1111", "2001:4860:4860::8888", "2a00:1450:4001:81b::200e", "feed.com", "fcbarcelona.com"]) {
      expect(isPrivateHost(ip), ip).toBe(false);
    }
  });
});

describe("IPv4 hidden inside IPv6", () => {
  it("reads both the dotted and hex IPv4-mapped forms", () => {
    // The URL parser rewrites ::ffff:192.168.0.1 as ::ffff:c0a8:1, so both spellings must be caught.
    for (const ip of ["::ffff:192.168.0.1", "::ffff:c0a8:1", "::ffff:10.0.0.1", "::ffff:0a00:1", "::ffff:127.0.0.1"]) {
      expect(isPrivateHost(ip), ip).toBe(true);
    }
  });

  it("also treats a mapped public IPv4 as private, pinning the deliberate over-block", () => {
    // isPrivateAddress refuses every ::ffff: form, not only ranges in NON_PUBLIC_V4 (its comment: "Any IPv4-mapped
    // form is not a public address"). The ticket expected a public mapped address to be public; the code is the
    // other way round, so the actual behaviour is pinned here rather than changing src/ on a test-only ticket.
    for (const ip of ["::ffff:8.8.8.8", "::ffff:808:808", "::ffff:1.1.1.1"]) expect(isPrivateHost(ip), ip).toBe(true);
  });
});

describe("brackets and upper-case hex", () => {
  it("accepts a bracketed IPv6 literal and upper-case hex like the plain forms", () => {
    expect(isPrivateHost("[::1]")).toBe(true);
    expect(isPrivateHost("[fc00::1]")).toBe(true);
    expect(isPrivateHost("[::ffff:192.168.0.1]")).toBe(true);
    expect(isPrivateHost("FC00::1")).toBe(true);
    expect(isPrivateHost("FE80::1")).toBe(true);
    expect(isPrivateHost("FD12:3456::1")).toBe(true);
    expect(isPrivateHost("::FFFF:C0A8:1")).toBe(true);
  });

  it("keeps a bracketed public address public", () => {
    expect(isPrivateHost("[2606:4700:4700::1111]")).toBe(false);
    expect(isPrivateHost("2606:4700:4700::1111")).toBe(false);
  });
});

describe("inV4Ranges with a one-entry table", () => {
  const table = [["10.0.0.0", 8]] as const;

  it("matches inside and at both edges", () => {
    for (const ip of ["10.0.0.0", "10.0.0.1", "10.1.2.3", "10.255.255.255"]) expect(inV4Ranges(ip, table), ip).toBe(true);
  });

  it("does not match just outside, a public address or something that isn't an address", () => {
    for (const ip of ["9.255.255.255", "11.0.0.0", "192.168.1.1", "not-an-ip", "256.0.0.1", "10.0.0", "10.0.0.0.1"]) {
      expect(inV4Ranges(ip, table), ip).toBe(false);
    }
  });

  it("honours the prefix length", () => {
    expect(inV4Ranges("172.16.0.1", [["172.16.0.0", 12]])).toBe(true);
    expect(inV4Ranges("172.31.255.255", [["172.16.0.0", 12]])).toBe(true);
    expect(inV4Ranges("172.15.255.255", [["172.16.0.0", 12]])).toBe(false);
    expect(inV4Ranges("172.32.0.0", [["172.16.0.0", 12]])).toBe(false);
  });
});

describe("inV6Ranges with a one-entry table", () => {
  const table = [["fc00", 7]] as const;

  it("matches inside and at both edges of fc00::/7", () => {
    for (const hex of ["fc00::1", "fd12:3456::1", "fdff::1"]) expect(inV6Ranges(hex, table), hex).toBe(true);
  });

  it("does not match just outside or something that isn't an address", () => {
    for (const hex of ["fbff::1", "fe00::1", "2606:4700::1", "zzzz::1", "::1"]) expect(inV6Ranges(hex, table), hex).toBe(false);
  });

  it("honours a 10-bit prefix at the 16-bit edge", () => {
    expect(inV6Ranges("fe80::1", [["fe80", 10]])).toBe(true);
    expect(inV6Ranges("febf::1", [["fe80", 10]])).toBe(true);
    expect(inV6Ranges("fe7f::1", [["fe80", 10]])).toBe(false);
    expect(inV6Ranges("fec0::1", [["fe80", 10]])).toBe(false);
  });
});

describe("mappedV4InRanges with a one-entry table", () => {
  const table = [["10.0.0.0", 8]] as const;

  it("reads a plain IPv4 address and both mapped forms against the table", () => {
    for (const ip of ["10.1.2.3", "::ffff:10.1.2.3", "::ffff:0a01:0203"]) expect(mappedV4InRanges(ip, table), ip).toBe(true);
  });

  it("is false for a public mapping and for an IPv6 address that doesn't map IPv4", () => {
    for (const ip of ["8.8.8.8", "::ffff:8.8.8.8", "::ffff:0808:0808", "2001:db8::1", "::1", "not-an-ip"]) {
      expect(mappedV4InRanges(ip, table), ip).toBe(false);
    }
  });

  it("matches at the edges of a mapped range", () => {
    expect(mappedV4InRanges("::ffff:10.0.0.0", table)).toBe(true);
    expect(mappedV4InRanges("::ffff:0a00:0000", table)).toBe(true);
    expect(mappedV4InRanges("::ffff:10.255.255.255", table)).toBe(true);
    expect(mappedV4InRanges("::ffff:09ff:ffff", table)).toBe(false);
    expect(mappedV4InRanges("::ffff:11.0.0.0", table)).toBe(false);
  });
});
