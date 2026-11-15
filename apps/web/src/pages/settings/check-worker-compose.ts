// BOS-1550: the compose file the owner pastes on the worker's machine, filled in with what Boss Man knows (its address,
// the commit its runner is built from, the worker's slots and the token). The template is a byte-for-byte copy of
// deploy/check-worker/compose.yaml (the web build has no deploy/ folder); test/check-worker-compose.test.ts keeps them equal.
import template from "./check-worker-compose.yaml?raw";

const SERVER_PLACEHOLDER = "wss://boss.example.com/api/check-worker/connect";
const TOKEN_PLACEHOLDER = "PASTE-THE-WORKER-TOKEN-HERE";

/** The worker socket address for the page the owner is on (https://x -> wss://x/api/check-worker/connect). */
export const workerSocketUrl = (origin: string) => `${origin.replace(/^http/, "ws").replace(/\/+$/, "")}/api/check-worker/connect`;

export type AddressChoice = {
  /** "lan" = an address on the owner's local network that Boss Man reported; anything else is the page's or the public address. */
  kind?: "lan";
  url: string;
  label: string;
  /** Which machines can look this address up and reach it, in the owner's words. */
  worksFrom: string;
  /** Said plainly when the token would travel without encryption. */
  warning?: string;
};

const PLAIN_WARNING = "Plain ws:// is not encrypted: the worker's token and the check traffic cross your local network readable by anything on it. Whoever captures the token can take checks, read the code sent for them and report results. Fine on a network you trust; use an https address across the internet.";
const isTailscaleName = (host: string) => /\.ts\.net$/i.test(host);
const isIp = (host: string) => /^[0-9.]+$/.test(host) || host.includes(":");
/**
 * A private IPv4 address another machine on a home network can use: 192.168.x.x and 10.x.x.x. Left out on purpose: 172.16-31.x.x
 * (Docker's own bridge networks, which no other machine can reach), 127.x, 169.254.x.x, Tailscale's 100.64-127.x.x and IPv6.
 */
const isLanAddress = (a: string) => /^192\.168\.\d+\.\d+$/.test(a) || /^10\.\d+\.\d+\.\d+$/.test(a);

/**
 * BOS-1601: the addresses Boss Man knows for the worker to dial, best first. The LAN address(es) the host reported with
 * the host port come first (they work from any machine on the same network, with or without Tailscale); then the address
 * the owner's browser is on and the public address they confirmed, each labelled with where it resolves. Nothing is
 * guessed: no host facts means only the browser's address, which says so.
 */
export function workerAddressChoices(v: { origin: string; facts?: Record<string, { value: string }> }): AddressChoice[] {
  const f = (k: string) => v.facts?.[k]?.value;
  const out: AddressChoice[] = [];
  const seen = new Set<string>();
  const add = (c: AddressChoice) => {
    if (!seen.has(c.url)) {
      seen.add(c.url);
      out.push(c);
    }
  };
  const port = f("network.port.BOSSMAN_HOST_PORT") || "3100";
  const bind = (f("network.port.BOSSMAN_BIND") ?? "").trim();
  const wildcard = bind === "0.0.0.0" || bind === "::" || bind === "[::]";
  const loopback = bind === "localhost" || /^127\./.test(bind) || bind === "::1";
  // One specific address: Boss Man answers only on it, so it is the only local address to offer.
  const specific = !!bind && !wildcard && !loopback && !bind.includes(":");
  const lanOpen = specific || wildcard;
  const lanWorksFrom = lanOpen
    ? "Any machine on the same network, with or without Tailscale."
    : "Any machine on the same network, once Boss Man listens on it: it only answers on the server itself today. On the server, set BOSSMAN_BIND in its .env to its LAN address (not 0.0.0.0, which opens it on every network the machine is on) and restart it.";
  const candidates = specific ? [bind] : (f("network.addresses") ?? "").split(",").map((s) => s.trim()).filter(isLanAddress);
  for (const a of candidates) {
    add({
      kind: "lan",
      url: `ws://${a}:${port}/api/check-worker/connect`,
      label: `Local network address ${a}:${port}`,
      worksFrom: lanWorksFrom,
      warning: PLAIN_WARNING,
    });
  }
  const browser = workerSocketUrl(v.origin);
  try {
    const u = new URL(v.origin);
    const tls = u.protocol === "https:";
    const kind = isTailscaleName(u.hostname)
      ? { label: `Tailscale name ${u.host}`, worksFrom: "Only machines on your Tailscale network (they use Tailscale's DNS). A plain Docker host will not find it." }
      : isIp(u.hostname) || u.hostname === "localhost"
        ? { label: `The address this page is open at (${u.host})`, worksFrom: u.hostname === "localhost" || u.hostname.startsWith("127.") ? "Only the Boss Man machine itself." : "Machines that can reach that address." }
        : { label: `The address this page is open at (${u.host})`, worksFrom: "Machines whose DNS knows that name; a name only your own DNS or router knows may not resolve from another network." };
    add({ ...kind, url: browser, warning: tls ? undefined : PLAIN_WARNING });
  } catch {
    // an origin that isn't a URL gives no browser address
  }
  const pub = f("network.publicAddress");
  if (pub) {
    const base = /^https?:\/\//.test(pub) ? pub : `https://${pub}`;
    add({ url: workerSocketUrl(base), label: `Public address ${pub}`, worksFrom: "Any machine that can reach the internet, if that address leads to Boss Man.", warning: base.startsWith("https:") ? undefined : PLAIN_WARNING });
  }
  return out;
}

/**
 * The template with each CHANGE THIS value replaced (address, slots, token). There is no commit to fill in any more
 * (BOS-1570): a worker matches the runner on its tools. JSON.stringify quotes the strings the way YAML wants.
 */
export function workerComposeFile(v: { url: string; slots: number; token: string }): string {
  let out = template.split(SERVER_PLACEHOLDER).join(v.url);
  out = out.replace(/BOSSMAN_CHECK_SLOTS: "\d+"/, `BOSSMAN_CHECK_SLOTS: "${Math.max(1, Math.floor(v.slots))}"`);
  return out.split(`content: "${TOKEN_PLACEHOLDER}"`).join(`content: ${JSON.stringify(v.token)}`);
}
