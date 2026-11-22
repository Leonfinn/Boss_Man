import { describe, expect, it } from "vitest";
import { CHECK_PEAK_MB, checkMemoryWarning } from "../src/check-memory.js";

const GB = 1024;

describe("checkMemoryWarning", () => {
  it("warns in plain words when the checks at once need more than the machine has", () => {
    expect(checkMemoryWarning({ slots: 3, perCheckMb: 4 * GB, machineMb: 8 * GB })).toBe(
      "3 checks at once × 4 GB each is 12 GB, more than the 8 GB this machine has: lower the checks at once to 2, or lower the memory per check. Otherwise the machine can run out of memory before any check's own limit acts, and checks are stopped.",
    );
  });

  it("is silent when the checks at once fit exactly, and gives the default peak when no per-check figure is set", () => {
    expect(checkMemoryWarning({ slots: 2, perCheckMb: 4 * GB, machineMb: 8 * GB })).toBeNull();
    expect(checkMemoryWarning({ slots: 1, perCheckMb: null, machineMb: 4 * GB })).toBe(
      "1 check at once × 5 GB each is 5 GB, more than the 4 GB this machine has: lower the memory per check or give the machine more memory. Otherwise the machine can run out of memory before any check's own limit acts, and checks are stopped.",
    );
    expect(CHECK_PEAK_MB).toBe(5 * GB);
  });

  it("falls back to the default peak for a per-check figure of zero or below", () => {
    const expected = checkMemoryWarning({ slots: 1, perCheckMb: null, machineMb: 4 * GB });
    expect(checkMemoryWarning({ slots: 1, perCheckMb: 0, machineMb: 4 * GB })).toBe(expected);
    expect(checkMemoryWarning({ slots: 1, perCheckMb: -1, machineMb: 4 * GB })).toBe(expected);
  });

  it("advises lowering the memory per check when even one check cannot fit", () => {
    expect(checkMemoryWarning({ slots: 1, perCheckMb: 5 * GB, machineMb: 4 * GB })).toContain(
      "lower the memory per check or give the machine more memory",
    );
  });

  it("says one check, not checks, and rounds the figures to one decimal place", () => {
    expect(checkMemoryWarning({ slots: 1, perCheckMb: 1536, machineMb: 1024 })).toBe(
      "1 check at once × 1.5 GB each is 1.5 GB, more than the 1 GB this machine has: lower the memory per check or give the machine more memory. Otherwise the machine can run out of memory before any check's own limit acts, and checks are stopped.",
    );
  });

  it("says nothing when the machine's memory is missing or not positive", () => {
    expect(checkMemoryWarning({ slots: 8, perCheckMb: 4 * GB, machineMb: null })).toBeNull();
    expect(checkMemoryWarning({ slots: 8, perCheckMb: 4 * GB, machineMb: undefined })).toBeNull();
    expect(checkMemoryWarning({ slots: 8, perCheckMb: 4 * GB, machineMb: 0 })).toBeNull();
    expect(checkMemoryWarning({ slots: 8, perCheckMb: 4 * GB, machineMb: -1 })).toBeNull();
  });

  it("says nothing for a slot count that is not a whole number of one or more", () => {
    expect(checkMemoryWarning({ slots: 0, perCheckMb: 4 * GB, machineMb: 8 * GB })).toBeNull();
    expect(checkMemoryWarning({ slots: -1, perCheckMb: 4 * GB, machineMb: 8 * GB })).toBeNull();
    expect(checkMemoryWarning({ slots: Number.NaN, perCheckMb: 4 * GB, machineMb: 8 * GB })).toBeNull();
    expect(checkMemoryWarning({ slots: Number.POSITIVE_INFINITY, perCheckMb: 4 * GB, machineMb: 8 * GB })).toBeNull();
  });
});
