// BOS-770: the owner's own network-guard allow list (BOSSMAN_NETGUARD_ALLOW in .env), made visible. The launcher says
// which entries it started with; the host deployer says what .env holds now, line by line (Compose uses only the last
// line, so an earlier one is silently ignored). Boss Man marks every entry that it already allows by itself, because a
// tool server or a project's git host covers it, so a stopgap line can be spotted and removed. It only reports: it
// never changes .env and raises no card.
//
// BOS-791: the page also lists what the guard opens by itself (each company's tool servers and project git hosts), each
// with what it is and the company it is for, and any of those the guard now drops because it resolves to a private
// address (BOS-708), so a missing tool server is visible rather than silently absent.

export type CoveredBy = "tool server" | "git host";
export type AllowEntry = { entry: string; coveredBy: CoveredBy[]; note: string | null };

/** What one address the guard opens by itself is: the kind, the company it is for, and the reason it is dropped. */
export type AutomaticEntry = {
  address: string;
  /** A tool server, or a project's git host. */
  kind: "tool server" | "git host";
  /** The tool server's name, or the project's name for a git host. Never a path or a token. */
  name: string;
  /** The company whose runners can reach it; null for a git host whose project is unknown. */
  company: string | null;
  /** A private address the owner allowed on purpose (an import tick, a LAN host, a git host they set): the guard keeps it. */
  trusted: boolean;
  /** The plain reason it is not allowed, if the guard drops it: null when it is allowed. */
  notAllowed: string | null;
};

export type NetguardAllowReport = {
  /** The launcher's guard mode (auto, enforce or off); null when there is no launcher or it is older than BOS-770. */
  mode: string | null;
  /** The entries the launcher is using now; null when the launcher can't be asked. */
  entries: AllowEntry[] | null;
  /** True when every entry the launcher uses is one Boss Man allows anyway: the whole line can go. */
  lineCanGo: boolean;
  /** Every address the guard opens by itself (BOS-791), in address order; null when Boss Man couldn't work them out. */
  automatic: AutomaticEntry[] | null;
  /** What .env holds now, line by line, as the host deployer last reported; null without a deployer report. */
  env: { lines: string[][]; reportedAt: string; envFound: boolean } | null;
  /** Plain-words warnings: a duplicate line, entries a duplicate hides, or a launcher that hasn't read .env since it changed. */
  warnings: string[];
};

const key = (e: string) => e.toLowerCase();
/** Same entries, in any order (the launcher drops repeats). */
const same = (a: string[], b: string[]) => {
  const [x, y] = [new Set(a.map(key)), new Set(b.map(key))];
  return x.size === y.size && [...x].every((e) => y.has(e));
};

export const COVERED_NOTE = "Already allowed by Boss Man; this line can go.";

/** What the guard says when it drops one of Boss Man's own addresses (BOS-708); shown on the page as the reason. */
export const DROPPED_TIED_TO_SERVER = "Not allowed. Boss Man allows this name, but it points at an address on your own server's private network, so the guard drops it. Point it at the address you meant, or allow it in the extra lines if that is on purpose.";
export const DROPPED_PRIVATE = "Not allowed. Boss Man allows this name, but it now points at a private address on your home network. The guard drops it unless you allowed a private address for it on purpose: add a tool server at the private address itself, or set the project's repo address to it.";

/** A known kind wins over a plain tool server when two sources claim the same host:port. */
const PRIORITY = { "tool server": 0, "git host": 1 } as const;

/** Builds the report from what the launcher, the host and Boss Man's own lists say. Pure, so it is tested on its own. */
export function netguardAllowReport(input: {
  launcher: { mode: string; allow: string[] } | null;
  env: { envFound: boolean; lines: string[][]; reportedAt: string } | null;
  toolServers: string[];
  gitHosts: string[];
  /** What the guard opens by itself, per address (BOS-791): null when it couldn't be worked out. */
  automatic?: AutomaticEntry[] | null;
}): NetguardAllowReport {
  const tool = new Set(input.toolServers.map(key));
  const git = new Set(input.gitHosts.map(key));
  const covers = (e: string): CoveredBy[] => [...(tool.has(key(e)) ? (["tool server"] as const) : []), ...(git.has(key(e)) ? (["git host"] as const) : [])];
  const allow = input.launcher?.allow ?? null;
  const entries = allow?.map((entry) => {
    const coveredBy = covers(entry);
    return { entry, coveredBy, note: coveredBy.length ? (allow.length === 1 ? COVERED_NOTE : `Already allowed by Boss Man (a ${coveredBy.join(" and a ")}); this entry can go from the line.`) : null };
  }) ?? null;
  const warnings: string[] = [];
  const lines = input.env?.lines ?? [];
  if (lines.length > 1) {
    const last = new Set(lines[lines.length - 1]!.map(key));
    const hidden = [...new Set(lines.slice(0, -1).flat().filter((e) => !last.has(key(e))))];
    warnings.push(
      `BOSSMAN_NETGUARD_ALLOW is set on ${lines.length} lines in .env, and only the last one counts.` +
        (hidden.length ? ` These entries on the earlier lines are ignored: ${hidden.join(", ")}.` : "") +
        " Merge them into one line.",
    );
  }
  if (allow && input.env?.envFound && !same(allow, lines.at(-1) ?? []))
    warnings.push("The launcher is using a different list from the one in .env now; it reads .env again when it is recreated (Build and update runners).");
  // One row per company and host:port (a company's entries are only reachable from its own runners, so two companies
  // sharing a tool server get a row each): a dropped row wins over an allowed one that shares the address (so a missing
  // tool server shows rather than hides), and otherwise the more specific kind is kept.
  const keep = (old: AutomaticEntry | undefined, e: AutomaticEntry): boolean => {
    if (!old) return true;
    const oldDropped = old.notAllowed !== null;
    const newDropped = e.notAllowed !== null;
    if (oldDropped !== newDropped) return newDropped;
    return PRIORITY[e.kind] > PRIORITY[old.kind];
  };
  const automatic = input.automatic
    ? [...input.automatic.reduce((by, e) => {
        const k = `${e.company ?? ""}\n${key(e.address)}`;
        if (keep(by.get(k), e)) by.set(k, e);
        return by;
      }, new Map<string, AutomaticEntry>()).values()].sort((a, b) => a.address.localeCompare(b.address) || (a.company ?? "").localeCompare(b.company ?? ""))
    : input.automatic ?? null;
  return { mode: input.launcher?.mode ?? null, entries, lineCanGo: !!entries?.length && entries.every((e) => e.coveredBy.length > 0), automatic, env: input.env, warnings };
}
