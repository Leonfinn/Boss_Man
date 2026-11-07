// The runner's own pnpm store joins the shared one (BOS-568), and the unfenced merge gate gets a store of
// its own so a poisoned package in the agents' store can't run there (BOS-568 review).
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { assertSeparateStore, gateStoreDir, storeEnv } from "../src/store.js";

describe("the runner's pnpm store (BOS-568)", () => {
  it("points the runner's installs at the shared store itself, not a second one beside it", () => {
    // npm_config_store_dir is what pnpm reads; it must be the shared dir itself, so the runner writes `<dir>/vN`
    // exactly where an agent's install does. Nothing else is set that pnpm would treat as a store location.
    expect(storeEnv("/ws/.pnpm-store")).toEqual({ npm_config_store_dir: "/ws/.pnpm-store" });
  });

  it("gives the merge gate a store of its own beside the shared one", () => {
    expect(gateStoreDir("/ws/.pnpm-store")).toBe("/ws/.pnpm-store-gate");
    expect(() => assertSeparateStore("/ws/.pnpm-store", gateStoreDir("/ws/.pnpm-store"))).not.toThrow();
  });

  it("refuses a gate store inside the shared one, or one that contains it", () => {
    const root = mkdtempSync(path.join(tmpdir(), "bm-store-"));
    const shared = path.join(root, ".pnpm-store");
    expect(() => assertSeparateStore(shared, shared)).toThrow(/outside/);
    expect(() => assertSeparateStore(shared, path.join(shared, "v10"))).toThrow(/outside/);
    expect(() => assertSeparateStore(shared, root)).toThrow(/outside/);
    expect(() => assertSeparateStore(shared, `${shared}-gate/..`)).toThrow(/outside/);
  });
});
