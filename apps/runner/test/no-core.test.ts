import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { withoutCoreDumps } from "../src/no-core.js";

const src = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src");

describe("no core dumps (BOS-1059)", () => {
  it("starts the command with a core limit of 0 that its children inherit", () => {
    const l = withoutCoreDumps({ bin: "sh", args: ["-c", 'echo "$(ulimit -c) $(ulimit -Hc) $(sh -c "ulimit -c")"'] });
    const r = spawnSync(l.bin, l.args, { encoding: "utf8" });
    expect(r.stdout.trim()).toBe("0 0 0");
  });

  it("keeps arguments intact", () => {
    const l = withoutCoreDumps({ bin: "printf", args: ["%s|", "a b", "$HOME", "'q'"] });
    expect(spawnSync(l.bin, l.args, { encoding: "utf8" }).stdout).toBe("a b|$HOME|'q'|");
  });

  it("a crashing child writes no core file", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "nocore-"));
    try {
      const l = withoutCoreDumps({ bin: "sh", args: ["-c", 'sh -c "kill -SEGV \\$\\$"; true'] });
      spawnSync(l.bin, l.args, { cwd: dir });
      expect(readdirSync(dir).filter((f) => /^core(\.\d+)?$/.test(f))).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sessions and check jobs both spawn through it", () => {
    for (const f of ["session-manager.ts", "workspace.ts"]) {
      expect(readFileSync(path.join(src, f), "utf8")).toMatch(/const noCore = withoutCoreDumps\(launch\);\s+const child = spawn\(noCore\.bin, noCore\.args/);
    }
  });
});
