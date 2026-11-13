// Which address is the portal visitor? Behind a reverse proxy the connecting address is the
// proxy's, so every visitor would share one rate-limit counter. BOSSMAN_PORTAL_TRUSTED_PROXY lists
// the proxy's own address(es); only a connection from one of them may say who the visitor is, via
// CF-Connecting-IP or X-Forwarded-For. From any other address those headers are never read.
// Only rate-limit accounting depends on this: no login or permission does.
import { BlockList, isIP } from "node:net";

export type ProxyMatcher = { size: number; has(address: string): boolean };

/** One address in a single form, so one visitor always gets one counter key. */
export function normaliseAddress(raw: string): string {
  const a = raw.trim().toLowerCase();
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(a);
  return mapped ? mapped[1]! : a;
}

function validAddress(raw: string): string | null {
  const a = normaliseAddress(raw);
  return isIP(a) ? a : null;
}

/**
 * Reads the setting: a comma or space separated list of addresses and CIDRs (v4 and v6). Bad
 * entries and any /0 prefix (which would trust the whole internet) are ignored and returned in
 * `ignored`, so a typo trusts nobody.
 */
export function parseTrustedProxies(raw: string | string[] | undefined): { matcher: ProxyMatcher; ignored: string[] } {
  const list = new BlockList();
  const ignored: string[] = [];
  let size = 0;
  const entries = (Array.isArray(raw) ? raw : (raw ?? "").split(/[\s,]+/)).map((s) => s.trim()).filter(Boolean);
  for (const entry of entries) {
    const [addrPart, prefixPart, ...rest] = entry.split("/");
    const addr = addrPart === undefined ? null : validAddress(addrPart);
    const family = addr ? (isIP(addr) === 6 ? "ipv6" : "ipv4") : null;
    if (!addr || !family || rest.length) { ignored.push(entry); continue; }
    try {
      if (prefixPart === undefined) {
        list.addAddress(addr, family);
      } else {
        const wasMapped = addrPart !== addr; // "::ffff:10.0.0.0/104" style: not supported, refuse
        if (wasMapped || !/^\d{1,3}$/.test(prefixPart)) { ignored.push(entry); continue; }
        const prefix = Number(prefixPart);
        if (prefix < 1 || prefix > (family === "ipv6" ? 128 : 32)) { ignored.push(entry); continue; }
        list.addSubnet(addr, prefix, family);
      }
      size++;
    } catch {
      ignored.push(entry);
    }
  }
  return {
    ignored,
    matcher: {
      size,
      has(address) {
        const a = validAddress(address);
        if (!a) return false;
        return list.check(a, isIP(a) === 6 ? "ipv6" : "ipv4");
      },
    },
  };
}

const MAX_FORWARDED_LENGTH = 2048;

function headerText(v: string | string[] | undefined): string | null {
  if (v === undefined) return null;
  return Array.isArray(v) ? v.join(",") : v;
}

/**
 * The visitor's address. `peer` is the connecting address. With no trusted proxy, or a peer that
 * is not one, the headers are ignored completely. From a trusted peer: CF-Connecting-IP if
 * present (it must be one valid address), else the right-most X-Forwarded-For entry that is not
 * itself a trusted proxy. Anything malformed falls back to the peer.
 */
export function portalClientAddress(peer: string, headers: Record<string, string | string[] | undefined>, matcher: ProxyMatcher): string {
  const peerAddr = normaliseAddress(peer);
  if (matcher.size === 0 || !matcher.has(peerAddr)) return peerAddr;

  const cf = headerText(headers["cf-connecting-ip"]);
  if (cf !== null) return validAddress(cf) ?? peerAddr;

  const xff = headerText(headers["x-forwarded-for"]);
  if (xff === null) return peerAddr;
  if (xff.length > MAX_FORWARDED_LENGTH) return peerAddr;
  const hops = xff.split(",");
  for (let i = hops.length - 1; i >= 0; i--) {
    const hop = validAddress(hops[i]!);
    if (!hop) return peerAddr;
    if (!matcher.has(hop)) return hop;
  }
  return peerAddr;
}
