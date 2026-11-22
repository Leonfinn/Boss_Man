// R43 (BOS-1716): every count the owner sees is one named figure from the server, with one fixed label.
//
// The 17 Nov cock-up: the sidebar badge said 31 and the merge banner said "21 merge checks waiting". Both
// came from the same server read, filtered two ways, and both said "waiting". This list is the rule made
// concrete: each owner-visible count has a name (the server field it comes from) and exactly one label,
// and every place that shows the count writes it with `figureText`. No two figures share a label word
// (`word`, checked in packages/shared/test/owner-figures.test.ts), so two different numbers can never
// read as the same thing. The web's agreement tests (apps/web/test/owner-figures-agreement.test.tsx)
// render every place a figure appears and check they show the same value with the same label.
//
// Adding a count to a screen: add it here first, give it a word no other figure uses, and add the new
// place to that area's agreement test.

export type OwnerFigureArea = "merges" | "decisions" | "feedback" | "notifications" | "agents";

export type OwnerFigure = {
  area: OwnerFigureArea;
  /** Where the number comes from on the server: the route and field. */
  source: string;
  /** The label word or phrase that names this figure and no other: no other figure's label contains it. */
  word: string;
  /** The fixed label with its number: the one way the figure is written anywhere. */
  label: (n: number) => string;
  /** Every place the owner sees it. */
  places: string[];
};

const s = (n: number, one: string, many: string) => (n === 1 ? one : many);

export const OWNER_FIGURES = {
  "mergeQueue.inLine": {
    area: "merges",
    source: "GET /api/companies/:id/merge-queue → waitingCount (approved tickets in the merge line, not counting running merges)",
    word: "in the merge line",
    label: (n) => `${n} in the merge line`,
    places: ["sidebar Merge queue badge", "Merge queue page, Merges tab count", "Dashboard Right now, Merges line", "Merging-slowly banner (Decisions, Dashboard)"],
  },
  "mergeQueue.forBossMan": {
    area: "merges",
    source: "GET /api/companies/:id/merge-queue → line.waiting (the part of the line Boss Man moves by itself; the rest wait on an agent, a card or the owner)",
    word: "for Boss Man to merge",
    label: (n) => `${n} for Boss Man to merge`,
    places: ["Merging-slowly banner", "Dashboard Right now, Merges line", "Merging-slowly notification", "Merges-stuck reason (empty seat, no landing)"],
  },
  "mergeQueue.behindIt": {
    area: "merges",
    source: "GET /api/companies/:id/merge-queue → line.others (the rest of the line behind the stuck merge)",
    word: "behind it",
    label: (n) => `${n} more behind it`,
    places: ["Merges-stuck banner", "Merges-stuck notification"],
  },
  "mergeQueue.lineStuck": {
    area: "merges",
    source: "GET /api/companies/:id/merge-queue → stuckCount (1 while the merge line is stuck, else 0)",
    word: "stuck",
    label: () => "merge line stuck",
    places: ["sidebar Merge queue badge (warning colour)"],
  },
  "mergeQueue.overAnHour": {
    area: "merges",
    source: "GET /api/companies/:id/merge-queue → waiting rows with stuck set (over an hour without moving), not the owner's own or a failed check",
    word: "over an hour",
    label: (n) => `${n} not moved for over an hour`,
    places: ["Merge queue page, status pill"],
  },
  "mergeQueue.checkFailed": {
    area: "merges",
    source: "GET /api/companies/:id/merge-queue → waiting rows in check_failed_retrying, not the owner's own",
    word: "failed",
    label: (n) => `${n} with a failed check`,
    places: ["Merge queue page, status pill"],
  },
  "mergeQueue.heldBehindFix": {
    area: "merges",
    source: "GET /api/companies/:id/merge-queue → line.held (R28: approved tickets held behind a marked fix for main)",
    word: "held behind",
    label: (n) => `${n} approved ${s(n, "ticket is", "tickets are")} held behind`,
    places: ["Merge queue page, Main is red pill", "Held banner and Dashboard Merges line"],
  },
  "mergeQueue.forYou": {
    area: "merges",
    source: "GET /api/companies/:id/merge-queue → waiting rows whose next step is the owner's (a sign-off or a card)",
    word: "for you to answer",
    label: (n) => `${n} for you to answer`,
    places: ["Merge queue page, status pill"],
  },
  "checkQueue.onHold": {
    area: "merges",
    source: "GET /api/companies/:id/check-queue → rows held because main is red",
    word: "on hold",
    label: (n) => `${n} ${s(n, "check", "checks")} on hold`,
    places: ["Merge queue page, Main is red pill"],
  },
  "checkQueue.queued": {
    area: "merges",
    source: "GET /api/companies/:id/check-queue → rows that are not merge checks (running and waiting)",
    word: "quick",
    label: (n) => `${n} quick ${s(n, "check", "checks")}`,
    places: ["Merge queue page, Quick checks tab count"],
  },
  "decisions.needYou": {
    area: "decisions",
    source: "GET /api/decisions/tally → open",
    word: "need",
    label: (n) => `${n} ${s(n, "needs", "need")} you`,
    places: ["sidebar Decisions badge", "company switcher", "Dashboard Needs you count", "Decisions page heading", "Decisions page, other companies line", "a held ticket's start-hold reason (BOS-2196, written by the server)"],
  },
  "decisions.withTeam": {
    area: "decisions",
    source: "GET /api/decisions/tally → waiting (cards with the team, nothing for the owner to do yet)",
    word: "with the team",
    label: (n) => `${n} with the team`,
    places: ["sidebar Decisions badge (hover text)", "Dashboard Needs you footer", "Decisions page heading", "Decisions page, With the team fold"],
  },
  "feedback.toProcess": {
    area: "feedback",
    source: "GET /api/feedback/unprocessed → [companyId]",
    word: "to process",
    label: (n) => `${n} to process`,
    places: ["sidebar Feedback badge", "Feedback page, Unprocessed tab count"],
  },
  "notifications.unread": {
    area: "notifications",
    source: "GET /api/notifications → unread",
    word: "unread",
    label: (n) => `${n} unread`,
    places: ["sidebar Notifications badge", "Notifications page, Unread chip"],
  },
  "runs.running": {
    area: "agents",
    source: "GET /api/runs → length (agent runs going now)",
    word: "running",
    label: (n) => `${n} ${s(n, "agent", "agents")} running now`,
    places: ["Dashboard Right now, Runner line"],
  },
  "usage.held": {
    area: "agents",
    source: "GET /api/companies/:id/dashboard → usage.agents",
    word: "usage limit",
    label: (n) => `${n} ${s(n, "agent", "agents")} held by a usage limit`,
    places: ["Dashboard Right now, Usage limits line"],
  },
} satisfies Record<string, OwnerFigure>;

export type OwnerFigureName = keyof typeof OWNER_FIGURES;

/** The one way to write an owner-visible count: "31 in the merge line". */
export function figureText(name: OwnerFigureName, n: number): string {
  return OWNER_FIGURES[name].label(n);
}

/**
 * The merging-slowly line's two figures, each under its own label, for the server's note and the web's banner alike:
 * "21 for Boss Man to merge (31 in the merge line; the rest are merging now or with an agent or you)".
 */
export function slowLineCounts(s: { waiting: number; inQueue?: number }): string {
  const of = s.inQueue && s.inQueue > s.waiting ? ` (${figureText("mergeQueue.inLine", s.inQueue)}; the rest are merging now or with an agent or you)` : "";
  return `${figureText("mergeQueue.forBossMan", s.waiting)}${of}`;
}
