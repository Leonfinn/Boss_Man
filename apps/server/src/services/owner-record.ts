// What the owner has set up, read from the record (BOS-1596, DR-064 extending DR-046). The CEO told an owner their check
// worker was "set up but idle" when none had ever connected: the claim came from ticket wording, and the record
// (check_workers.last_seen_at) said otherwise. So the record puts the owner's setup in server_status and the CEO brief,
// owner-facing text that contradicts it is held with the live value, and cards can fill worker facts from it.
// Nothing is stored: every figure is read from existing tables and the live socket count.
import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { checkWorkers, runners } from "../db/schema.js";
import { onlineWorkerCount } from "./check-workers.js";

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
};

export async function ownerSetupFacts(db: Db, companyId: string): Promise<OwnerRecordFacts> {
  const workers = await db.select({ lastSeenAt: checkWorkers.lastSeenAt }).from(checkWorkers);
  const [runner] = await db.select({ lastSeenAt: runners.lastSeenAt }).from(runners).where(eq(runners.companyId, companyId));
  return {
    checkWorkers: { added: workers.length, everConnected: workers.filter((w) => w.lastSeenAt).length, online: onlineWorkerCount() },
    runner: { registered: !!runner, everConnected: !!runner?.lastSeenAt },
  };
}

/** The line the CEO reads: "Check workers: 0 added · 0 ever connected · 0 online". */
export const workersLine = (f: OwnerRecordFacts) => `Check workers: ${f.checkWorkers.added} added · ${f.checkWorkers.everConnected} ever connected · ${f.checkWorkers.online} online`;

/** The "Owner's setup" lines for the brief: worker counts and the runner, with what a count means. */
export function ownerSetupLines(f: OwnerRecordFacts): string[] {
  return [
    `- ${workersLine(f)}. A worker is installed only once it has connected; with 0 ever connected, never call one set up, existing or idle.`,
    `- Runner: ${!f.runner.registered ? "none registered" : f.runner.everConnected ? "has connected" : "registered, never connected"}.`,
  ];
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
type FactRow = { key: string; claims: RegExp[]; contradicted: (f: OwnerRecordFacts) => boolean; live: (f: OwnerRecordFacts) => string };
const FACT_TABLE: FactRow[] = [
  {
    key: "checkWorkers.installed",
    claims: [
      new RegExp(String.raw`${NOT_AN_INSTRUCTION}\b(?:your|existing|current|installed|set[- ]up)\s+(?:check[- ])?workers?\b`, "i"),
      /\b(?:check[- ])?workers?\b[^.\n]{0,30}\b(?:set up but idle|sits? idle|sitting idle|(?:is|are|went|goes|gone) idle|already (?:set up|installed|connected))\b/i,
      /\bsecond machine\b/i,
    ],
    contradicted: (f) => f.checkWorkers.everConnected === 0,
    live: (f) => workersLine(f),
  },
];

/**
 * The hold text when owner-facing text claims something the record contradicts (BOS-1596), or null. Narrow on purpose:
 * only the rows above, only when the record has a value that disagrees. Text that agrees, or a fact with no record,
 * is never held; this is not a fact-checker for prose.
 */
export async function ownerFactHeld(db: Db, companyId: string, ...texts: Array<string | null | undefined>): Promise<string | null> {
  const text = texts.filter(Boolean).join("\n");
  if (!text) return null;
  const hits = FACT_TABLE.filter((r) => r.claims.some((c) => c.test(text)));
  if (!hits.length) return null;
  const facts = await ownerSetupFacts(db, companyId);
  const bad = hits.filter((r) => r.contradicted(facts));
  if (!bad.length) return null;
  return `Not sent. This text says the owner has a check worker installed, existing, set up or idle (or a second machine), but the record says: ${bad.map((r) => r.live(facts)).join("; ")}. A worker counts as installed only once it has connected, and none ever has. Say what the record says, or, if you have newer proof than the record, say how you know. Source: server_status ownerSetup.`;
}
