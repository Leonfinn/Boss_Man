// Migration numbers shared between branches (BOS-219). Drizzle names a migration by its number and
// applies a journal entry only when its `when` beats the last applied one, so two branches that
// both add 0075 can't both land. This reads the branch and the other open branches from the bare
// clone (nothing is checked out or run) and says whether a number is already taken.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
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
// Hand renumbering left main's snapshot chain broken (BOS-519); regenerating sets the number, when and snapshot parent together.
const JOURNAL_FIX = "To fix: merge origin/<target> into your branch, delete your migration's .sql, meta/NNNN_snapshot.json and journal entry, then run drizzle-kit generate again; node scripts/lint-migrations.mjs checks the result (docs/10-migrations.md).";
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
  // Several matches: the shallowest one is the real journal; a stray copy deeper in the tree can't shadow it.
  const file = files.filter((p) => /(^|\/)drizzle\/meta\/_journal\.json$/.test(p)).sort((x, y) => x.split("/").length - y.split("/").length)[0];
  if (!file) return [];
  const shown = await git(["show", `${ref}:${file}`]);
  if (shown.code !== 0) return [];
  try {
    return (JSON.parse(shown.stdout) as { entries?: JournalEntry[] }).entries ?? [];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------------------------
// The merge gate renumbers a clashing migration itself (BOS-690, DR-037 fix 2).
// Every pair of branches that both add a migration clashes in meta/_journal.json, whatever their
// numbers. When that is the only clash, the gate rebuilds the branch's migration on top of main:
// next free number, new journal entry, snapshot chained to main's, `when` above main's newest.
// The SQL file is reused as the very same git object. Everything is built in git's object store
// (a temporary index file, no work tree) and the same inputs always give the same tree.
// ---------------------------------------------------------------------------------------------

/** git with an optional extra environment (the temporary index). Runs in the bare clone. */
export type RebaseGit = (args: string[], env?: Record<string, string>) => Promise<{ code: number; stdout: string }>;

export type RebaseResult =
  | { status: "none" }
  | { status: "rebuilt"; tree: string; renamed: Array<{ from: string; to: string }> }
  | { status: "refused"; reason: string };

type Json = unknown;
type Plain = Record<string, Json>;
const isPlain = (v: Json): v is Plain => typeof v === "object" && v !== null && !Array.isArray(v);
const same = (a: Json, b: Json) => JSON.stringify(a) === JSON.stringify(b);
const ABSENT = Symbol("absent");

/** Thrown inside the merge of two snapshots when both sides changed the same thing differently. */
class SnapshotClash extends Error {}

/**
 * Three-way merge of drizzle snapshots: `base` is where the branch started, `ours` the branch's,
 * `theirs` main's. A table's column, index, foreign key or constraint is one unit: changed on one
 * side only, it is taken; changed differently on both, the merge refuses (the branch is sent back).
 */
export function mergeSnapshots(base: Json, ours: Json, theirs: Json): Json {
  const walk = (b: Json | typeof ABSENT, o: Json | typeof ABSENT, t: Json | typeof ABSENT, p: string[]): Json | typeof ABSENT => {
    // Each snapshot's own id and its link to the one before are set by the caller, never merged.
    if (p.length === 1 && (p[0] === "id" || p[0] === "prevId")) return o;
    if (same(o, t)) return o;
    if (same(o, b)) return t;
    if (same(t, b)) return o;
    // The unit that must not change on both sides: tables.<t>.<section>.<name>, or <section>.<name> elsewhere.
    const unit = p[0] === "tables" ? 4 : 2;
    if (p.length < unit && isPlain(o) && isPlain(t) && (b === ABSENT || isPlain(b))) {
      const bb: Plain = b === ABSENT ? {} : b;
      const out: Plain = {};
      for (const key of [...Object.keys(t), ...Object.keys(o)]) {
        if (key in out) continue;
        const v = walk(key in bb ? bb[key] : ABSENT, key in o ? o[key] : ABSENT, key in t ? t[key] : ABSENT, [...p, key]);
        if (v !== ABSENT) out[key] = v;
      }
      return out;
    }
    throw new SnapshotClash(p.join(".") || "snapshot");
  };
  const r = walk(base, ours, theirs, []);
  return r === ABSENT ? {} : r;
}

/** The tag's migration number as text, "0113" from "0113_name". */
const tagNumber = (tag: string) => /^(\d{4})_/.exec(tag)?.[1] ?? null;
const pad4 = (n: number) => String(n).padStart(4, "0");

/**
 * Rebuilds the branch's new migrations on top of main. `base` is the merge base of `main` and
 * `branch`. Returns "none" when there is nothing to do (no new migration, or already in order),
 * "rebuilt" with the merged tree, or "refused" with a reason when it can't be done safely: a real
 * code conflict, a changed existing migration, a snapshot changed on both sides, or any layout
 * it doesn't recognise. A refusal means today's behaviour: the branch is sent back.
 */
export async function rebaseMigrations(git: RebaseGit, ref: { base: string; branch: string; main: string }, tmpRoot?: string): Promise<RebaseResult> {
  const { base, branch, main } = ref;
  const refuse = (reason: string): RebaseResult => ({ status: "refused", reason });
  const out = async (args: string[], env?: Record<string, string>) => {
    const r = await git(args, env);
    if (r.code !== 0) throw new Error(`git ${args[0]} failed (exit ${r.code})`);
    return r.stdout.trim();
  };
  const dir = mkdtempSync(path.join(tmpRoot ?? tmpdir(), "bm-rebase-"));
  try {
    // 1. Where the journal is, and what the branch added to it.
    const files = (await out(["ls-tree", "-r", "-z", "--name-only", main])).split("\0").filter(Boolean);
    const journalPath = files.filter((p) => /(^|\/)drizzle\/meta\/_journal\.json$/.test(p)).sort((x, y) => x.split("/").length - y.split("/").length)[0];
    if (!journalPath) return { status: "none" };
    const drizzle = journalPath.slice(0, -"/meta/_journal.json".length);
    const readJson = async (rev: string, file: string): Promise<Json> => {
      const r = await git(["show", `${rev}:${file}`]);
      if (r.code !== 0) throw new Error(`missing ${file}`);
      return JSON.parse(r.stdout);
    };
    type Journal = { entries: Plain[] } & Plain;
    let baseJ: Journal, branchJ: Journal, mainJ: Journal;
    try {
      baseJ = (await readJson(base, journalPath)) as Journal;
      branchJ = (await readJson(branch, journalPath)) as Journal;
      mainJ = (await readJson(main, journalPath)) as Journal;
    } catch {
      return refuse("a journal could not be read");
    }
    for (const j of [baseJ, branchJ, mainJ]) if (!isPlain(j) || !Array.isArray(j.entries) || !j.entries.every(isPlain)) return refuse("the journal has a layout the gate doesn't know");
    const tags = (j: Journal) => j.entries.map((e) => String(e.tag));
    const baseTags = tags(baseJ);
    const branchTags = tags(branchJ);
    if (!baseTags.every((t, i) => branchTags[i] === t)) return refuse("the branch changed or reordered migrations that already existed");
    const added = branchJ.entries.slice(baseTags.length);
    if (!added.length) return { status: "none" };
    const mainTags = tags(mainJ);
    if (!baseTags.every((t, i) => mainTags[i] === t)) return refuse(`${main.slice(0, 8)} changed or reordered migrations that existed at the branch's start`);
    if (added.some((e) => tagNumber(String(e.tag)) === null || typeof e.when !== "number")) return refuse("a new journal entry has an unusual tag or no usable \"when\"");

    // 2. The branch may touch only its own new files in the drizzle folder.
    const addedTags = new Set(added.map((e) => String(e.tag)));
    const ownSql = (t: string) => `${drizzle}/${t}.sql`;
    const ownSnap = (t: string) => `${drizzle}/meta/${tagNumber(t)}_snapshot.json`;
    const allowed = new Set([journalPath, ...[...addedTags].flatMap((t) => [ownSql(t), ownSnap(t)])]);
    const changed = parseNameStatus((await out(["diff", "--name-status", "-z", base, branch, "--", drizzle])));
    for (const c of changed) if (!allowed.has(c.path) || (c.path !== journalPath && c.status !== "A")) return refuse(`the branch changes ${c.path}, which isn't one of its own new migration files`);

    // 3. Does anything need to move? A tag, number or idx that main also uses, or a `when` that isn't above main's newest.
    const mainNew = mainJ.entries.slice(baseTags.length);
    const mainNums = new Set(mainTags.map(tagNumber));
    const mainMaxNum = Math.max(-1, ...mainTags.map((t) => Number(tagNumber(t))).filter(Number.isFinite));
    const mainWhen = Math.max(-Infinity, ...mainJ.entries.map((e) => Number(e.when)).filter(Number.isFinite));
    const renumber = added.some((e) => Number(tagNumber(String(e.tag))) <= mainMaxNum || mainNums.has(tagNumber(String(e.tag))));
    const idxClash = added.some((e) => mainJ.entries.some((m) => m.idx === e.idx));
    const oldWhen = added.some((e) => Number(e.when) <= mainWhen);
    if (!mainNew.length && !oldWhen) return { status: "none" };
    if (!renumber && !idxClash && !oldWhen) return { status: "none" };

    // 4. The branch's code on top of main. Its migration files and journal go back to the merge base
    // first, so the only conflicts left are real ones. A commit is needed only because this git's
    // merge-tree takes commits; nothing refers to it afterwards.
    const index = path.join(dir, "index");
    // update-index wants a work tree even in a bare clone; an empty folder of ours stands in, nothing is ever written to it.
    const idxEnv = { GIT_INDEX_FILE: index, GIT_WORK_TREE: dir };
    await out(["read-tree", branch], idxEnv);
    const remove = [...addedTags].flatMap((t) => [ownSql(t), ownSnap(t)]);
    for (const f of remove) await out(["update-index", "--force-remove", "--", f], idxEnv);
    const baseJournalBlob = await out(["rev-parse", `${base}:${journalPath}`]);
    await out(["update-index", "--add", "--cacheinfo", `100644,${baseJournalBlob},${journalPath}`], idxEnv);
    const stripped = await out(["write-tree"], idxEnv);
    const who = { GIT_AUTHOR_NAME: "Boss Man", GIT_AUTHOR_EMAIL: "bossman@localhost", GIT_COMMITTER_NAME: "Boss Man", GIT_COMMITTER_EMAIL: "bossman@localhost" };
    const strippedCommit = await out(["commit-tree", stripped, "-p", base, "-m", "branch code without its migrations"], who);
    const merged = await git(["merge-tree", "--write-tree", "--name-only", main, strippedCommit]);
    if (merged.code === 1) {
      const lines = merged.stdout.split("\n");
      return refuse(`real code conflicts too: ${lines.slice(1, lines.indexOf("") === -1 ? undefined : lines.indexOf("")).filter(Boolean).slice(0, 5).join(", ")}`);
    }
    if (merged.code !== 0) return refuse("git could not merge the branch's code");
    const codeTree = merged.stdout.split("\n")[0]!.trim();

    // 5. Snapshots: each new snapshot is merged key by key with main's newest, in the branch's own order.
    const lastNum = (tagList: string[]) => tagNumber(tagList[tagList.length - 1] ?? "");
    const snapPath = (n: string | null) => `${drizzle}/meta/${n}_snapshot.json`;
    let baseSnap: Json, mainSnap: Json;
    const branchSnaps: Plain[] = [];
    try {
      baseSnap = await readJson(base, snapPath(lastNum(baseTags)));
      mainSnap = await readJson(main, snapPath(lastNum(mainTags)));
      for (const e of added) branchSnaps.push((await readJson(branch, ownSnap(String(e.tag)))) as Plain);
    } catch {
      return refuse("a snapshot could not be read");
    }
    if (!isPlain(baseSnap) || !isPlain(mainSnap) || branchSnaps.some((s) => !isPlain(s))) return refuse("a snapshot has a layout the gate doesn't know");

    // 6. Overlay on main's tree + the branch's code.
    const outIndex = { GIT_INDEX_FILE: path.join(dir, "out-index"), GIT_WORK_TREE: dir };
    await out(["read-tree", codeTree], outIndex);
    const put = async (file: string, text: string) => {
      const tmp = path.join(dir, "blob");
      writeFileSync(tmp, text);
      const sha = await out(["hash-object", "-w", "--no-filters", tmp]);
      await out(["update-index", "--add", "--cacheinfo", `100644,${sha},${file}`], outIndex);
    };
    const entries = [...mainJ.entries];
    let nextNum = mainMaxNum + 1;
    let prevWhen = mainWhen;
    let prevSnap = mainSnap as Plain;
    let prevBranchSnap = baseSnap as Plain;
    let prevSnapId = (mainSnap as Plain).id;
    const renamed: Array<{ from: string; to: string }> = [];
    for (let i = 0; i < added.length; i++) {
      const e = added[i]!;
      const oldTag = String(e.tag);
      // When any number clashes, all the branch's new migrations move to the next free numbers, in their own order.
      const number = renumber ? nextNum : Number(tagNumber(oldTag));
      const newTag = `${pad4(number)}_${oldTag.slice(5)}`;
      nextNum = number + 1;
      if (newTag !== oldTag) renamed.push({ from: oldTag, to: newTag });
      const sqlBlob = await out(["rev-parse", `${branch}:${ownSql(oldTag)}`]);
      await out(["update-index", "--add", "--cacheinfo", `100644,${sqlBlob},${ownSql(newTag)}`], outIndex);
      let snap: Json;
      try {
        snap = mergeSnapshots(prevBranchSnap, branchSnaps[i], prevSnap);
      } catch (err) {
        if (err instanceof SnapshotClash) return refuse(`the migration and main both change the same part of the schema (${err.message})`);
        throw err;
      }
      const merged2 = { ...(snap as Plain), id: branchSnaps[i]!.id, prevId: prevSnapId };
      await put(ownSnap(newTag), JSON.stringify(merged2, null, 2));
      prevSnap = merged2;
      prevBranchSnap = branchSnaps[i]!;
      prevSnapId = branchSnaps[i]!.id;
      const when = Math.max(Number(e.when), prevWhen + 1);
      prevWhen = when;
      const idx = renumber || idxClash ? Math.max(-1, ...entries.map((x) => Number(x.idx))) + 1 : e.idx;
      entries.push({ ...e, idx, tag: newTag, when });
    }
    if (!renamed.length && !idxClash && !added.some((e, i) => Number(entries[mainJ.entries.length + i]!.when) !== Number(e.when))) return { status: "none" };
    await put(journalPath, JSON.stringify({ ...mainJ, entries }, null, 2));
    const tree = await out(["write-tree"], outIndex);
    return { status: "rebuilt", tree, renamed };
  } catch (err) {
    return refuse(`the rebuild failed: ${(err as Error).message}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
