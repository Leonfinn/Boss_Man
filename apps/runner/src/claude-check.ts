// Setup-token check (R58). Only Claude Code can prove a setup-token works, so the runner runs
// one tiny prompt with it, in a session of its own: nothing is reported to the server as a run,
// permission requests are refused, and the session works in a temporary folder removed afterwards.
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { RunnerEvent } from "@boss-man/shared";
import { SessionManager } from "./session-manager.js";

export const CHECK_PROMPT = "This is a connection check. Reply with the single word OK and nothing else. Don't use any tools.";
/** What the check's Claude Code process may see of the runner's environment: enough to start and to get out through a proxy. */
const PASSED_ON = ["PATH", "CLAUDE_CODE_EXECUTABLE", "HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "NO_PROXY", "no_proxy", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE"];

export type ClaudeCheck = { ok: boolean; message: string };

export async function checkClaude(credentials: Record<string, string>, opts: { baseEnv?: NodeJS.ProcessEnv; timeoutMs?: number } = {}): Promise<ClaudeCheck> {
  const token = credentials.CLAUDE_CODE_OAUTH_TOKEN?.trim();
  if (!token) return { ok: false, message: "The company has no Claude setup-token (CLAUDE_CODE_OAUTH_TOKEN) to check." };
  const base = opts.baseEnv ?? process.env;
  const home = mkdtempSync(path.join(tmpdir(), "bm-check-"));
  const cwd = path.join(home, "work");
  mkdirSync(cwd, { recursive: true });
  const events: RunnerEvent[] = [];
  let finish!: () => void;
  const ended = new Promise<void>((r) => (finish = r));
  const baseEnv: Record<string, string | undefined> = { HOME: home, CLAUDE_CONFIG_DIR: path.join(home, ".claude") };
  for (const k of PASSED_ON) if (base[k] !== undefined) baseEnv[k] = base[k];
  const manager: SessionManager = new SessionManager({
    // Nothing listens here; the check needs none of Boss Man's tools.
    mcpUrl: "http://127.0.0.1:9/mcp",
    baseEnv,
    resolveEnv: async () => credentials,
    emit: (e) => {
      events.push(e);
      if (e.type === "run.permission_request") manager.handle({ type: "permission.decide", runId: e.runId, requestId: e.requestId, verdict: "deny" });
      if (e.type === "run.ended") finish();
    },
  });
  const timeoutMs = opts.timeoutMs ?? 90_000;
  try {
    manager.handle({ type: "run.start", runId: randomUUID(), agentId: randomUUID(), agentKind: "claude", model: null, fundingSourceId: randomUUID(), cwd, prompt: CHECK_PROMPT, mcpToken: "bm_check" });
    const timedOut = await Promise.race([ended.then(() => false), new Promise<boolean>((r) => setTimeout(() => r(true), timeoutMs).unref())]);
    const end = events.find((e): e is Extract<RunnerEvent, { type: "run.ended" }> => e.type === "run.ended");
    const answered = events.some((e) => e.type === "run.update" && (e.update as { kind?: string; text?: string }).kind === "agent_message" && !!(e.update as { text?: string }).text?.trim());
    if (timedOut) return { ok: false, message: `Claude Code didn't answer within ${Math.round(timeoutMs / 1000)} seconds. Check the runner can reach api.anthropic.com.` };
    if (end?.error) return { ok: false, message: /401|403|auth|oauth|token|log ?in|credential/i.test(end.error) ? `Claude refused the token: ${end.error.slice(0, 300)}` : `The check failed: ${end.error.slice(0, 300)}` };
    if (!answered) return { ok: false, message: "Claude Code started, but no answer came back." };
    return { ok: true, message: "Claude Code answered using the setup-token." };
  } finally {
    manager.shutdown();
    for (let i = 0; i < 50 && manager.processGroups().length; i++) await new Promise((r) => setTimeout(r, 100));
    try {
      rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      // A leftover temp folder doesn't change the verdict.
    }
  }
}
