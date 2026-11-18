// What the owner has set up, read from the record (BOS-1596, DR-064 extending DR-046). The CEO told an owner their check
// worker was "set up but idle" when none had ever connected: the claim came from ticket wording, and the record
// (check_workers.last_seen_at) said otherwise. So the record puts the owner's setup in server_status and the CEO brief,
// owner-facing text that contradicts it is held with the live value, and cards can fill worker facts from it.
// Nothing is stored: every figure is read from existing tables and the live socket count.
import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { parseRepoUrl } from "@boss-man/shared";
import { checkWorkers, projects, runners, settings } from "../db/schema.js";
import { isWorkerOnline, onlineWorkerCount } from "./check-workers.js";
import { clip, day, searchOwnerAnswers } from "./owner-answers.js";
import { ANSWERED_LOOKBACK_MS } from "./stale-requests.js";
import type { GitHostConfig } from "./git-hosts.js";

export type OwnerRecordFacts = {
  checkWorkers: {
    /** Workers the owner has added. */
    added: number;
    /** Workers that have connected at least once: a worker counts as installed only once last_seen_at is set. */
    everConnected: number;
    /** Workers with an open socket on this server now. */
    online: number;
  };
  /** This company's runner: whether one is registered and whether it has ever connected. */
  runner: { registered: boolean; everConnected: boolean };
  /** Whether the git token can read GitHub Actions (R34, BOS-1670): a live probe, filled only when text claims something about it. */
  gitTokenActionsRead?: "yes" | "no" | "unknown";
  /** Whether the owner has saved a public address for Boss Man (Notifications, publicUrl). */
  publicAddress: { set: boolean };
};

/** Answers whether a company's git token can read GitHub Actions runs right now; "unknown" when it can't tell. */
export type GitTokenProbe = (companyId: string) => Promise<"yes" | "no" | "unknown">;

/**
 * The live probe behind the git-token fact (R34): one checkAccess read of the company's first GitHub project, cached
 * for ten minutes so a run of cards doesn't hit GitHub each time. Only a clear answer is cached; no GitHub project, no
 * token, or a failed read gives "unknown", which never holds any text.
 */
export function gitTokenActionsProbe(deps: {
  db: Db;
  gitHosts: { checkAccess(cfg: GitHostConfig, token: string): Promise<{ ok: boolean; canReadChecks?: boolean }> };
  gitToken: (companyId: string) => Promise<string | undefined>;
  now?: () => Date;
  ttlMs?: number;
}): GitTokenProbe {
  // lost on restart, harmless because the next ask just runs one more probe (a cache only saves GitHub calls)
  const cache = new Map<string, { at: number; value: "yes" | "no" }>();
  const now = () => (deps.now ? deps.now().getTime() : Date.now());
  return async (companyId) => {
    const hit = cache.get(companyId);
    if (hit && now() - hit.at < (deps.ttlMs ?? 600_000)) return hit.value;
    try {
      const rows = await deps.db.select({ repoUrl: projects.repoUrl, gitHost: projects.gitHost, gitApiBase: projects.gitApiBase }).from(projects).where(eq(projects.companyId, companyId));
      const p = rows.find((r) => r.gitHost === "github" && r.repoUrl && r.gitApiBase);
      const addr = p?.repoUrl ? parseRepoUrl(p.repoUrl) : null;
      const token = await deps.gitToken(companyId);
      if (!p || !addr || !token) return "unknown";
      const r = await deps.gitHosts.checkAccess({ kind: "github", apiBase: p.gitApiBase!, owner: addr.owner, repo: addr.repo }, token);
      if (!r.ok) return "unknown"; // refused or unreachable: the token itself may be the fault, so don't claim anything
      const value = r.canReadChecks ? "yes" : "no";
      cache.set(companyId, { at: now(), value });
      return value;
    } catch {
      return "unknown";
    }
  };
}

export async function ownerSetupFacts(db: Db, companyId: string): Promise<OwnerRecordFacts> {
  // Only workers granted to this company count as its setup; a worker with no companies runs nobody's checks.
  const workers = (await db.select({ lastSeenAt: checkWorkers.lastSeenAt, companyIds: checkWorkers.companyIds }).from(checkWorkers)).filter((w) => w.companyIds.includes(companyId));
  const [runner] = await db.select({ lastSeenAt: runners.lastSeenAt }).from(runners).where(eq(runners.companyId, companyId));
  const [notify] = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, "notifications"));
  const publicUrl = (notify?.value as { publicUrl?: string | null } | undefined)?.publicUrl;
  return {
    checkWorkers: { added: workers.length, everConnected: workers.filter((w) => w.lastSeenAt).length, online: onlineWorkerCount() },
    runner: { registered: !!runner, everConnected: !!runner?.lastSeenAt },
    publicAddress: { set: !!publicUrl },
  };
}

