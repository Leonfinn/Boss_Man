// BOS-513: the server now accepts a run token only while its run row exists and is open. Most tests mint a token for a made-up run id,
// so this setup gives that id a live run row first. A real run row, or one already ended, is left alone (insert does nothing on a clash).
// Tests that need the strict behaviour (run-token-lifetime.test.ts) make their own rows and delete or end them.
//
// BOS-1926: this file runs before every test file, so it imports nothing heavy at the top. The schema is loaded inside the mock
// (which runs only when a test imports mcp.js) and the pool is closed through a handle db/client.ts leaves on globalThis, so a
// test file that never touches the database or the server doesn't pay for loading them.
import { afterAll, vi } from "vitest";

// BOS-657: openPglite() parks emptied databases for the next test; close them when the file is done.
afterAll(() => (globalThis as { __bossmanClosePglitePool?: () => Promise<void> }).__bossmanClosePglitePool?.());

vi.mock("../src/mcp.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/mcp.js")>();
  const { runs } = await import("../src/db/schema.js");
  const issueRunToken: typeof real.issueRunToken = async (db, scope, ttlHours) => {
    try {
      await db.insert(runs).values({ id: scope.runId, companyId: scope.companyId, agentId: scope.agentId, startedAt: new Date() }).onConflictDoNothing();
    } catch {
      // A test with a made-up company has no company row to attach the run to; the token is minted anyway.
    }
    return real.issueRunToken(db, scope, ttlHours);
  };
  return { ...real, issueRunToken };
});
