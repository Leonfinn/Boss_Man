import { and, eq, gte, lt, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { decisions } from "../db/schema.js";
import { judgePermission, PUSHING } from "@boss-man/shared";

/** Rows the BOS-339 act level may never touch (band A, hard gates). Everything else the judge can name is band B. */
export const BAND_A_ROWS = ["outward", "secret", "privateNet", "others", "kills", "opaque"] as const;

type Tally = { allow: number; deny: number; uncertain: number };
const tally = (): Tally => ({ allow: 0, deny: 0, uncertain: 0 });

export interface JudgeReport {
  from: string;
  to: string;
  /** Answered permission cards that carry a judge reading. */
  judged: number;
  /** Of those, cards whose human answer was neither an allow nor "Deny" (custom text, "Keep planning"): left out of agreement. */
  unclassified: number;
  /** Cards with a clear human allow or deny. */
  compared: number;
  /** Agreement of the combined advice (rules judge, plus the model if it said deny) with the human. */
  agreement: { agreed: number; compared: number; pct: number | null };
  /** Same, using the rules judge alone. */
  agreementRulesOnly: { agreed: number; compared: number; pct: number | null };
  /** Judge allowed, human denied. Combined advice first; rulesOnly ignores the model. */
  falseAllows: { band: { A: number; B: number; unknown: number }; total: number; rulesOnlyTotal: number };
  /** Same, split by who answered: the CEO settling it, or the owner. */
  answeredBy: { ceo: number; owner: number };
  /** Rules judge: count by row, each split by what the human did. */
  rulesByRow: Record<string, { cards: number; humanAllow: number; humanDeny: number }>;
  rulesVerdicts: Tally;
  /** Model second opinion, only on cards where the rules judge allowed and the model was on. */
  second: { asked: number; allow: number; deny: number; failed: number; pending: number; denyHumanAllowed: number };
}

type Ctx = { explain?: { title?: string; summary?: string; command?: string; push?: { dangerous?: boolean } } };

/**
 * Band of a card, read from the card itself and not from the judge's own row (a judge allow always has row "ok").
 * A: the stored command or text is a hard gate (outward, secret, privateNet, others, kills, opaque), found by re-running
 * the rules on the stored command, a dangerous push reading, or the push/publish pattern. B: anything else.
 * unknown: the card kept no explanation to read.
 */
export function bandOf(ctx: Ctx): "A" | "B" | "unknown" {
  const e = ctx.explain;
  if (!e || (e.command == null && !e.summary)) return "unknown";
  if (e.push?.dangerous) return "A";
  if (e.command && new RegExp(PUSHING).test(e.command)) return "A";
  const again = judgePermission(`${e.title ?? ""}. ${e.summary ?? ""}`, e.command ?? null);
  return (BAND_A_ROWS as readonly string[]).includes(again.row) ? "A" : "B";
}

interface Row { answer: string | null; context: unknown }

/** Pure: turns answered permission rows into the report. Exported for tests. */
export function summarise(rows: Row[], from: Date, to: Date): JudgeReport {
  const r: JudgeReport = {
    from: from.toISOString(), to: to.toISOString(), judged: 0, unclassified: 0, compared: 0,
    agreement: { agreed: 0, compared: 0, pct: null }, agreementRulesOnly: { agreed: 0, compared: 0, pct: null },
    falseAllows: { band: { A: 0, B: 0, unknown: 0 }, total: 0, rulesOnlyTotal: 0 },
    answeredBy: { ceo: 0, owner: 0 }, rulesByRow: {}, rulesVerdicts: tally(),
    second: { asked: 0, allow: 0, deny: 0, failed: 0, pending: 0, denyHumanAllowed: 0 },
  };
  for (const row of rows) {
    const ctx = (row.context ?? {}) as { judge?: { verdict: string; row: string; second?: { state: string } }; always?: { label: string }[]; settled?: unknown };
    const j = ctx.judge;
    if (!j) continue;
    r.judged++;
    const a = row.answer ?? "";
    const human: "allow" | "deny" | null =
      a === "Allow once" || a === "Approve plan" || ctx.always?.some((x) => x.label === a) ? "allow" : a === "Deny" ? "deny" : null;
    const rulesV = j.verdict === "allow" ? "allow" : j.verdict === "deny" ? "deny" : "uncertain";
    r.rulesVerdicts[rulesV]++;
    const byRow = (r.rulesByRow[j.row] ??= { cards: 0, humanAllow: 0, humanDeny: 0 });
    byRow.cards++;
    const s = j.second?.state;
    if (s) {
      r.second.asked++;
      if (s === "allow") r.second.allow++; else if (s === "deny") r.second.deny++; else if (s === "failed") r.second.failed++; else r.second.pending++;
    }
    if (!human) { r.unclassified++; continue; }
    r.compared++;
    ctx.settled ? r.answeredBy.ceo++ : r.answeredBy.owner++;
    if (human === "allow") byRow.humanAllow++; else byRow.humanDeny++;
    if (s === "deny" && human === "allow") r.second.denyHumanAllowed++;
    const combined = s === "deny" ? "deny" : j.verdict;
    r.agreement.compared++;
    if (combined === human) r.agreement.agreed++;
    r.agreementRulesOnly.compared++;
    if (j.verdict === human) r.agreementRulesOnly.agreed++;
    if (j.verdict === "allow" && human === "deny") {
      r.falseAllows.rulesOnlyTotal++;
      if (combined === "allow") {
        r.falseAllows.total++;
        const b = bandOf(ctx as Ctx); if (b === "A") r.falseAllows.band.A++; else if (b === "B") r.falseAllows.band.B++; else r.falseAllows.band.unknown++;
      }
    }
  }
  const pct = (x: { agreed: number; compared: number; pct: number | null }) => { x.pct = x.compared ? Math.round((1000 * x.agreed) / x.compared) / 10 : null; };
  pct(r.agreement); pct(r.agreementRulesOnly);
  return r;
}

/** Read-only: one SELECT over answered permission cards answered in [from, to). */
export async function judgeReport(db: Db, opts: { from: Date; to: Date; companyId?: string }): Promise<JudgeReport> {
  const rows = await db
    .select({ answer: decisions.answer, context: decisions.context })
    .from(decisions)
    .where(and(eq(decisions.kind, "permission"), eq(decisions.status, "answered"), gte(decisions.answeredAt, opts.from), lt(decisions.answeredAt, opts.to), sql`${decisions.context} ? 'judge'`, ...(opts.companyId ? [eq(decisions.companyId, opts.companyId)] : [])));
  return summarise(rows, opts.from, opts.to);
}

export function formatReport(r: JudgeReport): string {
  const p = (x: { agreed: number; compared: number; pct: number | null }) => `${x.pct ?? "n/a"}% (${x.agreed}/${x.compared})`;
  const rows = Object.entries(r.rulesByRow).sort((a, b) => b[1].cards - a[1].cards).map(([k, v]) => `  ${k.padEnd(10)} ${String(v.cards).padStart(5)} cards   human allow ${v.humanAllow}, deny ${v.humanDeny}`);
  return [
    `Permission judge agreement, answered ${r.from.slice(0, 10)} to ${r.to.slice(0, 10)}`,
    `Judged cards: ${r.judged} (${r.compared} with a clear human allow/deny, ${r.unclassified} left out)`,
    `Answered by: CEO ${r.answeredBy.ceo}, owner ${r.answeredBy.owner}`,
    `Agreement, combined advice: ${p(r.agreement)}`,
    `Agreement, rules judge only: ${p(r.agreementRulesOnly)}`,
    `Safety false allows (judge allowed, human denied): ${r.falseAllows.total} (band A ${r.falseAllows.band.A}, band B ${r.falseAllows.band.B}, band unknown ${r.falseAllows.band.unknown}); rules judge alone: ${r.falseAllows.rulesOnlyTotal}`,
    `Rules judge verdicts: allow ${r.rulesVerdicts.allow}, deny ${r.rulesVerdicts.deny}, uncertain ${r.rulesVerdicts.uncertain}`,
    `Model second opinion: asked ${r.second.asked} (allow ${r.second.allow}, deny ${r.second.deny}, failed ${r.second.failed}, pending ${r.second.pending}); said deny but human allowed ${r.second.denyHumanAllowed}`,
    `Per rules-judge row:`,
    ...(rows.length ? rows : ["  (none)"]),
  ].join("\n");
}
