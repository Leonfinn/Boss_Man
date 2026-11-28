/**
 * BOS-2856. The standing rule says agents write files with their file tools, never with shell one-liners. When one does anyway
 * (`echo ... >> run.sh`, `printf ... | tee f`, `cat <<EOF > f`, `sed -i`), the command becomes a permission card and the CEO answers
 * the same advice each time (BOS-2801: 12 cards). Such a command is refused to the agent at once, with one fixed hint, and raises no card.
 *
 * What counts as a file write (the writer is what makes the content, so a command's own output sent to a log is left alone):
 *   - a redirect (`>`, `>>`, `>|`, `&>`, `>&file`, `3>`) of a command that makes content itself: `echo`, `printf`, `:`, `true`, `cat`
 *     with no file operand (a here-doc, a here-string or a pipe from such a command), `tee` of those, or no command at all (`> f`);
 *   - `tee f` / `tee -a f` fed by such a command or by a here-doc / here-string;
 *   - an in-place edit: `sed -i`, `sed --in-place`, `perl -pi`, `perl -i`;
 *   - the same inside `sh -c '...'`, `bash -c`, `eval`, `$( )`, backticks and `>( )`.
 * Left to today's handling (a card, or the rules): `/dev/null` and other device targets, `2>&1` and other fd copies, a stderr-only
 * redirect, `cmd > $BOSSMAN_SCRATCH/out.log 2>&1` for any other program, `cat a b > c`, `rm`, `git clone`, `cp`, `dd of=`.
 * The reader never needs to be complete: whatever it does not recognise is not refused here and keeps the old route. It only ever
 * turns a card into a refusal, never into an allow.
 */
export const SHELL_FILE_WRITE_HINT = "Write files with your Write or Edit tool, then run them by their full path.";

const MAX_DEPTH = 4;
const MAX_LENGTH = 10_000;
const META = new Set([" ", "\t", "\n", ";", "&", "|", "(", ")", "<", ">"]);

interface Cmd {
  words: string[];
  redirs: Array<{ fd: number | null; target: string }>;
  heredoc: boolean;
  here: boolean;
  piped: Cmd | null;
  /** Created by `)`: a redirect after it belongs to a group, not to a command with nothing in it. */
  grouped: boolean;
}

const newCmd = (piped: Cmd | null, grouped = false): Cmd => ({ words: [], redirs: [], heredoc: false, here: false, piped, grouped });

/** Index of the `)` that closes the `(` at `open`, skipping quotes; -1 when there is none. */
function matchClose(src: string, open: number): number {
  let depth = 0;
  for (let j = open; j < src.length; j++) {
    const c = src[j]!;
    if (c === "\\") j++;
    else if (c === "'") {
      const e = src.indexOf("'", j + 1);
      if (e < 0) return -1;
      j = e;
    } else if (c === '"') {
      for (j++; j < src.length && src[j] !== '"'; j++) if (src[j] === "\\") j++;
    } else if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return j;
  }
  return -1;
}

/** A `$( )` or backtick substitution starting at `j`: scans what is inside, returns where it ends and the text to keep. */
function substitution(src: string, j: number, depth: number, out: Cmd[]): { end: number; text: string } | null {
  if (src[j] === "`") {
    let e = j + 1;
    while (e < src.length && src[e] !== "`") e += src[e] === "\\" ? 2 : 1;
    scan(src.slice(j + 1, e), depth + 1, out);
    return { end: Math.min(e + 1, src.length), text: "$(…)" };
  }
  if (src[j] === "$" && src[j + 1] === "(") {
    const e = matchClose(src, j + 1);
    const end = e < 0 ? src.length : e + 1;
    // `$(( ))` is arithmetic: its `>` is a comparison, not a redirect.
    if (src[j + 2] !== "(") scan(src.slice(j + 2, e < 0 ? src.length : e), depth + 1, out);
    return { end, text: "$(…)" };
  }
  return null;
}

