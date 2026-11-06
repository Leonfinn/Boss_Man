// The runner's own pnpm store joins the shared one (BOS-568): before this, the runner's start-up install
// and the merge gate's check kept packages in HOME's store, on the container's root disk.
import { existsSync, mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { movedLogFile, moveStore, oldStoreInHome, storeEnv, storeRoot } from "../src/store.js";

const root = () => mkdtempSync(path.join(tmpdir(), "bm-store-"));

describe("the runner's own pnpm store (BOS-568)", () => {
  it("points the runner's installs at the same store the agents use, not a second one beside it", () => {
    // npm_config_store_dir is what pnpm reads; it must be the shared dir itself, so the runner writes `<dir>/vN`
    // exactly where a check's or an agent's install does.
    expect(storeEnv("/ws/.pnpm-store")).toMatchObject({ npm_config_store_dir: "/ws/.pnpm-store" });
    expect(storeRoot("/ws/.pnpm-store")).toBe("/ws/.pnpm-store/v10");
    expect(oldStoreInHome("/home/node")).toBe("/home/node/.pnpm-store");
  });

  it("merges an old store's version folders into the shared one and remembers it, so a second start doesn't move it again", () => {
    const r = root();
    const shared = path.join(r, ".pnpm-store");
    const old = oldStoreInHome(path.join(r, "home"));
    mkdirSync(path.join(old, "v10", "files"), { recursive: true });
    mkdirSync(shared, { recursive: true });
    const log: string[] = [];
    const moved = moveStore(old, shared, movedLogFile(r), (m) => log.push(m));
    expect(moved).toBe(true);
    expect(existsSync(path.join(shared, "v10", "files"))).toBe(true);
    expect(existsSync(old)).toBe(false);
    expect(log.join("\n")).toContain("moved the runner's own pnpm store");
    // The same store (a start that crashed after the move) is left where it is.
    expect(moveStore(old, shared, movedLogFile(r))).toBe(false);
    const into = readFileSync(movedLogFile(r), "utf8").trim();
    expect(into).toMatch(/^\d+:\d+$/);
  });

  it("keeps the shared store's own version folder rather than overwriting it", () => {
    const r = root();
    const shared = path.join(r, ".pnpm-store");
    const old = oldStoreInHome(path.join(r, "home"));
    mkdirSync(path.join(shared, "v10"), { recursive: true });
    writeFileSync(path.join(shared, "v10", "keep"), "shared");
    mkdirSync(path.join(old, "v10"), { recursive: true });
    writeFileSync(path.join(old, "v10", "old"), "old");
    expect(moveStore(old, shared, movedLogFile(r))).toBe(false);
    expect(readFileSync(path.join(shared, "v10", "keep"), "utf8")).toBe("shared");
    expect(existsSync(path.join(old, "v10", "old"))).toBe(true);
  });

  it("leaves a file or a link alone, and does nothing when there is no old store", () => {
    const r = root();
    const shared = path.join(r, ".pnpm-store");
    mkdirSync(shared, { recursive: true });
    expect(moveStore(path.join(r, "missing"), shared, movedLogFile(r))).toBe(false);
    const file = path.join(r, "a-file");
    writeFileSync(file, "x");
    expect(moveStore(file, shared, movedLogFile(r))).toBe(false);
    expect(existsSync(file)).toBe(true);
    const link = path.join(r, "a-link");
    symlinkSync(shared, link);
    expect(moveStore(link, shared, movedLogFile(r))).toBe(false);
  });

  it("never moves the shared store into itself", () => {
    const r = root();
    const shared = path.join(r, ".pnpm-store");
    mkdirSync(shared, { recursive: true });
    expect(moveStore(shared, shared, movedLogFile(r))).toBe(false);
    expect(existsSync(shared)).toBe(true);
  });
});
