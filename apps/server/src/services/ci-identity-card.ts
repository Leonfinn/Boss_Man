// BOS-2285: GitHub emails whoever pushed a branch when a run on it fails. The merge gate pushes bossman-ci/<ticket> with
// the company's GIT_TOKEN, so every failed gate run emails the token's owner. BOS-2125 lets the runner push those
// branches with an optional second account's GIT_CI_TOKEN, but nobody was asked for it. Boss Man holds no other git
// identity (no deploy key, no bot), so the one way to change who is emailed is to ask once: this card.
import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { decisions } from "../db/schema.js";
import { clearOwnerTodo, raiseOwnerTodo } from "./decisions.js";

export const ciIdentityKey = (companyId: string) => `owner-todo:ci-identity:${companyId}`;

export const CI_IDENTITY_QUESTION =
  "GitHub emails you every time a merge check run fails on a Boss Man gate branch (bossman-ci/...), because Boss Man pushes those branches with your token. To send those emails to a second account instead, give Boss Man that account's token. If you would rather keep the emails, answer \"A step failed\": Boss Man will not ask again. Muting GitHub Actions emails is not offered because it would also hide real failures on main.";

/** Plain steps for the owner; GitHub's screens are not yet confirmed by a real run, and the card says so. */
export const CI_IDENTITY_STEPS = [
  "Not yet confirmed on GitHub (checked against GitHub's documentation, 22 Nov 2026). Create a second GitHub account for Boss Man, or use a teammate's, and add it as a collaborator with write access to the repo: on GitHub, open the repo's Settings tab, then Collaborators.",
  "Signed in as that second account, create a fine-grained token: GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens. Repository access: only the company's repo. Permissions: Contents read and write, and Actions read and write (so Boss Man can re-run a job that failed by chance without your own token needing it). Add Workflows read and write if the repo's workflows change.",
  "In Boss Man open Settings → Secrets, choose Add, then \"Git token for the merge gate (second account)\", paste the token and save.",
  "Grant it to the company on the same screen. Do not add a user name unless your git host needs one (GitHub does not).",
];

/**
 * Called when the gate is about to publish a bossman-ci/* branch on a GitHub project. With a GIT_CI_TOKEN granted, closes
 * an open card (done by hand); without one, raises the card once per company. Never throws: a card problem must not stop a merge.
 */
export async function ensureCiIdentityCard(db: Db, companyId: string, ciToken: string | undefined): Promise<"raised" | "cleared" | "none"> {
  try {
    const key = ciIdentityKey(companyId);
    if (ciToken) {
      const r = await clearOwnerTodo(db, key, "A second account's token (GIT_CI_TOKEN) is now granted: the gate's CI branches are pushed with it. Marked done.");
      return r ? "cleared" : "none";
    }
    // dedupeKey is unique across all statuses, so an answered card (either answer) is never raised again.
    const [seen] = await db.select({ id: decisions.id }).from(decisions).where(and(eq(decisions.dedupeKey, key), eq(decisions.companyId, companyId)));
    if (seen) return "none";
    const row = await raiseOwnerTodo(db, {
      companyId,
      question: CI_IDENTITY_QUESTION,
      key,
      steps: CI_IDENTITY_STEPS,
      check: "Check it worked: after the next failed gate run, GitHub's run page shows the second account as the one who triggered it, and your own inbox stays quiet.",
      rollback: "Delete the GIT_CI_TOKEN secret in Settings → Secrets: the gate goes back to pushing with your token.",
      ofDecisionId: "system",
    });
    return row ? "raised" : "none";
  } catch {
    return "none";
  }
}
