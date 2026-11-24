// BOS-2490: filter Chat's team list by name or role, and optionally to agents with a new reply.
// The order is kept and the open conversation is never touched.
//
// The role part matches the words a row shows: "worker", "manager", "ceo", "developer", "qa", and "pa" (a PA's
// row reads "PA" though the API stores it as a worker). They match whole words, so "wo" or "man" finds no one
// rather than half the team; a name matches anywhere in it. The stored role and the label can differ, so both
// are checked, and a word the row doesn't show ("worker" for a row that reads "Web Developer") matches nobody.
const ROLE_WORDS: Record<string, string[]> = { ceo: ["ceo"], manager: ["manager"], worker: ["worker"] };

export function filterTeam<T extends { name: string; role: string }>(
  team: T[],
  query: string,
  unreadOnly: boolean,
  roleOf: (t: T) => string,
  isUnread: (t: T) => boolean,
): T[] {
  const q = query.trim().toLowerCase();
  return team.filter((t) => {
    if (unreadOnly && !isUnread(t)) return false;
    if (!q) return true;
    return t.name.toLowerCase().includes(q) || roleWords(t.role, roleOf(t)).includes(q);
  });
}

// The words of the shown label, split on anything that isn't a letter or digit, plus the stored role's word.
const roleWords = (role: string, label: string): string[] =>
  [...new Set([...(ROLE_WORDS[role] ?? []), ...label.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean)])];
