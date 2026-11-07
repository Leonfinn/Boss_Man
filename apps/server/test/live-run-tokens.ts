// BOS-513: the server now accepts a run token only while its run row exists and is open. Most tests mint a token for a made-up run id,
// so this setup gives that id a live run row first. A real run row, or one already ended, is left alone (insert does nothing on a clash).
// Tests that need the strict behaviour (run-token-lifetime.test.ts) make their own rows and delete or end them.
import { vi } from "vitest";
import { runs } from "../src/db/schema.js";

vi.mock("../src/mcp.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/mcp.js")>();
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
