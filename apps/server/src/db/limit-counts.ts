// BOS-2380: how often the database limits were hit, for the server health box. Counted in memory by db/client.ts's limit watcher.
const DAY_MS = 86_400_000;
// lost on restart, harmless because the page says "since the server started" and the log line still names the first hit.
const hits: { kind: "statement" | "connect"; at: number }[] = [];

export function recordLimitHit(kind: "statement" | "connect", at = Date.now()): void {
  hits.push({ kind, at });
  // Keep a day only, so a busy hour can't grow the list without end.
  const cutoff = at - DAY_MS;
  while (hits.length && hits[0]!.at < cutoff) hits.shift();
}

/** Statement timeouts and full-pool waits in the last 24 hours. */
export function limitCounts(now = Date.now()): { statementTimeouts: number; poolFull: number } {
  const cutoff = now - DAY_MS;
  return {
    statementTimeouts: hits.filter((h) => h.kind === "statement" && h.at >= cutoff).length,
    poolFull: hits.filter((h) => h.kind === "connect" && h.at >= cutoff).length,
  };
}

/** Tests: forget every hit. */
export function resetLimitCounts(): void {
  hits.length = 0;
}
