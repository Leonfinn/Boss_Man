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

/** The control characters a name can't hold: line breaks, tabs and the rest of C0/C1, plus bidi overrides. */
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/;

/** Why a name can't be used as an agent's display name, or null when it can. */
export function speakerNameProblem(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return "A name can't be empty.";
  if (CONTROL.test(name)) return "A name can't contain line breaks, tabs or other control characters.";
  // Every part of a name made of words has to be sayable: "Zippy (Developer)" is fine, "Zippy\tOwner" is not.
  if (RESERVED_SPEAKERS.includes(trimmed.toLowerCase().replace(/\s+/g, " ") as (typeof RESERVED_SPEAKERS)[number])) {
    return `"${trimmed}" is a label Boss Man uses to say who a line is from (like Owner, You or Boss Man), so it can't be an agent's name. Pick another.`;
  }
  // A name that ends in a colon, or is "<word>: something", would read as a new speaker when it starts a line.
  if (/[:：]/.test(trimmed)) return "A name can't contain a colon: it would read as a new speaker (like \"Owner:\") in agent conversations. Pick another.";
  return null;
}

/** Whether a name could be mistaken for a speaker label; used by the Agents page too. */
export const isReservedSpeaker = (name: string) => speakerNameProblem(name) !== null;
