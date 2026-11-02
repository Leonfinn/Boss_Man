// Migration numbers shared between branches (BOS-219). Drizzle names a migration by its number and
// applies a journal entry only when its `when` beats the last applied one, so two branches that
// both add 0075 can't both land. This reads the branch and the other open branches from the bare
// clone (nothing is checked out or run) and says whether a number is already taken.
import type { MigrationsResult } from "@boss-man/shared";

/** Matches a migration file at any depth: "apps/server/drizzle/0075_name.sql". */
const MIGRATION_FILE = /(?:^|\/)(\d{4})_[^/]+\.sql$/;
/** A migration file inside a `drizzle` folder at any depth ("apps/server/drizzle/0075_name.sql"), not just any SQL file. */
const MIGRATION_FOLDER = /(?:^|\/)drizzle(?:\/[^/]+)?\/\d{4}_[^/]+\.sql$/;

export type GitCode = (args: string[], cwd?: string) => Promise<{ code: number; stdout: string }>;

/** The migration number in a path, or null. */
export function numberOf(file: string): number | null {
  const m = MIGRATION_FILE.exec(file);
  return m ? Number(m[1]) : null;
}

/** One branch's migrations: the SQL files it added (or changed), and its journal's `when` values. */
export type MigrationSet = { files: string[]; when: number[] };

