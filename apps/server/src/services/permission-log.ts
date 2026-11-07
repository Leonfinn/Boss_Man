// A record of every permission decision (BOS-306, finding F11 of the architecture review): which
// rule allowed, sent on or refused each request, who answered when it became a card, and which
// tool calls an agent reported as refused. Each entry is one log line carrying the run, ticket and
// agent ids so it can be searched, and the last hour is kept in memory for server_status.
// Nothing is stored in the database: the summary starts again when the server restarts.

export type PermissionLogEntry = {
  at: Date;
  companyId: string;
  runId: string;
  agentId: string | null;
  ticketId: string | null;
  title: string | null;
  kind: string | null;
  /** The rule that matched, and its place in the checked list (0 when it isn't in the list). */
  rule: string;
  position: number;
  /** allow, deny, ceo or owner: what the rules decided. */
  outcome: string;
  /** Where it went: allow or deny, or the tier that holds the card (ceo or owner), which differs from outcome when the CEO is paused or is the asker. */
  tier: string;
  /** Set when the request became a card. */
  decisionId?: string | null;
};

export type RefusedCall = { at: Date; companyId: string; runId: string; agentId: string | null; ticketId: string | null; title: string | null };
type Answer = { at: Date; companyId: string; answeredBy: string };

const HOUR_MS = 60 * 60 * 1000;
const MAX_ENTRIES = 5000;

const quote = (s: string | null | undefined) => JSON.stringify((s ?? "").slice(0, 200));

export function createPermissionLog(opts: { log?: (line: string) => void; now?: () => Date } = {}) {
  const log = opts.log ?? (() => {});
  const now = opts.now ?? (() => new Date());
  let decided: PermissionLogEntry[] = [];
  let refused: RefusedCall[] = [];
  let answers: Answer[] = [];
  let fenced: RefusedCall[] = [];

  function trim() {
    const cutoff = now().getTime() - HOUR_MS;
    decided = decided.filter((e) => e.at.getTime() >= cutoff).slice(-MAX_ENTRIES);
    refused = refused.filter((e) => e.at.getTime() >= cutoff).slice(-MAX_ENTRIES);
    fenced = fenced.filter((e) => e.at.getTime() >= cutoff).slice(-MAX_ENTRIES);
    answers = answers.filter((e) => e.at.getTime() >= cutoff).slice(-MAX_ENTRIES);
  }

  return {
    /** One decision by the rules. */
    decision(e: Omit<PermissionLogEntry, "at">) {
      decided.push({ ...e, at: now() });
      trim();
      log(
        `permission decision run=${e.runId} agent=${e.agentId ?? "-"} ticket=${e.ticketId ?? "-"} tool=${quote(e.title)} kind=${e.kind ?? "-"} rule=${quote(e.rule)} position=${e.position} outcome=${e.outcome} tier=${e.tier}${e.decisionId ? ` card=${e.decisionId}` : ""}`,
      );
    },
    /** A card for a request was answered; answeredBy is "ceo", "owner" or what settled it. */
    answer(e: { companyId: string; runId: string; agentId: string | null; ticketId: string | null; decisionId: string; answeredBy: string; answer: string }) {
      answers.push({ at: now(), companyId: e.companyId, answeredBy: e.answeredBy });
      trim();
      log(`permission answer run=${e.runId} agent=${e.agentId ?? "-"} ticket=${e.ticketId ?? "-"} card=${e.decisionId} answeredBy=${e.answeredBy} answer=${quote(e.answer)}`);
    },
    /** The agent reported a tool call failed with "User refused permission". */
    refusedCall(e: Omit<RefusedCall, "at">) {
      refused.push({ ...e, at: now() });
      trim();
      log(`permission refused tool call run=${e.runId} agent=${e.agentId ?? "-"} ticket=${e.ticketId ?? "-"} tool=${quote(e.title)}`);
    },
    /** A fenced agent's tool call got a kernel refusal (EACCES or EPERM): the fence's watch log (BOS-325). */
    fenceDenied(e: Omit<RefusedCall, "at">) {
      fenced.push({ ...e, at: now() });
      trim();
      log(`fence refused tool call run=${e.runId} agent=${e.agentId ?? "-"} ticket=${e.ticketId ?? "-"} tool=${quote(e.title)}`);
    },
    /** The last hour for one company: each rule's matches by outcome, the cards that reached the CEO and the owner, and refused calls. */
    summary(companyId: string) {
      trim();
      const rules = new Map<string, { rule: string; position: number; outcome: string; matches: number }>();
      const cards = { ceo: 0, owner: 0 };
      for (const e of decided) {
        if (e.companyId !== companyId) continue;
        const key = `${e.position}|${e.rule}|${e.outcome}`;
        const r = rules.get(key) ?? { rule: e.rule, position: e.position, outcome: e.outcome, matches: 0 };
        r.matches++;
        rules.set(key, r);
        if (e.decisionId && e.tier === "ceo") cards.ceo++;
        if (e.decisionId && e.tier === "owner") cards.owner++;
      }
      const answered = { ceo: 0, owner: 0 };
      for (const a of answers) if (a.companyId === companyId && (a.answeredBy === "ceo" || a.answeredBy === "owner")) answered[a.answeredBy]++;
      const mine = refused.filter((r) => r.companyId === companyId);
      const theirs = fenced.filter((r) => r.companyId === companyId);
      return {
        windowMinutes: 60,
        rules: [...rules.values()].sort((a, b) => b.matches - a.matches),
        cardsReached: cards,
        cardsAnswered: answered,
        fenceRefusals: { count: theirs.length, recent: theirs.slice(-10).map((r) => ({ at: r.at.toISOString(), runId: r.runId, ticketId: r.ticketId, agentId: r.agentId, tool: r.title })) },
        refusedCalls: { count: mine.length, recent: mine.slice(-10).map((r) => ({ at: r.at.toISOString(), runId: r.runId, ticketId: r.ticketId, agentId: r.agentId, tool: r.title })) },
      };
    },
  };
}

export type PermissionLog = ReturnType<typeof createPermissionLog>;
