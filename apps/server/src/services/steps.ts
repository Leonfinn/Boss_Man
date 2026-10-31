// Owner step text with copy-safe commands (BOS-269). The owner is not a developer and copies commands by hand,
// so a command is never written inside a sentence: it goes in its own fenced block under the sentence that
// explains it, and the block holds exactly what is to be pasted. The web app renders each block with a Copy
// button (apps/web/src/pages/Decisions.tsx, StepText). Plain text without a fence still renders as before.

export type Command = { sh: string };
/** Marks a command inside `step(...)`: it is rendered as its own block. */
export const sh = (command: string): Command => ({ sh: command });

/** Why a command is not copy-safe, or null. A command is one trimmed line with nothing but the text to paste. */
export function commandProblem(command: string): string | null {
  if (command !== command.trim() || !command) return "has spaces around it or is empty";
  if (/[\r\n]/.test(command)) return "spans more than one line";
  if (command.includes("```")) return "contains a code fence";
  if (/^[$#>%]\s/.test(command)) return "starts with a prompt character";
  if (/[.,;:]$/.test(command)) return "ends with punctuation";
  if (/<[A-Za-z][\w.-]*>/.test(command) || /\b(?:YOUR|REPLACE|TODO)[_-]?\w*/.test(command)) return "has a placeholder the owner would have to edit";
  return null;
}

/**
 * One step: the sentence in plain words, then each command in its own block. Strings after the first are
 * more sentences (to explain the next command); `sh("...")` is a command. A command that is not copy-safe
 * throws, so a card with a broken command is a bug found by the tests and never shown to the owner.
 */
export function step(sentence: string, ...rest: Array<string | Command>): string {
  const parts = [sentence, ...rest];
  return parts
    .map((p) => {
      if (typeof p === "string") {
        if (p.includes("```")) throw new Error("A sentence must not contain a code fence");
        return p;
      }
      const problem = commandProblem(p.sh);
      if (problem) throw new Error(`Command is not copy-safe (${problem}): ${p.sh}`);
      return "```sh\n" + p.sh + "\n```";
    })
    .join("\n\n");
}

export type StepPiece = { type: "text"; text: string } | { type: "command"; text: string };

/** Splits a step into sentences and command blocks; the web app has the same logic for rendering. */
export function parseStep(text: string): StepPiece[] {
  const out: StepPiece[] = [];
  const re = /```[a-z]*\n([\s\S]*?)\n```/g;
  let last = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const before = text.slice(last, m.index).trim();
    if (before) out.push({ type: "text", text: before });
    out.push({ type: "command", text: m[1]! });
    last = m.index + m[0].length;
  }
  const rest = text.slice(last).trim();
  if (rest) out.push({ type: "text", text: rest });
  return out;
}
