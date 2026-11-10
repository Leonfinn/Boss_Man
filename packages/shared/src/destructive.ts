// Which parts of a shell command destroy data or push it out (BOS-116). The built-in owner rules
// used to look for text such as `rm -rf`, so the same delete written another way ("r"m, r\m, a line
// continuation, --recursive, find -delete, xargs rm, a python one-liner) ran with no one asked.
// This reads the command the way the shell would: it undoes quotes, escapes and continuations,
// splits it into the commands it runs (including $( ), backticks, sh -c and eval), and decides by
// each command's program and options.
//
// BOS-393 added: code fed to source/./a shell/an interpreter from <( ), a pipe or a here-string;
// commands run inside containers; git commands that throw work away (rm -f, reset --hard,
// checkout -- ., restore, stash drop, branch -D); tar --remove-files and zip -m; deletes outside
// the machine (aws, kubectl, gh, SQL clients, redis-cli); and in-place edits (sed -i, perl -i)
// outside the agent's own checkout and /tmp.
//
// shortcut: a script file the command runs (`bash x.sh`, `python x.py`) isn't read: Boss Man judges
// the command text, not the runner's files. Code inside an interpreter one-liner is matched against
// a word list, which a deliberate attacker can beat; closing both needs a sandbox on the runner.
// The same goes for SQL and sed scripts: their words are matched, not run.

export type Risk = {
  kind: "destroys" | "pushes";
  /** Why, in a few plain words. */
  why: string;
  /** The command's words, joined with spaces. */
  text: string;
  /** A top-level command written as plain words: no quotes, escapes, expansions or wrappers, so `text` is what runs. */
  plain: boolean;
};

type Word = {
  text: string;
  /** Holds an unquoted or double-quoted expansion ($, backticks), a brace expansion or a glob: the shell decides its value. */
  dynamic: boolean;
  /** Starts with an expansion, so it could turn into an option such as -rf. */
  lead: boolean;
  /** Holds an unquoted expansion, which the shell splits on spaces: dist$x can become `dist -rf`. */
  split: boolean;
  /** Has a brace expansion or glob in it, so it can become several words: -{a,delete} is `-a -delete`. */
  many: boolean;
  /** Has quotes or escapes in it. */
  quoted: boolean;
};

/**
 * named: the command began with `function` or `coproc`, so `NAME { … }` is a body, not a program and its arguments.
 * procIn: its input is redirected from <( ) (`bash < <(curl …)`), so what it reads is made when it runs (BOS-393).
 * elsewhere: it runs inside a container or on another machine, so a relative path isn't the agent's checkout (BOS-393).
 */
type Cmd = { words: Word[]; stdin: Word[]; piped: boolean; nested: boolean; named?: boolean; procIn?: boolean; elsewhere?: boolean };

