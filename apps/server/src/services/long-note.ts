// BOS-2874: a note on an owner card can carry pasted command output of any size. One over the limit is never refused:
// the whole text is kept as an attachment the agent opens with open_attachment, and the note keeps the start and the
// end, with repeated lines collapsed to "(same line ×N)".

/** What a note may hold once saved on the card (the answer route's long-standing limit). */
export const NOTE_KEEP_MAX = 20_000;
/** The most a note may arrive with; the whole text becomes one attachment (10 MB cap, up to 4 bytes a character). */
export const NOTE_PASTE_MAX = 2_000_000;

const MIN_REPEAT_LEN = 12;

/** Every repeat of an earlier line (a short line is left alone) is dropped; the first shows "(same line ×N)". */
export function collapseRepeats(text: string): string {
  const lines = text.split("\n");
  // not state: a local of one call
  const counts = new Map<string, number>();
  for (const l of lines) if (l.trim().length >= MIN_REPEAT_LEN) counts.set(l, (counts.get(l) ?? 0) + 1);
  // not state: a local of one call
  const seen = new Set<string>();
  const out: string[] = [];
  for (const l of lines) {
    const n = counts.get(l) ?? 0;
    if (n < 2) {
      out.push(l);
      continue;
    }
    if (seen.has(l)) continue;
    seen.add(l);
    out.push(`${l} (same line ×${n})`);
  }
  return out.join("\n");
}

/**
 * The note as saved when `text` is over the limit: null when it fits. `link` is the Markdown of the attachment that
 * holds the full text. The result is never longer than NOTE_KEEP_MAX.
 */
export function shrinkNote(text: string, link: string, limit = NOTE_KEEP_MAX): string | null {
  if (text.length <= limit) return null;
  const tail = `\n\nThe full ${text.length.toLocaleString("en-US")} characters are attached: ${link}`;
  const collapsed = collapseRepeats(text);
  const budget = limit - tail.length - 200;
  if (collapsed.length <= budget) return `${collapsed}${tail}`;
  const head = Math.floor(budget / 2);
  const end = budget - head;
  const left = collapsed.length - head - end;
  return `${collapsed.slice(0, head)}\n\n… ${left.toLocaleString("en-US")} characters left out here …\n\n${collapsed.slice(collapsed.length - end)}${tail}`;
}
