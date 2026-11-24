// The optional model second opinion on permission cards (BOS-338, DR-005). Off by default, per company.
// It calls any OpenAI-compatible /chat/completions endpoint the owner set (OpenRouter, Synthetic, a local
// server). Every failure (off, no key, slow, down, out of credit, a bad answer) comes back as "failed",
// and the caller then lets the rules judge decide alone. It never answers a card.
import { and, eq, gte, sql } from "drizzle-orm";
import { z } from "zod";
import { SECOND_OPINION_DEADLINE_MS, parseSecondOpinion, redactForModel, secondOpinionSystemPrompt, secondOpinionUserPrompt } from "@boss-man/shared";
import type { Db } from "../db/client.js";
import { decisions, settings } from "../db/schema.js";
import { record } from "./activity.js";

export const SecondOpinionSettings = z.object({
  enabled: z.boolean(),
  /** Empty until set up. Any OpenAI-compatible base address, e.g. https://openrouter.ai/api/v1 or a local http://host:11434/v1. */
  baseUrl: z.union([z.literal(""), z.string().trim().url().max(300).regex(/^https?:\/\//, "Must start with http:// or https://")]),
  model: z.string().trim().max(200),
  /** The API key, as a secret in the encrypted store. A local server may need none. */
  secretId: z.string().uuid().nullable(),
});
export type SecondOpinionSettings = z.infer<typeof SecondOpinionSettings>;
export const SECOND_OPINION_DEFAULTS: SecondOpinionSettings = { enabled: false, baseUrl: "", model: "", secretId: null };

export type SecondOpinionResult = { verdict: "allow" | "deny"; reason: string } | { failed: string };
export type SecondOpinionCard = { question: string; command: string | null; ownTicket?: string | null };

/** How the model did on the last 24 h of cards (BOS-1052), from each card's own judge.second record. */
export type SecondOpinionWindow = {
  answered: number; allowed: number; denied: number; fellBack: number; pending: number; reasons: Array<{ reason: string; count: number }>;
  /** Answered cards whose rules-judge verdict was also stored, and how many of those matched the model. agreement is null when none (shown as "not recorded"). */
  bothVerdicts: number; agreed: number; agreement: number | null;
  /** Cards per UTC day, oldest first; empty for the 24 h window. */
  perDay: Array<{ day: string; cards: number }>;
};
export type SecondOpinionStatsAll = { last24h: SecondOpinionWindow; last7d: SecondOpinionWindow; last30d: SecondOpinionWindow };
export type SecondOpinionStats = SecondOpinionWindow;

const key = (companyId: string) => `second-opinion:${companyId}`;

/** A retry after a 429 is made only if the wait is at most this... */
const MAX_RETRY_WAIT_MS = 2_000;
/** ...and at least this much of the deadline is left after it, so a retry never slows a card past the deadline. */
const MIN_TIME_FOR_RETRY_MS = 1_500;
/** An upstream 429 without Retry-After: one short pause, since a busy shared provider often frees up within a second. */
const UPSTREAM_PAUSE_MS = 500;

/**
 * What the provider said in an error body, cleaned for display (BOS-1052). OpenRouter sends
 * { error: { message, code, metadata: { provider_name, raw } } }; others send { error: { message } } or plain text.
 * The key is cut out and the text redacted like a card, since it is shown on the page, stored on cards and logged.
 */
export function providerSaid(body: string, apiKey: string | null): { said: string | null; provider: string | null; upstream: boolean } {
  let message: string | null = null;
  let provider: string | null = null;
  let raw: string | null = null;
  try {
    const j = JSON.parse(body) as { error?: unknown; message?: unknown };
    const err = (j && typeof j.error === "object" && j.error ? j.error : typeof j.error === "string" ? { message: j.error } : j) as { message?: unknown; metadata?: { provider_name?: unknown; raw?: unknown } };
    if (typeof err.message === "string") message = err.message;
    if (typeof err.metadata?.provider_name === "string") provider = err.metadata.provider_name;
    const r = err.metadata?.raw;
    if (typeof r === "string") raw = r;
    else if (r && typeof r === "object") {
      const inner = (r as { error?: { message?: unknown }; message?: unknown }).error?.message ?? (r as { message?: unknown }).message;
      if (typeof inner === "string") raw = inner;
    }
  } catch {
    // Not JSON: plain text is shown as it is, an HTML error page isn't.
    if (!/^\s*</.test(body)) message = body;
  }
  const clean = (t: string | null): string | null => {
    if (!t) return null;
    const noKey = apiKey && apiKey.length >= 8 ? t.split(apiKey).join("[key]") : t;
    const out = redactForModel(noKey).replace(/\s+/g, " ").trim();
    return out ? (out.length > 200 ? `${out.slice(0, 199)}…` : out) : null;
  };
  // The upstream's own words (raw) are the most specific; OpenRouter's message is often just "Provider returned error".
  const said = clean(raw) ?? clean(message);
  const p = clean(provider);
  return { said, provider: p, upstream: !!p || /upstream/i.test(`${raw ?? ""} ${message ?? ""}`) };
}

/** The failure in plain words, with what the owner can do about it (BOS-1052). */
export function describeFailure(status: number, body: string, apiKey: string | null, baseUrl: string): { text: string; upstream: boolean } {
  const { said, provider, upstream } = providerSaid(body, apiKey);
  const openRouter = /^https?:\/\/([^/]*\.)?openrouter\.ai(\/|:|$)/i.test(baseUrl);
  const quote = said ? `: "${said}"` : "";
  if (status === 429 && upstream) {
    const who = provider ? `${provider}, the company that runs this model for ${openRouter ? "OpenRouter" : "the provider"},` : "the company that runs this model for the provider";
    return { upstream, text: `${who} is too busy and is turning requests away (429)${quote}. This is not a limit on your key. Try again later, or pick another suggested model` };
  }
  if (status === 429) return { upstream, text: `your key or account has hit the provider's rate limit (429)${quote}. Wait a minute and try again; if it keeps happening, check the key's limits${openRouter ? " at openrouter.ai/settings/keys" : " with the provider"}` };
  if (status === 402) return { upstream, text: `the provider says your account is out of credit (402)${quote}. Add credit${openRouter ? " at openrouter.ai/settings/credits" : " with the provider"}` };
  if (status === 401 || status === 403) return { upstream, text: `the provider refused the key (${status})${quote}. Check the key picked below is the right one${openRouter ? ", and that its spending limit at openrouter.ai/settings/keys isn't used up" : ""}` };
  if (status === 404) return { upstream, text: `the provider doesn't offer this model (404)${quote}. Check the model name` };
  if (status === 200) return { upstream, text: `the provider sent an error instead of an answer${quote}` };
  return { upstream, text: `the provider answered ${status}${quote}` };
}

/** Retry-After as milliseconds (seconds or an HTTP date); null when absent or unreadable. */
function retryAfterMs(h: string | null, nowMs: number): number | null {
  if (!h) return null;
  const s = h.trim();
  if (/^\d+(\.\d+)?$/.test(s)) return Math.round(Number(s) * 1000);
  const at = Date.parse(s);
  return Number.isNaN(at) ? null : Math.max(0, at - nowMs);
}

export function secondOpinionService(
  db: Db,
  deps: { reveal: (secretId: string) => Promise<string | null>; fetch?: typeof fetch; workspaceRoot?: string; deadlineMs?: number; now?: () => Date },
) {
  const doFetch = deps.fetch ?? fetch;
  const deadline = deps.deadlineMs ?? SECOND_OPINION_DEADLINE_MS;
  const now = deps.now ?? (() => new Date());

  async function getSettings(companyId: string): Promise<SecondOpinionSettings> {
    const [row] = await db.select().from(settings).where(eq(settings.key, key(companyId)));
    const parsed = SecondOpinionSettings.safeParse(row?.value);
    return parsed.success ? parsed.data : SECOND_OPINION_DEFAULTS;
  }

  async function call(s: SecondOpinionSettings, card: SecondOpinionCard): Promise<SecondOpinionResult> {
    let apiKey: string | null = null;
    if (s.secretId) {
      apiKey = await deps.reveal(s.secretId).catch(() => null);
      if (!apiKey) return { failed: "its API key is missing from Secrets" };
    }
    const ctl = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const slow = new Promise<SecondOpinionResult>((resolve) => {
      timer = setTimeout(() => (ctl.abort(), resolve({ failed: `no answer within ${Math.round(deadline / 1000)} s` })), deadline);
    });
    const started = Date.now();
    const body = JSON.stringify({
      model: s.model,
      temperature: 0,
      max_tokens: 1000,
      messages: [
        { role: "system", content: secondOpinionSystemPrompt(deps.workspaceRoot ?? "/workspaces") },
        { role: "user", content: secondOpinionUserPrompt(card) },
      ],
    });
    // Error text is the provider's own words, cleaned by describeFailure: never the request body, never the key.
    const ask = (async (): Promise<SecondOpinionResult> => {
      for (let attempt = 1; ; attempt++) {
        let res: Response;
        try {
          res = await doFetch(`${s.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
            method: "POST",
            headers: { "content-type": "application/json", ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
            body,
            // A redirect could carry the key somewhere the owner didn't choose.
            redirect: "error",
            signal: ctl.signal,
          });
        } catch {
          return { failed: ctl.signal.aborted ? `no answer within ${Math.round(deadline / 1000)} s` : "the provider could not be reached" };
        }
        if (res.ok) {
          const data = (await res.json().catch(() => null)) as { choices?: Array<{ message?: { content?: unknown } }>; error?: unknown } | null;
          // OpenRouter can send 200 with only an error (the provider failed after the headers went out).
          if (data && !data.choices && data.error) return { failed: describeFailure(200, JSON.stringify(data), apiKey, s.baseUrl).text };
          const answer = parseSecondOpinion(data?.choices?.[0]?.message?.content);
          return answer ?? { failed: "the model's answer wasn't a valid verdict" };
        }
        const text = (await res.text().catch(() => "")).slice(0, 20_000);
        const failure = describeFailure(res.status, text, apiKey, s.baseUrl);
        // At most one retry, and only on a 429 that says (or, upstream, is likely) to clear quickly, with time left.
        if (res.status === 429 && attempt === 1) {
          const wait = retryAfterMs(res.headers.get("retry-after"), Date.now()) ?? (failure.upstream ? UPSTREAM_PAUSE_MS : null);
          if (wait !== null && wait <= MAX_RETRY_WAIT_MS && Date.now() - started + wait + MIN_TIME_FOR_RETRY_MS <= deadline) {
            await new Promise((r) => setTimeout(r, wait));
            if (ctl.signal.aborted) return { failed: `no answer within ${Math.round(deadline / 1000)} s` };
            continue;
          }
        }
        return { failed: attempt > 1 ? `${failure.text}. Boss Man tried twice` : failure.text };
      }
    })();
    try {
      return await Promise.race([ask, slow]);
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    settings: getSettings,

    async setSettings(companyId: string, s: SecondOpinionSettings): Promise<SecondOpinionSettings> {
      const value = SecondOpinionSettings.parse(s);
      if (value.enabled && (!value.model || !value.baseUrl)) throw new Error("Set the provider address and the model first.");
      const before = await getSettings(companyId);
      await db.insert(settings).values({ key: key(companyId), value }).onConflictDoUpdate({ target: settings.key, set: { value } });
      // One "settings" line per real change (like permission rules, BOS-1963). Model name, host and on/off only:
      // never the key, its secret id, or any path or query of the address.
      const host = (u: string) => { try { return new URL(u).host; } catch { return ""; } };
      const parts: string[] = [];
      if (value.enabled !== before.enabled) parts.push(value.enabled ? `turned the second opinion on (model ${value.model})` : "turned the second opinion off");
      else {
        const changes: string[] = [];
        if (value.model !== before.model) changes.push(`model to ${value.model || "none"}`);
        if (host(value.baseUrl) !== host(before.baseUrl)) changes.push(`provider address to ${host(value.baseUrl) || "none"}`);
        if (changes.length) parts.push(`changed the second opinion ${changes.join(" and ")}${value.enabled ? "" : " (it stays off)"}`);
      }
      if (parts.length) await record(db, { companyId, kind: "settings", summary: `Owner ${parts[0]}`, detail: { change: "second-opinion", enabled: value.enabled, model: value.model, host: host(value.baseUrl) } });
      return value;
    },

    /** Whether a card would be sent: on, with a model. One small read, no outside call. */
    async enabled(companyId: string): Promise<boolean> {
      const s = await getSettings(companyId);
      return s.enabled && !!s.baseUrl && !!s.model;
    },

    /** Asks the model about one card. Never throws; every failure is { failed }. */
    async ask(companyId: string, card: SecondOpinionCard): Promise<SecondOpinionResult> {
      try {
        const s = await getSettings(companyId);
        if (!s.enabled || !s.baseUrl || !s.model) return { failed: "it is off" };
        return await call(s, card);
      } catch {
        return { failed: "it could not be asked" };
      }
    },

    /**
     * The last 24 h of cards the model was asked about (BOS-1052): answered (allow/deny) vs fell back to the rules judge,
     * with the commonest reasons. Read from each card's judge.second, so it counts what really happened on cards.
     */
    async stats(companyId: string): Promise<SecondOpinionStatsAll> {
      const state = sql<string>`${decisions.context} #>> '{judge,second,state}'`;
      const reason = sql<string | null>`${decisions.context} #>> '{judge,second,reason}'`;
      const verdict = sql<string | null>`${decisions.context} #>> '{judge,verdict}'`;
      const day = sql<string>`to_char(${decisions.createdAt} at time zone 'UTC', 'YYYY-MM-DD')`;
      const window = async (hours: number, withDays: boolean): Promise<SecondOpinionWindow> => {
        const since = new Date(now().getTime() - hours * 3600_000);
        const rows = await db
          .select({ state, reason, verdict, day, n: sql<number>`count(*)::int` })
          .from(decisions)
          .where(and(eq(decisions.companyId, companyId), eq(decisions.kind, "permission"), gte(decisions.createdAt, since), sql`${decisions.context} #> '{judge,second}' IS NOT NULL`))
          .groupBy(state, reason, verdict, day);
        const out: SecondOpinionWindow = { answered: 0, allowed: 0, denied: 0, fellBack: 0, pending: 0, reasons: [], bothVerdicts: 0, agreed: 0, agreement: null, perDay: [] };
        const reasons = new Map<string, number>();
        const days = new Map<string, number>();
        for (const r of rows) {
          const n = Number(r.n);
          if (r.state === "allow") out.allowed += n;
          else if (r.state === "deny") out.denied += n;
          else if (r.state === "pending") out.pending += n;
          else if (r.state === "failed") {
            out.fellBack += n;
            const k = r.reason ?? "no reason recorded";
            reasons.set(k, (reasons.get(k) ?? 0) + n);
          }
          if ((r.state === "allow" || r.state === "deny") && (r.verdict === "allow" || r.verdict === "deny")) {
            out.bothVerdicts += n;
            if (r.state === r.verdict) out.agreed += n;
          }
          if (r.state !== "pending") days.set(r.day, (days.get(r.day) ?? 0) + n);
        }
        out.answered = out.allowed + out.denied;
        // null means "not recorded": no card in the window kept both verdicts, so no rate is guessed.
        out.agreement = out.bothVerdicts > 0 ? out.agreed / out.bothVerdicts : null;
        out.reasons = [...reasons].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count).slice(0, 5);
        if (withDays) {
          // Every day of the window, oldest first, so empty days show as gaps in the strip.
          const nDays = Math.round(hours / 24);
          const end = now().getTime();
          for (let i = nDays - 1; i >= 0; i--) {
            const d = new Date(end - i * 86_400_000).toISOString().slice(0, 10);
            out.perDay.push({ day: d, cards: days.get(d) ?? 0 });
          }
        }
        return out;
      };
      return { last24h: await window(24, false), last7d: await window(24 * 7, true), last30d: await window(24 * 30, true) };
    },

    /** The Test button: a harmless sample card, with the settings given (saved or not). */
    async test(s: SecondOpinionSettings): Promise<{ ok: boolean; message: string }> {
      if (!s.baseUrl || !s.model) return { ok: false, message: "Set the provider address and the model first." };
      const started = Date.now();
      const r = await call(SecondOpinionSettings.parse(s), { question: "Run a shell command. It runs the project's tests in its own checkout.", command: "pnpm test", ownTicket: null }).catch(() => ({ failed: "it could not be asked" }) as SecondOpinionResult);
      const ms = Date.now() - started;
      if ("failed" in r) return { ok: false, message: `It didn't work: ${r.failed}. Cards will use the rules judge alone.` };
      return { ok: true, message: `It answered in ${(ms / 1000).toFixed(1)} s with a valid verdict (${r.verdict} for "pnpm test"${r.verdict === "deny" ? `: ${r.reason}` : ""}).` };
    },
  };
}

export type SecondOpinionService = ReturnType<typeof secondOpinionService>;
