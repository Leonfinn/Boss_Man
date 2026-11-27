// BOS-2854: notes Boss Man's code appends under an agent's reply (the "Done in this reply" line, link checks, the receipt
// check, the old "You said" footer) are for the owner's screen. A reply that is shown back to an agent in a prompt goes
// through stripCodeNotes first, so the agent never sees them and never learns to write them itself (and a copy it did write
// is an unchecked claim that looks like the checked one, BOS-758). Every new appended note needs a line here.

/** Drops the "You said "X" on card Y, 2026-11-01, about Z, ..." footer lines that BOS-1855 saved under older CEO replies. */
export function stripYouSaidLines(text: string): string {
  return text.replace(/(?:\n+|^)You said "[^\n]*?, \d{4}-\d{2}-\d{2}, about [^\n]*/g, "").trimEnd();
}

/**
 * The start of each paragraph the code adds under a reply. The sources are in chat.ts (doneInThisReply, the receipt line),
 * wiki.ts (missingPageNote). A test in reply-notes.test.ts builds each from the real function, so a reworded note fails there.
 */
const NOTE_START = [/^Done in this reply: /, /^No changes made in this reply\./, /^Ticket link check: /, /^Wiki link check: /, /^Boss Man check: /];

/** A reply's own words, without any paragraph the code added under it. Paragraphs are split on blank lines, as the notes are joined. */
export function stripCodeNotes(text: string): string {
  return stripYouSaidLines(text)
    .split(/\n{2,}/)
    .filter((p) => !NOTE_START.some((re) => re.test(p.trimStart())))
    .join("\n\n")
    .trim();
}
