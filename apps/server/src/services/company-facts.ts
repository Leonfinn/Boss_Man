// Company facts on owner cards (DR-057 points 3 and 4, BOS-1285). Host facts (DR-008, host-facts.ts) say where things
// are on the server; company facts say what another company has set up in Boss Man, read from the server's own
// record rather than typed from memory. An agent can't see another company's deploy targets (the `deploy` tool is
// scoped to its own company), but the server can: `deploy_targets` is read here by company id at check time.
//
// - `{{company.<slug>.deployTarget.<field>}}` (name, kind, address, tagName) is filled from that company's deploy
//   target. A token with no record behind it stays, and R4 refuses it: at go-live the steps then go to the CEO's
//   fix card (DR-052 point 4), never to the owner.
// - A step starting `[if company.<slug>.deployTarget exists]` or `[if company.<slug>.deployTarget is missing]` is
//   kept or dropped by the record, so the owner never has to settle "if it isn't listed" themselves.
// - R18b: a literal value for another company's form must cite `engagement:<id>`, an engagement that company
//   answered for this one. The cite becomes "(confirmed by <company> on <date>)" on the card.
//
// The slug is the company's name in lower case with dashes ("Holiday Hours" is holiday-hours), as the launcher writes it.

import { and, desc, eq, inArray } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { companies, deployTargets, engagementMessages, engagements } from "../db/schema.js";
import { liveTagOf } from "./deploys.js";
import { BRANCH_MARKER, COMPANY_TOKEN, fieldValues, formsIn } from "./owner-form-steps.js";
import type { LintFinding } from "./steps.js";

