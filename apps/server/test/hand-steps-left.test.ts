import { describe, expect, it } from "vitest";
import { handStepsLeft, leftSentence, newerCardLine, type HandEvidence } from "../src/services/hand-steps-left.js";
import { liveNotice, newerNotice } from "../src/services/closed-notice.js";

// BOS-2783: what a by-hand update still needs outside the server, from the host's own evidence.
const BOTH = { deployer: true, runner: true };
const ev = (over: Partial<HandEvidence> = {}): HandEvidence => ({ deployer: "current", deployerCard: false, runner: "not_needed", runnerCovered: false, ...over });

describe("handStepsLeft (BOS-2783)", () => {
  it("keeps a step until its own evidence shows it done, whatever the live commit", () => {
    expect(handStepsLeft(ev({ deployer: "behind", runner: "needed" }), BOTH)).toEqual(BOTH);
    expect(handStepsLeft(ev(), BOTH)).toEqual({ deployer: false, runner: false });
  });

  it("keeps a step the host can't confirm (old deployer, image not placed)", () => {
    expect(handStepsLeft(ev({ deployer: "unknown", runner: "unknown" }), BOTH)).toEqual(BOTH);
    expect(handStepsLeft(ev({ deployer: "none" }), BOTH)).toEqual({ deployer: true, runner: false });
  });

  it("never lists a step the hand card didn't ask for, nor one another card or a queued update holds", () => {
    expect(handStepsLeft(ev({ deployer: "behind", runner: "needed" }), { deployer: false, runner: false })).toEqual({ deployer: false, runner: false });
    expect(handStepsLeft(ev({ deployer: "behind", deployerCard: true, runner: "needed", runnerCovered: true }), BOTH)).toEqual({ deployer: false, runner: false });
  });

  it("no runner on this install: nothing to rebuild", () => {
    expect(handStepsLeft(ev({ runner: null }), BOTH).runner).toBe(false);
  });
});

describe("the closing notice and the newer card name what is left (BOS-2783)", () => {
  const now = new Date("2026-11-27T09:17:00Z");
  it("names the steps left and their card, or what the host confirmed", () => {
    expect(leftSentence({ deployer: true, runner: false }, ev({ deployer: "behind" }), "Finish the by-hand update")).toBe(
      'The server part is done, but one step is still to do: copy the deployer script into the deployer folder. They are on the card "Finish the by-hand update", which closes by itself once the host confirms them.',
    );
    expect(leftSentence({ deployer: false, runner: false }, ev({ runner: "needed", runnerCovered: true }), null)).toBe(
      "Nothing else is left to do: the host runs the current deployer script, and the runner rebuild has its own card or is already under way.",
    );
  });

  it("liveNotice and newerNotice drop 'You don't need to finish these steps' when given what is left", () => {
    const left = { text: "The server part is done, but one step is still to do: x.", stepsLeft: true };
    const live = liveNotice({ commit: "b".repeat(40), liveAt: now, now, left });
    expect(live.text).toContain(left.text);
    expect(live.text).not.toContain("You don't need to finish these steps");
    expect(live.stepsLeft).toBe(true);
    const newer = newerNotice({ newerId: "id", label: "Deploy Boss Man", now, left });
    expect(newer.text).toContain("This card's server part is already live.");
    expect(newer.text).not.toContain("brings in everything this one did");
    // Without it, the wording is as before.
    expect(liveNotice({ commit: "b".repeat(40), liveAt: now, now }).text).toContain("You don't need to finish these steps");
    expect(liveNotice({ commit: "b".repeat(40), liveAt: now, now }).stepsLeft).toBeUndefined();
  });

  it("the newer card's line says this deploy doesn't do them", () => {
    expect(newerCardLine(BOTH, "Finish the by-hand update")).toBe(
      'Still to do from the last by-hand update: copy the deployer script into the deployer folder; and rebuild the runners (Settings → Server and runner → Updates → Build and update runners). Do the card "Finish the by-hand update" first: this deploy doesn\'t do them.',
    );
  });
});
