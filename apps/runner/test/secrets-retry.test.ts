// BOS-2526: a run dispatched while the server's address is still silent after a restart must not end on
// "Couldn't load the company's secrets: fetch failed"; the fetch is tried again until the server answers.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { RunnerEvent } from "@boss-man/shared";
import { SessionManager } from "../src/session-manager.js";

const fake = path.join(path.dirname(fileURLToPath(import.meta.url)), "fake-acp.mjs");

async function start(resolveEnv: () => Promise<Record<string, string>>, retry = { budgetMs: 10_000, delayMs: 5, maxDelayMs: 10 }) {
  const events: RunnerEvent[] = [];
  const manager = new SessionManager({
    mcpUrl: "http://127.0.0.1:9/mcp",
    emit: (e) => events.push(e),
    resolveEnv,
    secretsRetry: retry,
    adapterBins: { claude: fake },
    baseEnv: { PATH: process.env.PATH },
  });
  const runId = randomUUID();
  manager.handle({ type: "run.start", runId, agentId: randomUUID(), agentKind: "claude", model: null, fundingSourceId: null, cwd: mkdtempSync(path.join(tmpdir(), "bm-secrets-retry-")), prompt: "hi", mcpToken: "t" });
  const deadline = Date.now() + 20_000;
  while (!events.some((e) => e.type === "run.ended") && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
  manager.shutdown();
  return events.find((e) => e.type === "run.ended") as { error?: string | null } | undefined;
}

describe("the secrets fetch at run start (BOS-2526)", () => {
  it("tries again after a first network failure instead of ending the run", async () => {
    let calls = 0;
    const ended = await start(async () => {
      calls++;
      if (calls < 3) throw new TypeError("fetch failed");
      return {};
    });
    expect(calls).toBe(3);
    expect(ended?.error ?? "").not.toContain("secrets");
  });

  it("ends the run with the error once the budget is up", async () => {
    let calls = 0;
    const ended = await start(async () => { calls++; throw new TypeError("fetch failed"); }, { budgetMs: 100, delayMs: 5, maxDelayMs: 10 });
    expect(calls).toBeGreaterThan(1);
    expect(ended?.error).toContain("Couldn't load the company's secrets");
  });

  it("does not retry a refusal (HTTP 4xx)", async () => {
    let calls = 0;
    const ended = await start(async () => { calls++; throw new Error("HTTP 403"); });
    expect(calls).toBe(1);
    expect(ended?.error).toContain("HTTP 403");
  });
});