/** The line the CEO reads: "Check workers: 0 added · 0 ever connected · 0 online". */
export const workersLine = (f: OwnerRecordFacts) => `Check workers: ${f.checkWorkers.added} added · ${f.checkWorkers.everConnected} ever connected · ${f.checkWorkers.online} online`;

/** The "Owner's setup" lines for the brief: worker counts and the runner, with what a count means. */
export function ownerSetupLines(f: OwnerRecordFacts): string[] {
  return [
    `- ${workersLine(f)}. A worker is installed only once it has connected; with 0 ever connected, never call one set up, existing or idle.`,
    `- Runner: ${!f.runner.registered ? "none registered" : f.runner.everConnected ? "has connected" : "registered, never connected"}.`,
    `- Public address: ${f.publicAddress.set ? "set" : "not set; never ask the owner to open Boss Man from outside their network"}.`,
  ];
}

const kindsOf = (w: { takes: string; mergeKept: number }) =>
  w.takes === "merge" ? "merge checks only" : w.takes === "checks" ? "quick checks only" : w.mergeKept > 0 ? `all checks, ${w.mergeKept} slot${w.mergeKept === 1 ? "" : "s"} kept for merges` : "all checks";

/**
 * One line per check worker (R49, BOS-1815): its name, what kinds of check it takes, whether it is online, and the owner's
 * newest answered card that names it in the last 30 days, so the CEO sees what the owner last decided about a machine
 * before offering to change it. Read live; nothing is stored.
 */
export async function workerSetupLines(db: Db, companyId: string): Promise<string[]> {
  const workers = (await db.select({ id: checkWorkers.id, name: checkWorkers.name, takes: checkWorkers.takes, mergeKept: checkWorkers.mergeKept, enabled: checkWorkers.enabled, companyIds: checkWorkers.companyIds }).from(checkWorkers)).filter((w) => w.companyIds.includes(companyId));
  const since = new Date(Date.now() - ANSWERED_LOOKBACK_MS);
  const lines: string[] = [];
  for (const w of workers) {
    const name = w.name.trim();
    // Only a card that names the machine counts: a name made of common words must not pull in unrelated answers.
    const hits = name ? (await searchOwnerAnswers(db, { companyId, q: name, since, kinds: ["card"], limit: 50 })).filter((h) => `${h.question ?? ""} ${h.answer} ${h.ownerNote ?? ""}`.toLowerCase().includes(name.toLowerCase())) : [];
    const last = hits.sort((a, b) => b.at.getTime() - a.at.getTime())[0];
    const word = last ? `owner's last word: card ${last.sourceId.slice(0, 8)}${last.ticketRef ? ` (${last.ticketRef})` : ""} ${day(last.at).slice(0, 10)}, asked "${clip(last.question ?? "", 100)}", owner: "${clip(last.answer, 100)}"` : "no owner card on it in 30 days";
    lines.push(`- Worker ${clip(name, 40)}: ${kindsOf(w)} · ${w.enabled ? "on" : "switched off"} · ${isWorkerOnline(w.id) ? "online" : "offline"} · ${word}`);
  }
  return lines;
}

/** `{{checkWorkers.added}}`, `{{checkWorkers.everConnected}}`, `{{checkWorkers.online}}`: card steps filled from the record, like `{{host}}`. */
const WORKER_TOKEN = /\{\{\s*checkWorkers\.([A-Za-z]+)\s*\}\}/g;
export function fillOwnerSetupTokens(steps: readonly string[], facts: OwnerRecordFacts | undefined): { steps: string[]; missing: string[] } {
  const missing = new Set<string>(); // not state: local to this call
  const values: Record<string, number | undefined> = facts ? { ...facts.checkWorkers } : {};
  const filled = steps.map((s) =>
    s.replace(WORKER_TOKEN, (token, key: string) => {
      const v = Object.hasOwn(values, key) ? values[key] : undefined;
      if (v === undefined) { missing.add(key); return token; }
      return String(v);
    }),
  );
  return { steps: filled, missing: [...missing] };
}

/** True when the text uses a worker token at all (so the record is only read for cards that need it). */
export const usesOwnerSetupToken = (steps: readonly string[]) => steps.some((s) => new RegExp(WORKER_TOKEN.source).test(s));

