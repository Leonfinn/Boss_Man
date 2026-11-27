// BOS-2742 and BOS-2798 (DR-078): a card option that promises the owner hands something over ("Done, screenshot attached",
// "Done, output pasted in my note") carries a typed need: an attachment or a note. The web page, the server and phone
// Approve read this one rule so they never disagree. The need comes from the raiser's flags (raise_decision's
// needsAttachment / needsNote, stored on the card as attachOptions / noteOptions). A raise whose option promises a
// hand-over in words but isn't flagged is refused (handOverRefusal), so on a new card the flags are the whole story;
// the word check in optionNeeds remains only as a backstop for cards raised before that refusal existed.
//
// The words are hand-over PHRASES, never bare words (CEO, 27 Nov): "Leave a note for Zebedee", "Link it to BOS-12",
// "Sent" and "Details below the fold" are ordinary options and must pass.

export type OptionNeed = "attachment" | "note";
/** The card's flags: the options its raiser marked as needing an attachment or a note. */
export type OptionNeedFlags = { attachOptions?: readonly string[] | null; noteOptions?: readonly string[] | null } | null | undefined;

const PICTURE = String.raw`(?:screen ?shots?|screengrabs?|pictures?|photos?|images?)`;
/**
 * Phrases that promise the owner sends a picture or file: "I'll attach", "attaching", "I've attached", "screenshot ...
 * attached", "with/plus/and/here's a screenshot", or an option that ends in "attached". Just naming a screenshot is not
 * enough: "Pass - the screenshot meets the criterion" or "the attached screenshot looks right" talk about the agent's picture.
 */
const ATTACH_PROMISES = [
  /\b(?:I'?ll|I will|I'?ve|I have|will)\s+attach/i,
  /\battaching\b/i,
  new RegExp(String.raw`\b${PICTURE}\b[^.;:]{0,40}\battached\b`, "i"),
  // "with a screenshot", "and my screenshot", "here's a photo"; not "and the image looks right" (the agent's picture).
  new RegExp(String.raw`\b(?:with|plus|and|here'?s|here is|sending)\s+(?:a|an|my|one|\d+)\s+(?:\w+\s+)?${PICTURE}\b`, "i"),
  /\battached\W*$/i,
];
/** The same phrases, negated ("no screenshot", "with no screenshot", "skip the screenshot"): those need nothing attached. */
const ATTACH_NEGATED = new RegExp(String.raw`\b(?:no|not|without|skip|don't|do not|never)\b[^.,;:()]{0,20}\b(?:attach\w*|${PICTURE})`, "i");

/**
 * Phrases that say the answer travels in the note: "in/into/see my note", "pasted", "I'll paste", "I've entered/typed",
 * "output/link/error below". "Leave a note for X" (no "in/see"), "Link it to BOS-12" and a bare "below" don't match.
 */
const NOTE_PROMISES = [
  /\b(?:in|into|see)\s+(?:my|the)\s+note\b/i,
  /\b(?:pasted|pasting)\b/i,
  /\b(?:I'?ll|I will)\s+paste\b/i,
  /\b(?:I'?ve|I have)\s+(?:entered|typed|written)\b/i,
  /\b(?:output|log|logs|result|results|details|text|error|code|link|value|reason)\s+(?:is\s+|are\s+)?below\b/i,
];
/** The same phrases, negated ("no output to paste", "nothing pasted"): those need no note. */
const NOTE_NEGATED = /\b(?:no|not|nothing|without|skip|don't|do not|never)\b[^.,;:()]{0,20}\b(?:note|paste\w*|output|log|below)\b/i;

/** What an option's own words promise the owner hands over, flags aside. */
export function promisedHandOver(option: string): OptionNeed | null {
  if (ATTACH_PROMISES.some((p) => p.test(option)) && !ATTACH_NEGATED.test(option)) return "attachment";
  if (NOTE_PROMISES.some((p) => p.test(option)) && !NOTE_NEGATED.test(option)) return "note";
  return null;
}

/**
 * What answering with `option` needs: "attachment" (a picture or file on the card), "note" (text in the card's note; an
 * attachment, which travels in the note, also meets it) or null. The card's flags decide; the words are a backstop for
 * cards raised before the raise-time refusal.
 */
export function optionNeeds(option: string, flags: OptionNeedFlags): OptionNeed | null {
  if (flags?.attachOptions?.includes(option)) return "attachment";
  if (flags?.noteOptions?.includes(option)) return "note";
  return promisedHandOver(option);
}

/**
 * The raise-time check (DR-078): every option whose words promise a hand-over must be flagged needsAttachment or
 * needsNote. Returns the refusal for the first unflagged one, or null.
 */
export function handOverRefusal(options: readonly string[], flags: OptionNeedFlags): string | null {
  for (const o of options) {
    if (flags?.attachOptions?.includes(o) || flags?.noteOptions?.includes(o)) continue;
    const need = promisedHandOver(o);
    if (!need) continue;
    const field = need === "attachment" ? "needsAttachment" : "needsNote";
    return `The option "${o}" says the owner hands something over (${need === "attachment" ? "a picture or file" : "text in the note"}), so the card must ask for it: flag this option ${field} (${field}: ["${o}"]), or reword it. Without the flag the owner could press it with nothing handed over.`;
  }
  return null;
}

/** The ids of every /api/ticket-images/<id> link in a text, in order, without repeats. */
export function attachmentIds(text: string | null | undefined): string[] {
  if (!text) return [];
  return [...new Set([...text.matchAll(/\/api\/ticket-images\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/gi)].map((m) => m[1]!.toLowerCase()))];
}

/** The plain message the owner sees when they press an option that needs an attachment with nothing attached. */
export const ATTACH_FIRST = "Attach the screenshot first";
/** The plain message the owner sees when they press an option that needs a note with the note empty. */
export const NOTE_FIRST = "Paste it in the note first";
