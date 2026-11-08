// BOS-332: the runner's own git must not run programs a shared repo's config names.
//
// Git has no switch to skip a repo's own config file, and many keys in it make git run a program
// (filter.<x>.clean/smudge/process, diff.external, diff.<x>.textconv/command, merge.<x>.driver,
// gpg.program, core.sshCommand, credential.helper, include.path to a file holding any of these...).
// Most of them are wildcard keys, so a per-key override in GIT_CONFIG_* can never cover them all.
// Instead the daemon keeps an allowlist: before each of its git calls it reads the config file that
// call will use and removes every key not on the list. A denylist would miss the next key git adds.
//
// Why remove, not refuse: refusing would stall every ticket in the project until a human edited the
// file; removing heals it, and protects the agents' own git (which shares the file) as well. Every
// removed key is logged by name (never by value), so a key wrongly removed shows at once and can be
// put back by hand after it's added here.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";

const run = promisify(execFile);

/** Keys with no subsection, normalised (section and name lower case). */
const PLAIN = new Set([
  "core.repositoryformatversion",
  "core.bare",
  "core.filemode",
  "core.logallrefupdates",
  "core.ignorecase",
  "core.precomposeunicode",
  "core.symlinks",
  "extensions.objectformat",
  "user.name",
  "user.email",
  "gc.auto",
  "gc.pruneexpire",
  "gc.worktreepruneexpire",
  "gc.reflogexpire",
  "gc.reflogexpireunreachable",
]);

/** Allowed keys with a subsection: section.subsection.name, the subsection matched as given. */
const SUB: Array<{ section: string; subsection: (s: string) => boolean; names: Set<string> }> = [
  { section: "remote", subsection: (s) => s === "origin", names: new Set(["url", "fetch"]) },
  { section: "branch", subsection: () => true, names: new Set(["remote", "merge"]) },
  { section: "bossman", subsection: (s) => s.startsWith("ticket-"), names: new Set(["base"]) },
];

/**
 * Whether a key, as `git config --list` prints it (section and name lower case, subsection as written),
 * may stay. The subsection is everything between the first and the last dot, so it may itself hold dots.
 */
export function allowedKey(key: string): boolean {
  const first = key.indexOf(".");
  const last = key.lastIndexOf(".");
  if (first <= 0 || last === key.length - 1) return false;
  const section = key.slice(0, first).toLowerCase();
  const name = key.slice(last + 1).toLowerCase();
  if (first === last) return PLAIN.has(`${section}.${name}`);
  const subsection = key.slice(first + 1, last);
  return SUB.some((s) => s.section === section && s.names.has(name) && s.subsection(subsection));
}

/** Only these reach the guard's own git: nothing from a global or system config, no prompts. */
const GUARD_ENV = { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" };

/**
 * The keys in a config file, read the way git reads it but without following include.path, so
 * reading it runs nothing. `--null` puts each entry as key, newline, value, NUL (no newline when
 * the key has no value), so a value with newlines can't fake a key.
 */
async function listKeys(file: string, env: Record<string, string | undefined>): Promise<string[]> {
  const { stdout } = await run("git", ["config", "--file", file, "--no-includes", "--list", "--null"], { env: { ...env, ...GUARD_ENV } as NodeJS.ProcessEnv, maxBuffer: 64 * 1024 * 1024 });
  return stdout
    .split("\0")
    .filter(Boolean)
    .map((entry) => entry.split("\n", 1)[0]!);
}

export type GuardLog = (message: string) => void;

/**
 * Keeps one config file to the allowlist. A file whose content matches the last one seen clean is
 * skipped (one read and a hash). Calls for the same file run one at a time in this process; across
 * processes git's own config.lock serialises the writes. Fails closed: if a key can't be removed, or
 * any is still there afterwards, it throws and the caller's git call must not run.
 */
export class GitConfigGuard {
  private readonly clean = new Map<string, string>();
  private readonly busy = new Map<string, Promise<unknown>>();

  constructor(
    private readonly env: { PATH?: string } = { PATH: process.env.PATH },
    private readonly log: GuardLog = (m) => console.warn(`[runner] ${m}`),
  ) {}

  async check(file: string): Promise<void> {
    const prev = this.busy.get(file) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(() => this.checkNow(file));
    this.busy.set(file, next);
    try {
      await next;
    } finally {
      if (this.busy.get(file) === next) this.busy.delete(file);
    }
  }

  private hash(file: string): string | null {
    try {
      return createHash("sha256").update(readFileSync(file)).digest("hex");
    } catch (err) {
      // No config yet (a clone being made): nothing for git to read either.
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  private async checkNow(file: string): Promise<void> {
    const before = this.hash(file);
    if (before === null || this.clean.get(file) === before) return;
    const env = { PATH: this.env.PATH };
    const bad = [...new Set((await listKeys(file, env)).filter((k) => !allowedKey(k)))];
    for (const key of bad) {
      const unset = await run("git", ["config", "--file", file, "--unset-all", key], { env: { ...env, ...GUARD_ENV } as NodeJS.ProcessEnv }).then(
        () => true,
        () => false,
      );
      // A key git won't name on the command line (an odd subsection): drop its whole section instead.
      if (!unset) {
        const section = key.slice(0, key.lastIndexOf("."));
        await run("git", ["config", "--file", file, "--remove-section", section], { env: { ...env, ...GUARD_ENV } as NodeJS.ProcessEnv }).catch(() => undefined);
      }
      this.log(`git config guard: removed ${key} from ${file} (not on the runner's allowlist, BOS-332)`);
    }
    // Hashed on both sides of the verifying read: only content that was the same throughout is remembered as clean,
    // so a write landing mid-check is looked at again next time instead of being cached.
    const h1 = this.hash(file);
    const left = (await listKeys(file, env)).filter((k) => !allowedKey(k));
    if (left.length) throw new Error(`Refusing to run git: ${file} still holds ${[...new Set(left)].join(", ")}, which the runner couldn't remove (BOS-332).`);
    if (h1 !== null && h1 === this.hash(file)) this.clean.set(file, h1);
  }
}
