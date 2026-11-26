// What the owner has set up, read from the record (BOS-1596, DR-064 extending DR-046). The CEO told an owner their check
// worker was "set up but idle" when none had ever connected: the claim came from ticket wording, and the record
// (check_workers.last_seen_at) said otherwise. So the record puts the owner's setup in server_status and the CEO brief,
// owner-facing text that contradicts it is held with the live value, and cards can fill worker facts from it.
// Nothing is stored: every figure is read from existing tables and the live socket count.
import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { failingChecks, parseRepoUrl } from "@boss-man/shared";
import { checkWorkers, projects, runners, settings } from "../db/schema.js";
import type { AddonFacts } from "./addons.js";
import { isWorkerOnline, onlineWorkerCount } from "./check-workers.js";
import { clip, day, searchOwnerAnswers } from "./owner-answers.js";
import { ANSWERED_LOOKBACK_MS } from "./stale-requests.js";
import type { GitHostConfig } from "./git-hosts.js";
import type { HostFactsRecord } from "./host-facts.js";
import { HOST_REPORT_FRESH_MS } from "./host-facts.js";
import { PHONE_TEST_KEY, type PhoneTestRecord } from "./notifications.js";

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

export const kindsOf = (w: { takes: string; mergeKept: number }) =>
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

// ── Questions the record answers (BOS-1797, R48; DR-064 extended from statements to questions) ──────────────────
// The rows above hold text that *states* something the record contradicts. These hold a *question* to the owner
// that the record already answers ("does your phone reach the Tailscale address?" when the phone tapped Got it
// through it). Each row says which questions it answers (`asks`, narrow on purpose) and reads the answer from the
// record with its time (`answer`). The rule is R34's: a definite, fresh value refuses the card and gives the raiser
// the value; a value the record can't vouch for any more (too old, or a setting it depends on changed) lets the card
// through with a warning and the record line on it; no value says nothing. Never on ticket_reply: a reply that
// mentions a fact doesn't ask the owner anything.

/** What the ask rows read. Each source is optional: a row whose source is missing is unknown, which never refuses. */
export type AskRecord = {
  now: Date;
  /** The public address saved on the Notifications page now (null: none). */
  publicUrl: string | null;
  /** The last test push (null: none sent). */
  phoneTest: PhoneTestRecord | null;
  /** The host's facts as last reported (Settings → This host). */
  host?: HostFactsRecord;
  /** The add-on states server_status shows. */
  addons?: AddonFacts;
};

/** The record's answer to a question. `fresh` false: the record has a value but can't vouch it still holds (`staleWhy`). */
export type RecordAnswer = { value: string; source: string; at: string | null; fresh: boolean; staleWhy?: string };
/** `answer` gives no entry when the record doesn't know, which never refuses or warns. */
type AskRow = { key: string; asks: (text: string) => boolean; answer: (r: AskRecord, text: string) => RecordAnswer[] };

/** A tap on Got it is proof for this long; past it the phone may have changed (Tailscale removed, a new phone). */
export const PHONE_PROOF_FRESH_MS = 30 * 24 * 3_600_000;

const isQuestion = (t: string) => /\?|\b(?:does|do you|is it|is there|are you|can (?:you|it|your)|still)\b/i.test(t);
/** "On your phone / laptop": the owner's own device, which no server-side add-on state describes. */
const ON_OWNER_DEVICE = /\bon (?:your|the|their) (?:own )?(?:phone|tablet|laptop|computer|mac|pc|desktop)\b/i;
const sameUrl = (a: string | null | undefined, b: string | null | undefined) => !!a && !!b && a.trim().replace(/\/+$/, "").toLowerCase() === b.trim().replace(/\/+$/, "").toLowerCase();
const utc = (iso: string) => `${iso.slice(0, 16).replace("T", " ")} UTC`;
const ADDON_NAMES: Record<string, string> = { ntfy: "ntfy", tailscale: "Tailscale", penpot: "Penpot" };

