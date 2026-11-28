// BOS-2814: never leave a first task silently stuck. What keeps a company's agents from starting (a Claude account,
// what pays for the CEO, a connected runner) is read once from the server and shown as a red bar on the Dashboard and
// Decisions, and as a "Not started" line on a task whose assignee can't run. Every message has a button to the fix.
import { api } from "../api";
import { usePoll } from "../hooks";

export type StartBlockItem = { id: "claude" | "funding" | "runner"; label: string };
export type StartBlock = { items: StartBlockItem[]; noFunding: string[] };

/** The missing must-haves for a company, read every 15 s; null until the first read (or if it fails: no bar then). */
export function useStartBlock(companyId: string | undefined): StartBlock | null {
  const read = usePoll((signal) => (companyId ? api<StartBlock>(`/api/companies/${companyId}/start-block`, { signal }).then((b) => (Array.isArray(b?.items) ? { items: b.items, noFunding: Array.isArray(b.noFunding) ? b.noFunding : [] } : null), () => null) : Promise.resolve(null)), 15_000, `start-block-${companyId ?? "none"}`);
  return read.data ?? null;
}

/** "a Claude account and a connected runner", at most two named, then "and 1 more". */
export function missingText(items: StartBlockItem[]): string {
  const named = items.slice(0, 2).map((i) => i.label);
  const more = items.length - named.length;
  return `${named.join(" and ")}${more > 0 ? ` and ${more} more` : ""}`;
}

/** The red bar. It has no dismiss button and renders nothing once nothing is missing. */
export function StartBlockBar({ block }: { block: StartBlock | null }) {
  if (!block || block.items.length === 0) return null;
  return (
    <div className="banner start-block" role="alert" data-testid="start-block-bar">
      <span>
        <strong>Your agents can't start yet.</strong> Missing: {missingText(block.items)}.
      </span>
      <a className="btn primary" href="#/setup">Finish setting up</a>
    </div>
  );
}

/** Why this agent can't run, with the fix link, or null when it can. */
export function notStartedReason(block: StartBlock | null, agentId: string | null | undefined, agentName: string | null | undefined, companyId: string): { text: string; link: string; linkText: string } | null {
  if (!block || !agentId) return null;
  const who = agentName ?? "The assignee";
  const noAccount = block.items.some((i) => i.id === "claude") || block.noFunding.includes(agentId);
  if (noAccount) return { text: `Not started: ${who} has no Claude account to run on yet.`, link: "#/setup", linkText: "Connect one" };
  if (block.items.some((i) => i.id === "runner")) return { text: `Not started: the runner isn't connected.`, link: `#/settings/${companyId}/runner`, linkText: "Start it" };
  return null;
}
