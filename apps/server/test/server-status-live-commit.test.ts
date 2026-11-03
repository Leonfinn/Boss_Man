import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { openPglite } from "../src/db/client.js";
import { serverStatusService } from "../src/services/server-status.js";

// BOS-364: a refused runner update named its commit as "live since" the moment it was refused.
const OLD = "fc704d69" + "0".repeat(32);
const NEW = "9c9e1c8e" + "0".repeat(32);
let close: (() => Promise<void>) | undefined;
afterEach(async () => { await close?.(); close = undefined; });

async function status(deploy: { status: unknown; available: unknown }) {
  const opened = await openPglite();
  close = opened.close;
  const svc = serverStatusService(opened.db, {
    role: () => "leader", isConnected: () => false, hold: async () => null,
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
  it("falls back to the server's own commit when the host reports nothing", async () => {
    expect(await status({ status: null, available: null })).toMatchObject({ liveCommit: "fc704d69", liveSince: null });
  });
});
