// One reading of an owner step's text (BOS-550), shared by the server's card lint (apps/server/src/services/steps.ts)
// and the web app's card renderer (apps/web/src/pages/Decisions.tsx, StepText). Before this each side had its own
// copy of the fence pattern, and a step the lint accepted could still reach the owner as raw ``` text. With one
// parser, what the lint checks as a command is exactly what the card shows as a command block with a Copy button,
// and any ``` left over in the sentences is reported (`strayFence`) so the lint can refuse it.
//
// A command block is a fence line, the command, and a closing fence line, each on its own line:
//
//   ```sh host="nas01" as="root"
//   ls -l /srv
//   ```
//
// The fence lines may be indented (a step written as a numbered list item), and the body loses the opening
// fence's indentation. Anything may follow the three backticks on the opening line (the info string); `sh host=…
// as=…` is read as where the command runs and as whom (BOS-427), and any other info string is a block that names
// neither. Windows line endings are read as plain ones.

/** Where a command runs and as whom (BOS-427). */
export type Where = { host: string; as: "root" | "login" };

/** A step's text in order: sentences, and command blocks with where they run when the fence line says. */
export type StepPiece = { type: "text"; text: string } | { type: "command"; text: string; where?: Where };

/** A host name a fence line may carry: a plain DNS-style name, so it can never break the fence or the shell. */
export const HOST_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

const WHERE = /^sh\s+host="([A-Za-z0-9][A-Za-z0-9_.-]{0,63})"\s+as="(root|login)"$/;
const OPEN = /^([ \t]*)```([^`]*)$/;
const CLOSE = /^[ \t]*```[ \t]*$/;

/**
 * The host and account an info string names, or undefined. `sh` alone, or any other info string, names neither;
 * a malformed one is not guessed at (the lint's R6 then says the block doesn't say where it runs).
 */
export function fenceWhere(info: string): Where | undefined {
  const m = WHERE.exec(info.trim());
  return m ? { host: m[1]!, as: m[2] as Where["as"] } : undefined;
}

/** Strip up to `indent` characters of leading spaces or tabs, so an indented block's command is what's pasted. */
const dedent = (line: string, indent: number) => {
  let i = 0;
  while (i < indent && (line[i] === " " || line[i] === "\t")) i++;
  return line.slice(i);
};

/** Splits a step into sentences and command blocks. Text pieces are trimmed; empty ones are dropped. */
export function parseStep(text: string): StepPiece[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const out: StepPiece[] = [];
  let prose: string[] = [];
  const flush = () => {
    const t = prose.join("\n").trim();
    if (t) out.push({ type: "text", text: t });
    prose = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const open = OPEN.exec(lines[i]!);
    const close = open ? lines.findIndex((l, j) => j > i && CLOSE.test(l)) : -1;
    if (!open || close < 0) {
      prose.push(lines[i]!);
      continue;
    }
    flush();
    const indent = open[1]!.length;
    const where = fenceWhere(open[2]!);
    out.push({ type: "command", text: lines.slice(i + 1, close).map((l) => dedent(l, indent)).join("\n"), ...(where ? { where } : {}) });
    i = close;
  }
  flush();
  return out;
}

/**
 * The first sentence line that still holds ``` after parsing, or null: a fence that isn't on its own line, or one
 * that is never closed. The owner would see it as raw text, so the lint refuses it (BOS-550).
 */
export function strayFence(pieces: StepPiece[]): string | null {
  for (const p of pieces) {
    if (p.type !== "text") continue;
    const line = p.text.split("\n").find((l) => l.includes("```"));
    if (line !== undefined) return line.trim();
  }
  return null;
}

/** Where a step's clicks came from (R19): the card checker's tag, kept in the stored step, never shown as written. */
export type StepSource = { kind: "seen"; imageId: string; /** YYYY-MM-DD the screenshot was attached, when known. */ takenAt?: string } | { kind: "notSeen"; url: string; date: string };

const SEEN_TAG = /(?<!not )\bseen:\s*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})[ \t]*[.,;]?/i;
const NOT_SEEN_TAG = /\bnot seen:\s*(https?:\/\/[^\s,]+)\s*,\s*(\d{4}-\d{2}-\d{2})[ \t]*[.,;]?/i;

/**
 * Every checker tag that may sit inside a step's written text (BOS-1665): R19 "seen:" / "not seen:" and R18b
 * "engagement:<id>". One list, so a rule that adds an in-step tag adds its pattern here, and the test that runs the
 * card fixtures through the owner-text split fails while any of these still matches what the owner reads.
 */
export const CHECKER_TAG_PATTERNS: readonly RegExp[] = [
  SEEN_TAG,
  NOT_SEEN_TAG,
  /\bengagement:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i,
];

/** A checker tag left in text the owner reads, or undefined. */
export function leftoverCheckerTag(text: string): string | undefined {
  for (const p of CHECKER_TAG_PATTERNS) {
    const m = p.exec(text);
    if (m) return m[0];
  }
  return undefined;
}

/**
 * The owner's steps and where each came from, split once (BOS-1665): `steps` has no checker tag, `stepSources[i]` is
 * the R19 source of step i (or null). `stepSources` is left out when no step has one. `imageDates` maps a screenshot
 * id to its ISO date so the muted line can say when it was taken.
 */
export function splitOwnerSteps(steps: readonly string[], imageDates?: Record<string, string>): { steps: string[]; stepSources?: Array<StepSource | null> } {
  const split = steps.map((s) => splitStepSource(s));
  const sources = split.map((x) => {
    const src = x.source;
    if (src?.kind === "seen" && imageDates?.[src.imageId]) return { ...src, takenAt: imageDates[src.imageId]!.slice(0, 10) };
    return src ?? null;
  });
  return { steps: split.map((x) => x.text), ...(sources.some(Boolean) ? { stepSources: sources } : {}) };
}

/**
 * A step with its R19 "seen: <id>" / "not seen: <url>, <date>" tag taken out, and the tag read into `source`. The
 * stored step keeps the tag (the card checker needs it); the owner's views (card, Decisions, review lane, push)
 * show `text` and, at most, a muted line built from `source`.
 */
export function splitStepSource(step: string): { text: string; source?: StepSource } {
  let source: StepSource | undefined;
  let text = step;
  const notSeen = NOT_SEEN_TAG.exec(text);
  if (notSeen) {
    source = { kind: "notSeen", url: notSeen[1]!, date: notSeen[2]! };
    text = text.replace(NOT_SEEN_TAG, "");
  }
  const seen = SEEN_TAG.exec(text);
  if (seen) {
    source ??= { kind: "seen", imageId: seen[1]!.toLowerCase() };
    text = text.replace(SEEN_TAG, "");
  }
  if (!source) return { text: step };
  // Tidy what the tag leaves behind: an empty "()" or "[]", doubled spaces, a dangling separator.
  text = text.replace(/\s*[(\[]\s*[)\]]/g, "").replace(/[ \t]{2,}/g, " ").replace(/[ \t]+$/gm, "").replace(/\s*[-–—;,]\s*$/, "").trim();
  return { text, source };
}
