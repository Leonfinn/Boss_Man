// BOS-2176: the Settings → Server backup line says plainly when there is no automatic backup yet.
import { describe, expect, it } from "vitest";
import { dailyBackupLine } from "../src/pages/settings/ThisHost";

describe("dailyBackupLine", () => {
  it("says no automatic backup yet when nothing is recorded, or the answer is missing", () => {
    expect(dailyBackupLine({ lastAt: null, failed: null, stale: false })).toEqual({ text: "No automatic backup yet", warn: false });
    expect(dailyBackupLine(null)).toEqual({ text: "No automatic backup yet", warn: false });
    expect(dailyBackupLine(undefined).text).toBe("No automatic backup yet");
    expect(dailyBackupLine({} as never).text).toBe("No automatic backup yet");
  });

  it("shows the time of the newest backup, and flags it when it is over 36 hours old", () => {
    const fresh = dailyBackupLine({ lastAt: "2026-11-21T03:00:00.000Z", failed: null, stale: false });
    expect(fresh.text.startsWith("Last automatic backup: ")).toBe(true);
    expect(fresh.warn).toBe(false);
    expect(dailyBackupLine({ lastAt: "2026-11-18T03:00:00.000Z", failed: null, stale: true }).warn).toBe(true);
  });
});