function readWord(src: string, i: number, depth: number, out: Cmd[]): [string, number] {
  let text = "";
  let j = i;
  while (j < src.length) {
    const c = src[j]!;
    if (c === "\\") {
      if (src[j + 1] !== "\n") text += src[j + 1] ?? "";
      j += 2;
      continue;
    }
    if (c === "'") {
      const e = src.indexOf("'", j + 1);
      const end = e < 0 ? src.length : e;
      text += src.slice(j + 1, end);
      j = end + 1;
      continue;
    }
    if (c === '"') {
      j++;
      while (j < src.length && src[j] !== '"') {
        if (src[j] === "\\") {
          text += src[j + 1] ?? "";
          j += 2;
          continue;
        }
        const sub = substitution(src, j, depth, out);
        if (sub) {
          text += sub.text;
          j = sub.end;
          continue;
        }
        text += src[j];
        j++;
      }
      j++;
      continue;
    }
    const sub = substitution(src, j, depth, out);
    if (sub) {
      text += sub.text;
      j = sub.end;
      continue;
    }
    if (c === "$" && src[j + 1] === "{") {
      const e = src.indexOf("}", j);
      const end = e < 0 ? src.length : e + 1;
      text += src.slice(j, end);
      j = end;
      continue;
    }
    if (META.has(c)) break;
    text += c;
    j++;
  }
  return [text, j];
}

function readTarget(src: string, i: number, depth: number, out: Cmd[]): [string, number] {
  let j = i;
  while (src[j] === " " || src[j] === "\t") j++;
  if (j >= src.length || META.has(src[j]!)) return ["", j];
  return readWord(src, j, depth, out);
}

function skipHeredoc(src: string, from: number, h: { delim: string; strip: boolean }): number {
  let i = from;
  while (i < src.length) {
    const e = src.indexOf("\n", i);
    const line = src.slice(i, e < 0 ? src.length : e);
    if ((h.strip ? line.replace(/^\t+/, "") : line) === h.delim) return e < 0 ? src.length : e + 1;
    if (e < 0) return src.length;
    i = e + 1;
  }
  return src.length;
}

/** Splits a script into simple commands (every nested one too), keeping each command's words and file redirects. */
function scan(src: string, depth: number, out: Cmd[]): void {
  if (depth > MAX_DEPTH) return;
  let cur = newCmd(null);
  out.push(cur);
  const fresh = (piped: Cmd | null, grouped = false) => {
    cur = newCmd(piped, grouped);
    out.push(cur);
  };
  const pending: Array<{ delim: string; strip: boolean }> = [];
  const redirectAt = (from: number, fd: number | null): number => {
    let i = from + 1;
    if (src[i] === ">" || src[i] === "|") i++;
    else if (src[i] === "&") {
      const [t, j] = readTarget(src, i + 1, depth, out);
      // `>&2`, `>&-`: a copy of a stream, not a file.
      if (t !== "" && !/^(\d+|-)$/.test(t)) cur.redirs.push({ fd, target: t });
      return j;
    }
    if (src[i] === "(") {
      const e = matchClose(src, i);
      scan(src.slice(i + 1, e < 0 ? src.length : e), depth + 1, out);
      return e < 0 ? src.length : e + 1;
    }
    const [t, j] = readTarget(src, i, depth, out);
    if (t !== "") cur.redirs.push({ fd, target: t });
    return j;
  };
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (c === " " || c === "\t") i++;
    else if (c === "\\" && src[i + 1] === "\n") i += 2;
    else if (c === "#") {
      const e = src.indexOf("\n", i);
      i = e < 0 ? src.length : e;
    } else if (c === "\n") {
      i++;
      for (const h of pending) i = skipHeredoc(src, i, h);
      pending.length = 0;
      fresh(null);
    } else if (c === ";" || c === "(") {
      i++;
      fresh(null);
    } else if (c === ")") {
      i++;
      fresh(null, true);
    } else if (c === "|") {
      const next = src[i + 1];
      const piped = next === "|" ? null : cur;
      i += next === "|" || next === "&" ? 2 : 1;
      fresh(piped);
    } else if (c === "&") {
      if (src[i + 1] === ">") {
        i = redirectAt(i + 1, null);
      } else {
        i += src[i + 1] === "&" ? 2 : 1;
        fresh(null);
      }
    } else if (c === "<") {
      if (src.startsWith("<<<", i)) {
        cur.here = true;
        i = readTarget(src, i + 3, depth, out)[1];
      } else if (src.startsWith("<<", i)) {
        i += 2;
        const strip = src[i] === "-";
        if (strip) i++;
        const [delim, j] = readTarget(src, i, depth, out);
        cur.heredoc = true;
        pending.push({ delim, strip });
        i = j;
      } else if (src[i + 1] === "(") {
        const e = matchClose(src, i + 1);
        scan(src.slice(i + 2, e < 0 ? src.length : e), depth + 1, out);
        i = e < 0 ? src.length : e + 1;
      } else {
        i++;
        if (src[i] === ">") i++;
        i = readTarget(src, i, depth, out)[1];
      }
    } else if (c === ">") {
      i = redirectAt(i, null);
    } else {
      const [text, j] = readWord(src, i, depth, out);
      if (/^\d+$/.test(text) && src[j] === ">") i = redirectAt(j, Number(text));
      else if (/^\d+$/.test(text) && src[j] === "<") i = j;
      else {
        cur.words.push(text);
        i = j;
      }
    }
  }
}

