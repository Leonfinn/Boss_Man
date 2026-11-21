// BOS-2127 (background lane): siblingsFromSysfs reads one fixed sysfs file per CPU and returns the parsed
// hyperthread siblings, or null when the file is missing or isn't a CPU list. The source has no injectable
// read (and the ticket says not to add one), so node:fs is mocked here: nothing touches the real /sys, and the
// test passes on any host.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { siblingsFromSysfs } from "../src/cpu-layout.js";

const fs = vi.hoisted(() => ({ readFileSync: vi.fn() }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, readFileSync: fs.readFileSync };
});

describe("siblingsFromSysfs", () => {
  beforeEach(() => {
    fs.readFileSync.mockReset();
  });

  it("reads this CPU's thread_siblings_list and parses it", () => {
    fs.readFileSync.mockReturnValue("0,4-5\n");
    expect(siblingsFromSysfs(5)).toEqual([0, 4, 5]);
    expect(fs.readFileSync).toHaveBeenCalledWith("/sys/devices/system/cpu/cpu5/topology/thread_siblings_list", "utf8");
  });

  it("returns an empty list for an empty file", () => {
    fs.readFileSync.mockReturnValue("");
    expect(siblingsFromSysfs(2)).toEqual([]);
  });

  it("returns null when the sysfs file can't be read", () => {
    fs.readFileSync.mockImplementation(() => {
      throw Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" });
    });
    expect(siblingsFromSysfs(0)).toBeNull();
  });

  it("returns null when the file isn't a CPU list", () => {
    fs.readFileSync.mockReturnValue("not a cpu list");
    expect(siblingsFromSysfs(1)).toBeNull();
  });
});
