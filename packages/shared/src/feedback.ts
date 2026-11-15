// Feature requests: feedback notes, features, and how features are prioritised. Ideas from
// Productboard (notes whose highlighted passages are linked to features with an importance,
// a demand score from those links, criteria scored 0 to 5, and a portal); the scoring below is
// Boss Man's own.
import type { Horizon } from "./roadmap.js";

export const IMPORTANCE = ["nice_to_have", "important", "critical"] as const;
export type Importance = (typeof IMPORTANCE)[number];
export const IMPORTANCE_POINTS: Record<Importance, number> = { nice_to_have: 1, important: 2, critical: 3 };
export const IMPORTANCE_LABEL: Record<Importance, string> = { nice_to_have: "Nice to have", important: "Important", critical: "Critical" };

export const FEATURE_STATUSES = ["idea", "considering", "planned", "in_progress", "released", "declined"] as const;
export type FeatureStatus = (typeof FEATURE_STATUSES)[number];

/**
 * Where a feature sits on the roadmap's Now / Next / Later columns. A person can pin it;
 * otherwise it follows its status: work in progress is Now, planned work is Next, and an
 * idea or one still being considered is Later. Released features sit in their own list.
 */
export function featureHorizon(f: { status: FeatureStatus; horizon: Horizon | null }): Horizon | "released" {
  if (f.status === "released") return "released";
  if (f.horizon) return f.horizon;
  if (f.status === "in_progress") return "now";
  if (f.status === "planned") return "next";
  return "later";
}

export const NOTE_SOURCES = ["owner", "chat", "agent", "portal", "email", "import"] as const;
export type NoteSource = (typeof NOTE_SOURCES)[number];

/**
 * Demand: how much people want a feature. Each linked insight scores its importance (1 to 3),
 * but a customer counts once per feature, at the most important level they asked for, so one
 * loud customer can't outweigh many quiet ones. Insights with no customer count separately.
 */
export function demandScore(insights: Array<{ customerKey: string | null; importance: Importance }>): number {
  const byCustomer = new Map<string, number>();
  let anonymous = 0;
  for (const i of insights) {
    const points = IMPORTANCE_POINTS[i.importance];
    if (i.customerKey) byCustomer.set(i.customerKey, Math.max(byCustomer.get(i.customerKey) ?? 0, points));
    else anonymous += points;
  }
  let total = anonymous;
  for (const p of byCustomer.values()) total += p;
  return total;
}

export type DriverScore = { weight: number; value: number | null };

/** Effort assumed for a feature nobody has sized yet: medium. */
export const DEFAULT_EFFORT = 3;

/**
 * Priority: value for effort.
 * - Value (0 to 5) is the weighted average of the feature's demand, scaled so the company's
 *   most wanted feature scores 5, and each criterion the feature has been scored on (0 to 5).
 * - Effort is 1 (tiny) to 5 (huge); unsized counts as 3.
 * - Priority = value × 3 ÷ effort, so medium effort leaves value as it is, small effort raises
 *   it and big effort lowers it. The result runs from 0 to 15.
 */
export function priorityScore(input: { demand: number; maxDemand: number; demandWeight: number; drivers: DriverScore[]; effort: number | null }) {
  const demandPart = input.maxDemand > 0 ? (input.demand / input.maxDemand) * 5 : 0;
  let weighted = demandPart * input.demandWeight;
  let weights = input.demandWeight;
  for (const d of input.drivers) {
    if (d.value === null || d.weight <= 0) continue;
    weighted += Math.max(0, Math.min(5, d.value)) * d.weight;
    weights += d.weight;
  }
  const value = weights > 0 ? weighted / weights : 0;
  const effort = Math.max(1, Math.min(5, input.effort ?? DEFAULT_EFFORT));
  const priority = (value * DEFAULT_EFFORT) / effort;
  const round = (n: number) => Math.round(n * 10) / 10;
  return { value: round(value), demandPart: round(demandPart), effort, priority: round(priority) };
}

const STOP = new Set(
  "the and for with that this from have has had was were are you your our can could would should will into about when what which their there them they then than also just like need needs want wants make made more some any all not but its it's i'm don't doesn't please".split(" "),
);