const MAX_DEPTH = 6;
const KEYWORDS = new Set("if then else elif fi do done while until for case esac select ! { } coproc function".split(" "));
const SHELLS = new Set("sh bash zsh dash ksh mksh ash fish".split(" "));
const WIPES = new Set("shred truncate wipefs dd mke2fs mkswap blkdiscard sfdisk".split(" "));
const DELETES = new Set(["rm", "rmdir", "unlink"]);
// Paths a program reads its input stream through: `bash /dev/stdin <<< …`, `source /dev/fd/0` (BOS-393).
const STREAM_PATH = /^(-|\/dev\/stdin|\/dev\/fd\/\d+|\/proc\/(self|\d+)\/fd\/\d+)$/;
/** <( ) or >( ): a file whose contents a command makes when it runs. */
const PROC_SUB = /^[<>]\(/;
// A cd anywhere in the command moves where a relative path points.
const MOVES = /(^|[\s;&|(`{])(cd|pushd|popd)(\s|$|[;&|)])/;

/**
 * A word the shell may turn into an option when it runs: $x or "$x" (lead), -$x, -{r,f}, -[r]f,
 * dist$x (split on spaces into `dist -rf`), {-rf,x}, or * (a file named -rf). Globs and braces after
 * a plain start (./*, a{b,c}) can't: every word they make starts the same way.
 */
const mayBeOption = (w: Word) => w.dynamic && (w.lead || w.split || /^[-{*?[]/.test(w.text));

/** GNU tools and git accept any unambiguous start of a long option: --rec is --recursive, --forc is --force. */
function longOf(o: string, names: string[]): boolean {
  const long = /^--([^=]+)/.exec(o)?.[1];
  return !!long && names.some((n) => n.startsWith(long));
}

/** A cluster of short options (-df) holding the letter. */
const shortHas = (o: string, letter: string) => /^-[a-zA-Z]+$/.test(o) && o.includes(letter);

/** Index of the ")" closing the "(" at s[open], skipping quotes and escapes; -1 when there's none. */
function matchParen(s: string, open: number): number {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    const c = s[i];
    if (c === "\\") i++;
    else if (c === "'") {
      i = s.indexOf("'", i + 1);
      if (i < 0) return -1;
    } else if (c === '"') {
      for (i++; i < s.length && s[i] !== '"'; i++) if (s[i] === "\\") i++;
      if (i >= s.length) return -1;
    } else if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return i;
  }
  return -1;
}

/** Index of the next unescaped backtick from i; -1 when there's none. */
function matchTick(s: string, i: number): number {
  for (; i < s.length; i++) {
    if (s[i] === "\\") i++;
    else if (s[i] === "`") return i;
  }
  return -1;
}

/** Reads a shell command into the commands it runs. Commands inside $( ), backticks, <( ) and ${ } are read too. */
function parse(src: string): { cmds: Cmd[]; unparsed: boolean } {
  const cmds: Cmd[] = [];
  let unparsed = false;

  function run(s: string, depth: number) {
    if (depth > MAX_DEPTH) {
      unparsed = true;
      return;
    }
    const newCmd = (piped: boolean): Cmd => ({ words: [], stdin: [], piped, nested: depth > 0 });
    let cmd = newCmd(false);
    let word = "";
    let started = false;
    let dynamic = false;
    let lead = false;
    let split = false;
    let quoted = false;
    let brace = false;
    let glob = false;
    let redirect: null | "file" | "here" = null;
    const heredocs: Array<{ delim: string; strip: boolean; expand: boolean; cmd: Cmd }> = [];

    // An unquoted expansion; $'…' is quoted, so it isn't split.
    const expansion = (splits = true) => {
      if (!started) lead = true;
      if (splits) split = true;
      dynamic = started = true;
    };
    const endWord = () => {
      if (!started) return;
      let many = false;
      if (brace && /\{[^{}]*(,|\.\.)[^{}]*\}/.test(word)) dynamic = many = true;
      // [ on its own (the test command) isn't a pattern; [ab] is.
      if (glob && /[*?]|\[.*\]/.test(word)) dynamic = many = true;
      const w: Word = { text: word, dynamic, lead, split, many, quoted };
      if (redirect === "here") cmd.stdin.push(w);
      else if (redirect === "file") {
        // A redirect's target isn't one of the command's words; `< <(…)` feeds the command what <( ) makes (BOS-393).
        if (word.startsWith("<(")) cmd.procIn = true;
      } else if (cmd.words.length === 0 && !quoted && KEYWORDS.has(word)) {
        if (word === "function" || word === "coproc") cmd.named = true;
      } else cmd.words.push(w);
      redirect = null;
      word = "";
      started = dynamic = lead = split = quoted = brace = glob = false;
    };
    const endCmd = (piped: boolean) => {
      endWord();
      if (cmd.words.length) cmds.push(cmd);
      cmd = newCmd(piped);
    };
    // The body of a "here document": text between the line after << WORD and a line holding only WORD.
    const readHeredocs = (i: number): number => {
      for (const h of heredocs.splice(0)) {
        let body = "";
        let found = false;
        while (i < s.length) {
          const nl = s.indexOf("\n", i);
          const line = s.slice(i, nl < 0 ? s.length : nl);
          i = nl < 0 ? s.length : nl + 1;
          if ((h.strip ? line.replace(/^\t+/, "") : line) === h.delim) {
            found = true;
            break;
          }
          body += line + "\n";
        }
        if (!found) unparsed = true;
        // Unless its WORD is quoted, the shell expands $( ) and backticks inside the body.
        const expands = h.expand && /[$`]/.test(body);
        if (expands) expandIn(body, depth);
        h.cmd.stdin.push({ text: body, dynamic: expands, lead: false, split: false, many: false, quoted: false });
      }
      return i - 1;
    };

    for (let i = 0; i < s.length; i++) {
      const c = s[i]!;
      if (c === "\\") {
        if (s[i + 1] === "\n") {
          i++;
          continue;
        }
        if (i + 1 < s.length) word += s[++i];
        started = quoted = true;
      } else if (c === "'") {
        const end = s.indexOf("'", i + 1);
        if (end < 0) {
          unparsed = true;
          word += s.slice(i + 1);
          started = quoted = true;
          break;
        }
        word += s.slice(i + 1, end);
        i = end;
        started = quoted = true;
      } else if (c === '"') {
        let j = i + 1;
        for (; j < s.length && s[j] !== '"'; j++) {
          const d = s[j]!;
          if (d === "\\" && j + 1 < s.length) {
            const n = s[++j]!;
            if (n !== "\n") word += '$`"\\'.includes(n) ? n : "\\" + n;
          } else if (d === "$" || d === "`") {
            if (!started && word === "") lead = true;
            dynamic = true;
            const end = d === "`" ? matchTick(s, j + 1) : s[j + 1] === "(" ? matchParen(s, j + 1) : s[j + 1] === "{" ? s.indexOf("}", j) : j;
            if (end < 0) {
              unparsed = true;
              j = s.length;
              break;
            }
            if (end > j) {
              const inner = s.slice(j + (d === "`" ? 1 : 2), end);
              if (d === "`" || s[j + 1] === "(") run(d === "`" ? inner.replace(/\\([`$\\])/g, "$1") : inner, depth + 1);
              else expandIn(inner, depth);
            }
            word += s.slice(j, end + 1);
            j = end;
          } else word += d;
        }
        if (j >= s.length) unparsed = true;
        i = j;
        started = quoted = true;
      } else if (c === "$") {
        const n = s[i + 1];
        if (n === "'") {
          // $'\x72m' is ANSI-C quoting: escapes Boss Man doesn't decode, so its value is unknown.
          let j = i + 2;
          for (; j < s.length && s[j] !== "'"; j++) if (s[j] === "\\") j++;
          if (j >= s.length) unparsed = true;
          word += s.slice(i, j + 1);
          expansion(false);
          quoted = true;
          i = j;
        } else if (n === "(" || n === "{") {
          const end = n === "(" ? matchParen(s, i + 1) : s.indexOf("}", i);
          if (end < 0) {
            unparsed = true;
            break;
          }
          const inner = s.slice(i + 2, end);
          if (n === "(") run(s[i + 2] === "(" ? inner.slice(1, -1) : inner, depth + 1);
          else expandIn(inner, depth);
          word += s.slice(i, end + 1);
          expansion();
          i = end;
        } else {
          word += c;
          expansion();
        }
      } else if (c === "`") {
        const end = matchTick(s, i + 1);
        if (end < 0) {
          unparsed = true;
          break;
        }
        run(s.slice(i + 1, end).replace(/\\([`$\\])/g, "$1"), depth + 1);
        word += s.slice(i, end + 1);
        expansion();
        i = end;
      } else if ((c === "<" || c === ">") && s[i + 1] === "(") {
        const end = matchParen(s, i + 1);
        if (end < 0) {
          unparsed = true;
          break;
        }
        run(s.slice(i + 2, end), depth + 1);
        word += s.slice(i, end + 1);
        expansion();
        i = end;
      } else if (c === "#" && !started) {
        const nl = s.indexOf("\n", i);
        i = (nl < 0 ? s.length : nl) - 1;
      } else if (c === " " || c === "\t") endWord();
      else if (c === "<" || c === ">" || (c === "&" && s[i + 1] === ">")) {
        // A number right before a redirect (2>) is the stream it redirects, not a word.
        if (started && !quoted && /^\d+$/.test(word)) word = "", started = false;
        else endWord();
        if (s.startsWith("<<<", i)) {
          i += 2;
          redirect = "here";
        } else if (s.startsWith("<<", i)) {
          i += 2;
          const strip = s[i] === "-";
          if (strip) i++;
          while (s[i] === " " || s[i] === "\t") i++;
          let delim = "";
          let expand = true;
          while (i < s.length && !/[\s;&|<>()]/.test(s[i]!)) {
            const d = s[i]!;
            if (d === "'" || d === '"') {
              expand = false;
              let e = s.indexOf(d, i + 1);
              if (e < 0) unparsed = true, e = s.length;
              delim += s.slice(i + 1, e);
              i = e + 1;
            } else if (d === "\\") {
              expand = false;
              delim += s[i + 1] ?? "";
              i += 2;
            } else delim += s[i++];
          }
          i--;
          heredocs.push({ delim, strip, expand, cmd });
        } else {
          if (c === "&") i++;
          else if (c === ">" && /[>|&]/.test(s[i + 1] ?? "")) i++;
          else if (c === "<" && /[&>]/.test(s[i + 1] ?? "")) i++;
          redirect = "file";
        }
      } else if (c === "\n" || c === ";" || c === "&" || c === "|" || c === "(" || c === ")") {
        let piped = false;
        if ((c === "|" || c === "&" || c === ";") && s[i + 1] === c) i++;
        else if (c === "|") {
          piped = true;
          if (s[i + 1] === "&") i++;
        }
        endCmd(piped);
        if (c === "\n" && heredocs.length) i = readHeredocs(i + 1);
      } else {
        if (c === "{") brace = true;
        if (c === "*" || c === "?" || c === "[") glob = true;
        word += c;
        started = true;
      }
    }
    endCmd(false);
    if (heredocs.length) unparsed = true;
  }

  // Text the shell expands without running it as a command (a here-doc body, ${x:-…}): only the commands substituted into it run.
  function expandIn(text: string, depth: number) {
    for (let i = 0; i < text.length; i++) {
      if (text[i] === "\\") i++;
      else if (text[i] === "`") {
        const end = matchTick(text, i + 1);
        if (end < 0) return void (unparsed = true);
        run(text.slice(i + 1, end), depth + 1);
        i = end;
      } else if (text[i] === "$" && text[i + 1] === "(") {
        const end = matchParen(text, i + 1);
        if (end < 0) return void (unparsed = true);
        run(text.slice(i + 2, end), depth + 1);
        i = end;
      }
    }
  }

  run(src, 0);
  return { cmds, unparsed };
}

const plainWords = (texts: string[]): Word[] => texts.map((text) => ({ text, dynamic: false, lead: false, split: false, many: false, quoted: false }));

/** True when a word before the program's first plain operand may turn into an option, so whether it runs inline code (bash -c, python -c) is only known when it runs. */
function unknownMode(args: Word[]): boolean {
  for (const a of args) {
    if (mayBeOption(a)) return true;
    if (!a.text.startsWith("-")) return false;
  }
  return false;
}

// find's tests and actions that take one value: a single word after one of them is that value, whatever it holds.
const FIND_VALUED = new Set(
  "-name -iname -path -ipath -wholename -iwholename -regex -iregex -lname -ilname -type -xtype -mtime -mmin -atime -amin -ctime -cmin -newer -anewer -cnewer -size -perm -user -group -uid -gid -links -inum -samefile -maxdepth -mindepth -fstype -used -regextype -context".split(" "),
);

/** Skips a program's options (and the values of those in `withValue`); returns what follows. */
function afterOptions(args: Word[], withValue: string[] = []): Word[] {
  let i = 0;
  while (i < args.length && /^[-+]./.test(args[i]!.text)) {
    const t = args[i]!.text;
    i++;
    if (t === "--") break;
    if (withValue.includes(t)) i++;
  }
  return args.slice(i);
}

// Programs that run another program given as their arguments, with their options that take a value.
const WRAPPERS: Record<string, string[]> = {
  sudo: ["-u", "-g", "-h", "-p", "-C", "-D", "-r", "-t", "-U", "-T", "-R", "--user", "--group", "--host", "--prompt", "--chdir"],
  doas: ["-u", "-C"],
  pkexec: ["--user"],
  nice: ["-n", "--adjustment"],
  nohup: [],
  chronic: [],
  time: ["-f", "-o", "--format", "--output"],
  stdbuf: ["-i", "-o", "-e"],
  ionice: ["-c", "-n", "-t"],
  builtin: [],
  exec: ["-a"],
  setsid: [],
  xargs: ["-I", "-L", "-n", "-P", "-s", "-d", "-E", "-a", "--max-args", "--max-procs", "--delimiter", "--arg-file", "--max-lines", "--replace"],
  parallel: ["-j", "-S", "--jobs", "--sshlogin", "--joblog"],
  busybox: [],
  toybox: [],
  unshare: [],
  nsenter: ["-t", "--target", "-S", "-G", "-r", "-w", "--setuid", "--setgid"],
  bunx: [],
  strace: ["-o", "-e", "-p", "-s", "-u", "-E", "-a", "-b", "-I", "-P", "-S", "-X", "--output", "--trace", "--attach", "--string-limit", "--user", "--env"],
  ltrace: ["-o", "-e", "-p", "-s", "-u", "-a", "-n", "-l", "-L", "-w", "-x", "--output", "--library"],
  fakeroot: ["-l", "-s", "-i", "-b", "--lib", "--faked", "--fd-base"],
  proot: ["-r", "-b", "-m", "-w", "-q", "-k", "--rootfs", "--bind", "--mount", "--cwd", "--qemu", "--kernel-release"],
  "systemd-run": ["-u", "-p", "-M", "-H", "-E", "--unit", "--property", "--machine", "--host", "--setenv", "--description", "--slice", "--uid", "--gid", "--nice", "--working-directory"],
  setpriv: ["--reuid", "--regid", "--ruid", "--rgid", "--euid", "--egid", "--groups", "--inh-caps", "--ambient-caps", "--bounding-set", "--securebits", "--pdeathsig", "--selinux-label", "--apparmor-profile", "--landlock-access", "--landlock-rule"],
  entr: [],
  // firejail runs the program after its own options in the same filesystem (BOS-571). Its options take a value only
  // after `=` (--net=none), never as the next word, so none may be listed here: a word after `--private` is the
  // program (firejail --private rm -rf /x) and must be judged, not skipped (BOS-571 review).
  firejail: [],
  // bwrap builds a new filesystem view from its --bind/--ro-bind/… options and runs the program there: see the bwrap case (BOS-571).
  bwrap: ["--ro-bind", "--bind", "--dev-bind", "--ro-bind-try", "--bind-try", "--dev-bind-try", "--tmpfs", "--proc", "--dev", "--dir", "--mqueue", "--chdir", "--setenv", "--unsetenv", "--clearenv", "--uid", "--gid", "--hostname", "--args", "--file", "--bind-data", "--ro-bind-data", "--seccomp", "--add-seccomp-fd", "--userns", "--userns-block-fd", "--info-fd", "--json-status-fd", "--cap-add", "--cap-drop", "--perms", "--size", "--lock-file", "--sync-fd", "--level-prefix", "--log-file", "--exec-label", "--file-label", "--unshare-user-try", "--userns-try"],
};
// Wrappers whose first word after their options is a value (a CPU mask, a priority), not the program.
const WRAPPERS_WITH_VALUE = new Set(["taskset", "chrt"]);
// Programs given a shell command as an option's value (su -c, flock -c, script -qc, npx -c), and what they run without one.
const SCRIPT_OPTION: Record<string, (args: Word[]) => Word[]> = {
  su: () => [],
  runuser: (args) => afterOptions(args, ["-u", "-g", "-G", "--user", "--group"]),
  flock: (args) => afterOptions(args, ["-w", "--timeout", "-E", "--conflict-exit-code"]).slice(1),
  script: () => [],
  npx: (args) => afterOptions(args, ["-p", "--package"]),
  // sg GROUP cmd runs cmd as the group; with -c the SCRIPT_OPTION check reads its command. Either way the group is dropped.
  sg: (args) => afterOptions(args).slice(1),
};
// ssh's options that take a value; the words after the host are a command for the remote shell.
const SSH_VALUED = "-B -b -c -D -E -e -F -I -i -J -L -l -m -O -o -p -Q -R -S -W -w".split(" ");
// Global options that take a value, so the word after them isn't the subcommand.
const KUBE_VALUED = ["-n", "--namespace", "--context", "--cluster", "--kubeconfig", "-s", "--server", "--user", "--token", "-l", "--selector", "-o", "--output", "-c", "--container", "-f", "--filename"];
const AWS_VALUED = ["--profile", "--region", "--output", "--endpoint-url", "--query", "--color", "--ca-bundle", "--cli-read-timeout", "--cli-connect-timeout"];
const REDIS_VALUED = ["-h", "-p", "-s", "-a", "-u", "-n", "-r", "-i", "-d", "--user", "--pass", "--sni", "--cacert", "--cacertdir", "--cert", "--key"];

// Interpreters, and the options that hand them code in the command itself.
const INLINE: Array<[RegExp, RegExp]> = [
  [/^(python[\d.]*|pypy[\d.]*)$/, /^-[a-zA-Z]*c/],
  // -r/--require and --import (or a loader) load a module first, which may be inline code (data: URLs).
  [/^(node|nodejs|bun)$/, /^(-[a-zA-Z]*[epr]|--eval|--print|--require|--import|--loader|--experimental-loader)(=|$)/],
  [/^deno$/, /^eval$/],
  // -M/-m put their value into a `use` line, so it can carry code: -M'File::Path;rmtree("/x")'.
  [/^perl[\d.]*$/, /^-[a-zA-Z]*[eEmM]/],
  [/^ruby[\d.]*$/, /^-[a-zA-Z]*e/],
  [/^php[\d.]*$/, /^-[a-zA-Z]*r/],
  [/^(lua[\d.]*|luajit)$/, /^-[a-zA-Z]*e/],
  [/^[gmn]?awk$/, /^/],
];
// Words in interpreter code that delete files, or that run or build code Boss Man can't read.
const CODE_DELETES = /\b(rm|rm_r|rm_rf|rm_f|rmdir\w*|rmtree|rmSync|remove\w*|unlink\w*|truncate\w*|shred|delete_file|File\.delete|FileUtils)\b/;
const CODE_HIDDEN = /\b(exec\w*|spawn\w*|eval|system|popen\w*|subprocess|child_process|qx|__import__|importlib|getattr|globals|compile|Function|b64decode|atob|fromCharCode|chr|unhexlify|fromhex)\b|`/;

// Database clients (BOS-393): the options that hand them SQL, the ones that read SQL from a file, and other options that take a value.
const SQL_CLIENTS: Record<string, { code: string[]; file: string[]; valued: string[] }> = {
  psql: {
    code: ["-c", "--command"],
    file: ["-f", "--file"],
    valued: ["-d", "--dbname", "-h", "--host", "-p", "--port", "-U", "--username", "-v", "--set", "--variable", "-o", "--output", "-L", "--log-file", "-P", "--pset", "-F", "--field-separator", "-R", "--record-separator", "-T", "--table-attr"],
  },
  mysql: { code: ["-e", "--execute"], file: [], valued: ["-u", "--user", "-h", "--host", "-P", "--port", "-D", "--database", "-S", "--socket"] },
  sqlite3: { code: ["-cmd"], file: [], valued: ["-init", "-separator", "-newline", "-nullvalue", "-mmap", "-lookaside", "-pagecache", "-vfs", "-maxsize", "-escape"] },
};
SQL_CLIENTS.mariadb = SQL_CLIENTS.mysql!;
SQL_CLIENTS.sqlite = SQL_CLIENTS.sqlite3!;
// SQL that deletes data (drop, truncate, delete; also `on delete cascade`, which asks needlessly but rarely), and the
// client commands that run a shell or a program: psql \! and \o |cmd and COPY … PROGRAM, \gexec (runs what a query
// returns), mysql system, sqlite .shell/.system/.load and load_extension().
const SQL_DESTROYS = /\b(drop|truncate|delete|program|system|load_extension)\b|\\!|\\gexec|\\(o|out|g|gx|w|write)\s*['"]?\||\.(shell|system|load)\b|\.(output|once|import|read)\s+['"]?\|/i;

/**
 * A sed script that runs a shell command: GNU sed's `e` command (`1e rm -rf x`) or the `e` flag of `s`
 * (s/x/rm -rf y/e). Matched on the text, so a lone ` e ` in replacement text asks needlessly.
 */
const SED_EXEC = /(^|[;\n{}!\d$/,])\s*e(\s|;|}|$)|\bs([^\w\s\\]).*\3[gpiImMw\d]*e[gpiImM\d]*(\s|;|}|$)/m;

/**
 * A sed script that can write a file: the `w` / `W` command or the `w` flag of `s` (`s/a/b/w FILE` creates FILE even
 * when the input is /dev/null). Matched on the text and on purpose wide (BOS-680): a stray `w` only means the
 * do-nothing `sed -i … /dev/null` is judged as an edit, as before.
 */
const SED_WRITES = /(^|[;\n{}!\d$/,])\s*[wW](\s|\/|$)|\bs([^\w\s\\]).*\3[gpiImMe\d]*[wW]/m;

/**
 * In-place edits (sed -i, perl -i), decided on purpose (BOS-393). Agents edit files in their own
 * checkout all the time, so an edit there or under /tmp runs without asking. Anything else goes to the
 * owner: an absolute path outside /tmp, ~, a variable, `..`, anything in .git (.git/config can set a hook,
 * which runs code), a wrapper (sudo sed -i), bulk input (xargs sed -i, find -exec sed -i), a cd anywhere in
 * the command, a container or another machine, or sed --follow-symlinks. Without that option sed and perl
 * replace a symlink rather than write through it, so a link in the checkout can't reach outside it.
 * Known cost: commandRisks sees only the command, not the folder the run is in, so an absolute path into
 * the agent's own checkout goes to the owner too; agents should use relative paths.
 *
 * Left out on purpose: plain redirects (`> x`, `cp /dev/null x`) also empty or overwrite a file, but they
 * are how agents write files every few minutes; catching them would flood the owner with routine writes.
 */
function safeEditPath(w: Word): boolean {
  const t = w.text;
  if (!t || t.includes("..")) return false;
  // Only a glob is accepted from the shell (src/*.ts): no expansion, brace or ? and [ ] pattern, and no
  // glob on a dot-name, which could reach .git.
  if (w.dynamic && /[$`{?[]|[<>]\(/.test(t)) return false;
  const parts = t.split("/");
  if (parts.some((p) => p.toLowerCase() === ".git" || (w.dynamic && p.startsWith(".") && p.includes("*")))) return false;
  if (t.startsWith("/tmp/")) return t.length > 5;
  return /^[^/~]/.test(t);
}

/**
 * The command words of a gcloud/az command: its global options (which may take a value) and every other option are
 * dropped, so what's left is the resource path that ends with the verb (`compute instances delete`). A word only known
 * when it runs is kept so it can be flagged (BOS-571).
 */
function gcloudWords(args: Word[]): Word[] {
  // az's short flags that take a value (gcloud has none at global level). Only these skip the next word: an unknown
  // short flag is boolean, so `gcloud compute instances -q delete i` must keep `delete` (BOS-571 review).
  const valued = new Set([
    "--project", "--account", "--configuration", "--filter", "--format", "--impersonate-service-account", "--billing-project",
    "--subscription", "--output", "--query", "--resource-group", "-g", "-s", "--location", "-l",
    "-n", "--name", "-o", "--sub",
  ]);
  const out: Word[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const t = a.text;
    if (t === "--") continue;
    if (t.startsWith("-")) {
      if (valued.has(t)) i++; // its value is the next word
      continue;
    }
    out.push(a);
  }
  return out;
}

/**
 * Reads an interpreter's switches up to its first operand (BOS-571): `inPlace` when -i appears (a suffix may be
 * joined to it, -pi.bak), `code` when -e/-E was given (so the first operand is a file, not the script), and `end`
 * the index of that first operand. `joined` lists the other letters whose value is joined to them (-I, -M, -m),
 * so the switch cluster ends there; "0" and "l" take optional digits and more switches may follow (-0777pi).
 * `valued` lists letters whose value may be joined OR given as the next word (-r lib / -rlib), so the word after them
 * is not read as a switch cluster (BOS-571: a value like -rdate must not hide a later -i).
 */
function inPlaceSwitches(args: Word[], joined: string, valued = "", codeLetters = "eE", longValued: string[] = []): { inPlace: boolean; code: boolean; end: number; unknownLong: boolean } {
  let inPlace = false;
  let code = false;
  let unknownLong = false;
  let i = 0;
  for (; i < args.length && /^-./.test(args[i]!.text); i++) {
    const t = args[i]!.text;
    if (t === "--") {
      i++;
      break;
    }
    // A long option (--encoding): its value is joined (--encoding=x) or, for the ones listed, the next word. An
    // unknown long option could take the next word as its value too, which would hide a following -i, so the read
    // stops and the caller flags it (BOS-571 security review round 3).
    if (t.startsWith("--")) {
      if (t.includes("=")) {
        if (/^--inplace=/.test(t)) inPlace = true;
        continue;
      }
      // --inplace is ruby's long form of -i.
      if (t === "--inplace") {
        inPlace = true;
        continue;
      }
      if (longValued.includes(t)) i++;
      else {
        unknownLong = true;
        break;
      }
      continue;
    }
    for (let j = 1; j < t.length; j++) {
      const c = t[j]!;
      if (c === "i") {
        inPlace = true;
        break;
      }
      if (codeLetters.includes(c)) {
        code = true;
        if (j + 1 === t.length) i++;
        break;
      }
      // -0 and -l take optional digits, then more switches may follow: -0pi, -lpi, -0777pi.
      if (c === "0" || c === "l") {
        if (c === "0" && /[xX]/.test(t[j + 1] ?? "")) for (j++; /[0-9a-fA-F]/.test(t[j + 1] ?? ""); ) j++;
        else while (/[0-7]/.test(t[j + 1] ?? "")) j++;
        continue;
      }
      if (valued.includes(c)) {
        if (j + 1 === t.length) i++;
        break;
      }
      if (joined.includes(c)) break;
    }
  }
  return { inPlace, code, end: i, unknownLong };
}

/**
 * What in a shell command destroys data or pushes it out. A command given as an argv array
 * (["bash", "-lc", "…"]) is read as those words; a string is read the way the shell reads it.
 * A command Boss Man can't read (unbalanced quotes, nesting too deep, an error) counts as destroying.
 */
export function commandRisks(command: string | string[]): Risk[] {
  const risks: Risk[] = [];
  try {
    const whole = typeof command === "string" ? command : command.join(" ");
    const top = typeof command === "string" ? parse(command) : { cmds: [{ words: plainWords(command), stdin: [], piped: false, nested: false }], unparsed: false };
    const flat = top.cmds.flatMap((c) => [...c.words, ...c.stdin].map((w) => w.text)).join(" ");
    if (top.unparsed) risks.push({ kind: "destroys", why: "Boss Man couldn't read this command", text: whole, plain: false });
    // Words judged inside containers, where every position is tried: a cap keeps nested `docker exec` cheap.
    let containerWords = 0;

    const add = (kind: Risk["kind"], why: string, words: Word[], plain: boolean) => risks.push({ kind, why, text: words.map((w) => w.text).join(" "), plain });
    const readScript = (script: string, depth: number, elsewhere?: boolean) => {
      if (depth > MAX_DEPTH) return add("destroys", "commands nested too deeply to read", [], false);
      const p = parse(script);
      if (p.unparsed) add("destroys", "Boss Man couldn't read a script it runs", plainWords([script]), false);
      for (const c of p.cmds) judge({ ...c, nested: true, elsewhere }, depth, false);
    };

    function judge(cmd: Cmd, depth: number, bulk: boolean) {
      let w = cmd.words;
      let wrapped = false;
      let named = !!cmd.named;
      // VAR=value words in front of the command: git reads its config from GIT_CONFIG_* among them (BOS-1061).
      const envPrefix: Word[] = [];
      for (let hops = 0; hops < 12; hops++) {
        while (w.length && /^[A-Za-z_]\w*\+?=/.test(w[0]!.text)) envPrefix.push(w[0]!), (w = w.slice(1));
        // A keyword after a wrapper (time { rm …; }, time ! rm …) starts the command that follows it.
        while (w.length && !w[0]!.quoted && KEYWORDS.has(w[0]!.text)) {
          if (w[0]!.text === "function" || w[0]!.text === "coproc") named = true;
          w = w.slice(1);
        }
        // `function f { rm …; }` and `coproc f { rm …; }` reach here as `f { rm …`: the body starts after the `{`.
        // Only after one of those keywords: elsewhere a second word `{` is just an argument, and
        // `truncate { -s0 x` runs truncate (BOS-116 round 15, Jane).
        if (named && w.length > 2 && !w[1]!.quoted && w[1]!.text === "{") w = w.slice(2);
        named = false;
        const first = w[0];
        if (!first) return;
        const all = w;
        const plain = !cmd.nested && !wrapped && !bulk && all.every((x) => !x.dynamic && !x.quoted);
        const destroys = (why: string) => add("destroys", why, all, plain);
        if (first.dynamic) return destroys("runs a program whose name is only known when it runs");
        const prog = first.text.split("/").pop()!;
        const args = w.slice(1);

        // What a shell or `source` reads when its script comes from the input stream: a here-doc or here-string
        // is read like any script; a pipe or < <( ) gives code made when it runs, so it goes to the owner (BOS-393).
        const readStream = () => {
          if (cmd.procIn) return destroys("runs code made when it runs (< <( ))");
          for (const body of cmd.stdin) {
            if (body.dynamic) return destroys("runs a script only known when it runs");
            readScript(body.text, depth + 1, cmd.elsewhere);
          }
          if (!cmd.stdin.length && cmd.piped) destroys("runs commands piped into it");
        };
        // A script operand that isn't a file on disk: <( ) (bash <(curl …), source <(…)), /dev/stdin, /dev/fd/N or -,
        // or a name only known when it runs with code waiting on the input stream. True when it was judged here.
        const streamed = (script: Word): boolean => {
          if (PROC_SUB.test(script.text)) return destroys("runs code made when it runs (<( ))"), true;
          if (!STREAM_PATH.test(script.text) && !(script.dynamic && (cmd.stdin.length || cmd.piped || cmd.procIn))) return false;
          readStream();
          return true;
        };
        // An in-place edit (sed -i, perl -i): see safeEditPath for the decision.
        const editsInPlace = (files: Word[], why: string) => {
          if (wrapped || bulk || cmd.elsewhere || MOVES.test(whole) || !files.every(safeEditPath)) destroys(why);
        };
        // A command run inside a container (docker exec/run, kubectl exec), decided on purpose (BOS-393): containers
        // commonly mount host folders and volumes, so a delete in one can delete real data, and it is judged like
        // any other command. These programs have long lists of options that take a value, so which word is the
        // container or image and which starts the command can't be told; the command is judged from every
        // position instead and is flagged if any of them destroys. A word only known when it runs is passed over
        // after an option (-v "$PWD":/w) or right after the subcommand (the container), and judged elsewhere.
        const inside = (words: Word[]) => {
          containerWords += words.length;
          if (depth >= MAX_DEPTH || containerWords > 2000) return destroys("too many commands inside containers to read");
          words.forEach((x, i) => {
            if (x.dynamic && (i === 0 || words[i - 1]!.text.startsWith("-"))) return;
            judge({ ...cmd, words: words.slice(i), nested: true, elsewhere: true }, depth + 1, bulk);
          });
        };

        if (prog === "entr" && args.some((a) => /^-[a-zA-Z]*s/.test(a.text))) {
          // entr -s 'cmd' hands its one argument to a shell.
          const script = afterOptions(args)[0];
          if (script?.dynamic) return destroys("runs a script only known when it runs");
          return script ? readScript(script.text, depth + 1, cmd.elsewhere) : undefined;
        }
        if (prog === "bwrap") {
          // bwrap runs the program after its options in a new namespace over the files it was given, so a relative
          // path isn't the agent's checkout. Its options take one or two values (--setenv VAR VAL), so which word is
          // the program can't be told: judge every position as elsewhere, like docker exec (BOS-571).
          const rest = afterOptions(args);
          rest.forEach((x, i) => {
            if (x.text.startsWith("-") || (x.dynamic && i > 0 && rest[i - 1]!.text.startsWith("-"))) return;
            judge({ ...cmd, words: rest.slice(i), nested: true, elsewhere: true }, depth + 1, bulk);
          });
          return;
        }
        if (WRAPPERS_WITH_VALUE.has(prog)) {
          if (args.some((a) => a.text === "-p" || a.text === "--pid")) return; // changes a running process, runs nothing
          w = afterOptions(args).slice(1);
          wrapped = true;
          continue;
        }
        if (WRAPPERS[prog]) {
          if (prog === "xargs" || prog === "parallel") bulk = true;
          w = afterOptions(args, WRAPPERS[prog]);
          const inputs = w.findIndex((x) => x.text === ":::");
          if (prog === "parallel" && inputs >= 0) w = w.slice(0, inputs);
          wrapped = true;
          continue;
        }
        if (prog === "command") {
          if (args.some((a) => /^-[a-zA-Z]*[vV]/.test(a.text))) return; // looks a program up, doesn't run it
          w = afterOptions(args);
          wrapped = true;
          continue;
        }
        if (prog === "env") {
          const split = args.findIndex((a) => a.text === "-S" || a.text === "--split-string" || a.text.startsWith("--split-string="));
          if (split >= 0) {
            const a = args[split]!;
            const text = a.text.includes("=") ? a.text.slice(a.text.indexOf("=") + 1) : args[split + 1]?.text ?? "";
            return readScript([text, ...args.slice(split + 2).map((x) => x.text)].join(" "), depth + 1, cmd.elsewhere);
          }
          w = afterOptions(args, ["-u", "--unset", "-C", "--chdir"]);
          wrapped = true;
          continue;
        }
        if (prog === "timeout") {
          w = afterOptions(args, ["-s", "--signal", "-k", "--kill-after"]).slice(1);
          wrapped = true;
          continue;
        }
        if (prog === "watch") {
          const rest = afterOptions(args, ["-n", "--interval", "-d", "--differences"]);
          return readScript(rest.map((x) => x.text).join(" "), depth + 1, cmd.elsewhere);
        }
        if (prog === "chroot") {
          w = afterOptions(args, ["--userspec", "--groups"]).slice(1);
          wrapped = true;
          continue;
        }
        if ((prog === "pnpm" || prog === "yarn") && args.some((a) => a.text === "exec" || a.text === "dlx")) {
          w = afterOptions(args.slice(args.findIndex((a) => a.text === "exec" || a.text === "dlx") + 1));
          wrapped = true;
          continue;
        }
        // npm exec / npm x / npx / bunx / bun x run a package's program, like pnpm exec.
        const npmSub = prog === "npm" || prog === "bun" ? args.findIndex((a) => a.text === "exec" || a.text === "x") : -1;
        if (prog === "npx" || prog === "bunx" || npmSub >= 0) {
          const rest = npmSub >= 0 ? args.slice(npmSub + 1) : args;
          const call = rest.findIndex((a) => /^(-c|--call)$/.test(a.text) || a.text.startsWith("--call="));
          if (call >= 0) {
            const a = rest[call]!;
            const script = a.text.includes("=") ? { ...a, text: a.text.slice(a.text.indexOf("=") + 1) } : rest[call + 1];
            if (script?.dynamic) return destroys("runs a script only known when it runs");
            return script ? readScript(script.text, depth + 1, cmd.elsewhere) : undefined;
          }
          w = afterOptions(rest, ["-p", "--package", "-w", "--workspace"]);
          // npm's option parser swallows a later "--", so `npx rm -- -rf x` hands rm "-rf x".
          if (prog !== "bunx" && prog !== "bun") w = w.filter((a, i) => i === 0 || a.text !== "--");
          wrapped = true;
          continue;
        }
        const scriptOption = SCRIPT_OPTION[prog];
        if (scriptOption) {
          const at = args.findIndex((a) => /^(-[a-zA-Z]*c|--command|--call)$/.test(a.text) || /^--(command|call)=/.test(a.text));
          if (at >= 0) {
            const a = args[at]!;
            const script = a.text.includes("=") ? { ...a, text: a.text.slice(a.text.indexOf("=") + 1) } : args[at + 1];
            if (script?.dynamic) return destroys("runs a script only known when it runs");
            return script ? readScript(script.text, depth + 1, cmd.elsewhere) : undefined;
          }
          if (args.some(mayBeOption)) return destroys("may be given a script by an option only known when it runs");
          w = scriptOption(args);
          wrapped = true;
          continue;
        }
        if (prog === "trap") {
          if (args[0]?.dynamic) return destroys("runs a script only known when it runs");
          return args[0] && !args[0].text.startsWith("-") ? readScript(args[0].text, depth + 1, cmd.elsewhere) : undefined;
        }
        if (prog === "ssh") {
          const remote = afterOptions(args, SSH_VALUED).slice(1);
          if (remote.some((a) => a.dynamic)) return destroys("runs a remote command only known when it runs");
          return remote.length ? readScript(remote.map((a) => a.text).join(" "), depth + 1, true) : undefined;
        }
        if (prog === "rimraf") return destroys("deletes folders (rimraf)");
        if (prog === "rsync") {
          if (args.some((a) => /^--(del|delete[\w-]*|remove-source-files)(=|$)/.test(a.text))) return destroys("deletes files (rsync --delete)");
          // rsync reads options after its paths too, so any word can be the --delete.
          if (args.some(mayBeOption)) return destroys("rsync with an option only known when it runs");
          return;
        }
        if (prog === "tar") {
          if (args.some((a) => longOf(a.text, ["remove-files", "recursive-unlink"]))) return destroys("deletes the files it archives (tar --remove-files)");
          // BOS-571: --delete removes entries inside the archive; the options below run a command while it archives. Both
          // are matched by name (any unambiguous start, --delet) and after --, and by a word only known when it runs.
          const rm = (t: string) => t === "--" ? false : longOf(t, ["delete"]);
          // -I/-F and --rsh-command run a program (local for -I/-F, remote for --rsh-command), and GNU tar reads options
          // after the file name too, so a dashed one counts in any position (BOS-571 review); the bundled tar cIf is only
          // the first word, so an archive name like Installer.tgz stays allowed.
          const run = (t: string) => t === "--" ? false : longOf(t, ["to-command", "use-compress-program", "info-script", "new-volume-script", "rsh-command"]);
          const dashed = (t: string) => /^-[a-zA-Z]*[IF]/.test(t);
          // --checkpoint-action=exec=CMD runs CMD; only exec does, so other actions are left alone. The option name may
          // be abbreviated (--checkpoint-act=exec), and GNU tar accepts the value as the next word too
          // (--checkpoint-action exec=CMD), so check both forms (BOS-571 review).
          const execAction = (t: string) => {
            if (!t.startsWith("--") || !t.includes("=")) return false;
            if (!longOf(t, ["checkpoint-action"])) return false;
            const value = t.slice(t.indexOf("=") + 1);
            return /^exec(=|$)/.test(value);
          };
          const execActionNext = (i: number) => {
            const t = args[i]!.text;
            if (!longOf(t, ["checkpoint-action"])) return false;
            if (t.includes("=")) return false;
            return /^exec(=|$)/.test(args[i + 1]?.text ?? "");
          };
          // -I PROGRAM runs it (tar -I gzip, and the bundled tar cIf PROGRAM). Only the first word can be that bundle;
          // a later archive name like Installer.tgz is not an option (BOS-571 review). A dashed word in any position is
          // an option, so it is checked everywhere.
          const bundled = (t: string) => t === "--" ? false : /^[a-zA-Z]*[IF]/.test(t);
          if (args.some((a, i) => rm(a.text) || execAction(a.text) || execActionNext(i))) return destroys("deletes files or runs a command while it archives (tar --delete)");
          // A word only known when it runs could be that option, unless it is the value of -f or -C (tar czf "$OUT" dir).
          const valued = (i: number) => i > 0 && (/^(-[a-zA-Z]*[fC]|--file|--directory)$/.test(args[i - 1]!.text) || (i === 1 && /^[a-zA-Z]*f$/.test(args[0]!.text)));
          if ((args[0] && bundled(args[0].text)) || args.some((a) => run(a.text) || dashed(a.text))) return destroys("runs a command while it archives (tar --to-command)");
          if (args.some((a, i) => mayBeOption(a) && !(valued(i) && !a.split && !a.many))) return destroys("tar with an option only known when it runs");
          return;
        }
        if (prog === "zip") {
          if (args.some((a) => /^-[a-zA-Z]*m/.test(a.text) || longOf(a.text, ["move"]))) return destroys("deletes the files it archives (zip -m)");
          // zip reads options after its paths too, like rsync.
          if (args.some(mayBeOption)) return destroys("zip with an option only known when it runs");
          return;
        }

        if (prog === "rm") {
          if (bulk) return destroys("deletes every file fed to it (xargs, find -exec)");
          for (const a of args) {
            const t = a.text;
            if (t === "--") break;
            if (mayBeOption(a)) return destroys("rm with an option only known when it runs");
            // GNU rm accepts any unambiguous start of a long option: --rec is --recursive.
            if (t.startsWith("--") ? longOf(t, ["recursive", "force", "no-preserve-root"]) : /^-[a-zA-Z]*[rRf]/.test(t)) return destroys("deletes folders or forces deletes (rm -r/-f)");
          }
          return;
        }
        if (DELETES.has(prog)) return bulk ? destroys("deletes every file fed to it (xargs, find -exec)") : undefined;
        if (WIPES.has(prog) || /^mkfs(\.|$)/.test(prog)) return destroys(`wipes or overwrites data (${prog})`);
        if (prog === "find") {
          for (let i = 0; i < args.length; i++) {
            const t = args[i]!.text;
            if (t === "-delete") return destroys("deletes what it finds (find -delete)");
            // x=-delete; find . $x, find "$dir" (a path can be -delete too) or find . -name * (a file named -delete).
            // A single word after -name and the like is only that test's value: find . -name "$PAT".
            const a = args[i]!;
            const value = i > 0 && FIND_VALUED.has(args[i - 1]!.text) && !a.split && !a.many;
            if (mayBeOption(a) && !value) return destroys("find with an option only known when it runs");
            if (/^-(exec|execdir|ok|okdir)$/.test(t)) {
              const end = args.findIndex((a, j) => j > i && (a.text === ";" || a.text === "+"));
              judge({ ...cmd, words: args.slice(i + 1, end < 0 ? args.length : end) }, depth, true);
              i = end < 0 ? args.length : end;
            }
          }
          return;
        }
        if (prog === "git") {
          const valued = ["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--config-env"];
          // git -c can set a command git then runs: an alias starting with !, a pager, an editor, a hook path…
          const aliases = new Map<string, string>();
          // -c gc.pruneExpire / gc.reflogExpire* / gc.worktreePruneExpire set to anything but "never" makes a plain gc discard (BOS-954).
          let gcConfigPrunes = false;
          // The gc settings that decide what gc throws away; a subsection (gc.refs/*.reflogExpire) counts too (BOS-1061).
          const GC_KEY = "gc\\.(?:[^=]*\\.)?(?:pruneexpire|reflogexpire\\w*|worktreepruneexpire)";
          const GC_SET = new RegExp(`^${GC_KEY}(=(?!never$)|$)`, "i");
          let configError: string | undefined;
          // One `key=value` setting from -c, --config-env or the GIT_CONFIG_* variables.
          const applySet = (set: string, dynamic: boolean) => {
            if (GC_SET.test(set) || (dynamic && /[$`]/.test(set.split("=")[0]!))) gcConfigPrunes = true;
            const alias = /^alias\.([^=]*)=(.*)$/is.exec(set);
            const m = /^[^=]*\.(fsmonitor|sshcommand|pager|editor|hookspath|cmd|command|program|helper|textconv|clean|smudge|process)=(.*)$/i.exec(set);
            if ((alias || m) && dynamic) configError = "sets a git command only known when it runs";
            else if (alias) aliases.set(alias[1]!.toLowerCase(), alias[2]!);
            else if (m) readScript(m[2]!, depth + 1, cmd.elsewhere);
          };
          for (let i = 0; i < args.length && /^-/.test(args[i]!.text); i++) {
            const t = args[i]!.text;
            if (t === "-c") {
              const setWord = args[++i];
              applySet(setWord?.text ?? "", !!setWord?.dynamic);
            } else if (t === "--config-env" || t.startsWith("--config-env=")) {
              // --config-env=NAME=ENVVAR takes the value from the environment: any value, so it may be "now".
              const word = t === "--config-env" ? args[++i] : undefined;
              const spec = t === "--config-env" ? word?.text ?? "" : t.slice("--config-env=".length);
              const eq = spec.lastIndexOf("=");
              applySet(`${eq < 0 ? spec : spec.slice(0, eq)}=${eq < 0 ? "" : spec.slice(eq + 1)}`, true);
            } else if (valued.includes(t)) i++;
          }
          // GIT_CONFIG_COUNT / KEY_n / VALUE_n and GIT_CONFIG_PARAMETERS set the same things as -c (BOS-1061).
          const envKeys = new Map<string, Word>();
          const envValues = new Map<string, Word>();
          for (const e of envPrefix) {
            const [, name, text] = /^([A-Za-z_]\w*)\+?=(.*)$/s.exec(e.text) ?? [];
            const idx = /^GIT_CONFIG_(KEY|VALUE)_(\d+)$/.exec(name ?? "");
            if (idx) (idx[1] === "KEY" ? envKeys : envValues).set(idx[2]!, { ...e, text: text! });
            else if (name === "GIT_CONFIG_PARAMETERS") {
              for (const p of text!.matchAll(/'([^']*)'(?:='([^']*)')?/g)) applySet(p[2] === undefined ? p[1]! : `${p[1]}=${p[2]}`, e.dynamic);
              if (e.dynamic) applySet("$=", true);
            }
          }
          for (const [n, key] of envKeys) {
            const value = envValues.get(n);
            applySet(`${key.text}=${value?.text ?? ""}`, key.dynamic || !!value?.dynamic);
          }
          // Exported on an earlier line (`export GIT_CONFIG_PARAMETERS=…; git gc`): the value can't be tied to this command,
          // so the setting being there at all goes to the owner.
          if (!envPrefix.some((e) => e.text.startsWith("GIT_CONFIG_")) && new RegExp(`GIT_CONFIG_(?:PARAMETERS|KEY_\\d+)=[^\\n;&|]*${GC_KEY}`, "i").test(whole)) gcConfigPrunes = true;
          if (configError) return destroys(configError);
          const rest = afterOptions(args, valued);
          if (rest[0]?.dynamic) return destroys("runs a git command only known when it runs");
          const sub = rest[0]?.text;
          // An alias set with -c is read with the words given after it: `!rm` + ` -rf x` runs `rm -rf x`; `push` + ` -f` is git push -f.
          // The -c is dropped, so the alias isn't expanded twice. (Aliases already in the repo's config can't be seen.)
          const aliased = sub === undefined ? undefined : aliases.get(sub.toLowerCase());
          if (aliased !== undefined) {
            const extra = rest.slice(1).map((a) => a.text);
            if (aliased.startsWith("!")) return readScript([aliased.slice(1), ...extra].join(" "), depth + 1, cmd.elsewhere);
            w = [first, ...parse(aliased).cmds.flatMap((c) => c.words), ...rest.slice(1)];
            wrapped = true;
            continue;
          }
          for (const value of aliases.values()) if (value.startsWith("!")) readScript(value.slice(1), depth + 1, cmd.elsewhere);
          const opts = rest.slice(1).map((a) => a.text);
          // Also a refspec: git push origin "$b" with b=+main force-pushes.
          const unknownOpt = rest.slice(1).some(mayBeOption);
          // BOS-393: the options before a `--`, the paths after it, and a -f/--force among the options.
          const dashes = opts.indexOf("--");
          const before = dashes < 0 ? opts : opts.slice(0, dashes);
          const paths = dashes < 0 ? [] : opts.slice(dashes + 1);
          const force = before.some((o) => /^-[a-zA-Z]*f/.test(o) || longOf(o, ["force"]));
          // A gc setting that discards, carried by any git command: gc, `maintenance run --task=gc`, or the auto gc that
          // commit, fetch, merge and the like start (BOS-1061).
          if (gcConfigPrunes && sub !== "config") return destroys("discards unreachable commits for good (a gc expire setting other than never)");
          if (sub === "config") {
            // Writing the setting to the repo's config makes a later plain `git gc` discard (BOS-1061). Read, unset and list stay allowed.
            const OPTS_WITH_VALUE = ["-f", "--file", "--blob", "-t", "--type", "--default", "--comment", "--includes"];
            const operands: Word[] = [];
            const given = rest.slice(1);
            for (let i = 0; i < given.length; i++) {
              if (given[i]!.text === "--") continue;
              if (/^-./.test(given[i]!.text)) i += OPTS_WITH_VALUE.includes(given[i]!.text) ? 1 : 0;
              else operands.push(given[i]!);
            }
            const reads = before.some((o) => /^--(get|get-all|get-regexp|get-urlmatch|unset|unset-all|list|edit|remove-section|rename-section)$/.test(o) || /^-[a-z]*l$/.test(o));
            const op = operands[0]?.text;
            const [key, value] = op === "set" ? operands.slice(1) : operands;
            if (!reads && !["get", "unset", "list", "edit"].includes(op ?? "") && key && value) {
              const keyMatches = new RegExp(`^${GC_KEY}$`, "i").test(key.text) || (key.dynamic && /[$`]/.test(key.text));
              if (keyMatches && (value.text !== "never" || value.dynamic)) destroys("sets a gc expire time that discards unreachable commits for good (git config gc.pruneExpire)");
            }
            return;
          }
          if (sub === "push") {
            add("pushes", "pushes to a remote (git push)", all, plain);
            if (unknownOpt || opts.some((o) => /^-[a-zA-Z]*[fd]|^[+:]/.test(o) || longOf(o, ["force", "force-with-lease", "force-if-includes", "mirror", "delete", "prune"]))) destroys("overwrites or deletes on the remote (git push --force/--delete)");
          } else if (sub === "clean" && (unknownOpt || opts.some((o) => /^-[a-zA-Z]*f/.test(o) || longOf(o, ["force"])))) destroys("deletes untracked files (git clean -f)");
          else if (sub === "rm" && (unknownOpt || force)) destroys("deletes files and their unsaved changes (git rm -f)");
          else if (sub === "reset" && (unknownOpt || before.some((o) => longOf(o, ["hard"])))) destroys("throws away uncommitted changes (git reset --hard)");
          else if (sub === "checkout") {
            // `git checkout NAME` can't be told from a branch switch, so it is allowed; paths after `--`, `.`,
            // a second operand (git checkout HEAD~1 src/x.ts) or -f overwrite uncommitted changes.
            const operands = before.filter((o, i) => !o.startsWith("-") && !(i > 0 && ["-b", "-B", "--orphan"].includes(before[i - 1]!)));
            if (unknownOpt || force || paths.length || operands.length > 1 || operands.some((o) => /^(\.\/?|:\/.*)$/.test(o)) || before.some((o) => longOf(o, ["pathspec-from-file"])))
              destroys("overwrites uncommitted changes (git checkout -- paths)");
          } else if (sub === "switch") {
            // -C/--force-create resets an existing branch to the start point, unlike -c (BOS-571).
            if (unknownOpt || force || before.some((o) => shortHas(o, "C") || longOf(o, ["discard-changes", "force-create"])))
              destroys("throws away uncommitted changes or overwrites an existing branch (git switch -C/--discard-changes)");
          } else if (sub === "restore") {
            // Only restoring the index (--staged without --worktree) keeps the files as they are.
            const staged = before.some((o) => shortHas(o, "S") || longOf(o, ["staged"]));
            const worktree = before.some((o) => shortHas(o, "W") || longOf(o, ["worktree"]));
            if (unknownOpt || !staged || worktree) destroys("overwrites uncommitted changes (git restore)");
          } else if (sub === "stash") {
            const op = afterOptions(rest.slice(1))[0];
            if (op?.dynamic || op?.text === "drop" || op?.text === "clear") destroys("throws away saved changes (git stash drop/clear)");
          } else if (sub === "branch") {
            const del = before.some((o) => shortHas(o, "d") || longOf(o, ["delete"]));
            // -C (and its long form) overwrites an existing branch; lowercase -c only copies or creates one (BOS-571).
            const overwrite = before.some((o) => shortHas(o, "C") || longOf(o, ["force-create"]));
            if (unknownOpt || overwrite || before.some((o) => shortHas(o, "D")) || (del && force)) destroys("deletes or overwrites a branch that may not be merged (git branch -D/-C)");
          } else if (sub === "worktree") {
            // Removing a worktree deletes its files, with -f or not (BOS-571). prune only drops metadata of worktrees
            // whose directories are already gone, so it is left alone.
            const op = afterOptions(rest.slice(1))[0];
            if (op?.dynamic || op?.text === "remove") destroys("deletes a worktree's files (git worktree remove)");
          } else if (sub === "update-ref") {
            // -d deletes the ref, and with it the only pointer to the commits it held (BOS-571). --stdin reads the
            // commands from input, which can't be seen, and an all-zero new value deletes the ref (git update-ref x
            // 0000…) (BOS-571 review), so both go to the owner too.
            const words = afterOptions(rest.slice(1));
            if (unknownOpt || before.some((o) => shortHas(o, "d") || longOf(o, ["delete"]))) destroys("deletes a ref (git update-ref -d)");
            else if (args.some((a) => longOf(a.text, ["stdin"])) || words.some((a) => a.text === "--stdin" || /^0+$/.test(a.text))) destroys("deletes or rewrites a ref the checker can't read (git update-ref --stdin/zero)");
          } else if (sub === "reflog") {
            // expire (and delete) throw away the reflogs that make a lost commit recoverable (BOS-571).
            const op = afterOptions(rest.slice(1))[0];
            if (op?.dynamic || op?.text === "expire" || op?.text === "delete") destroys("expires the reflogs that make resets recoverable (git reflog expire)");
          } else if (sub === "gc") {
            // --prune=<date> reaches the unreachable objects a reset or branch -D left behind, so it can't be undone
            // whatever the date (=now, =all, =1.second.ago); only --prune=never leaves them. A bare --prune prunes the
            // default two weeks. An option only known when it runs could be that one. A plain gc, --auto and --quiet
            // leave them alone (BOS-571).
            // git takes any unambiguous start of --prune (--pru=now), and `-c gc.pruneExpire=now` does the same (BOS-954).
            const prunesNow = before.some((o) => longOf(o, ["prune"]) && !/^--[^=]*=never$/.test(o));
            if (unknownOpt || prunesNow || gcConfigPrunes) destroys("discards unreachable commits for good (git gc --prune=now)");
          } else if (sub === "prune") {
            // The standalone `git prune` discards unreachable objects just as gc --prune does (BOS-571 review).
            if (!before.some((o) => longOf(o, ["dry-run"]))) destroys("discards unreachable commits for good (git prune)");
          }
          return;
        }
        if (prog === "docker" || prog === "podman") {
          const rest = afterOptions(args, ["-H", "--host", "--context", "-c", "--config", "-l", "--log-level"]);
          const [a, b] = [rest[0]?.text, afterOptions(rest.slice(1))[0]?.text];
          const group = /^(system|volume|container|image|network|builder)$/.test(a ?? "");
          if (rest[0]?.dynamic || (group && afterOptions(rest.slice(1))[0]?.dynamic)) return destroys(`runs a ${prog} command only known when it runs`);
          if (a === "rm" || a === "rmi" || (/^(system|volume|container|image|network|builder)$/.test(a ?? "") && (b === "prune" || b === "rm"))) destroys(`removes containers, images or volumes (${prog} ${a})`);
          if (a === "push" || (a === "image" && b === "push")) add("pushes", `publishes an image (${prog} push)`, all, plain);
          // docker exec/run, docker container exec/run and docker compose exec/run: see `inside` above.
          const runAt = a === "exec" || a === "run" ? 0 : a === "container" || a === "compose" ? rest.findIndex((x, i) => i > 0 && (x.text === "exec" || x.text === "run")) : -1;
          if (runAt >= 0) inside(rest.slice(runAt + 1));
          return;
        }
        if (prog === "kubectl") {
          const cmdWords = afterOptions(args, KUBE_VALUED);
          if (cmdWords[0]?.dynamic) return destroys("runs a kubectl command only known when it runs");
          const at = args.findIndex((a) => a.text === "exec" || a.text === "delete");
          if (args[at]?.text === "delete") return destroys("deletes cluster resources (kubectl delete)");
          // BOS-571: --prune deletes what the manifests no longer list; replace --force deletes and recreates an object.
          const verb = cmdWords[0]?.text;
          if (verb === "apply" && args.some((a) => longOf(a.text, ["prune"]) || a.text.startsWith("--prune-"))) return destroys("deletes resources missing from the manifests (kubectl apply --prune)");
          if (verb === "replace" && args.some((a) => longOf(a.text, ["force"]))) return destroys("deletes and recreates a resource (kubectl replace --force)");
          // kubectl exec runs a command in a pod: see `inside` above.
          if (at >= 0) inside(args.slice(at + 1));
          return;
        }
        if (prog === "terraform" || prog === "tofu") {
          // terraform destroy, and apply/plan -destroy, delete the infrastructure the state describes (BOS-571).
          const cmdWords = afterOptions(args, ["-chdir", "-var", "-var-file", "--var", "--var-file"]);
          const verb = cmdWords[0];
          if (verb?.dynamic) return destroys("runs a terraform command only known when it runs");
          // state push overwrites the remote state with a local file, with -force even when the lineage or serial is older (BOS-1061).
          if (verb?.text === "state") {
            const op = afterOptions(cmdWords.slice(1))[0];
            if (op?.dynamic || op?.text === "push") return destroys("overwrites the stored infrastructure state (terraform state push)");
          }
          if (verb?.text === "destroy") return destroys("destroys the infrastructure it manages (terraform destroy)");
          if (verb?.text === "apply" && args.some((a) => /^-{1,2}destroy(=true)?$/.test(a.text))) return destroys("destroys the infrastructure it manages (terraform apply -destroy)");
          return;
        }
        if (prog === "pulumi") {
          const verb = afterOptions(args, ["-C", "--cwd", "--stack", "-s"]).find((a) => !a.text.startsWith("-"));
          if (verb?.dynamic) return destroys("runs a pulumi command only known when it runs");
          if (verb?.text === "destroy" || verb?.text === "down" || verb?.text === "dn") return destroys("destroys the infrastructure it manages (pulumi destroy)");
          return;
        }
        if (prog === "helm") {
          // uninstall (and its aliases del, delete, un) deletes the release's resources (BOS-571).
          const verb = afterOptions(args, ["-n", "--namespace", "--kube-context", "--kubeconfig"]).find((a) => !a.text.startsWith("-"));
          if (verb?.dynamic) return destroys("runs a helm command only known when it runs");
          if (verb && ["uninstall", "del", "delete", "un"].includes(verb.text)) return destroys("deletes a release's resources (helm uninstall)");
          return;
        }
        if (prog === "gcloud") {
          // gcloud GROUP … delete: strip the global options and look for `delete` among the command's own words (BOS-571).
          const words = gcloudWords(args);
          if (words.some((a) => a.dynamic)) return destroys("runs a gcloud command only known when it runs");
          // A bare `delete` anywhere (even where an option was thought to take it as a value) is never a value in
          // gcloud, so flag it: a wrong entry in the value list can then only over-flag, never miss a delete.
          if (words.some((a) => a.text === "delete") || args.some((a) => !a.dynamic && a.text === "delete")) return destroys("deletes cloud resources (gcloud … delete)");
          // gcloud storage mv copies, then removes the source objects (BOS-1061).
          if (words.some((a) => a.text === "mv")) return destroys("removes the source after copying (gcloud storage mv)");
          return;
        }
        if (prog === "gsutil") {
          // gsutil [-m] [-h header] [-o section:key=value] mv … removes the source after copying (BOS-1061).
          const verb = afterOptions(args, ["-h", "-o", "-u", "-i"])[0];
          if (verb?.dynamic) return destroys("runs a gsutil command only known when it runs");
          if (verb?.text === "mv") return destroys("removes the source after copying (gsutil mv)");
          return;
        }
        if (prog === "az") {
          // az GROUP … delete: same shape as gcloud (BOS-571).
          const words = gcloudWords(args);
          if (words.some((a) => a.dynamic)) return destroys("runs an az command only known when it runs");
          if (words.some((a) => a.text === "delete") || args.some((a) => !a.dynamic && a.text === "delete")) return destroys("deletes cloud resources (az … delete)");
          // --mode Complete makes a deployment delete every resource in the group that the template doesn't list (BOS-1061).
          // az (Python argparse) takes any unambiguous start of the option, and the value from the next word or after =.
          for (let i = 0; i < args.length; i++) {
            const t = args[i]!.text;
            if (!t.startsWith("--") || !longOf(t, ["mode"]) || t.length < 4) continue;
            const value = t.includes("=") ? { text: t.slice(t.indexOf("=") + 1), dynamic: args[i]!.dynamic } : args[i + 1];
            if (value && (value.dynamic || /^complete$/i.test(value.text))) return destroys("deletes resources the template doesn't list (az deployment … --mode Complete)");
          }
          return;
        }
        if (prog === "aws") {
          const cmdWords = afterOptions(args, AWS_VALUED);
          const service = cmdWords[0];
          const op = afterOptions(cmdWords.slice(1), AWS_VALUED)[0];
          if (service?.dynamic || op?.dynamic) return destroys("runs an aws command only known when it runs");
          const has = (o: string) => cmdWords.some((x) => x.text === o);
          // An S3 object delete can't be undone unless the bucket keeps versions, so every `s3 rm` goes to the owner.
          // s3 mv copies, then deletes the source object (BOS-1061).
          if (service?.text === "s3" && (op?.text === "rm" || op?.text === "mv" || (op?.text === "rb" && has("--force")) || (op?.text === "sync" && has("--delete")))) return destroys(`deletes in the cloud (aws s3 ${op.text})`);
          if (service?.text === "s3" && /^(rb|sync)$/.test(op?.text ?? "") && cmdWords.some(mayBeOption)) return destroys("aws s3 with an option only known when it runs");
          if (op && /^(delete|terminate)-/.test(op.text)) return destroys(`deletes in the cloud (aws ${service!.text} ${op.text})`);
          return;
        }
        if (prog === "gh") {
          const words = afterOptions(args, ["-R", "--repo", "--hostname"]);
          const group = words[0];
          const op = afterOptions(words.slice(1), ["-R", "--repo"])[0];
          if (group?.dynamic || op?.dynamic) return destroys("runs a gh command only known when it runs");
          // gh repo delete, gh release delete(-asset), gh gist delete, gh secret delete…
          if (op && /^delete(-|$)/.test(op.text)) return destroys(`deletes on GitHub (gh ${group!.text} ${op.text})`);
          if (group?.text === "api") {
            for (let i = 0; i < args.length; i++) {
              const t = args[i]!.text;
              const method = t === "-X" || t === "--method" ? args[i + 1] : /^-X./.test(t) ? { ...args[i]!, text: t.slice(2) } : t.startsWith("--method=") ? { ...args[i]!, text: t.slice(9) } : undefined;
              if (method && (method.dynamic || /^delete$/i.test(method.text))) return destroys("deletes on GitHub (gh api -X DELETE)");
            }
          }
          return;
        }
        if (prog === "dropdb" || prog === "dropuser") return destroys(`deletes a database or role (${prog})`);
        if (prog === "mysqladmin" && args.some((a) => a.dynamic || /^drop$/i.test(a.text))) return destroys("deletes a database (mysqladmin drop)");
        const sql = SQL_CLIENTS[prog];
        if (sql) {
          const code: Word[] = [];
          const operands: Word[] = [];
          let fromFile = false;
          let fromSub = false;
          let fromStream = false;
          for (let i = 0; i < args.length; i++) {
            const a = args[i]!;
            const t = a.text;
            const eq = t.indexOf("=");
            const name = t.startsWith("--") && eq > 0 ? t.slice(0, eq) : t;
            const value = (): Word | undefined => (name !== t ? { ...a, text: t.slice(eq + 1) } : args[++i]);
            if (sql.code.includes(name)) {
              const v = value();
              if (v) code.push(v);
            } else if (sql.file.includes(name)) {
              const v = value();
              if (v && PROC_SUB.test(v.text)) fromSub = true;
              else if (v && STREAM_PATH.test(v.text)) fromStream = true;
              else fromFile = true;
            } else if (sql.valued.includes(t)) i++;
            else if (prog !== "sqlite3" && prog !== "sqlite" && /^-[a-zA-Z]/.test(t)) {
              // A short cluster holding the code option: -c"drop …", -qc "drop …". A letter that takes a value
              // (-hlocalhost, mysql's -psecret) ends the cluster: the rest is that value.
              const letter = sql.code[0]!.slice(1);
              const valuedLetters = sql.valued.filter((v) => /^-[a-zA-Z]$/.test(v)).map((v) => v[1]!).join("") + (prog === "psql" ? "" : "p");
              for (let j = 1; j < t.length; j++) {
                if (t[j] === letter) {
                  const v = j + 1 < t.length ? { ...a, text: t.slice(j + 1) } : args[++i];
                  if (v) code.push(v);
                  break;
                }
                if (valuedLetters.includes(t[j]!)) break;
              }
            } else if (!t.startsWith("-")) operands.push(a);
          }
          // sqlite3 DB SQL…: the words after the database are SQL.
          if (prog === "sqlite3" || prog === "sqlite") code.push(...operands.slice(1));
          const readsStdin = (!code.length && !fromFile) || fromStream;
          if (readsStdin) code.push(...cmd.stdin);
          // SQL piped in, made by <( ) or built from variables may come from elsewhere in the command, so read all of it.
          const unseen = fromSub || cmd.procIn || (readsStdin && !cmd.stdin.length && cmd.piped) || code.some((a) => a.dynamic);
          const text = unseen ? flat : code.map((a) => a.text).join("\n");
          if (SQL_DESTROYS.test(text)) return destroys(`runs SQL that deletes data or runs a program (${prog})`);
          return;
        }
        if (prog === "redis-cli") {
          const op = afterOptions(args, REDIS_VALUED)[0];
          if (op?.dynamic) return destroys("runs a redis command only known when it runs");
          const piped = !op && !cmd.stdin.length && (cmd.piped || cmd.procIn);
          const text = piped || cmd.stdin.some((a) => a.dynamic) ? flat : [...args, ...cmd.stdin].map((a) => a.text).join(" ");
          if (/\bflush(all|db)\b/i.test(text)) return destroys("empties a redis database (FLUSHALL/FLUSHDB)");
          return;
        }
        if ((prog === "zfs" || prog === "zpool") && args.some((a) => a.text === "destroy")) return destroys(`destroys a dataset or pool (${prog} destroy)`);
        if ((prog === "zfs" || prog === "zpool") && afterOptions(args)[0]?.dynamic) return destroys(`runs a ${prog} command only known when it runs`);
        if (/^(npm|pnpm|yarn)$/.test(prog) && args.some((a) => a.text === "publish")) return add("pushes", `publishes a package (${prog} publish)`, all, plain);

        if (prog === "sed") {
          // GNU sed reads options anywhere before `--`. -i takes an optional suffix joined to it (-i.bak, and -ie
          // means suffix "e"); -e, -f and -l take a value, joined or as the next word.
          const scripts: Word[] = [];
          const operands: Word[] = [];
          let inPlace = false;
          let scriptGiven = false;
          let follow = false;
          let fileScript = false;
          let dashes = false;
          for (let i = 0; i < args.length; i++) {
            const a = args[i]!;
            const t = a.text;
            if (dashes || !/^-./.test(t)) {
              operands.push(a);
              continue;
            }
            if (t === "--") dashes = true;
            else if (t.startsWith("--")) {
              const eq = t.indexOf("=");
              const value = (): Word | undefined => (eq > 0 ? { ...a, text: t.slice(eq + 1) } : args[++i]);
              if (longOf(t, ["in-place"])) inPlace = true;
              else if (longOf(t, ["follow-symlinks"])) follow = true;
              else if (longOf(t, ["expression"])) {
                scriptGiven = true;
                const v = value();
                if (v) scripts.push(v);
              } else if (longOf(t, ["file"])) {
                scriptGiven = true;
                fileScript = true;
                const v = value();
                if (v && (PROC_SUB.test(v.text) || STREAM_PATH.test(v.text))) return destroys("runs a sed script made when it runs");
              } else if (longOf(t, ["line-length"]) && eq < 0) i++;
            } else {
              for (let j = 1; j < t.length; j++) {
                const c = t[j]!;
                if (c === "i") {
                  inPlace = true;
                  break;
                }
                if (c === "e" || c === "f" || c === "l") {
                  const v = j + 1 < t.length ? { ...a, text: t.slice(j + 1) } : args[++i];
                  if (c !== "l") scriptGiven = true;
                  if (c === "f") fileScript = true;
                  if (c === "e" && v) scripts.push(v);
                  if (c === "f" && v && (PROC_SUB.test(v.text) || STREAM_PATH.test(v.text))) return destroys("runs a sed script made when it runs");
                  break;
                }
              }
            }
          }
          if (!scriptGiven && operands.length) scripts.push(operands.shift()!);
          if (scripts.some((s) => SED_EXEC.test(s.text))) return destroys("runs a shell command from a sed script (sed e)");
          // `sed -i '<script>' /dev/null` (or no file) changes nothing unless the script writes (w/W) or runs (e, checked
          // above) or comes from a file (-f), so the rest of the command is judged on its own (BOS-680).
          const nothingToEdit = !wrapped && !bulk && !fileScript && !scripts.some((s) => SED_WRITES.test(s.text)) && operands.every((o) => o.text === "/dev/null" && !o.dynamic);
          if (inPlace && !nothingToEdit) editsInPlace(follow ? [] : operands, "edits files outside the working copy and /tmp (sed -i)");
          if (inPlace && follow) destroys("edits files through symlinks (sed -i --follow-symlinks)");
          return;
        }
        if (/^perl[\d.]*$/.test(prog)) {
          // perl's switches end at the first word that isn't one; -i takes an optional suffix joined to it (-pi.bak;
          // -pie means suffix "e"), and -e/-E take the next word, -I/-M/-m/-l/-0/-x/-d/-C/-F a joined value.
          const edit = inPlaceSwitches(args, "IE0lIMmxdCF");
          // Without -e the first word left is the script file; the rest are the files edited.
          if (edit.inPlace) editsInPlace(args.slice(edit.code ? edit.end : edit.end + 1), "edits files outside the working copy and /tmp (perl -i)");
        }
        if (/^ruby[\d.]*$/.test(prog)) {
          // ruby reads a script from a file or -e code and edits its files in place with -i[SUFFIX]; its switches end
          // at the first word that isn't one (the script file, unless -e was given), as perl's do (BOS-571).
          // -r/-I/-C/-E take a value (joined or the next word; -E is an encoding, not code), so their value must not
          // be read as a switch cluster: `ruby -rdate -i …` and `ruby -Fe -i …` still see the -i. But -F/-K/-W/-T/-x
          // take their value joined only (-Fe, never `-F e`), so a word after them is the next switch: `ruby -W -i`
          // is the -i (BOS-571 security review round 2).
          // ruby also has long options (--encoding, --external-encoding, --internal-encoding) whose value is the next
          // word, and --inplace is its long form of -i; an unknown long option could hide a following -i too.
          const edit = inPlaceSwitches(args, "0lFKWTx", "rICE", "e", ["--encoding", "--external-encoding", "--internal-encoding"]);
          // -C/--chdir changes the directory before the files resolve, so a relative path no longer names a file in
          // the checkout; its base is unknown, so a -i edit goes to the owner (BOS-571 review).
          const chdirs = args.slice(0, edit.end).some((a) => a.text === "-C" || a.text === "--chdir" || /^-C./.test(a.text) || /^--chdir=/.test(a.text));
          // An unknown long option stops the read, so a -i after it can't be shown absent: send it to the owner.
          if (edit.unknownLong) destroys("edits files outside the working copy and /tmp (ruby -i after an unknown long option)");
          // Without -e the first word left is the script file; the rest are the files edited.
          else if (edit.inPlace && chdirs) destroys("edits files outside the working copy and /tmp (ruby -C with -i)");
          else if (edit.inPlace) editsInPlace(args.slice(edit.code ? edit.end : edit.end + 1), "edits files outside the working copy and /tmp (ruby -i)");
        }

        if (SHELLS.has(prog)) {
          let i = 0;
          let inline = false;
          let stdin = false;
          for (; i < args.length && /^[-+]./.test(args[i]!.text); i++) {
            const t = args[i]!.text;
            if (t === "--") {
              i++;
              break;
            }
            if (/^-[a-zA-Z]*c/.test(t)) inline = true;
            if (/^-[a-zA-Z]*s/.test(t)) stdin = true;
            if (["-o", "+o", "-O", "+O", "--rcfile", "--init-file"].includes(t)) i++;
          }
          const script = args[i];
          if (inline) {
            if (!script) return;
            if (script.dynamic) return destroys("runs a script only known when it runs");
            return readScript(script.text, depth + 1, cmd.elsewhere);
          }
          // x=-c; bash $x 'rm -rf /x'
          if (unknownMode(args)) return destroys("runs a shell whose options are only known when it runs");
          if (script && streamed(script)) return;
          if (script && !stdin) return; // runs a script file (see the shortcut at the top)
          return readStream();
        }
        // `source FILE` and `. FILE` run a script in this shell (BOS-393): read it like a shell's script.
        if (prog === "source" || prog === ".") {
          const script = args[0]?.text === "--" ? args[1] : args[0];
          if (script) streamed(script);
          return; // otherwise a script file (see the shortcut at the top)
        }
        if (prog === "eval") {
          if (args.some((a) => a.dynamic)) return destroys("runs text only known when it runs (eval)");
          return readScript(args.map((a) => a.text).join(" "), depth + 1, cmd.elsewhere);
        }
        if (prog === "alias") {
          for (const a of args) if (a.text.includes("=")) readScript(a.text.slice(a.text.indexOf("=") + 1), depth + 1, cmd.elsewhere);
          return;
        }
        const inline = INLINE.find(([p]) => p.test(prog))?.[1];
        if (inline) {
          const opts = args.filter((a) => a.text.startsWith("-") || prog === "deno");
          const isInline = prog.endsWith("awk") ? !args.some((a) => /^-[a-zA-Z]*f/.test(a.text)) : opts.some((a) => inline.test(a.text));
          // x=-c; python3 $x '…'
          if (!isInline && unknownMode(args)) return destroys(`runs ${prog} with options only known when they run`);
          // BOS-393: python3 /dev/stdin <<< '…' or python3 <(curl …) reads its code from the input stream or from code
          // made when it runs. Any such word counts, since which word is the script can't be told for every
          // interpreter: `python3 x.py <(git log)` asks needlessly.
          const stream = isInline ? undefined : args.find((a) => PROC_SUB.test(a.text) || STREAM_PATH.test(a.text));
          if (stream && PROC_SUB.test(stream.text)) return destroys(`runs ${prog} code made when it runs (<( ))`);
          const reads = isInline || !!stream || !args.some((a) => !a.text.startsWith("-"));
          if (!reads) return; // runs a script file
          if (!isInline && cmd.procIn) return destroys(`runs ${prog} code made when it runs (< <( ))`);
          const code = isInline ? args : cmd.stdin;
          // Code built from variables may come from elsewhere in the command, so read all of it; a pipe gives no code to read.
          const text = code.some((a) => a.dynamic) || (!isInline && !cmd.stdin.length) ? flat : code.map((a) => a.text).join(" ");
          if (!isInline && !cmd.stdin.length && !cmd.piped) return;
          if (CODE_DELETES.test(text) || CODE_HIDDEN.test(text)) return destroys(`runs ${prog} code that deletes files or hides what it runs`);
        }
        return;
      }
      add("destroys", "too many wrapping programs to read", w, false);
    }

    for (const c of top.cmds) judge(c, 0, false);
  } catch {
    risks.push({ kind: "destroys", why: "Boss Man couldn't read this command", text: String(command), plain: false });
  }
  return risks;
}
