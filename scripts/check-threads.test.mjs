import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { DEFAULT_MAX, cgroupCpus, cgroupFreeMemory, checkThreads } from "./check-threads.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
// files: path -> contents; anything else reads as missing (no cgroup limit, no proof file).
const fs = (files = {}) => (p) => files[p];
const v2 = (s) => fs({ "/sys/fs/cgroup/cpu.max": s });

test("BOSSMAN_CHECK_THREADS sets the budget outright", () => {
  assert.equal(checkThreads({ env: { BOSSMAN_CHECK_THREADS: "7" }, cpus: 2, readFile: fs() }), 7);
  assert.equal(checkThreads({ env: { BOSSMAN_CHECK_THREADS: "0" }, cpus: 2, readFile: fs() }), 2);
  assert.equal(checkThreads({ env: { BOSSMAN_CHECK_THREADS: "lots" }, cpus: 2, readFile: fs() }), 2);
});

test("the slot's share of the CPUs, at most DEFAULT_MAX and at least 1", () => {
  assert.equal(DEFAULT_MAX, 4);
  assert.equal(checkThreads({ env: {}, cpus: 12, readFile: fs() }), 4); // 12-thread host, one slot
  assert.equal(checkThreads({ env: { BOSSMAN_CHECK_SLOTS: "2" }, cpus: 12, readFile: fs() }), 4);
  assert.equal(checkThreads({ env: { BOSSMAN_CHECK_SLOTS: "4" }, cpus: 12, readFile: fs() }), 3);
  assert.equal(checkThreads({ env: { BOSSMAN_CHECK_SLOTS: "2" }, cpus: 4, readFile: fs() }), 2);
  assert.equal(checkThreads({ env: {}, cpus: 2, readFile: fs() }), 2);
  assert.equal(checkThreads({ env: { BOSSMAN_CHECK_SLOTS: "3" }, cpus: 2, readFile: fs() }), 1);
  assert.equal(checkThreads({ env: {}, cpus: 1, readFile: fs() }), 1);
});

test("a cgroup CPU quota (docker --cpus, LXC, Proxmox limits) counts, not just the host's cores", () => {
  assert.equal(cgroupCpus(v2("max 100000\n")), undefined);
  assert.equal(cgroupCpus(v2("250000 100000\n")), 2.5);
  assert.equal(checkThreads({ env: {}, cpus: 64, readFile: v2("200000 100000") }), 2);
  assert.equal(checkThreads({ env: {}, cpus: 64, readFile: v2("50000 100000") }), 1);
  assert.equal(checkThreads({ env: {}, cpus: 2, readFile: v2("max 100000") }), 2);
  const v1 = fs({ "/sys/fs/cgroup/cpu/cpu.cfs_quota_us": "300000\n", "/sys/fs/cgroup/cpu/cpu.cfs_period_us": "100000\n" });
  assert.equal(checkThreads({ env: {}, cpus: 16, readFile: v1 }), 3);
  assert.equal(cgroupCpus(fs({ "/sys/fs/cgroup/cpu/cpu.cfs_quota_us": "-1", "/sys/fs/cgroup/cpu/cpu.cfs_period_us": "100000" })), undefined);
});

test("the slot count comes from check-all's proof file when BOSSMAN_CHECK_SLOTS is not set", () => {
  const files = { "/p": "3\n" };
  assert.equal(checkThreads({ env: { CHECK_ALL_PAIR_PROOF: "/p" }, cpus: 6, readFile: fs(files) }), 2);
  // A pair-measurement note (not a number) means no slot count: one slot.
  assert.equal(checkThreads({ env: { CHECK_ALL_PAIR_PROOF: "/p" }, cpus: 6, readFile: fs({ "/p": "passed on 3 Nov" }) }), 4);
});

const GB = 1024 ** 3;
const mem = (limit, current, inactive) => fs({
  "/sys/fs/cgroup/memory.max": `${limit}\n`,
  "/sys/fs/cgroup/memory.current": `${current}\n`,
  ...(inactive === undefined ? {} : { "/sys/fs/cgroup/memory.stat": `anon 1\ninactive_file ${inactive}\n` }),
});

test("free cgroup memory caps the workers (about 1.2 GB each, shared across slots), never below 1", () => {
  assert.equal(cgroupFreeMemory(fs()), undefined);
  assert.equal(cgroupFreeMemory(fs({ "/sys/fs/cgroup/memory.max": "max\n", "/sys/fs/cgroup/memory.current": "5\n" })), undefined);
  assert.equal(cgroupFreeMemory(mem(16 * GB, 10 * GB)), 6 * GB);
  assert.equal(cgroupFreeMemory(mem(16 * GB, 10 * GB, 4 * GB)), 10 * GB); // reclaimable cache is free
  const env = { BOSSMAN_CHECK_SLOTS: "2" };
  assert.equal(checkThreads({ env, cpus: 12, readFile: mem(16 * GB, 1 * GB) }), 4); // plenty free: CPU rule
  assert.equal(checkThreads({ env, cpus: 12, readFile: mem(16 * GB, 11 * GB) }), 2); // 5 GB / 2 slots / 1.2 GB
  assert.equal(checkThreads({ env, cpus: 12, readFile: mem(16 * GB, 15 * GB + GB / 2) }), 1); // nearly full
  assert.equal(checkThreads({ env, cpus: 12, readFile: mem(16 * GB, 16 * GB) }), 1); // full: still 1
  // v1 files work too, and an unreadable limit leaves today's rule.
  const v1 = fs({ "/sys/fs/cgroup/memory/memory.limit_in_bytes": `${8 * GB}`, "/sys/fs/cgroup/memory/memory.usage_in_bytes": `${4 * GB}` });
  assert.equal(checkThreads({ env: {}, cpus: 12, readFile: v1 }), 3);
  assert.equal(checkThreads({ env, cpus: 12, readFile: fs() }), 4);
});

test("run as a script it prints the number", () => {
  const out = execFileSync(process.execPath, [join(root, "scripts/check-threads.mjs")], { env: { ...process.env, BOSSMAN_CHECK_THREADS: "3" } });
  assert.equal(out.toString().trim(), "3");
});

// Every vitest project the checks run must take its worker cap from checkThreads(), or one check can fill the host
// (BOS-674). A new package with a vitest test script and no capped config fails here.
test("every vitest config caps its workers from checkThreads()", () => {
  const configs = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { cwd: root })
    .toString().split("\n").filter((f) => /(^|\/)vitest\.config\.[cm]?[jt]s$/.test(f));
  assert.ok(configs.length >= 6, `expected the package configs, found ${configs.join(", ")}`);
  for (const f of configs) {
    const src = readFileSync(join(root, f), "utf8");
    assert.match(src, /import \{[^}]*\bcheckThreads\b[^}]*\} from "[./]*scripts\/check-threads\.mjs"/, `${f} must import checkThreads`);
    assert.match(src, /maxWorkers:/, `${f} must set maxWorkers`);
  }
  for (const group of ["apps", "packages"]) {
    for (const name of readdirSync(join(root, group))) {
      const pkg = join(root, group, name, "package.json");
      if (!existsSync(pkg)) continue;
      const test = JSON.parse(readFileSync(pkg, "utf8")).scripts?.test ?? "";
      if (!/\bvitest\b/.test(test)) continue;
      const has = configs.some((f) => dirname(f) === `${group}/${name}`);
      assert.ok(has, `${group}/${name} runs vitest but has no vitest.config with a worker cap (vitest would use cores - 1)`);
    }
  }
});
