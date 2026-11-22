import { commandRisks } from "./destructive.js";

/**
 * BOS-2244 (R58). An agent, mostly a sub-agent that never saw Boss Man's built-in rules, writes `R=/path; G="git -C $R"; $G grep x`.
 * The shell word `$G` is the program, so Boss Man can't tell what runs and the destructive-command guard sends a card, which
 * nobody approves. When that is the ONLY thing wrong with the command and the variable is one the command sets itself to a
 * plain value, the card helps no one: the agent is told to type the command out in full and gets a refusal at once.
 *
 * Anything else keeps today's route (a card): another kind of risk in the same command, a variable set twice, by `read`, `for`
 * over a computed list, `$(...)`, a backtick, `eval`, `export`, `declare`, `local`, `unset`, or one that holds a system name
 * (HOME, PATH, IFS), or one that is used before it is set.
 */
const WHY_VARIABLE_PROGRAM = "runs a program whose name is only known when it runs";
const SHELL_NAMES_OFF_LIMITS = new Set(["HOME", "PATH", "IFS", "SHELL", "PWD", "OLDPWD", "BASH_ENV", "ENV", "PS4", "PROMPT_COMMAND"]);
/** Words that make a variable's value depend on more than the plain assignments this reads. */
const UNREADABLE_SETTERS = /\b(?:eval|export|declare|typeset|local|unset|readonly|read|mapfile|readarray|getopts|source|alias|set|trap)\b|\bprintf\s+-v\b|\$\{\w+[^}\w]*?:?[=?+-]|\+=|[`]|\$\(|<\(|>\(/;
const WORD = /^\$(?:\{(\w+)\}|(\w+))/;

/** The variable names a command word is built from: `$G grep`, `"$G" grep`, `$R/run.sh`, after `;`, `&&`, `|`, `do`, `then`, or `NAME=x` prefixes. */
function commandWordVariables(command: string): string[] {
  const names: string[] = [];
  for (const seg of command.split(/[;&|\n(){}]+/)) {
    const words = seg.trim().split(/\s+/).filter(Boolean);
    let i = 0;
    while (i < words.length && (/^(?:do|then|else|elif|if|while|until|time|!)$/.test(words[i]!) || /^\w+=/.test(words[i]!))) i++;
    const w = (words[i] ?? "").replace(/^["']+/, "");
    const m = WORD.exec(w);
    if (m) names.push((m[1] ?? m[2])!);
  }
  return names;
}

/** Every plain assignment `NAME=value` (quoted or not) and `for NAME in words`, with its position. Null when a value can't be read as plain text. */
function plainSets(command: string): Map<string, { count: number; at: number; value: string | null }> {
  const sets = new Map<string, { count: number; at: number; value: string | null }>();
  const note = (name: string, at: number, value: string | null) => {
    const prev = sets.get(name);
    sets.set(name, { count: (prev?.count ?? 0) + 1, at: prev?.at ?? at, value });
  };
  for (const m of command.matchAll(/(?:^|[;&|\n(\s])([A-Za-z_]\w*)=("[^"]*"|'[^']*'|[^\s;&|)]*)/g)) {
    const raw = m[2]!;
    const value = raw.replace(/^(["'])([\s\S]*)\1$/, "$2");
    note(m[1]!, m.index!, value);
  }
  for (const m of command.matchAll(/\bfor\s+([A-Za-z_]\w*)\s+in\s+([^;\n]*)/g)) note(m[1]!, m.index!, m[2]!.includes("$") ? null : m[2]!);
  return sets;
}

/**
 * Text to send back to the agent when `command` is refused for running a program through a variable it set itself, else null.
 * The text names the variable and says to type the command in full. Never built from the command's other words.
 */
export function selfSetVariableRefusal(command: string): string | null {
  if (!command || command.length > 10_000) return null;
  if (UNREADABLE_SETTERS.test(command)) return null;
  const risks = commandRisks(command);
  if (risks.length === 0 || risks.some((r) => r.kind !== "destroys" || r.why !== WHY_VARIABLE_PROGRAM)) return null;
  const used = commandWordVariables(command);
  if (used.length === 0) return null;
  const sets = plainSets(command);
  const readable = (name: string, seen: Set<string>): boolean => {
    const s = sets.get(name);
    if (!s || s.count !== 1 || s.value === null || SHELL_NAMES_OFF_LIMITS.has(name) || seen.has(name)) return false;
    // Set before it is first read.
    const firstUse = command.search(new RegExp(`\\$\\{?${name}\\b`));
    if (firstUse >= 0 && firstUse < s.at) return false;
    // A value that holds other variables must hold only ones that are themselves plain and set once.
    seen.add(name);
    for (const v of s.value.matchAll(/\$(?:\{(\w+)\}|(\w+))/g)) if (!readable((v[1] ?? v[2])!, seen)) return false;
    seen.delete(name);
    return true;
  };
  for (const name of used) {
    if (!readable(name, new Set())) return null;
  }
  const first = used[0]!;
  return `Boss Man can't read $${first}: this command sets it and then runs it as a program, so nobody can see what runs. Type the command out in full instead, one command per call, with no shell variable standing in for the program or its options (for example git -C /your/checkout grep -n text, not G="git -C $R"; $G grep -n text). This request was refused at once and no one was asked.`;
}