const WRAPPERS = new Set(["env", "sudo", "nohup", "command", "builtin", "nice", "time", "timeout", "stdbuf", "setsid", "ionice"]);
const RESERVED = new Set(["if", "then", "else", "elif", "fi", "do", "done", "while", "until", "!", "{", "}"]);
const SHELLS = new Set(["sh", "bash", "dash", "zsh", "ksh", "ash"]);
const NO_FILE_TARGET = /^\/dev\/(?:null|stdout|stderr|tty|fd\/\d+)$/;

const base = (w: string) => (w.replace(/^\\/, "").split("/").pop() ?? "").toLowerCase();

function headOf(words: string[]): { name: string; args: string[]; bare: boolean } {
  let k = 0;
  let skipped = false;
  for (let guard = 0; k < words.length && guard < 16; guard++) {
    const w = words[k]!;
    if (/^[A-Za-z_]\w*(?:\[[^\]]*\])?\+?=/.test(w) || RESERVED.has(w)) {
      k++;
      skipped = true;
      continue;
    }
    const n = base(w);
    if (!WRAPPERS.has(n)) break;
    k++;
    skipped = true;
    while (k < words.length && words[k]!.startsWith("-")) k++;
    if (n === "timeout" && k < words.length) k++;
    if (n === "env") while (k < words.length && /^[A-Za-z_]\w*=/.test(words[k]!)) k++;
  }
  if (k >= words.length) return { name: "", args: [], bare: !skipped };
  return { name: base(words[k]!), args: words.slice(k + 1), bare: false };
}

/** Words that name a file: not an option (unless after `--`). */
function operands(args: string[]): string[] {
  const out: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === "--") ended = true;
    else if (ended || !a.startsWith("-") || a === "-") out.push(a);
  }
  return out;
}

/** True when the command's own output is text it makes itself (not a program's real output), so redirecting it writes a file. */
function makesContent(cmd: Cmd): boolean {
  const { name, args, bare } = headOf(cmd.words);
  const fed = () => cmd.heredoc || cmd.here || (cmd.piped !== null && makesContent(cmd.piped));
  if (name === "echo" || name === "printf" || name === ":" || name === "true") return true;
  if (name === "") return bare && cmd.words.length === 0 && !cmd.grouped;
  if (name === "cat") return operands(args).every((o) => o === "-") && fed();
  if (name === "tee") return fed();
  return false;
}

const IN_PLACE_SED = /^(?:-[nEsuzrb]*i|--in-place(?:=.*)?)/;
const IN_PLACE_PERL = /^-[^eEi\W]*i/;

function writesFile(cmds: Cmd[], depth: number): boolean {
  for (const cmd of cmds) {
    const { name, args } = headOf(cmd.words);
    if (cmd.redirs.some((r) => r.fd !== 2 && !NO_FILE_TARGET.test(r.target)) && makesContent(cmd)) return true;
    if (name === "tee" && operands(args).some((o) => !NO_FILE_TARGET.test(o)) && makesContent(cmd)) return true;
    if (name === "sed" && args.some((a) => IN_PLACE_SED.test(a))) return true;
    if (name === "perl" && args.some((a) => IN_PLACE_PERL.test(a))) return true;
    const script = SHELLS.has(name) ? args[args.findIndex((a) => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(a)) + 1] : name === "eval" ? args.join(" ") : undefined;
    if (script !== undefined && depth < MAX_DEPTH) {
      const nested: Cmd[] = [];
      scan(script, depth + 1, nested);
      if (writesFile(nested, depth + 1)) return true;
    }
  }
  return false;
}

/** The hint to send the agent when `command` writes a file through the shell, else null. The text is fixed; it never repeats the command. */
export function shellFileWriteRefusal(command: string): string | null {
  if (!command || command.length > MAX_LENGTH) return null;
  try {
    const cmds: Cmd[] = [];
    scan(command, 0, cmds);
    return writesFile(cmds, 0) ? `${SHELL_FILE_WRITE_HINT} This request was refused at once and no one was asked.` : null;
  } catch {
    return null;
  }
}
