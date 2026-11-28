import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { openPglite } from "../src/db/client.js";
import { serverStatusService } from "../src/services/server-status.js";

// BOS-364: a refused runner update named its commit as "live since" the moment it was refused.
const OLD = "fc704d69" + "0".repeat(32);
const NEW = "9c9e1c8e" + "0".repeat(32);
let close: (() => Promise<void>) | undefined;
afterEach(async () => { await close?.(); close = undefined; });

async function status(deploy: { status: unknown; available: unknown }, hold: unknown = null) {
  const opened = await openPglite();
  close = opened.close;
  const svc = serverStatusService(opened.db, {
    role: () => "leader", isConnected: () => false, hold: async () => hold as never,
    errors: { recent: () => [], count: () => 0, untagged: () => 0 } as never,
    deploy: async () => ({ enabled: true, pending: false, ...deploy }),
    commit: OLD, startedAt: new Date(0),
  });
  return (await svc.status(randomUUID())).deploy;
}

describe("server_status deploy record", () => {
  it("does not call a refused runner update's commit live", async () => {
    const d = await status({ status: { target: "runner", result: "rejected", to_commit: NEW, ended: "2026-11-02T21:48:01Z" }, available: { deployed: OLD, tip: NEW } });
    expect(d).toMatchObject({ liveCommit: "fc704d69", liveSince: null, lastResult: "rejected", mainTip: "9c9e1c8e" });
  });
  it("names the commit of a finished server deploy, with its time", async () => {
    const d = await status({ status: { target: "server", result: "deployed", to_commit: NEW, ended: "2026-11-02T21:48:01Z" }, available: { deployed: NEW, tip: NEW } });
    expect(d).toMatchObject({ liveCommit: "9c9e1c8e", liveSince: "2026-11-02T21:48:01Z" });
  });
  // BOS-2933: the host's "waiting for runs to finish, then swaps" text stays after the server did the swap.
  it("words lastMessage from the runner swap's record when it ended after the host's report", async () => {
    const host = { target: "runner", result: "ok", message: "Boss Man is waiting for runs to finish, then swaps the runners", ended: "2026-11-27T15:00:00Z" };
    const swap = { on: false, last: { at: "2026-11-27T15:37:15Z", ok: true, title: "Runners updated", body: "All swapped." } };
    const d = await status({ status: host, available: null }, swap);
    expect(d.lastMessage).toBe("Runner update ended: Runners updated. All swapped.");
    expect(d.lastRunnerSwap).toMatchObject({ ok: true, title: "Runners updated" });
    // An older swap record leaves the host's text alone.
    const old = await status({ status: { ...host, ended: "2026-11-28T10:00:00Z" }, available: null }, swap);
    expect(old.lastMessage).toBe(host.message);
  });
  it("falls back to the server's own commit when the host reports nothing", async () => {
    expect(await status({ status: null, available: null })).toMatchObject({ liveCommit: "fc704d69", liveSince: null });
  });
});
