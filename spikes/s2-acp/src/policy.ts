// A toy version of the Boss Man policy engine (R22): it answers ACP permission
// requests by rule, and anything outside policy would become a decision-queue row.
import type { RequestPermissionRequest, RequestPermissionResponse } from "@agentclientprotocol/sdk";

export type PolicyDecision = {
  sessionId: string;
  title: string | null | undefined;
  kind: string | null | undefined;
  rawInput: unknown;
  verdict: "allow" | "deny" | "escalate";
  rule: string;
  optionKinds: string[];
};

const DESTRUCTIVE = /\brm\s+-rf\b|\bmkfs\b|\bdd\s+if=|docker\s+(rm|system\s+prune)/;

function commandOf(rawInput: unknown): string {
  if (rawInput && typeof rawInput === "object" && "command" in rawInput) return String((rawInput as any).command);
  return "";
}

export function decide(req: RequestPermissionRequest): PolicyDecision {
  const { toolCall, sessionId, options } = req;
  const cmd = commandOf(toolCall.rawInput);
  const title = toolCall.title ?? "";
  const base = { sessionId, title: toolCall.title, kind: toolCall.kind, rawInput: toolCall.rawInput, optionKinds: options.map((o) => o.kind) };
  if (DESTRUCTIVE.test(cmd)) return { ...base, verdict: "deny", rule: "destructive-command" };
  if (/mcp__bossman__|bossman/i.test(title) || toolCall.kind === "other") return { ...base, verdict: "allow", rule: "bossman-mcp-tools" };
  if (toolCall.kind === "execute" || toolCall.kind === "edit" || toolCall.kind === "read") return { ...base, verdict: "allow", rule: "workspace-tools" };
  return { ...base, verdict: "escalate", rule: "default-escalate" };
}

export function toResponse(req: RequestPermissionRequest, d: PolicyDecision): RequestPermissionResponse {
  const pick = (kind: string) => req.options.find((o) => o.kind === kind);
  if (d.verdict === "allow") {
    const o = pick("allow_once") ?? pick("allow_always");
    if (o) return { outcome: { outcome: "selected", optionId: o.optionId } };
  }
  // "escalate" would park the request in the decision queue; the spike treats it as a rejection.
  const o = pick("reject_once") ?? pick("reject_always");
  return o ? { outcome: { outcome: "selected", optionId: o.optionId } } : { outcome: { outcome: "cancelled" } };
}
