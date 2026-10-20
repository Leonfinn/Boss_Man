// Asks a company's runner for the models each agent kind offers, without running an agent: the
// runner opens a throwaway ACP session and reads the model option (no prompt, so no usage).
// Probed when a runner connects and a credential is granted but no list is known (or it's a
// day old), after such a credential is saved, and when the owner asks.
import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { runners as runnersTable, secretGrants } from "../db/schema.js";
import type { modelsService } from "./models.js";
import type { runnersService } from "./runners.js";

/** The credentials that let each agent kind start. */
export const KIND_CREDENTIALS: Record<"claude" | "codex" | "opencode", string[]> = {
  claude: ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "AWS_BEARER_TOKEN_BEDROCK", "ANTHROPIC_FOUNDRY_API_KEY", "ANTHROPIC_AUTH_TOKEN"],
  codex: ["OPENAI_API_KEY", "CODEX_API_KEY"],
  // Keys only OpenCode uses; it also reads OPENAI_API_KEY and ANTHROPIC_API_KEY, but those start Codex and Claude probes already. A local Ollama needs OPENCODE_CONFIG_CONTENT.
  opencode: ["OPENROUTER_API_KEY", "OLLAMA_API_KEY", "OPENCODE_CONFIG_CONTENT"],
};
const STALE_MS = 24 * 3_600_000;

export function modelProbeService(db: Db, deps: { runners: ReturnType<typeof runnersService>; models: ReturnType<typeof modelsService>; now?: () => Date; log?: (msg: string) => void }) {
  const now = deps.now ?? (() => new Date());
  // shortcut: in-process dedupe of running probes; lost on restart, harmless because a probe re-runs when the runner reconnects.
  const inFlight = new Set<string>();

  async function probe(companyId: string, opts: { force?: boolean; only?: "claude" | "codex" | "opencode" } = {}): Promise<Record<string, { ok: boolean; count?: number; error?: string }>> {
    const [runner] = await db.select({ id: runnersTable.id }).from(runnersTable).where(eq(runnersTable.companyId, companyId));
    if (!runner || !deps.runners.isConnected(runner.id)) return {};
    const envs = (await db.select({ env: secretGrants.envName }).from(secretGrants).where(and(eq(secretGrants.companyId, companyId), inArray(secretGrants.envName, Object.values(KIND_CREDENTIALS).flat())))).map((g) => g.env);
    const known = await deps.models.forCompany(companyId).then((l) => l.runner);
    const out: Record<string, { ok: boolean; count?: number; error?: string }> = {};
    for (const kind of ["claude", "codex", "opencode"] as const) {
      if (opts.only && opts.only !== kind) continue;
      if (!KIND_CREDENTIALS[kind].some((e) => envs.includes(e))) continue;
      const seen = known[kind]?.observedAt;
      if (!opts.force && seen && now().getTime() - new Date(seen).getTime() < STALE_MS) continue;
      const key = `${companyId}:${kind}`;
      if (inFlight.has(key)) continue;
      inFlight.add(key);
      try {
        const r = await deps.runners.request<{ models: Array<{ value: string; name: string; description?: string | null }> }>(runner.id, (requestId) => ({ type: "models.probe", requestId, agentKind: kind }), 90_000);
        if (r.models.length) await deps.models.record(companyId, kind, r.models);
        out[kind] = { ok: true, count: r.models.length };
      } catch (err) {
        out[kind] = { ok: false, error: (err as Error).message };
        deps.log?.(`model probe for ${kind} failed: ${(err as Error).message}`);
      } finally {
        inFlight.delete(key);
      }
    }
    return out;
  }

  return {
    probe,
    /** A runner connected: probe its company in the background. */
    async onConnect(runnerId: string) {
      const [r] = await db.select({ companyId: runnersTable.companyId }).from(runnersTable).where(eq(runnersTable.id, runnerId));
      if (r) await probe(r.companyId);
    },
    /** A credential was granted: probe if it's one an agent kind starts on. */
    async onGrant(companyId: string, envName: string) {
      if (Object.values(KIND_CREDENTIALS).some((l) => l.includes(envName))) await probe(companyId, { force: true });
    },
  };
}
