// BOS-2490: filter Chat's team list by name or role, and optionally to agents with a new reply.
// Order is kept; the open conversation is never touched.
export function filterTeam<T extends { name: string }>(team: T[], query: string, unreadOnly: boolean, roleOf: (t: T) => string, isUnread: (t: T) => boolean): T[] {
  const q = query.trim().toLowerCase();
  return team.filter((t) => (!q || t.name.toLowerCase().includes(q) || roleOf(t).toLowerCase().includes(q)) && (!unreadOnly || isUnread(t)));
}