const ASK_TABLE: AskRow[] = [
  {
    // Card 82647439 (BOS-1603): "the box 'Boss Man's address on your phone' holds your Tailscale name … Keep it?"
    // A tap on Got it travels from the phone to `${publicUrl}/api/phone/got-it`, so it proves the phone reached the
    // address the test used. It says nothing about an address saved after the test.
    key: "ntfy.phoneReachesAddress",
    asks: (t) =>
      /\bphones?\b/i.test(t) &&
      // BOS-2685: a bare "address", "url", "open" or "can" matched a keyboard-shortcuts plan question that mentioned a phone.
      // The question must be about how the phone reaches Boss Man: Tailscale, the address the phone uses, push or ntfy.
      /\b(?:tailscale|tailnet|ts\.net|ntfy|(?:public|boss man'?s|phone'?s|server) (?:address|url)|address on your phone|reach(?:es)? boss man)\b/i.test(t) &&
      /\b(?:keep|does|do you|works?|working|right value|reach(?:es)?)\b/i.test(t) &&
      isQuestion(t),
    answer: (r) => {
      const p = r.phoneTest;
      if (!p?.confirmedAt) return []; // never confirmed: the record doesn't know
      const source = "server_status addons.ntfy.phone (the owner's tap on Got it on a test push)";
      const at = p.confirmedAt;
      if (!p.url) return [{ value: `the phone tapped Got it on a test push at ${utc(at)}, but that test is from before Boss Man kept the address it used`, source, at, fresh: false, staleWhy: "the test record doesn't say which address it tested; a new test push from the Notifications page would" }];
      const value = `the phone reached Boss Man at ${p.url}: it tapped Got it on a test push at ${utc(at)}`;
      if (!sameUrl(p.url, r.publicUrl)) return [{ value, source, at, fresh: false, staleWhy: r.publicUrl ? `the public address has changed since, to ${r.publicUrl.replace(/\/+$/, "")}` : "no public address is saved now" }];
      if (r.now.getTime() - Date.parse(at) > PHONE_PROOF_FRESH_MS) return [{ value, source, at, fresh: false, staleWhy: "that tap is more than 30 days old" }];
      return [{ value, source, at, fresh: true }];
    },
  },
  {
    // Card 5c87e6d4 (BOS-1584): "Does the This host panel still show repo.probe as failed, or the standby colour as a failing check?"
    key: "host.checks",
    asks: (t) => /\b(?:repo\.probe|failing checks?|checks? (?:is |are )?(?:still )?fail(?:ing|ed)?|this host panel|(?:probe|check)\b[^.?\n]{0,40}\bfail(?:s|ed|ing)?)\b/i.test(t) && isQuestion(t),
    answer: (r) => {
      const h = r.host;
      if (!h?.reportedAt) return [];
      const probe = h.facts["repo.probe"]?.value.trim();
      const bad = failingChecks(h.facts);
      const value = `${probe ? `repo.probe = ${probe}` : "repo.probe not reported"}; ${bad.length ? `failing: ${bad.map((k) => `${k} = ${h.facts[k]!.value.trim()}`).join(", ")}` : "no failing check"} (host report at ${utc(h.reportedAt)})`;
      const source = "server_status hostFacts (Settings → This host)";
      const age = r.now.getTime() - Date.parse(h.reportedAt);
      if (!Number.isFinite(age) || age > HOST_REPORT_FRESH_MS) return [{ value, source, at: h.reportedAt, fresh: false, staleWhy: "the host's last report is more than 30 minutes old, so the deployer may have stopped reporting" }];
      return [{ value, source, at: h.reportedAt, fresh: true }];
    },
  },
  {
    // "Is ntfy / Tailscale / Penpot running?" Boss Man's own view of the add-on, not one on the owner's phone or laptop.
    // ntfy "running" means only that ntfy accepted the last push (BOS-1482); whether the phone got it is the row above.
    key: "addons.running",
    // Only a question about its state ("is Penpot still running?"); "Set up Tailscale?" asks the owner to do it.
    asks: (t) => !ON_OWNER_DEVICE.test(t) && /\b(?:is|are|was|were|has|have)\b[^.?\n]{0,30}\b(?:ntfy|tailscale|penpot)\b[^.?\n]{0,30}\b(?:running|up|started|stopped|installed|set up)\b[^.\n]{0,40}\?/i.test(t),
    // One answer per add-on the text names: "is Tailscale running?" is answered from Tailscale's state only.
    answer: (r, text) => {
      if (!r.addons) return [];
      const out: RecordAnswer[] = [];
      for (const name of ["ntfy", "tailscale", "penpot"] as const) {
        if (!new RegExp(String.raw`\b${name}\b`, "i").test(text)) continue;
        const f = r.addons[name];
        if (!f || f.state === "unknown") continue; // Boss Man can't see it: say nothing
        out.push({ value: `${ADDON_NAMES[name]} is ${f.state.replace(/_/g, " ")}${f.since ? ` (since ${utc(f.since)})` : ""}: ${f.source}`, source: `server_status addons.${name}`, at: f.since, fresh: true });
      }
      return out;
    },
  },
  {
    // "Have you saved a public address?" The Notifications page's own setting: live, so always fresh.
    key: "publicAddress.set",
    asks: (t) => /\bpublic (?:address|url)\b/i.test(t) && /\b(?:have you|did you|is there|do you have|is (?:a|the|your) public|has (?:a|the) public)\b/i.test(t) && isQuestion(t),
    answer: (r) => [{ value: r.publicUrl ? `the public address saved on the Notifications page is ${r.publicUrl.replace(/\/+$/, "")}` : "no public address is saved on the Notifications page", source: "server_status ownerSetup (Notifications → public address)", at: null, fresh: true }],
  },
];

