// Who a line of agent-readable text is from. Ticket chat, the owner chat and the brief label each line
// "Owner:", "You:" (the agent it is talking to), "Boss Man:" or the agent's own name, so a display name
// that reads as one of those labels would let an agent's words pass for the owner's or Boss Man's.
// BOS-265: the CEO may rename agents, so the name is checked here before it is used as a speaker.

/**
 * Labels Boss Man itself writes before a line (case-insensitive), plus the ones an agent might be
 * given that would look like a system note. Compared after trimming and collapsing runs of spaces.
 */
export const RESERVED_SPEAKERS = [
  "owner",
  "the owner",
  "boss man",
  "bossman",
  "you",
  "an agent",
  "agent",
  "ceo",
  "system",
  "boss man system",
  "the system",
] as const;

/**
 * Control and format characters a name can't hold: line breaks, tabs, the rest of C0/C1, bidi overrides,
 * and every other Unicode format character (a soft hyphen or a word joiner would hide a reserved label).
 * Deliberately no \s: ordinary spaces are how names like "Zippy - Developer" are written.
 */
const CONTROL = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
/** Combining marks, variation selectors, blank fillers and a letter from another alphabet mixed into a Latin word. */
const HIDDEN = /[\p{M}\u115F\u1160\u3164\uFFA0\u2800\u180E]/u;
const LOOKALIKE = /[\p{Script=Cyrillic}\p{Script=Greek}\p{Script=Armenian}\p{Script=Cherokee}ɐ-ʯᴀ-ᶿ]/u;

/**
 * Why a name can't be used as an agent's display name, or null when it can. The name is read as an accented
 * or lookalike spelling too, so an "Owner" dotted with invisible marks or a Greek Omicron is refused as "Owner".
 */
export function speakerNameProblem(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return "A name can't be empty.";
  if (CONTROL.test(name)) return "A name can't contain line breaks, tabs or other control characters.";
  if (HIDDEN.test(name)) return "A name can't contain invisible accent or formatting characters: they could make it look like a label Boss Man uses (like Owner). Pick another.";
  // Cyrillic, Greek, Armenian and Cherokee letters, and Latin small capitals / IPA letters (which NFKC doesn't fold),
  // can spell "CEO" or "Owner" to a reader, whether mixed into a Latin word or used for the whole name (BOS-281).
  if (LOOKALIKE.test(name)) {
    return "A name can't use letters that look like Latin ones (Cyrillic, Greek, Armenian, Cherokee, small capitals): they could make it read as a label Boss Man uses (like Owner). Pick another.";
  }
  // Every part of a name made of words has to be sayable: "Zippy (Developer)" is fine, "Zippy\tOwner" is not.
  // NFKC folds full-width and other compatibility spellings back to ordinary letters before the comparison.
  const folded = trimmed.normalize("NFKC").toLowerCase().replace(/\s+/g, " ");
  if (RESERVED_SPEAKERS.includes(folded as (typeof RESERVED_SPEAKERS)[number])) {
    return `"${trimmed}" is a label Boss Man uses to say who a line is from (like Owner, You or Boss Man), so it can't be an agent's name. Pick another.`;
  }
  // A name that ends in a colon, or is "<word>: something", would read as a new speaker when it starts a line.
  if (/[:：]/.test(trimmed)) return "A name can't contain a colon: it would read as a new speaker (like \"Owner:\") in agent conversations. Pick another.";
  return null;
}

/** Whether a name could be mistaken for a speaker label; used by the Agents page too. */
export const isReservedSpeaker = (name: string) => speakerNameProblem(name) !== null;
