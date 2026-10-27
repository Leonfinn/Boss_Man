// Which parts of a shell command destroy data or push it out (BOS-116). The built-in owner rules
// used to look for text such as `rm -rf`, so the same delete written another way ("r"m, r\m, a line
// continuation, --recursive, find -delete, xargs rm, a python one-liner) ran with no one asked.
// This reads the command the way the shell would: it undoes quotes, escapes and continuations,
// splits it into the commands it runs (including $( ), backticks, sh -c and eval), and decides by
// each command's program and options.
//
// shortcut: a script file the command runs (`bash x.sh`, `python x.py`) isn't read: Boss Man judges
// the command text, not the runner's files. Code inside an interpreter one-liner is matched against
// a word list, which a deliberate attacker can beat; closing both needs a sandbox on the runner.

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
  /** Has quotes or escapes in it. */
  quoted: boolean;
};

type Cmd = { words: Word[]; stdin: Word[]; piped: boolean; nested: boolean };

const MAX_DEPTH = 6;
const KEYWORDS = new Set("if then else elif fi do done while until for case esac select ! { } coproc function".split(" "));
const SHELLS = new Set("sh bash zsh dash ksh mksh ash fish".split(" "));
const WIPES = new Set("shred truncate wipefs dd mke2fs mkswap blkdiscard sfdisk".split(" "));
const DELETES = new Set(["rm", "rmdir", "unlink"]);

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
    let quoted = false;
    let brace = false;
    let glob = false;
    let redirect: null | "file" | "here" = null;
    const heredocs: Array<{ delim: string; strip: boolean; expand: boolean; cmd: Cmd }> = [];

    const expansion = () => {
      if (!started) lead = true;
      dynamic = started = true;
    };
    const endWord = () => {
      if (!started) return;
      if (brace && /\{[^{}]*(,|\.\.)[^{}]*\}/.test(word)) dynamic = true;
      // [ on its own (the test command) isn't a pattern; [ab] is.
      if (glob && /[*?]|\[.*\]/.test(word)) dynamic = true;
      const w: Word = { text: word, dynamic, lead, quoted };
      if (redirect === "here") cmd.stdin.push(w);
      else if (redirect === "file") {
        // A redirect's target isn't one of the command's words.
      } else if (!(cmd.words.length === 0 && !quoted && KEYWORDS.has(word))) cmd.words.push(w);
      redirect = null;
      word = "";
      started = dynamic = lead = quoted = brace = glob = false;
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
        h.cmd.stdin.push({ text: body, dynamic: expands, lead: false, quoted: false });
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
          expansion();
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

const plainWords = (texts: string[]): Word[] => texts.map((text) => ({ text, dynamic: false, lead: false, quoted: false }));

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
  nice: ["-n", "--adjustment"],
  nohup: [],
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
};
// Programs given a shell command as an option's value (su -c, flock -c, script -qc, npx -c), and what they run without one.
const SCRIPT_OPTION: Record<string, (args: Word[]) => Word[]> = {
  su: () => [],
  runuser: (args) => afterOptions(args, ["-u", "-g", "-G", "--user", "--group"]),
  flock: (args) => afterOptions(args, ["-w", "--timeout", "-E", "--conflict-exit-code"]).slice(1),
  script: () => [],
  npx: (args) => afterOptions(args, ["-p", "--package"]),
};
// ssh's options that take a value; the words after the host are a command for the remote shell.
const SSH_VALUED = "-B -b -c -D -E -e -F -I -i -J -L -l -m -O -o -p -Q -R -S -W -w".split(" ");

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
  [/^[gmn]?awk$/, /^/],
];
// Words in interpreter code that delete files, or that run or build code Boss Man can't read.
const CODE_DELETES = /\b(rm|rm_r|rm_rf|rm_f|rmdir\w*|rmtree|rmSync|remove\w*|unlink\w*|truncate\w*|shred|delete_file|File\.delete|FileUtils)\b/;
const CODE_HIDDEN = /\b(exec\w*|spawn\w*|eval|system|popen\w*|subprocess|child_process|qx|__import__|importlib|getattr|globals|compile|Function|b64decode|atob|fromCharCode|chr|unhexlify|fromhex)\b|`/;

/**
 * What in a shell command destroys data or pushes it out. A command given as an argv array
 * (["bash", "-lc", "…"]) is read as those words; a string is read the way the shell reads it.
 * A command Boss Man can't read (unbalanced quotes, nesting too deep, an error) counts as destroying.
 */
export function commandRisks(command: string | string[]): Risk[] {
  const risks: Risk[] = [];
  try {
    const top = typeof command === "string" ? parse(command) : { cmds: [{ words: plainWords(command), stdin: [], piped: false, nested: false }], unparsed: false };
    const flat = top.cmds.flatMap((c) => [...c.words, ...c.stdin].map((w) => w.text)).join(" ");
    if (top.unparsed) risks.push({ kind: "destroys", why: "Boss Man couldn't read this command", text: typeof command === "string" ? command : command.join(" "), plain: false });

    const add = (kind: Risk["kind"], why: string, words: Word[], plain: boolean) => risks.push({ kind, why, text: words.map((w) => w.text).join(" "), plain });
    const readScript = (script: string, depth: number) => {
      if (depth > MAX_DEPTH) return add("destroys", "commands nested too deeply to read", [], false);
      const p = parse(script);
      if (p.unparsed) add("destroys", "Boss Man couldn't read a script it runs", plainWords([script]), false);
      for (const c of p.cmds) judge({ ...c, nested: true }, depth, false);
    };

    function judge(cmd: Cmd, depth: number, bulk: boolean) {
      let w = cmd.words;
      let wrapped = false;
      for (let hops = 0; hops < 12; hops++) {
        while (w.length && /^[A-Za-z_]\w*\+?=/.test(w[0]!.text)) w = w.slice(1);
        const first = w[0];
        if (!first) return;
        const all = w;
        const plain = !cmd.nested && !wrapped && !bulk && all.every((x) => !x.dynamic && !x.quoted);
        const destroys = (why: string) => add("destroys", why, all, plain);
        if (first.dynamic) return destroys("runs a program whose name is only known when it runs");
        const prog = first.text.split("/").pop()!;
        const args = w.slice(1);

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
            return readScript([text, ...args.slice(split + 2).map((x) => x.text)].join(" "), depth + 1);
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
          return readScript(rest.map((x) => x.text).join(" "), depth + 1);
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
        const scriptOption = SCRIPT_OPTION[prog];
        if (scriptOption) {
          const at = args.findIndex((a) => /^(-[a-zA-Z]*c|--command|--call)$/.test(a.text) || /^--(command|call)=/.test(a.text));
          if (at >= 0) {
            const a = args[at]!;
            const script = a.text.includes("=") ? { ...a, text: a.text.slice(a.text.indexOf("=") + 1) } : args[at + 1];
            if (script?.dynamic) return destroys("runs a script only known when it runs");
            return script ? readScript(script.text, depth + 1) : undefined;
          }
          w = scriptOption(args);
          wrapped = true;
          continue;
        }
        if (prog === "trap") {
          if (args[0]?.dynamic) return destroys("runs a script only known when it runs");
          return args[0] && !args[0].text.startsWith("-") ? readScript(args[0].text, depth + 1) : undefined;
        }
        if (prog === "ssh") {
          const remote = afterOptions(args, SSH_VALUED).slice(1);
          if (remote.some((a) => a.dynamic)) return destroys("runs a remote command only known when it runs");
          return remote.length ? readScript(remote.map((a) => a.text).join(" "), depth + 1) : undefined;
        }
        if (prog === "rimraf") return destroys("deletes folders (rimraf)");
        if (prog === "rsync" && args.some((a) => /^--(del|delete[\w-]*|remove-source-files)(=|$)/.test(a.text))) return destroys("deletes files (rsync --delete)");

        if (prog === "rm") {
          if (bulk) return destroys("deletes every file fed to it (xargs, find -exec)");
          for (const a of args) {
            const t = a.text;
            if (t === "--") break;
            if (a.lead) return destroys("rm with an option only known when it runs");
            const long = /^--([^=]+)/.exec(t)?.[1];
            // GNU rm accepts any unambiguous start of a long option: --rec is --recursive.
            if (long ? ["recursive", "force", "no-preserve-root"].some((o) => o.startsWith(long)) : /^-[a-zA-Z]*[rRf]/.test(t)) return destroys("deletes folders or forces deletes (rm -r/-f)");
          }
          return;
        }
        if (DELETES.has(prog)) return bulk ? destroys("deletes every file fed to it (xargs, find -exec)") : undefined;
        if (WIPES.has(prog) || /^mkfs(\.|$)/.test(prog)) return destroys(`wipes or overwrites data (${prog})`);
        if (prog === "find") {
          for (let i = 0; i < args.length; i++) {
            const t = args[i]!.text;
            if (t === "-delete") return destroys("deletes what it finds (find -delete)");
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
          for (let i = 0; i < args.length && /^-/.test(args[i]!.text); i++) {
            if (args[i]!.text !== "-c") {
              if (valued.includes(args[i]!.text)) i++;
              continue;
            }
            const set = args[++i]?.text ?? "";
            const m = /^(alias\.[^=]*|[^=]*\.(fsmonitor|sshcommand|pager|editor|hookspath|cmd|command|program|helper|textconv|clean|smudge|process))=(.*)$/i.exec(set);
            if (m) readScript(m[3]!.replace(/^!/, ""), depth + 1);
          }
          const rest = afterOptions(args, valued);
          const sub = rest[0]?.text;
          const opts = rest.slice(1).map((a) => a.text);
          if (sub === "push") {
            add("pushes", "pushes to a remote (git push)", all, plain);
            if (opts.some((o) => /^-[a-zA-Z]*[fd]|^--(force|mirror|delete|prune)|^[+:]/.test(o))) destroys("overwrites or deletes on the remote (git push --force/--delete)");
          } else if (sub === "clean" && opts.some((o) => /^-[a-zA-Z]*f|^--force$/.test(o))) destroys("deletes untracked files (git clean -f)");
          return;
        }
        if (prog === "docker" || prog === "podman") {
          const rest = afterOptions(args, ["-H", "--host", "--context", "-c", "--config", "-l", "--log-level"]);
          const [a, b] = [rest[0]?.text, afterOptions(rest.slice(1))[0]?.text];
          if (a === "rm" || a === "rmi" || (/^(system|volume|container|image|network|builder)$/.test(a ?? "") && (b === "prune" || b === "rm"))) destroys(`removes containers, images or volumes (${prog} ${a})`);
          if (a === "push" || (a === "image" && b === "push")) add("pushes", `publishes an image (${prog} push)`, all, plain);
          return;
        }
        if ((prog === "zfs" || prog === "zpool") && args.some((a) => a.text === "destroy")) return destroys(`destroys a dataset or pool (${prog} destroy)`);
        if (/^(npm|pnpm|yarn)$/.test(prog) && args.some((a) => a.text === "publish")) return add("pushes", `publishes a package (${prog} publish)`, all, plain);

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
            return readScript(script.text, depth + 1);
          }
          if (script && !stdin) return; // runs a script file (see the shortcut at the top)
          for (const body of cmd.stdin) {
            if (body.dynamic) return destroys("runs a script only known when it runs");
            readScript(body.text, depth + 1);
          }
          if (!cmd.stdin.length && cmd.piped) destroys("runs commands piped into it");
          return;
        }
        if (prog === "eval") {
          if (args.some((a) => a.dynamic)) return destroys("runs text only known when it runs (eval)");
          return readScript(args.map((a) => a.text).join(" "), depth + 1);
        }
        if (prog === "alias") {
          for (const a of args) if (a.text.includes("=")) readScript(a.text.slice(a.text.indexOf("=") + 1), depth + 1);
          return;
        }
        const inline = INLINE.find(([p]) => p.test(prog))?.[1];
        if (inline) {
          const opts = args.filter((a) => a.text.startsWith("-") || prog === "deno");
          const isInline = prog.endsWith("awk") ? !args.some((a) => /^-[a-zA-Z]*f/.test(a.text)) : opts.some((a) => inline.test(a.text));
          const reads = isInline || !args.some((a) => !a.text.startsWith("-"));
          if (!reads) return; // runs a script file
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
