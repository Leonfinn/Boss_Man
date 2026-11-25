import { describe, expect, it } from "vitest";
import { buildTitle, buildWords } from "../src/pages/Board";

const b = (state: string, failing: string[] = []) => ({ state, failing }) as never;

describe("buildWords", () => {
  it("words each known build state", () => {
    expect(buildWords(b("passed"))).toBe("Build passed");
    expect(buildWords(b("failed"))).toBe("Build failed");
    expect(buildWords(b("running"))).toBe("Build running");
    expect(buildWords(b("none"))).toBe("No build yet");
  });
  it("says the result is unavailable for an unknown state", () => {
    expect(buildWords(b("unavailable"))).toBe("Build result unavailable");
    expect(buildWords(b("something else"))).toBe("Build result unavailable");
  });
});

describe("buildTitle", () => {
  it("names the failing checks", () => {
    expect(buildTitle(b("failed", ["test", "lint"]))).toBe("Failing: test, lint");
  });
  it("falls back to the words for a failed build with no names, and for a passed build", () => {
    expect(buildTitle(b("failed", []))).toBe("Build failed");
    expect(buildTitle(b("passed", ["test"]))).toBe("Build passed");
  });
});
