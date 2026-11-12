import { describe, expect, it } from "vitest";
import { GO_LIVE_WAIT_MAX_MS, goLiveWaitWords } from "../src/go-live.js";

describe("goLiveWaitWords: what the board says a merged ticket waits for (BOS-1106)", () => {
  it("gives each wait its own sentence, all starting \"waiting for go-live\"", () => {
    const server = goLiveWaitWords("server");
    const runner = goLiveWaitWords("runner");
    const both = goLiveWaitWords("both");

    for (const words of [server, runner, both]) expect(words.startsWith("waiting for go-live")).toBe(true);
    expect(new Set([server, runner, both]).size).toBe(3);
  });

  it("names the server update for a server wait", () => {
    const words = goLiveWaitWords("server");
    expect(words).toContain("server update");
    expect(words).not.toContain("runner rebuild");
  });

  it("names the runner rebuild for a runner wait", () => {
    const words = goLiveWaitWords("runner");
    expect(words).toContain("runner rebuild");
    expect(words).not.toContain("server update");
  });

  it("names both the server update and the runner rebuild for a both wait", () => {
    const words = goLiveWaitWords("both");
    expect(words).toContain("server update");
    expect(words).toContain("runner rebuild");
  });

  it("lets a ticket wait three days before the watchdog looks at it again", () => {
    expect(GO_LIVE_WAIT_MAX_MS).toBe(3 * 24 * 60 * 60 * 1000);
    expect(GO_LIVE_WAIT_MAX_MS).toBe(259_200_000);
  });
});
