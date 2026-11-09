// BOS-895 (BOS-298 F12): when the coding tool offers no permission option kind the runner knows,
// the answer stays a cancel (never guess which unknown option means allow), but the runner says so
// in its log, naming the run, the tool and the kinds it was offered, so a renamed kind after a
// harness update is visible instead of every approval silently becoming "refused".
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { RunnerEvent } from "@boss-man/shared";
import { SessionManager } from "../src/session-manager.js";

const fake = path.join(path.dirname(fileURLToPath(import.meta.url)), "fake-acp.mjs");

async function ask(options: Array<{ optionId: string; name: string; kind: string }>, verdict: "allow" | "deny") {
  const dump = path.join(mkdtempSync(path.join(tmpdir(), "bm-perm-kinds-")), "answer.json");
  const events: RunnerEvent[] = [];
  let done!: () => void;
  const ended = new Promise<void>((r) => (done = r));
  const manager: SessionManager = new SessionManager({
    mcpUrl: "http://127.0.0.1:9/mcp",
    baseEnv: { PATH: process.env.PATH },
    adapterBins: { opencode: fake },
    resolveEnv: async () => ({ DUMP: dump, FAKE_PERMISSION_OPTIONS: JSON.stringify(options) }),
    emit: (e) => {
      events.push(e);
      if (e.type === "run.permission_request") manager.handle({ type: "permission.decide", runId: e.runId, requestId: e.requestId, verdict });
      if (e.type === "run.ended") done();
    },
  });
  manager.handle({ type: "run.start", runId: "run-kinds", agentId: "a1", agentKind: "opencode", model: null, cwd: mkdtempSync(path.join(tmpdir(), "bm-perm-kinds-ws-")), prompt: "hi", mcpToken: "t" } as never);
  await ended;
  manager.shutdown();
  const warnings = events.filter((e): e is Extract<RunnerEvent, { type: "runner.log" }> => e.type === "runner.log" && e.level === "warn" && /permission option/.test(e.message));
  return { answer: JSON.parse(readFileSync(dump, "utf8")), warnings, request: events.find((e) => e.type === "run.permission_request") };
}

const renamed = [
  { optionId: "yes", name: "Yes", kind: "permit_once" },
  { optionId: "no", name: "No", kind: "refuse_once" },
];

describe("permission options the runner doesn't know (BOS-895)", () => {
  it("an approval still cancels, but the runner logs the run, the tool and the kinds it was offered", async () => {
    const { answer, warnings, request } = await ask(renamed, "allow");
    expect(request).toMatchObject({ optionKinds: ["permit_once", "refuse_once"] });
    expect(answer).toEqual({ outcome: { outcome: "cancelled" } });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.message).toContain("run-kinds");
    expect(warnings[0]!.message).toContain("touch /tmp/x");
    expect(warnings[0]!.message).toContain("permit_once, refuse_once");
    expect(warnings[0]!.message).toContain("allow");
    const denied = await ask(renamed, "deny");
    expect(denied.answer).toEqual({ outcome: { outcome: "cancelled" } });
    expect(denied.warnings).toHaveLength(1);
    expect(denied.warnings[0]!.message).toContain("permit_once, refuse_once");
  }, 30_000);

  it("with known and unknown kinds mixed, a known one is still picked; a refusal with no known reject kind is logged", async () => {
    const mixed = [{ optionId: "yes", name: "Yes", kind: "allow_once" }, ...renamed.slice(1)];
    const allowed = await ask(mixed, "allow");
    expect(allowed.request).toMatchObject({ optionKinds: ["allow_once", "refuse_once"] });
    expect(allowed.answer).toEqual({ outcome: { outcome: "selected", optionId: "yes" } });
    expect(allowed.warnings).toEqual([]);
    const denied = await ask(mixed, "deny");
    expect(denied.answer).toEqual({ outcome: { outcome: "cancelled" } });
    expect(denied.warnings).toHaveLength(1);
    expect(denied.warnings[0]!.message).toContain("allow_once, refuse_once");
  }, 30_000);

  it("known kinds are picked as before and log nothing", async () => {
    const known = [
      { optionId: "a1", name: "Allow", kind: "allow_once" },
      { optionId: "r1", name: "Reject", kind: "reject_once" },
    ];
    const allowed = await ask(known, "allow");
    expect(allowed.answer).toEqual({ outcome: { outcome: "selected", optionId: "a1" } });
    expect(allowed.warnings).toEqual([]);
    const denied = await ask(known, "deny");
    expect(denied.answer).toEqual({ outcome: { outcome: "selected", optionId: "r1" } });
    expect(denied.warnings).toEqual([]);
  }, 30_000);
});
