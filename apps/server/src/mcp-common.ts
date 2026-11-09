// Small helpers every MCP tool file shares (BOS-298 step 15): kept here so the tool files split out of
// mcp.ts import them without importing mcp.ts back.

export type Scope = { companyId: string; agentId: string | null; runId: string };

export const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
export const fail = (t: string) => ({ content: [{ type: "text" as const, text: t }], isError: true });

/** A lossless cap: at most n chars of s from offset; when there's more, says how much and how to get it. */
export const cut = (s: string, n: number, how: (next: number) => string, offset = 0) =>
  s.length <= offset + n ? s.slice(offset) : `${s.slice(offset, offset + n)}\n\n… ${s.length - offset - n} more chars; ${how(offset + n)}`;
export const CAP = 40_000;
