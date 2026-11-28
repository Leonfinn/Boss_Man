import { describe, expect, it } from "vitest";
import { confirmedWords, DEPLOYER_LEFT, leftNames, RUNNER_LEFT, type HandEvidence } from "../src/services/hand-steps-left.js";

// BOS-2783: the owner's words on a by-hand update card — which steps are still to do, and what the
// host confirmed when nothing is left.
const ev = (over: Partial<HandEvidence> = {}): HandEvidence => ({ deployer: "current", deployerCard: false, runner: "not_needed", runnerCovered: false, ...over });

describe("leftNames (BOS-2783)", () => {
  it("names no step when nothing is left", () => {
    expect(leftNames({ deployer: false, runner: false })).toEqual([]);
  });

  it("names the deployer copy alone", () => {
    expect(leftNames({ deployer: true, runner: false })).toEqual([DEPLOYER_LEFT]);
  });

  it("names the runner rebuild alone", () => {
    expect(leftNames({ deployer: false, runner: true })).toEqual([RUNNER_LEFT]);
  });

  it("names the deployer step before the runner step when both are left", () => {
    expect(leftNames({ deployer: true, runner: true })).toEqual([DEPLOYER_LEFT, RUNNER_LEFT]);
  });
});

describe("confirmedWords (BOS-2783)", () => {
  it("confirms the deployer script when the host runs the current one", () => {
    expect(confirmedWords(ev({ deployer: "current", runner: null }))).toEqual(["the host runs the current deployer script"]);
  });

  it("names the deployer copy's own card when the script is not current but that card is open", () => {
    expect(confirmedWords(ev({ deployer: "behind", deployerCard: true, runner: null }))).toEqual(["the deployer script copy is on its own card"]);
  });

  it("confirms nothing for the deployer when it is not current and no card holds it", () => {
    expect(confirmedWords(ev({ deployer: "behind", deployerCard: false, runner: null }))).toEqual([]);
    expect(confirmedWords(ev({ deployer: "unknown", runner: null }))).toEqual([]);
  });

  it("confirms the runners are built from the server's version when the rebuild is not needed", () => {
    expect(confirmedWords(ev({ deployer: "behind", runner: "not_needed" }))).toEqual(["the runners are built from the version the server runs"]);
  });

  it("names the runner rebuild's own card when it is not needed but something covers it", () => {
    expect(confirmedWords(ev({ deployer: "behind", runner: "needed", runnerCovered: true }))).toEqual(["the runner rebuild has its own card or is already under way"]);
    expect(confirmedWords(ev({ deployer: "behind", runner: "unknown", runnerCovered: true }))).toEqual(["the runner rebuild has its own card or is already under way"]);
  });

  it("prefers 'built from' over the covered line when the rebuild is not needed", () => {
    expect(confirmedWords(ev({ deployer: "behind", runner: "not_needed", runnerCovered: true }))).toEqual([
      "the runners are built from the version the server runs",
    ]);
  });

  it("confirms nothing for the runner when there is no runner and nothing covers it", () => {
    expect(confirmedWords(ev({ deployer: "behind", runner: null, runnerCovered: false }))).toEqual([]);
    expect(confirmedWords(ev({ deployer: "behind", runner: "needed", runnerCovered: false }))).toEqual([]);
  });

  it("puts the deployer line before the runner line", () => {
    expect(confirmedWords(ev({ deployer: "current", runner: "not_needed" }))).toEqual([
      "the host runs the current deployer script",
      "the runners are built from the version the server runs",
    ]);
  });
});
