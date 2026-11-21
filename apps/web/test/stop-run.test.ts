// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { stopRun, stopRunQuestion, stopRunSaid } from "../src/stop-run";

afterEach(() => vi.restoreAllMocks());

describe("stopRun", () => {
  it("asks first with the shared wording and does nothing on No", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    expect(await stopRun("r1", "Ada")).toBeNull();
    expect(confirm).toHaveBeenCalledWith(stopRunQuestion("Ada"));
    expect(stopRunQuestion("Ada")).toBe("Stop Ada's run? It stops mid-step, so anything it has not committed yet can be lost.");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("says the runner is offline when the answer has endedHere", () => {
    expect(stopRunSaid(true)).toBe("The runner is offline, so Boss Man marked the run as stopped.");
    expect(stopRunSaid(false)).toBe("Stopping the run.");
  });
});