/** A company's name as a token slug: lower case, dashes, at most 40 characters. */
export function companySlug(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

/** The deploy target a token reads: its fields as the card shows them. */
export type TargetFacts = { name: string; kind: string; address: string; tagName: string | null };
export type CompanyFact = {
  id: string;
  name: string;
  slug: string;
  /** The company's one deploy target (or its one production target); null when it has none; "several" when it can't tell. */
  target: TargetFacts | null | "several";
};
export type EngagementFact = { providerCompanyId: string; requesterCompanyId: string; answeredAt: string | null };
export type CompanyFacts = { own: { id: string; name: string }; companies: CompanyFact[]; engagements: Record<string, EngagementFact> };

const KIND_LABEL: Record<string, string> = { ssh: "SSH host", docker: "Docker endpoint", git: "Git remote" };
const ENGAGEMENT = /\bengagement:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/gi;

/** Which target a token means: the only one, or the only production one. */
export function pickTarget(rows: Array<{ name: string; kind: string; endpoint: string; isProduction: boolean; rules: unknown }>): CompanyFact["target"] {
  const pick = rows.length === 1 ? rows[0] : rows.filter((r) => r.isProduction).length === 1 ? rows.find((r) => r.isProduction) : undefined;
  if (!rows.length) return null;
  if (!pick) return "several";
  return { name: pick.name, kind: KIND_LABEL[pick.kind] ?? pick.kind, address: pick.endpoint, tagName: liveTagOf({ rules: pick.rules as never })?.name ?? null };
}

/**
 * Read what the steps need from the database: every company's name (to see which steps are about another company),
 * the deploy targets of the companies they name, and the engagements they cite. Nothing is read for steps that need
 * nothing, beyond the company names.
 */
export async function loadCompanyFacts(db: Db, ownCompanyId: string, steps: readonly string[]): Promise<CompanyFacts | undefined> {
  if (!steps.length) return undefined;
  const all = await db.select({ id: companies.id, name: companies.name }).from(companies);
  const own = all.find((c) => c.id === ownCompanyId);
  if (!own) return undefined;
  const text = steps.join("\n");
  const others = all.filter((c) => c.id !== ownCompanyId);
  const wanted = others.filter((c) => namedIn(text, c.name, companySlug(c.name)));
  const targets = wanted.length ? await db.select().from(deployTargets).where(inArray(deployTargets.companyId, wanted.map((c) => c.id))) : [];
  const ids = [...new Set([...text.matchAll(ENGAGEMENT)].map((m) => m[1]!.toLowerCase()))];
  const engs = ids.length ? await db.select().from(engagements).where(inArray(engagements.id, ids)) : [];
  const facts: CompanyFacts = {
    own,
    companies: others.map((c) => ({ id: c.id, name: c.name, slug: companySlug(c.name), target: wanted.includes(c) ? pickTarget(targets.filter((t) => t.companyId === c.id)) : null })),
    engagements: {},
  };
  for (const e of engs) {
    const [reply] = await db
      .select({ at: engagementMessages.createdAt })
      .from(engagementMessages)
      .where(and(eq(engagementMessages.engagementId, e.id), eq(engagementMessages.fromCompanyId, e.providerCompanyId), inArray(engagementMessages.kind, ["message", "delivered"])))
      .orderBy(desc(engagementMessages.createdAt))
      .limit(1);
    facts.engagements[e.id] = { providerCompanyId: e.providerCompanyId, requesterCompanyId: e.requesterCompanyId, answeredAt: reply ? reply.at.toISOString() : null };
  }
  return facts;
}

/** Whether a step names a company: its name as a word, or its slug in a token or branch. */
function namedIn(text: string, name: string, slug: string): boolean {
  const word = new RegExp(String.raw`(?<![\p{L}\p{N}])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\p{L}\p{N}])`, "iu");
  return word.test(text) || text.includes(`company.${slug}.`);
}

/**
 * Fill company facts into the steps and run R18b. `mode` "raise" drops the branch that doesn't apply; "write" keeps
 * both (markers taken off) so the author's lint sees each. Returns the steps as the owner will read them and the
 * findings; unfilled tokens are left for R4.
 */
export function fillCompanyFacts(steps: readonly string[], facts: CompanyFacts | undefined, mode: "write" | "raise"): { steps: string[]; findings: LintFinding[] } {
  if (!facts) return { steps: [...steps], findings: [] };
  const findings: LintFinding[] = [];
  const bySlug = new Map(facts.companies.map((c) => [c.slug, c]));
  const out: string[] = [];
  steps.forEach((raw, i) => {
    const step = i + 1;
    let text = raw;
    const m = BRANCH_MARKER.exec(text);
    if (m) {
      const c = bySlug.get(m[1]!.toLowerCase());
      if (!c) { findings.push({ step, rule: "R4", problem: `starts a branch on company "${m[1]}", which isn't a company in Boss Man. Use the company's name in lower case with dashes (${facts.companies.map((x) => x.slug).join(", ") || "no other companies"})` }); out.push(text); return; }
      const wantsMissing = /missing/i.test(m[2]!);
      if (mode === "raise") {
        if (c.target === "several") { out.push(text); return; } // R4 refuses the marker: Boss Man can't tell which target
        if (wantsMissing !== (c.target === null)) return; // the branch that doesn't apply
      }
      text = text.slice(m[0].length);
      // No record to fill from in the "missing" branch: its values have to be written (and, R18b, confirmed).
      if (wantsMissing && new RegExp(String.raw`\{\{\s*company\.${c.slug}\.`).test(text)) findings.push({ step, rule: "R4", problem: `uses a {{company.${c.slug}.deployTarget.…}} token in the step for when ${c.name} has no deploy target, so there is nothing to fill it from. Write the values, citing the engagement:<id> ${c.name} answered with them` });
    }
    findings.push(...r18b(step, text, facts));
    text = text.replace(ENGAGEMENT, (all, id: string) => {
      const e = facts.engagements[id.toLowerCase()];
      const by = e && facts.companies.find((c) => c.id === e.providerCompanyId);
      return e?.answeredAt && by ? `(confirmed by ${by.name} on ${e.answeredAt.slice(0, 10)})` : all;
    });
    text = text.replace(COMPANY_TOKEN, (token, slug: string, field: string) => {
      const t = bySlug.get(slug)?.target;
      if (!t || t === "several" || !Object.hasOwn(t, field)) return token;
      const v = t[field as keyof TargetFacts];
      return typeof v === "string" && v.trim() && !/[\n\r`]/.test(v) ? v : token;
    });
    out.push(text);
  });
  return { steps: out, findings };
}

/**
 * R18b: a step that fills in one of Boss Man's forms for another company with a value typed into the card (not a
 * company token) must cite the engagement that company answered with it. The owner can't check a value only the
 * other company knows, so the card says who confirmed it and when.
 */
function r18b(step: number, text: string, facts: CompanyFacts): LintFinding[] {
  const prose = text.replace(/```[\s\S]*?```/g, " ");
  const form = formsIn(prose)[0];
  if (!form) return [];
  const named = facts.companies.filter((c) => namedIn(prose, c.name, c.slug));
  if (!named.length) return [];
  const literal = [...fieldValues(form, prose)].filter(([label, kind]) => kind === "literal" && !form.required.concat(...(form.groups ?? []).map((g) => g.fields)).find((f) => f.label === label)?.secret).map(([label]) => label);
  if (!literal.length) return [];
  const cited = [...prose.matchAll(ENGAGEMENT)].map((m) => m[1]!.toLowerCase());
  const out: LintFinding[] = [];
  for (const c of named) {
    const good = cited.find((id) => {
      const e = facts.engagements[id];
      return e && e.providerCompanyId === c.id && e.requesterCompanyId === facts.own.id && e.answeredAt;
    });
    if (good) continue;
    const why = cited.length
      ? `the engagement it cites isn't one ${c.name} answered for ${facts.own.name} (it must exist, have ${c.name} as the provider and carry their reply)`
      : `it cites no engagement`;
    out.push({ step, rule: "R18b", problem: `gives ${literal.map((l) => `"${l}"`).join(", ")} for ${c.name}'s ${form.name} as typed values, but ${why}. Only ${c.name} knows these: take them from {{company.${c.slug}.deployTarget.<field>}} where Boss Man has a record, or cite engagement:<id> for ${c.name}'s answer, and the card will say who confirmed it and when` });
  }
  return out;
}
