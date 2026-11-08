// BOS-770: the owner's own network-guard allow list (BOSSMAN_NETGUARD_ALLOW in .env), made visible. The launcher says
// which entries it started with; the host deployer says what .env holds now, line by line (Compose uses only the last
// line, so an earlier one is silently ignored). Boss Man marks every entry that it already allows by itself, because a
// tool server or a project's git host covers it, so a stopgap line can be spotted and removed. It only reports: it
// never changes .env and raises no card.

export type CoveredBy = "tool server" | "git host";
export type AllowEntry = { entry: string; coveredBy: CoveredBy[]; note: string | null };
export type NetguardAllowReport = {
  /** The launcher's guard mode (auto, enforce or off); null when there is no launcher or it is older than BOS-770. */
  mode: string | null;
  /** The entries the launcher is using now; null when the launcher can't be asked. */
  entries: AllowEntry[] | null;
  /** True when every entry the launcher uses is one Boss Man allows anyway: the whole line can go. */
  lineCanGo: boolean;
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

/** Builds the report from what the launcher, the host and Boss Man's own lists say. Pure, so it is tested on its own. */
export function netguardAllowReport(input: {
  launcher: { mode: string; allow: string[] } | null;
  env: { envFound: boolean; lines: string[][]; reportedAt: string } | null;
  toolServers: string[];
  gitHosts: string[];
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
  return { mode: input.launcher?.mode ?? null, entries, lineCanGo: !!entries?.length && entries.every((e) => e.coveredBy.length > 0), env: input.env, warnings };
}
