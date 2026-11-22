// BOS-1603: the address a link is built on when the owner has not set one. The address in the owner's own browser is
// often one only their devices can open (a Tailscale name, a LAN IP, localhost), so it is only a default when it is a
// public https name. Otherwise nothing is guessed: the caller says plainly that no suitable address is known.
export type LinkAddress = {
  /** Base address with no trailing slash, or "" when none is known. */
  url: string;
  /** Where this address works (when url is set) or why none was picked and what to do (when it is not). */
  note: string;
};

const isPublicName = (host: string) =>
  host.includes(".") &&
  !/^[0-9.]+$/.test(host) &&
  !host.includes(":") &&
  !/\.(ts\.net|local|lan|internal|home|home\.arpa|localdomain)$/i.test(host);

export function defaultLinkAddress(v: { origin: string; facts?: Record<string, { value: string }>; who: "clients" | "phone" }): LinkAddress {
  const pub = v.facts?.["network.publicAddress"]?.value?.trim();
  if (pub) {
    const base = (/^https?:\/\//.test(pub) ? pub : `https://${pub}`).replace(/\/+$/, "");
    return { url: base, note: `The public address you confirmed (${pub}): opens from any device on the internet, if it leads to Boss Man.` };
  }
  let host = "";
  let tls = false;
  try {
    const u = new URL(v.origin);
    host = u.hostname;
    tls = u.protocol === "https:";
  } catch {
    // not a URL: nothing to offer
  }
  if (tls && isPublicName(host)) {
    return { url: v.origin.replace(/\/+$/, ""), note: `The address this page is open at (${host}): opens from any device whose DNS knows that name.` };
  }
  const who = v.who === "clients" ? "people outside your network" : "your phone";
  const where = /\.ts\.net$/i.test(host)
    ? "This page is open at a Tailscale name, which only devices on your Tailscale network can open."
    : "This page is open at an address that only your own network can open.";
  return { url: "", note: `${where} No public address is known, so none was picked for ${who}. Enter the address ${who === "your phone" ? "your phone" : "they"} can reach, or confirm Boss Man's public address in Settings.` };
}