/** What the record says about the questions a card asks: settled (refuse unless stillNeeded), stale (warn), or null (unknown or not asked). */
export type AskAnswered = { kind: "settled" | "stale"; line: string; message: string };

/** The record line a card carries at its head when it is raised anyway (stillNeeded) or the record is stale. */
export function recordHeadLine(a: AskAnswered, stillNeeded?: string): string {
  return `Boss Man's record says: ${a.line}.${stillNeeded?.trim() ? ` Asked because: ${stillNeeded.trim()}` : a.kind === "stale" ? " The record may be out of date, so this is asked." : ""}`;
}

/** Pure part of ownerFactAnswered, for tests: which rows the text asks, and what the record says. */
export function answerFromRecord(texts: Array<string | null | undefined>, r: AskRecord): AskAnswered | null {
  const text = texts.filter(Boolean).join("\n");
  if (!text) return null;
  const fired = ASK_TABLE.filter((row) => row.asks(text));
  const answers = fired.flatMap((row) => row.answer(r, text));
  if (!answers.length) return null;
  // BOS-2700: say which row matched, so a wrong match (BOS-2685) can be traced without the refused text, which isn't kept.
  const rules = ` (matched rule: ${fired.filter((row) => row.answer(r, text).length).map((row) => row.key).join(", ")})`;
  const fresh = answers.filter((a) => a.fresh);
  if (fresh.length) {
    const line = fresh.map((a) => `${a.value} (${a.source})`).join("; ");
    return { kind: "settled", line, message: `Not raised. Boss Man already knows the answer to this question: ${line}${rules}. Use that and carry on without asking the owner. If you believe the record is out of date, raise it again with stillNeeded saying why: the card then goes to the CEO first, with this record line at its head.` };
  }
  const line = answers.map((a) => `${a.value} (${a.source}; may be out of date: ${a.staleWhy})`).join("; ");
  return { kind: "stale", line, message: `Boss Man's record has a value for this question but can't vouch for it now: ${line}${rules}. The card carries that line at its head and goes to the CEO first.` };
}

/** Reads the record the ask rows need and answers the card's question from it (BOS-1797). Only for owner asks: raise_decision and notify_owner. */
export async function ownerFactAnswered(
  db: Db,
  sources: { host?: () => Promise<HostFactsRecord>; addons?: () => Promise<AddonFacts>; now?: () => Date },
  texts: Array<string | null | undefined>,
): Promise<AskAnswered | null> {
  const text = texts.filter(Boolean).join("\n");
  if (!text || !ASK_TABLE.some((row) => row.asks(text))) return null; // most cards ask nothing the record holds: no reads
  const [notify] = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, "notifications"));
  const [test] = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, PHONE_TEST_KEY));
  const record: AskRecord = {
    now: sources.now ? sources.now() : new Date(),
    publicUrl: (notify?.value as { publicUrl?: string | null } | undefined)?.publicUrl ?? null,
    phoneTest: (test?.value as PhoneTestRecord | undefined) ?? null,
    host: sources.host ? await sources.host().catch(() => undefined) : undefined,
    addons: sources.addons ? await sources.addons().catch(() => undefined) : undefined,
  };
  return answerFromRecord([text], record);
}