/** Lower-case word stems of 3 letters or more, without common words. */
export function keywords(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.toLowerCase().match(/[a-z0-9][a-z0-9'-]{2,}/g) ?? []) {
    if (STOP.has(raw)) continue;
    out.add(raw.replace(/(ing|ed|es|s)$/, "").replace(/'$/, ""));
  }
  return out;
}

/**
 * Features a note may be about, best first: the words the note shares with each feature's
 * title, description and the passages already linked to it. Title words count double. A plain
 * word match, not AI; it's a starting point for the person (or agent) doing the linking.
 */
export function suggestFeatures<T extends { id: string; title: string; description?: string | null; highlights?: string[] }>(text: string, features: T[], limit = 5): Array<{ feature: T; score: number; shared: string[] }> {
  const note = keywords(text);
  if (!note.size) return [];
  const scored = features.map((f) => {
    const title = keywords(f.title);
    const body = keywords([f.description ?? "", ...(f.highlights ?? [])].join(" "));
    const shared = [...note].filter((w) => title.has(w) || body.has(w));
    const score = shared.reduce((s, w) => s + (title.has(w) ? 2 : 1), 0) / Math.sqrt(title.size + body.size || 1);
    return { feature: f, score: Math.round(score * 100) / 100, shared };
  });
  return scored.filter((s) => s.score > 0).sort((a, b) => b.score - a.score).slice(0, limit);
}

/**
 * The title a visitor sees on the feedback portal (BOS-991): the public title when one is written, otherwise the first
 * line of the public summary, so the internal title never reaches visitors. Null when neither is written.
 */
export function portalTitle(publicTitle: string | null | undefined, publicSummary: string | null | undefined): string | null {
  const title = publicTitle?.trim();
  if (title) return title;
  const summary = publicSummary?.trim();
  if (!summary) return null;
  return summary.split(/\r?\n/, 1)[0]!.trim().slice(0, 200) || null;
}

/** A feature is kept off the portal for one of two reasons: someone marked it, or the words say it's security work. */
export type PortalHoldReason = "sensitive" | "security";
/** What the portal rule says about a feature. */
export type PortalVerdict =
  | { onPortal: boolean; reason: null }
  /** Off the portal: the manual mark wins, or the area/criteria/title/description make it security work. */
  | { onPortal: false; reason: PortalHoldReason }
  /** Ticked on, but held back until a public summary exists (the portal shows the internal title and description). */
  | { onPortal: false; reason: "needs public summary" };

/** Single words that make a feature security work when they appear in its title, description, area or criteria. */
const SECURITY_WORDS = new Set([
  "security", "secure", "permission", "permissions", "credential", "credentials", "secret", "secrets", "token", "tokens",
  "password", "passwords", "vulnerability", "vulnerable", "exploit", "auth", "authentication", "authorisation", "authorization",
  "sandbox", "firewall", "encrypt", "encryption", "decrypt", "crypto", "cryptography", "ssh", "ssl", "tls",
  "certificate", "certificates", "privilege", "privileges", "sudo", "acl", "hostname", "hostnames",
]);
/** An IPv4 address, so a summary naming the server's own address is caught (BOS-1419): four dot-separated groups of 1-3
 * digits that don't run on into a fifth group or a word. A trailing full stop ("...50.") still counts. */
const IPV4 = /(?<![\w.])\d{1,3}(?:\.\d{1,3}){3}(?!\.?\d)/;
/** Phrases that make a feature security work even though each word on its own could be ordinary. "keys" and "key" are not
 * here on their own because a shortcut key or a sort key isn't security work. */
const SECURITY_PHRASES = ["access control", "api key", "api keys", "private key", "network guard", "agent fence", "key rotation", "role based"];

/** Whether text reads as security work: a security word, one of the security phrases, or an IP address. A simple rule, not AI. */
export function looksLikeSecurity(text: string): boolean {
  const lower = text.toLowerCase();
  // Split on anything that isn't a letter or digit, so "token-based" and "the token's expiry" count as "token",
  // the same way the migration's SQL word boundaries do.
  const words = lower.match(/[a-z0-9]+/g) ?? [];
  if (words.some((w) => SECURITY_WORDS.has(w) || SECURITY_WORDS.has(w.replace(/s$/, "")))) return true;
  if (IPV4.test(lower)) return true;
  return SECURITY_PHRASES.some((p) => lower.includes(p));
}

/** Whether text reads as security work by a security phrase only, ignoring the single security words. Criteria are
 * scoring axes a feature is graded on ("Security" means "how much this improves security", not "this is security
 * work"), so a bare word like that must not flag every feature scored on it (BOS-1260). A real phrase still does
 * (BOS-991: "Keeps the agent fence sound"). */
export function looksLikeSecurityPhrase(text: string): boolean {
  const lower = text.toLowerCase();
  return SECURITY_PHRASES.some((p) => lower.includes(p));
}

/**
 * Whether a feature goes on the feedback portal by default (BOS-957). A feature is off, and says why, when
 * someone marked it "keep off the portal (sensitive)"; that mark always wins. Otherwise, once it has a public
 * summary, only the text a visitor would actually see is judged — the stored public title and the stored public
 * summary — because the internal title and description never reach visitors (BOS-1419). Without a public summary
 * the internal title and description are judged, as before, so internal wording alone can't put a feature out.
 * The area and criteria are still read, as they describe the work whoever reads it. No model call.
 */
export function portalVerdict(input: {
  title: string;
  description?: string | null;
  publicTitle?: string | null;
  publicSummary?: string | null;
  area?: string | null;
  criteria?: string[];
  keepOffPortal?: boolean;
  hasPublicSummary?: boolean;
}): PortalVerdict {
  if (input.keepOffPortal) return { onPortal: false, reason: "sensitive" };
  const summary = input.publicSummary?.trim();
  const hasPublicSummary = input.hasPublicSummary ?? !!summary;
  // Judge the stored values, never a decoy supplied in the same call (BOS-991). With a public summary the visitor sees
  // its first line as the title, so the public title and public summary are what matters; without one, the internal title
  // and description are judged as before (BOS-1419).
  const judged = summary ? [input.publicTitle ?? "", summary, portalTitle(input.publicTitle, summary) ?? ""].join(" ") : [input.title, input.description ?? ""].join(" ");
  if (looksLikeSecurity([judged, input.area ?? ""].join(" "))) return { onPortal: false, reason: "security" };
  // A criterion is a scoring axis, so only a security phrase in one counts ("agent fence"), never a bare word
  // such as a criterion simply named "Security" (BOS-1260).
  if (looksLikeSecurityPhrase((input.criteria ?? []).join(" "))) return { onPortal: false, reason: "security" };
  if (!hasPublicSummary) return { onPortal: false, reason: "needs public summary" };
  return { onPortal: true, reason: null };
}

/** The statuses whose features can reach the portal (the rest are rejected or dropped work). */
export const PORTAL_STATUSES = ["idea", "considering", "planned", "in_progress", "released"] as const;

/** Why a ticked feature is not on the portal: the words are the owner-facing fix (BOS-1496). */
export type PortalNotShown = "kept off (sensitive)" | "looks like security work" | "needs public summary" | "status not shown";
export type PortalShowVerdict = { shown: true } | { shown: false; ticked: boolean; reason: PortalNotShown | null };

/**
 * The one rule for whether a feature reaches portal visitors: ticked on, not marked keep-off, a status the portal
 * lists, a public summary, and no security wording in what visitors would read. The portal's own query and the
 * Features page both call this, so the page can't promise what the portal won't show (BOS-1496).
 */
export function portalShows(f: { portalVisible: boolean; keepOffPortal: boolean; status: string; publicTitle?: string | null; publicSummary?: string | null }): PortalShowVerdict {
  const ticked = f.portalVisible;
  if (f.keepOffPortal) return { shown: false, ticked, reason: "kept off (sensitive)" };
  if (!(PORTAL_STATUSES as readonly string[]).includes(f.status)) return { shown: false, ticked, reason: ticked ? "status not shown" : null };
  const summary = f.publicSummary?.trim();
  if (!summary) return { shown: false, ticked, reason: "needs public summary" };
  if (looksLikeSecurity([f.publicTitle ?? "", summary].join(" "))) return { shown: false, ticked, reason: "looks like security work" };
  return ticked ? { shown: true } : { shown: false, ticked, reason: null };
}
