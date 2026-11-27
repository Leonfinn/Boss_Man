// BOS-2742: a card option that promises a screenshot ("Done, screenshot attached", "My screen looks different (I'll attach
// a screenshot)") can only be pressed with one attached. The card offers a paste/attach area for it and the server
// refuses it without an /api/ticket-images link. The web page and the server read this one rule so they never disagree.

const PICTURE = String.raw`(?:screen ?shots?|screengrabs?|pictures?|photos?|images?)`;
/**
 * Words that promise the owner sends one: "I'll attach", "attaching", "I've attached", "screenshot ... attached",
 * "with/plus/and/here's a screenshot", or an option that ends in "attached". Just naming a screenshot is not enough:
 * "Pass - the screenshot meets the criterion" or "the attached screenshot looks right" talk about the agent's picture.
 */
const PROMISES = [
  /\b(?:I'?ll|I will|I'?ve|I have|will)\s+attach/i,
  /\battaching\b/i,
  new RegExp(String.raw`\b${PICTURE}\b[^.;:]{0,40}\battached\b`, "i"),
  // "with a screenshot", "and my screenshot", "here's a photo"; not "and the image looks right" (the agent's picture).
  new RegExp(String.raw`\b(?:with|plus|and|here'?s|here is|sending)\s+(?:a|an|my|one|\d+)\s+(?:\w+\s+)?${PICTURE}\b`, "i"),
  /\battached\W*$/i,
];
/** The same words, negated ("no screenshot", "with no screenshot", "skip the screenshot"): those need nothing attached. */
const NEGATED = new RegExp(String.raw`\b(?:no|not|without|skip|don't|do not|never)\b[^.,;:()]{0,20}\b(?:attach\w*|${PICTURE})`, "i");

/**
 * Whether answering with `option` needs a picture or file attached. True when the card's raiser flagged it
 * (`flagged`, the option texts raise_decision's needsAttachment named) or when its words promise one.
 */
export function optionNeedsAttachment(option: string, flagged?: readonly string[] | null): boolean {
  if (flagged?.includes(option)) return true;
  return PROMISES.some((p) => p.test(option)) && !NEGATED.test(option);
}

/** The ids of every /api/ticket-images/<id> link in a text, in order, without repeats. */
export function attachmentIds(text: string | null | undefined): string[] {
  if (!text) return [];
  return [...new Set([...text.matchAll(/\/api\/ticket-images\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/gi)].map((m) => m[1]!.toLowerCase()))];
}

/** The plain message the owner sees when they press such an option with nothing attached. */
export const ATTACH_FIRST = "Attach the screenshot first";

// BOS-2798: the same for an option that says its answer is in the note ("Done, output pasted in my note", "Other (see my
// note)", "Ran it, output below"). Pressed with an empty note, the card used to close and the agent got nothing.
/** Words that say the answer travels in the note: "in/see my note", "pasted", "I'll paste", "output below". */
const NOTE_PROMISES = [
  /\b(?:in|into|see|per|with)\s+(?:my|the|a)\s+note\b/i,
  /\b(?:pasted|pasting)\b/i,
  /\b(?:I'?ll|I will|I'?ve|I have)\s+(?:paste|written|write|noted|note)\b/i,
  /\b(?:output|log|logs|result|results|answer|details?|reason|text|error)\s+(?:is\s+|are\s+)?below\b/i,
];
/** The same words, negated ("no output to paste", "nothing to note", "without a note"): those need no note. */
const NOTE_NEGATED = /\b(?:no|not|nothing|without|skip|don't|do not|never)\b[^.,;:()]{0,20}\b(?:note|paste\w*|output|log|below)\b/i;

/**
 * Whether answering with `option` needs text in the card's note. True when the raiser flagged it (`flagged`, the option
 * texts raise_decision's needsNote named) or when its words say the answer is in the note.
 */
export function optionNeedsNote(option: string, flagged?: readonly string[] | null): boolean {
  if (flagged?.includes(option)) return true;
  return NOTE_PROMISES.some((p) => p.test(option)) && !NOTE_NEGATED.test(option);
}

/** The plain message the owner sees when they press such an option with an empty note. */
export const NOTE_FIRST = "Paste it in the note first";
