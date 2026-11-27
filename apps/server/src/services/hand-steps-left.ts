// BOS-2783: a by-hand update has steps that happen outside the server: copying the host-deployer script into the
// deployer folder, and rebuilding the runners. On 27 Nov the card closed as soon as the server came up on its commit,
// with "You don't need to finish these steps", while the host still ran the old deployer script and the runners an
// older image. The live commit says only that the server part is done. Each other step has its own evidence, and this
// file turns that evidence into what is still to do, in the owner's words. It is pure: self-deploy.ts reads the facts.

/** The host deployer script, as self-deploy.ts's deployerScriptState reads it from the host's report (BOS-990). */
export type DeployerEvidence = "current" | "behind" | "unknown" | "none";
/** The runners, as runnerUpdateNeed answers (null: this install has no runner). */
export type RunnerEvidence = "needed" | "not_needed" | "unknown" | null;

export type HandEvidence = {
  deployer: DeployerEvidence;
  /** The separate "deployer script is older" card is open: that card holds the copy step already. */
  deployerCard: boolean;
  runner: RunnerEvidence;
  /** A runner card is open, or a runner update is queued, waiting for the host or running: the rebuild is in hand. */
  runnerCovered: boolean;
};

/** Steps of a by-hand update still to do. */
export type HandLeft = { deployer: boolean; runner: boolean };

export const DEPLOYER_LEFT = "copy the deployer script into the deployer folder";
export const RUNNER_LEFT = "rebuild the runners (Settings → Server and runner → Updates → Build and update runners)";

/**
 * What is still to do, from the host's own evidence, of the steps the hand cards asked for (`needs`: a deployer copy, a
 * runner rebuild). A step counts as done only on evidence that it is: the host runs the repo's deployer script, the
 * runners are built from the version the server runs. A host that can't say (an old deployer, an unrecorded image)
 * keeps the step, so the owner marks it done. A step another open card or a queued update already holds is not listed
 * twice. A step the card never asked for is left to its own card (the deployer-script card, the runner card).
 */
export function handStepsLeft(e: HandEvidence, needs: HandLeft): HandLeft {
  const deployerOld = e.deployer !== "current";
  const runnerOld = e.runner === "needed" || e.runner === "unknown";
  return { deployer: needs.deployer && deployerOld && !e.deployerCard, runner: needs.runner && runnerOld && !e.runnerCovered };
}

export const anyLeft = (l: HandLeft) => l.deployer || l.runner;

/** The steps still to do, by name. */
export function leftNames(l: HandLeft): string[] {
  return [...(l.deployer ? [DEPLOYER_LEFT] : []), ...(l.runner ? [RUNNER_LEFT] : [])];
}

/** What the evidence confirms, in plain words, for a card closing with nothing left. */
export function confirmedWords(e: HandEvidence): string[] {
  const out: string[] = [];
  if (e.deployer === "current") out.push("the host runs the current deployer script");
  else if (e.deployerCard) out.push("the deployer script copy is on its own card");
  if (e.runner === "not_needed") out.push("the runners are built from the version the server runs");
  else if (e.runnerCovered) out.push("the runner rebuild has its own card or is already under way");
  return out;
}

/**
 * The sentence a closing hand card's notice carries in place of "You don't need to finish these steps": the steps
 * still to do and the card that holds them, or that nothing is left and what the host confirmed.
 */
export function leftSentence(l: HandLeft, e: HandEvidence, cardLabel: string | null): string {
  const names = leftNames(l);
  if (names.length) {
    const where = cardLabel ? ` They are on the card "${cardLabel}", which closes by itself once the host confirms them.` : "";
    return `The server part is done, but ${names.length === 1 ? "one step is" : "two steps are"} still to do: ${names.join("; and ")}.${where}`;
  }
  const done = confirmedWords(e);
  return `Nothing else is left to do${done.length ? `: ${done.join(", and ")}` : ""}.`;
}

/**
 * The line a newer one-click deploy card carries while a by-hand update's steps are still to do. A good automatic deploy
 * copies the deployer script in by itself (BOS-1588: host-deployer.sh and deploy.sh run install-deployer.sh after a good
 * deploy; a hand-apply's rebuild-live.sh does not), so that step is done by this card; the runner rebuild never is.
 */
export function newerCardLine(l: HandLeft, cardLabel: string): string {
  const parts: string[] = [];
  if (l.deployer) parts.push("The host still runs the old deployer script; this deploy copies the new one in by itself once it succeeds.");
  if (l.runner) parts.push(`The runners still need rebuilding, which this deploy doesn't do: see the card "${cardLabel}".`);
  return `Left over from the last by-hand update: ${parts.join(" ")}`;
}

/** The card's own line when the deployer copy is left: the next good automatic deploy does it too (BOS-1588). */
export const DEPLOYER_BY_DEPLOY = "The next automatic server update also copies the deployer script in by itself once it succeeds, so if one is waiting you can approve that instead of copying by hand.";
