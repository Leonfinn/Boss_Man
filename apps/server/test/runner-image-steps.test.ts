// BOS-1448 (background lane): the small text helpers behind a ticket's owner-setup steps and the release log.
// splitSteps turns the stored setup text into one line per step, stepKey makes the same step written differently
// compare equal, and isRunnerOnlyStep recognises a step that only asks for a runner rebuild. None of the three
// touches the database, the network or the clock.
import { describe, expect, it } from "vitest";
import { isRunnerOnlyStep, splitSteps, stepKey } from "../src/services/runner-image.js";

const BUILD = "Build and update runners";
const REBUILD = "Rebuild the runners: Settings → Server and runner → Updates → Build and update runners";

describe("splitSteps: fenced command blocks (BOS-1953)", () => {
  it("keeps a fenced block together as one step", () => {
    const text = "Run this:\n```sh host=\"example-host\" as=\"root\"\nls -l /srv\ndf -h\n```\nDone.";
    expect(splitSteps(text)).toEqual(["Run this:", "```sh host=\"example-host\" as=\"root\"\nls -l /srv\ndf -h\n```", "Done."]);
  });
  it("reads an unclosed fence line by line", () => {
    expect(splitSteps("```sh\nls")).toEqual(["```sh", "ls"]);
  });
});

describe("splitSteps", () => {
  it("splits one step per line and trims each line's ends", () => {
    expect(splitSteps("  Settings → Secrets\n   Paste the token  ")).toEqual(["Settings → Secrets", "Paste the token"]);
  });

  it("drops blank and whitespace-only lines", () => {
    expect(splitSteps("first\n\n   \nsecond\n\t\nthird")).toEqual(["first", "second", "third"]);
  });

  it("reads Windows line endings the same as Unix ones", () => {
    expect(splitSteps("first\r\nsecond\r\n\r\nthird\r\n")).toEqual(["first", "second", "third"]);
  });

  it("returns no steps for empty or blank text", () => {
    expect(splitSteps("")).toEqual([]);
    expect(splitSteps(" \n\t\r\n ")).toEqual([]);
  });

  it("leaves the words inside a line alone, trimming only its ends", () => {
    expect(splitSteps("  Build   and\tupdate  ")).toEqual(["Build   and\tupdate"]);
  });

  it("keeps a single step whole", () => {
    expect(splitSteps(BUILD)).toEqual([BUILD]);
  });
});

describe("stepKey", () => {
  it("collapses runs of spaces, tabs and newlines to one space", () => {
    expect(stepKey("Build  and\tupdate\n\nrunners")).toBe(BUILD);
  });

  it("trims leading and trailing whitespace", () => {
    expect(stepKey(" \t Build and update runners \r\n")).toBe(BUILD);
  });

  it("leaves an already normalised step unchanged", () => {
    expect(stepKey("Settings → Server and runner")).toBe("Settings → Server and runner");
  });

  it("keeps the words and punctuation of the long rebuild step", () => {
    expect(stepKey(REBUILD)).toBe(REBUILD);
  });

  it("gives the same key to the same step written with different whitespace", () => {
    expect(stepKey(REBUILD.replace(/ /g, "\n"))).toBe(stepKey(`  ${REBUILD}  `));
  });
});

describe("isRunnerOnlyStep", () => {
  it("accepts the short runner-update step", () => {
    expect(isRunnerOnlyStep(BUILD)).toBe(true);
  });

  it("accepts the longer rebuild sentence", () => {
    expect(isRunnerOnlyStep(REBUILD)).toBe(true);
  });

  it("accepts whitespace variants of both", () => {
    expect(isRunnerOnlyStep("  Build\tand   update runners ")).toBe(true);
    expect(isRunnerOnlyStep(REBUILD.replace(/ /g, "\n"))).toBe(true);
  });

  it("refuses a step that also asks for something else", () => {
    expect(isRunnerOnlyStep(`${BUILD}, then restart the server`)).toBe(false);
    expect(isRunnerOnlyStep(`First ${REBUILD} and then set the secret`)).toBe(false);
  });

  it("refuses a different setup step", () => {
    expect(isRunnerOnlyStep("Settings → Secrets → Add the token")).toBe(false);
  });

  it("matches the whole step and its case exactly, never a guess", () => {
    expect(isRunnerOnlyStep("build and update runners")).toBe(false);
    expect(isRunnerOnlyStep("Build and update the runners")).toBe(false);
    expect(isRunnerOnlyStep(`${BUILD}.`)).toBe(false);
  });

  it("refuses empty text", () => {
    expect(isRunnerOnlyStep("")).toBe(false);
    expect(isRunnerOnlyStep("   \n\t ")).toBe(false);
  });
});
