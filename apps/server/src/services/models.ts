// Model lists for the picker (R60): what each agent kind offers, as the runner last saw it in
// an ACP session's model option, and what an API key can use, from the provider's model list.
import { and, eq, like } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { fundingSources, secretGrants, settings } from "../db/schema.js";

export type ModelChoice = { value: string; name: string; description?: string | null };
type ApiList = { fundingSourceId: string; name: string; provider: string; models: ModelChoice[]; error: string | null; fetchedAt: string };

const API_TTL_MS = 60 * 60_000;
/** OpenAI's list includes embeddings, audio and image models that agents can't run on. */
const NOT_FOR_AGENTS = /embedding|whisper|tts|dall-e|moderation|image|audio|realtime|transcribe|search|babbage|davinci/i;

export function modelsService(db: Db, deps: { reveal: (secretId: string) => Promise<string | null>; fetch?: typeof fetch; now?: () => Date }) {
  const http = deps.fetch ?? fetch;
  const now = deps.now ?? (() => new Date());
  // shortcut: provider model lists cached in memory; lost on restart, harmless because the next read refetches (TTL-based).
  const apiCache = new Map<string, ApiList>();

  /** The gateway a company's agents use: its ANTHROPIC_BASE_URL credential, else OpenRouter's Anthropic endpoint. */
  async function gatewayBase(companyId: string) {
    const [g] = await db.select({ secretId: secretGrants.secretId }).from(secretGrants).where(and(eq(secretGrants.companyId, companyId), eq(secretGrants.envName, "ANTHROPIC_BASE_URL")));
    return ((g && (await deps.reveal(g.secretId))) || "https://openrouter.ai/api").trim().replace(/\/+$/, "");
  }

  async function fetchApi(source: typeof fundingSources.$inferSelect, companyId: string): Promise<ApiList> {
    const base0 = { fundingSourceId: source.id, name: source.name, provider: source.provider, fetchedAt: now().toISOString() };
    const key = source.secretId ? await deps.reveal(source.secretId) : null;
    if (!key) return { ...base0, models: [], error: "No API key is stored with this funding source." };
    try {
      if (source.provider === "anthropic") {
        const res = await http("https://api.anthropic.com/v1/models?limit=1000", { headers: { "x-api-key": key, "anthropic-version": "2023-06-01" }, signal: AbortSignal.timeout(10_000) });
        if (!res.ok) return { ...base0, models: [], error: `Anthropic answered ${res.status}.` };
        const body = (await res.json()) as { data?: Array<{ id: string; display_name?: string }> };
        return { ...base0, models: (body.data ?? []).map((m) => ({ value: m.id, name: m.display_name ?? m.id })), error: null };
      }
      if (source.provider === "gateway") {
        // OpenRouter and LiteLLM both list at {base}/v1/models; send the key both ways a gateway might read it.
        const base = await gatewayBase(companyId);
        const res = await http(`${base}/v1/models`, { headers: { authorization: `Bearer ${key}`, "x-api-key": key }, signal: AbortSignal.timeout(10_000) });
        if (!res.ok) return { ...base0, models: [], error: `The gateway answered ${res.status}.` };
        const body = (await res.json()) as { data?: Array<{ id: string; name?: string; supported_parameters?: string[] }> };
        // Agents need tool calls; OpenRouter says which models take them. Claude first: Claude Code is only supported on Claude.
        const ids = (body.data ?? []).filter((m) => !m.supported_parameters || m.supported_parameters.includes("tools"));
        const claude = (m: { id: string }) => /claude/i.test(m.id);
        return {
          ...base0,
          models: [...ids.filter(claude), ...ids.filter((m) => !claude(m))].map((m) => ({ value: m.id, name: claude(m) ? (m.name ?? m.id) : `${m.name ?? m.id} (not Claude: may not work)` })),
          error: null,
        };
      }
      const res = await http("https://api.openai.com/v1/models", { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(10_000) });
      if (!res.ok) return { ...base0, models: [], error: `OpenAI answered ${res.status}.` };
      const body = (await res.json()) as { data?: Array<{ id: string }> };
      const ids = (body.data ?? []).map((m) => m.id).filter((id) => !NOT_FOR_AGENTS.test(id));
      return { ...base0, models: ids.sort().map((id) => ({ value: id, name: id })), error: null };
    } catch (err) {
      return { ...base0, models: [], error: `Couldn't reach the provider: ${(err as Error).message}` };
    }
  }

  return {
    /** What a runner reported for an agent kind; replaces the last report. */
    async record(companyId: string, agentKind: string, models: ModelChoice[]) {
      const value = { models, observedAt: now().toISOString() };
      await db.insert(settings).values({ key: `models:${companyId}:${agentKind}`, value }).onConflictDoUpdate({ target: settings.key, set: { value } });
    },

    /** Every list that applies to the company: per agent kind from its runner, per API funding source from the provider. */
    async forCompany(companyId: string, opts: { refresh?: boolean } = {}) {
      const rows = await db.select().from(settings).where(like(settings.key, `models:${companyId}:%`));
      const runner = Object.fromEntries(rows.map((r) => [r.key.slice(`models:${companyId}:`.length), r.value as { models: ModelChoice[]; observedAt: string }]));
      // Anthropic, OpenAI and gateways have a model-list API; Bedrock's and Foundry's models come from the runner's own list.
      const sources = (await db.select().from(fundingSources)).filter((s) => s.kind !== "subscription" && s.secretId && (s.provider === "anthropic" || s.provider === "openai" || s.provider === "gateway"));
      const api: ApiList[] = [];
      // shortcut: cached per funding source, so two companies on different gateways share one list; key by company if that happens.
      for (const s of sources) {
        const cached = apiCache.get(s.id);
        const fresh = cached && !opts.refresh && now().getTime() - new Date(cached.fetchedAt).getTime() < API_TTL_MS ? cached : await fetchApi(s, companyId);
        apiCache.set(s.id, fresh);
        api.push(fresh);
      }
      return { runner, api };
    },

    /** Drops a funding source's cached list, e.g. after its key changes. */
    forget(fundingSourceId: string) {
      apiCache.delete(fundingSourceId);
    },
  };
}

