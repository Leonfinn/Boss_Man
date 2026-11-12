import path from "node:path";

/**
 * The folder a run opens in (BOS-1120). A run with a ticket opens in that ticket's checkout; a reply run in its own
 * reply folder; a run with no ticket in a clean per-agent folder under `agents/`, never in `<root>/<agentId>`, which
 * on older runners is a stale copy of some earlier ticket.
 */
export function runFolder(root: string, agentId: string, opts: { ticketId?: string | null; reply?: boolean }): string {
  if (opts.reply) return path.posix.join(root, "reply", agentId);
  if (opts.ticketId) return path.posix.join(root, opts.ticketId);
  return path.posix.join(root, "agents", agentId);
}