/** The migration numbers this branch adds that another set already uses. */
export function clashes(mine: MigrationSet, others: MigrationSet[]): { number: number; why: string[] }[] {
  const tag = (file: string) => file.replace(/^.*\//, "").replace(/\.sql$/, "");
  const pad = (n: number) => String(n).padStart(4, "0");
  const why = new Map<number, string[]>();
  const add = (num: number, text: string) => {
    const list = why.get(num) ?? [];
    if (!list.includes(text)) why.set(num, [...list, text]);
  };
  const mineNums = new Set(mine.files.map(numberOf).filter((n): n is number => n !== null));
  const mineTags = new Set(mine.files.map(tag));
  for (const other of others) {
    for (const file of other.files) {
      const num = numberOf(file);
      // The same file on both branches is one migration merged in, not a clash.
      if (num === null || !mineNums.has(num) || mineTags.has(tag(file))) continue;
      // Name the ticket's own file too: that's the one the agent has to rename.
      const ours = mine.files.map(tag).filter((t) => numberOf(`${t}.sql`) === num);
      add(num, `${ours.join(", ") || pad(num)} shares its number with ${tag(file)} on another branch`);
    }
  }
  const otherWhen = others.flatMap((o) => o.when);
  if (mine.when.length && otherWhen.length) {
    const theirs = Math.max(...otherWhen);
    const ours = Math.max(...mine.when);
    if (ours <= theirs) for (const num of mineNums) add(num, `its journal entry's "when" (${ours}) isn't later than the one already applied (${theirs}), so drizzle would skip it`);
  }
  return [...why.entries()].map(([number, w]) => ({ number, why: w })).sort((a, b) => a.number - b.number);
}

/** The lowest number at or above `from` that no set uses. */
export function nextFree(sets: MigrationSet[], from: number): number {
  const taken = new Set(sets.flatMap((s) => s.files.map(numberOf).filter((n): n is number => n !== null)));
  let n = Math.max(0, Math.trunc(from));
  while (taken.has(n)) n++;
  return n;
}

/**
 * Checks a ticket's branch against the default branch and the other open branches, and answers
 * with the number to move to when one is taken. Never throws for a branch it can't read: a check
 * that can't say must not stop a ticket.
 */
export async function checkMigrations(git: GitCode, repo: string, ref: { branch: string; target: string; others: string[] }): Promise<MigrationsResult> {
  await git(["fetch", "--quiet", "origin"]).catch(() => null);
  const tip = async (name: string) => {
    for (const refname of [`refs/remotes/origin/${name}`, `refs/heads/${name}`]) {
      const r = await git(["rev-parse", "--verify", "--quiet", `${refname}^{commit}`]);
      if (r.code === 0 && r.stdout.trim()) return r.stdout.trim();
    }
    return null;
  };
  const base = await tip(ref.target);
  const head = await tip(ref.branch);
  if (!base || !head) return { needed: null, reason: `I couldn't find ${!head ? "this ticket's branch" : `the ${ref.target} branch`} in the repository, so there was nothing to compare.` };

  // Diff each branch against the default branch's current tip, not the merge base: a migration the
  // default branch took after the branch forked is not this ticket's, and comparing two tips means
  // a branch that only merged main in shows nothing new.
  const mine = await setOf(git, head, migrationEntries(parseNameStatus((await git(["diff", "--name-status", "-z", `${base}..${head}`])).stdout)));
  if (!mine.files.length) return { needed: false, reason: "This ticket adds no migration, so no number is at risk." };

  const others: MigrationSet[] = [];
  for (const other of [...new Set(ref.others)].filter((b) => b !== ref.branch)) {
    const theirHead = await tip(other);
    if (!theirHead) continue;
    // A branch that only merged main in has nothing of its own, so it says nothing here.
    others.push(await setOf(git, theirHead, migrationEntries(parseNameStatus((await git(["diff", "--name-status", "-z", `${base}..${theirHead}`])).stdout))));
  }
  // Every migration on the default branch is taken, whether or not this branch changed it.
  const baseFiles = (await git(["ls-tree", "-r", "-z", "--name-only", base])).stdout.split("\0").filter(Boolean);
  const baseJournal = baseFiles.find((p) => /(^|\/)drizzle\/meta\/_journal\.json$/.test(p));
  const onBaseSet: MigrationSet = {
    files: baseFiles.filter((p) => MIGRATION_FILE.test(p)),
    when: baseJournal ? await journalWhen(git, base, baseJournal) : [],
  };
  const found = clashes(mine, [...others, onBaseSet]);
  if (!found.length) return { needed: false, reason: "No other branch uses this ticket's migration numbers." };
  const first = found[0]!;
  return {
    needed: true,
    number: first.number,
    next: nextFree([mine, ...others, onBaseSet], Math.max(first.number, ...mine.files.map(numberOf).filter((n): n is number => n !== null))),
    why: first.why,
    others: found.slice(1).map((c) => `number ${String(c.number).padStart(4, "0")}: ${c.why.join("; ")}`),
  };
}

/** The files in a migrations folder that a branch added or changed (a deleted one isn't a migration it has). */
function migrationEntries(entries: Array<{ status: string; path: string }>) {
  return entries.filter((e) => e.status !== "D" && MIGRATION_FOLDER.test(`/${e.path}`));
}

/** A ref's journal `when` values, or none when it has no journal this can read. */
async function journalWhen(git: GitCode, ref: string, file: string): Promise<number[]> {
  const shown = await git(["show", `${ref}:${file}`]);
  if (shown.code !== 0) return [];
  try {
    const parsed = JSON.parse(shown.stdout) as { entries?: Array<{ when?: unknown }> };
    return (parsed.entries ?? []).map((e) => Number(e.when)).filter((n) => Number.isFinite(n));
  } catch {
    return [];
  }
}

async function setOf(git: GitCode, ref: string, entries: Array<{ path: string; status: string }>): Promise<MigrationSet> {
  const files = entries.map((e) => e.path).filter((p) => MIGRATION_FILE.test(p));
  const journal = entries.find((e) => /(^|\/)meta\/_journal\.json$/.test(e.path));
  const when = journal ? await journalWhen(git, ref, journal.path) : [];
  return { files, when };
}

/** git's name-status output (-z: NUL separated: status, then a path; a rename or copy adds the old path). */
export function parseNameStatus(out: string): Array<{ status: string; path: string }> {
  const parts = out.split("\0").filter((p) => p.length);
  const list: Array<{ status: string; path: string }> = [];
  for (let i = 0; i < parts.length; i++) {
    const status = parts[i]!;
    list.push({ status: status.replace(/\d+$/, ""), path: parts[i + 1] ?? "" });
    i += /^[RC]/.test(status) ? 2 : 1;
  }
  return list;
}

/** The gate's wording for what to do about a journal problem; drizzle gives no error of its own. */
const JOURNAL_FIX = "To fix: merge origin/<target> into your branch, renumber your migration to the next free number (NNNN), set its journal \"when\" to Date.now(), then run drizzle-kit generate to confirm it reports no changes.";
/** A journal entry may not be dated further ahead than this: a made-up future time would make every later migration look older and be skipped. */
export const JOURNAL_FUTURE_SLACK_MS = 10 * 60_000;

type JournalEntry = { idx?: unknown; when?: unknown; tag?: unknown };

/**
 * Problems with the journal a merge would produce (BOS-360). Drizzle runs a migration only when its
 * `when` is later than the newest already applied, and skips the rest without a word, so a
 * migration that merges with an older, equal or made-up future `when` ships and never runs.
 * `base` is the target's journal, `merged` the journal after the merge; an entry is the branch's
 * when its tag isn't on the target. Returns plain sentences, empty when all is well.
 */
export function journalProblems(base: JournalEntry[], merged: JournalEntry[], now: number, target = "main"): string[] {
  const baseTags = new Set(base.map((e) => String(e.tag)));
  const mine = merged.filter((e) => !baseTags.has(String(e.tag)));
  if (!mine.length) return [];
  const problems: string[] = [];
  const newest = Math.max(-Infinity, ...base.map((e) => Number(e.when)).filter(Number.isFinite));
  for (const e of mine) {
    const when = Number(e.when);
    const tag = String(e.tag);
    if (!Number.isFinite(when)) problems.push(`${tag}: its journal entry has no usable "when".`);
    else if (when <= newest) problems.push(`${tag}: its journal "when" (${when}) isn't later than the newest one on ${target} (${newest}), so drizzle would silently skip it.`);
    else if (when > now + JOURNAL_FUTURE_SLACK_MS) problems.push(`${tag}: its journal "when" (${when}) is more than 10 minutes in the future, so every later migration would be skipped.`);
  }
  const seen = (key: (e: JournalEntry) => string, what: string) => {
    const groups = new Map<string, string[]>();
    for (const e of merged) groups.set(key(e), [...(groups.get(key(e)) ?? []), String(e.tag)]);
    for (const [k, tags] of groups) if (tags.length > 1 && tags.some((t) => !baseTags.has(t))) problems.push(`${what} ${k} is used by ${tags.join(" and ")}.`);
  };
  seen((e) => String(e.idx), "Journal idx");
  seen((e) => /^\d+/.exec(String(e.tag))?.[0] ?? String(e.tag), "Migration number");
  return problems.length ? [...problems, JOURNAL_FIX.replace("<target>", target)] : [];
}

/** The entries of the journal at `ref`, or none when it has no readable one. */
export async function journalAt(git: GitCode, ref: string): Promise<JournalEntry[]> {
  const files = (await git(["ls-tree", "-r", "-z", "--name-only", ref])).stdout.split("\0");
  const file = files.find((p) => /(^|\/)drizzle\/meta\/_journal\.json$/.test(p));
  if (!file) return [];
  const shown = await git(["show", `${ref}:${file}`]);
  if (shown.code !== 0) return [];
  try {
    return (JSON.parse(shown.stdout) as { entries?: JournalEntry[] }).entries ?? [];
  } catch {
    return [];
  }
}
