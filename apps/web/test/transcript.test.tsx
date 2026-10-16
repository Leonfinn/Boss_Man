// @vitest-environment jsdom
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe as group, expect, it, vi } from "vitest";
import type { TranscriptItem } from "../src/api";
import { describe, MAX_ITEMS, useTranscript } from "../src/transcript";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const item = (seq: number, type: string, event: Record<string, unknown>): TranscriptItem => ({ seq, type, at: new Date(0).toISOString(), event });
const run = { id: "r", companyId: "c", agent: "CEO", agentId: null, ticketId: null, ticket: null, model: null, startedAt: "", endedAt: "2026-10-16T18:00:00Z", outcome: "end_turn", costMicros: 0 };

group("run transcript", () => {
  it("puts each kind of event into words", () => {
    expect(describe(item(1, "run.update", { update: { kind: "agent_message", text: "All done." } }))).toEqual({ tone: "text", label: "Agent", body: "All done." });
    expect(describe(item(2, "run.update", { update: { kind: "tool_call", title: "Run pnpm test", status: "in_progress" } }))).toEqual({ tone: "tool", label: "Run pnpm test", body: "in_progress" });
    expect(describe(item(3, "run.ended", { error: "The runner restarted while this run was going.", interrupted: true }))).toEqual({ tone: "bad", label: "Interrupted", body: "The runner restarted while this run was going." });
    expect(describe(item(4, "run.workspace", { branch: "bossman/t1", baseCommit: "abcdef0123", created: true, restoredPatch: false })).label).toBe("New workspace on bossman/t1 from abcdef0");
  });

  it("pages through a long run and keeps only the newest events (R43)", async () => {
    const total = MAX_ITEMS + 700;
    const fetch = vi.fn(async (url: string) => {
      const after = Number(new URL(url, "http://x").searchParams.get("after"));
      const items = Array.from({ length: Math.min(500, total - after) }, (_, i) => item(after + i + 1, "run.update", { update: { kind: "tool_call", title: `step ${after + i + 1}` } }));
      return new Response(JSON.stringify({ run, items, next: after + items.length, more: after + items.length < total }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetch);
    const { result } = renderHook(() => useTranscript("r"));
    await waitFor(() => expect(result.current.items.at(-1)?.seq).toBe(total), { timeout: 5000 });
    expect(result.current.items).toHaveLength(MAX_ITEMS);
    expect(result.current.dropped).toBe(700);
    expect(result.current.items[0]!.seq).toBe(701);
    // The run had ended, so it stops asking once it has everything.
    const calls = fetch.mock.calls.length;
    await new Promise((r) => setTimeout(r, 50));
    expect(fetch.mock.calls.length).toBe(calls);
    expect(calls).toBe(Math.ceil(total / 500));
  });
});
