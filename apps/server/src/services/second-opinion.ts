// The optional model second opinion on permission cards (BOS-338, DR-005). Off by default, per company.
// It calls any OpenAI-compatible /chat/completions endpoint the owner set (OpenRouter, Synthetic, a local
// server). Every failure (off, no key, slow, down, out of credit, a bad answer) comes back as "failed",
// and the caller then lets the rules judge decide alone. It never answers a card.
import { eq } from "drizzle-orm";
import { z } from "zod";
import { SECOND_OPINION_DEADLINE_MS, parseSecondOpinion, secondOpinionSystemPrompt, secondOpinionUserPrompt } from "@boss-man/shared";
import type { Db } from "../db/client.js";
import { settings } from "../db/schema.js";

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

const key = (companyId: string) => `second-opinion:${companyId}`;

export function secondOpinionService(
  db: Db,
  deps: { reveal: (secretId: string) => Promise<string | null>; fetch?: typeof fetch; workspaceRoot?: string; deadlineMs?: number },
) {
  const doFetch = deps.fetch ?? fetch;
  const deadline = deps.deadlineMs ?? SECOND_OPINION_DEADLINE_MS;

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
    // Errors carry no request or response body, and never the key.
    const ask = (async (): Promise<SecondOpinionResult> => {
      let res: Response;
      try {
        res = await doFetch(`${s.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json", ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
          body: JSON.stringify({
            model: s.model,
            temperature: 0,
            max_tokens: 1000,
            messages: [
              { role: "system", content: secondOpinionSystemPrompt(deps.workspaceRoot ?? "/workspaces") },
              { role: "user", content: secondOpinionUserPrompt(card) },
            ],
          }),
          // A redirect could carry the key somewhere the owner didn't choose.
          redirect: "error",
          signal: ctl.signal,
        });
      } catch {
        return { failed: ctl.signal.aborted ? `no answer within ${Math.round(deadline / 1000)} s` : "the provider could not be reached" };
      }
      if (!res.ok) {
        void res.body?.cancel().catch(() => {});
        return { failed: res.status === 402 ? "the provider says it is out of credit (402)" : res.status === 401 || res.status === 403 ? `the provider refused the key (${res.status})` : res.status === 429 ? "the provider is rate limiting (429)" : `the provider answered ${res.status}` };
      }
      const data = (await res.json().catch(() => null)) as { choices?: Array<{ message?: { content?: unknown } }> } | null;
      const answer = parseSecondOpinion(data?.choices?.[0]?.message?.content);
      return answer ?? { failed: "the model's answer wasn't a valid verdict" };
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
      await db.insert(settings).values({ key: key(companyId), value }).onConflictDoUpdate({ target: settings.key, set: { value } });
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
