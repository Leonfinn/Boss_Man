// Token end dates (BOS-2825): a GitHub/Gitea git token usually lasts 90 days and a Claude setup-token about a year.
// When the owner tells Boss Man the day one ends, they get one card a week before, saying which token and how to
// replace it, instead of learning from work that fails with "the token is wrong, expired or revoked".
//
// One card per secret: its `dedupeKey` names the secret, so a repeated pass, a restart or a leader change never
// raises a second one. It closes by itself once the secret's version moves on (a new value was saved). A token
// saved before this change has no date and is skipped: today's behaviour, with no reminder.
import { and, eq, isNotNull, lte } from "drizzle-orm";
import { endsOnDay } from "@boss-man/shared";
import type { Db } from "../db/client.js";
import { secrets } from "../db/schema.js";

/** How long before its end date a token's card is raised: a week, so the owner has time to make a new one. */
export const EXPIRY_WARN_MS = 7 * 86_400_000;

export const tokenExpiryKey = (secretId: string) => `alert:token-expiry:${secretId}`;

/** What the token is, in the owner's words; the secret's name is already the label for it. */
const KIND_NOUN = (kind: string): string => (kind === "claude_oauth_token" ? "Claude setup-token" : "token");

/** How to make a replacement, by kind. */
const MAKE = (t: TokenExpiryCandidate): string =>
  t.kind === "claude_oauth_token"
    ? "run `claude setup-token` on your own computer and sign in"
    : t.name.toLowerCase().includes("gitea")
      ? "in Gitea, create a token with the write:repository scope"
      : "on GitHub, make a fine-grained token for the company's repos with Contents, Pull requests and Workflows read and write, plus Actions read and write";

/**
 * Where to paste it: the Rotate box on this same secret's row of Settings → Secrets, not Add, which would make a
 * new secret and leave this one and its reminder card behind (BOS-2825). The secret is a row on that page, not a
 * page of its own, so it is named in words after the path (the Settings-path guard checks the path part).
 */
const WHERE = (t: TokenExpiryCandidate): string =>
  `Settings → Secrets, find ${t.name} and paste the new value in its Rotate box`;

export type TokenExpiryDeps = {
  now: () => Date;
  homeCompany: () => Promise<string | null>;
  isOpen: (dedupeKey: string) => Promise<boolean>;
  raise: (input: Record<string, unknown>) => Promise<{ id: string } | null | undefined>;
  log?: (m: string) => void;
};

export type TokenExpiryCandidate = { id: string; name: string; kind: string; version: number; expiresAt: string };

/** The secrets whose end date is within the warning window (or already past it), soonest first. `secretId` picks one. */
export async function dueTokens(db: Db, now: Date, secretId?: string): Promise<TokenExpiryCandidate[]> {
  const cutoff = new Date(now.getTime() + EXPIRY_WARN_MS).toISOString().slice(0, 10);
  const rows = await db
    .select({ id: secrets.id, name: secrets.name, kind: secrets.kind, version: secrets.version, expiresAt: secrets.expiresAt })
    .from(secrets)
    .where(and(isNotNull(secrets.expiresAt), lte(secrets.expiresAt, cutoff), ...(secretId ? [eq(secrets.id, secretId)] : [])))
    .orderBy(secrets.expiresAt);
  // A past date still gets a card: the work will fail, and the owner should know why before it does.
  return rows.filter((r): r is TokenExpiryCandidate => !!r.expiresAt);
}

/** The owner-facing card text: which token, the day it ends, and the two steps to replace it. */
export function expiryQuestion(t: TokenExpiryCandidate, now: Date): string {
  // Whole days from today (UTC) to the last day, so "ends today" means the owner's own day, not a 23-hour fraction.
  const today = now.toISOString().slice(0, 10);
  const days = Math.round((Date.parse(`${t.expiresAt}T00:00:00.000Z`) - Date.parse(`${today}T00:00:00.000Z`)) / 86_400_000);
  const when = days < 0 ? "this date has passed, so it may already have stopped working" : days === 0 ? "today" : days === 1 ? "tomorrow" : `in ${days} days`;
  return [
    `Your ${KIND_NOUN(t.kind)} **${t.name}** ends ${endsOnDay(t.expiresAt)} (${when}). Once it ends, runs and work that use it will fail until it is replaced.`,
    `Two steps: 1. Make a new token (${MAKE(t)}). 2. Paste it under ${WHERE(t)}, and give it an end date so the next reminder comes on time.`,
    "This card closes by itself once a new value is saved for this token. You get one card, not one every day.",
  ].join("\n\n");
}

export function tokenExpiryService(db: Db, deps: TokenExpiryDeps) {
  return {
    /** Every secret whose card is due now (for tests and a Settings panel to read). */
    due: () => dueTokens(db, deps.now()),

    /** One pass (the leader's timer): one card per due secret, no duplicate while an earlier one is still open. */
    async check(): Promise<{ raised: string[] }> {
      const t = deps.now();
      const due = await dueTokens(db, t);
      const raised: string[] = [];
      if (!due.length) return { raised };
      const companyId = await deps.homeCompany();
      if (!companyId) return { raised };
      for (const s of due) {
        const key = tokenExpiryKey(s.id);
        if (await deps.isOpen(key)) continue;
        const card = await deps.raise({
          companyId,
          kind: "token_expiry",
          question: expiryQuestion(s, t),
          from: "owner",
          why: "only the owner can make a new token and paste it in",
          dedupeKey: key,
          clearWhen: [{ kind: "secretReplaced", secretId: s.id, version: s.version }],
          context: { tokenExpiry: { secretId: s.id, name: s.name, kind: s.kind, expiresAt: s.expiresAt, version: s.version } },
        });
        if (card) {
          raised.push(s.id);
          deps.log?.(`token expiry: raised the card for ${s.name}`);
        }
      }
      return { raised };
    },
  };
}

export type TokenExpiry = ReturnType<typeof tokenExpiryService>;