// One row per fact: the phrases that claim it and when the record contradicts the claim. A claim in an instruction
// ("add your worker", "install the worker") is not a claim about what exists, so those verbs before it are skipped.
const NOT_AN_INSTRUCTION = String.raw`(?<!\b(?:add|create|install|start|connect|register|build|download|set up|setting up|new|first|another|a)\s)`;
type FactRow = { key: string; claims: RegExp[]; contradicted: (f: OwnerRecordFacts) => boolean; live: (f: OwnerRecordFacts) => string; hold: (live: string) => string };
const FACT_TABLE: FactRow[] = [
  {
    key: "checkWorkers.installed",
    claims: [
      new RegExp(String.raw`${NOT_AN_INSTRUCTION}\b(?:your|existing|current|installed|set[- ]up)\s+(?:check[- ])?workers?\b`, "i"),
      /\b(?:check[- ])?workers?\b[^.\n]{0,30}\b(?:set up but idle|sits? idle|sitting idle|(?:is|are|went|goes|gone) idle|already (?:set up|installed|connected))\b/i,
      new RegExp(String.raw`${NOT_AN_INSTRUCTION}\bsecond machine\b`, "i"), // "add a second machine", "do you have a second machine?" ask for one
    ],
    contradicted: (f) => f.checkWorkers.everConnected === 0,
    live: (f) => workersLine(f),
    hold: (live) => `This text says the owner has a check worker installed, existing, set up or idle (or a second machine), but the record says: ${live}. A worker counts as installed only once it has connected, and none ever has. Say what the record says. If the record itself is wrong (for example a worker that connected but was never recorded), fix the record first. Source: server_status ownerSetup.`,
  },
  {
    // R34 (BOS-1670): offers to change the git token's Actions access, or says it has none, while a live read says it has.
    key: "gitToken.actionsRead",
    claims: [
      /\b(?:give|grant|add|enable|allow|change|update|edit|regenerate|replace|widen|extend)\b[^.\n]{0,60}\btokens?\b[^.\n]{0,80}\b(?:actions?|ci (?:logs?|results?|runs?)|(?:test|workflow|build|ci) logs?)\b/i,
      /\b(?:give|grant|add|enable)\b[^.\n]{0,40}\bactions?\b[^.\n]{0,20}\b(?:read|permission|access)\b[^.\n]{0,60}\btokens?\b/i,
      /\btokens?\b[^.\n]{0,40}\b(?:has no|lacks?|doesn'?t have|does not have|can'?t read|cannot read|isn'?t able to read|without)\b[^.\n]{0,30}\b(?:actions?|ci (?:logs?|results?)|(?:test|workflow|build) logs?)\b/i,
    ],
    contradicted: (f) => f.gitTokenActionsRead === "yes",
    live: () => "the git token can read GitHub Actions runs (a live check just now)",
    hold: (live) => `This text offers to change the git token, or says it can't read CI, but a live check says: ${live}. Don't ask the owner to change the token. Agents can't read CI logs because they never hold the token (BOS-322); Boss Man reads them for you (main's CI watcher and the merge gate's bounce). Say what the live check says. If a read really fails, the check would say so.`,
  },
  {
    // A step that needs Boss Man reachable from outside the owner's network cannot be done with no public address.
    key: "publicAddress.outside",
    claims: [
      /\b(?:open|reach|use|visit|log ?in to|sign in to|connect to|get to)\b[^.\n]{0,60}\b(?:from outside|outside (?:of )?(?:your|the|their)|away from (?:your|the) (?:home )?(?:network|wifi))\b/i,
      /\b(?:open|reach|use|visit|log ?in to|connect to)\b[^.\n]{0,40}\bon (?:mobile data|cellular|4g|5g|your phone'?s data)\b/i,
    ],
    contradicted: (f) => !f.publicAddress.set,
    live: () => "Public address: not set",
    hold: (live) => `This text asks the owner to reach Boss Man from outside their network, but no public address is set, so they cannot. Say how to set one first (Notifications), or drop the step; it passes once one is set. The record says: ${live}. Source: server_status ownerSetup.`,
  },
];

/**
 * The hold text when owner-facing text claims something the record contradicts (BOS-1596), or null. Narrow on purpose:
 * only the rows above, only when the record has a value that disagrees. Text that agrees, or a fact with no record,
 * is never held; this is not a fact-checker for prose.
 */
export async function ownerFactHeld(db: Db, companyId: string, ...texts: Array<string | null | undefined>): Promise<string | null> {
  return ownerFactHeldLive(db, companyId, undefined, texts);
}

/** As ownerFactHeld, with the live git-token probe (R34): the probe runs only when the text claims something about the token. */
export async function ownerFactHeldLive(db: Db, companyId: string, probe: GitTokenProbe | undefined, texts: Array<string | null | undefined>): Promise<string | null> {
  const text = texts.filter(Boolean).join("\n");
  if (!text) return null;
  const hits = FACT_TABLE.filter((r) => r.claims.some((c) => c.test(text)));
  if (!hits.length) return null;
  const facts = await ownerSetupFacts(db, companyId);
  if (probe && hits.some((r) => r.key === "gitToken.actionsRead")) facts.gitTokenActionsRead = await probe(companyId).catch(() => "unknown" as const);
  const bad = hits.filter((r) => r.contradicted(facts));
  if (!bad.length) return null;
  return `Not sent. ${bad.map((r) => r.hold(r.live(facts))).join(" ")}`;
}
