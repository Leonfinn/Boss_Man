// BOS-2522: the scanning cores of the list guards (BOS-1727), shared by the guard tests and the move-to-review check
// (list-guard-gate.ts), so the two can't drift: a change here changes what both see. Pure text in, names out; no file
// access. The owner-control scanner came out of test/owner-control-list.test.ts, the wake-reason patterns out of
// test/wake-classes.test.ts and the hold-reader pattern out of test/update-waits-guard.test.ts, unchanged.

// ---- Owner controls (owner-control-list.test.ts): the labels a .tsx file shows on buttons and form fields. ----

/** Components whose `label` prop is a form field's label (rendered as a <label> from the prop). */
export const FIELD_COMPONENTS = new Set(["CheckPicker"]);

function skipString(s: string, i: number): number {
  const q = s[i];
  for (i++; i < s.length && s[i] !== q; i++) {
    if (s[i] === "\\") i++;
    else if (q === "`" && s[i] === "$" && s[i + 1] === "{") i = skipBraces(s, i + 1) - 1;
  }
  return i + 1;
}
function skipBraces(s: string, i: number): number {
  let depth = 0;
  for (; i < s.length; i++) {
    const c = s[i];
    if (c === '"' || c === "'" || c === "`") i = skipString(s, i) - 1;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return i + 1;
  }
  return i;
}
/** The strings a JSX expression can show: not ones compared against (`tab === "all"`) or given as attributes. */
export function shown(expr: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < expr.length; i++) {
    const c = expr[i];
    if (c !== '"' && c !== "'" && c !== "`") continue;
    const e = skipString(expr, i);
    const before = expr.slice(0, i).trimEnd();
    const after = expr.slice(e).trimStart();
    const compared = /[=!]=$/.test(before) || /^[=!]==?/.test(after) || /\b(?:includes|has|startsWith|endsWith)\($/.test(before);
    if (!compared && !/[\w-]=$/.test(before)) out.push(c === "`" ? expr.slice(i + 1, e - 1).split("${")[0]! : expr.slice(i + 1, e - 1));
    i = e - 1;
  }
  return out;
}
/**
 * The text each <button> in a file shows: its JSX text and the strings in its {…} children. A label with a value
 * inside comes out in pieces ("Open", "'s Kanban"); only pieces starting with a capital are labels (the rest are
 * the tail of one, or class names). TypeScript 7 has no JS parser API to borrow, so this is a small scanner that
 * knows JSX braces and strings.
 */
export function buttonLabels(src: string): string[] {
  return clean(elementTexts(src, "button").flatMap((chunks) => chunks.flat()));
}

/** The inside of every `<tag …>…</tag>` in a file, as its runs of text: each JSX text run or {…} is one chunk. */
function elementTexts(src: string, tag: string): string[][][] {
  const out: string[][][] = [];
  for (const m of src.matchAll(new RegExp(`<${tag}\\b`, "g"))) {
    let i = m.index + tag.length + 1;
    while (i < src.length && src[i] !== ">") i = src[i] === "{" ? skipBraces(src, i) : src[i] === '"' || src[i] === "'" ? skipString(src, i) : i + 1;
    if (src[i - 1] === "/") continue;
    const inner = src.slice(i + 1, src.indexOf(`</${tag}>`, i));
    const chunks: string[][] = [];
    for (let k = 0; k < inner.length; ) {
      if (inner[k] === "{") {
        const e = skipBraces(inner, k);
        chunks.push(shown(inner.slice(k + 1, e - 1)));
        k = e;
      } else if (inner[k] === "<") {
        // A field's own text stops at its input: the options of a <select> inside a <label> are not its label.
        if (/^<(?:select|option|textarea)\b/.test(inner.slice(k))) break;
        while (k < inner.length && inner[k] !== ">") k = inner[k] === "{" ? skipBraces(inner, k) : k + 1;
        k++;
      } else {
        const e = inner.slice(k).search(/[{<]/);
        const t = inner.slice(k, e < 0 ? undefined : k + e);
        if (t.trim()) chunks.push([t]);
        k = e < 0 ? inner.length : k + e;
      }
    }
    out.push(chunks);
  }
  return out;
}
// Leading and trailing marks aren't part of the name: "▸ Show all", "Saved ✓", "Attaching…", "History (".
const clean = (pieces: string[]) => pieces.map((p) => p.replace(/\s+/g, " ").replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N})]+$/gu, "")).filter((p) => /^\p{Lu}/u.test(p));

/**
 * The label of every form field in a file (BOS-442): the first text of each <label> (the words before its input;
 * a label that is only a variable shows nothing to list), and the `label` prop of a field component (CheckPicker).
 */
export function fieldLabels(src: string): string[] {
  const out = elementTexts(src, "label").flatMap((chunks) => chunks[0] ?? []);
  for (const m of src.matchAll(/<(\w+)\b[^>]*?\blabel="([^"]+)"/g)) if (FIELD_COMPONENTS.has(m[1]!)) out.push(m[2]!);
  return clean(out);
}

// ---- Wake classes (wake-classes.test.ts): the reasons a server source file wakes an agent with. ----

/**
 * Every wake reason a server source text names: `export const …REASON = "…"`, and `reason: "…"` in plain lower-case
 * words (the sentences after `reason:` elsewhere are refusals shown to people).
 */
export function wakeReasonsIn(text: string): string[] {
  return [...[...text.matchAll(/export const \w*REASON = "([^"]+)"/g)].map((m) => m[1]!), ...[...text.matchAll(/\breason: "([a-z_][a-z_ -]*)"/g)].map((m) => m[1]!)];
}
/** Strings that follow `reason:` but are refusal codes or the hold's label, never a wake (the test drops them too). */
export const NOT_WAKE_CODES = ["update pending", "no_wrapup", "too_early", "no_update", "agents_running", "no_checks"];

// ---- Update waits (update-waits-guard.test.ts): a file that reads an update hold to hold work back. ----

/** A call that reads the server update's soft hold or the runner update's maintenance hold. */
export const HOLD_READER = /\b(softHold|holdBlocksStarts|getHold|landingMergeIds)\(/;
