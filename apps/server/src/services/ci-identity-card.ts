// BOS-2285: GitHub emails whoever pushed a branch when a run on it fails. The merge gate pushes bossman-ci/<ticket> with
// the company's GIT_TOKEN, so every failed gate run emails the token's owner. BOS-2125 lets the runner push those
// branches with an optional second account's GIT_CI_TOKEN, but nobody was asked for it. Boss Man holds no other git
// identity (no deploy key, no bot), so the one way to change who is emailed is to ask once: this card.
import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { decisions } from "../db/schema.js";
import { clearOwnerTodo, raiseOwnerTodo } from "./decisions.js";

export const ciIdentityKey = (companyId: string) => `owner-todo:ci-identity:${companyId}`;

/** The answer that stops the asking. "A step failed" records a step problem and keeps the card open. */
export const CI_KEEP_EMAILS = "Keep the emails";

export const CI_IDENTITY_QUESTION =
  "GitHub emails you every time a merge check run fails on a Boss Man gate branch (bossman-ci/...), because Boss Man pushes those branches with your token. To send those emails to a second account instead, give Boss Man that account's token. If you would rather keep the emails, answer \"Keep the emails\": Boss Man will not ask again. If a step does not work on your screen, answer \"A step failed\" and say what you saw: the card stays open and Boss Man looks into it. Muting GitHub Actions emails is not offered because it would also hide real failures on main.";

/** Plain steps for the owner; GitHub's screens are not yet confirmed by a real run, and the card says so. */
export const CI_IDENTITY_STEPS = [
  "Create a second GitHub account for Boss Man, or use a teammate's, and add it as a collaborator with write access to the repo: on GitHub, open the repo's Settings tab, then Collaborators. Signed in as that second account, accept the invitation; the repo then shows under Your repositories.",
  "Still signed in as the second account, create a classic token: profile picture → Settings → Developer settings → Personal access tokens → Tokens (classic) → Generate new token → Generate new token (classic). Tick the scopes repo and workflow (repo also lets Boss Man re-run a job that failed by chance with this token), then copy the token. Not yet confirmed on GitHub for the classic screens.",
  "Why classic: a fine-grained token only reaches repos owned by the resource owner you pick, so for a repo you are only a collaborator on it offers nothing (seen: f2eee874… 23 Nov 2026). The classic token reaches only repos this account was invited to. If an organisation owns the repo, a fine-grained token with the organisation as resource owner works too.",
  "Expiry: pick No expiration for a dedicated account, or set a reminder. When an expiring token lapses, the gate's CI pushes fail until you replace it.",
  "A classic token can't be limited to one repository: its picker doesn't exist on that screen. Its reach is whatever the account can reach, so keep the limit in the account: a dedicated account that is a collaborator only on this repo, owns no repos of its own and belongs to no organisations.",
  "In Boss Man open Settings → Secrets, choose Add, then \"Git token for the merge gate (second account)\", paste the token and save.",
  "Grant it to the company on the same screen. Do not add a user name unless your git host needs one (GitHub does not). This card closes itself once the token is granted; you don't need to press anything.",
  "Last, stop the second account's own emails: signed in as it, open github.com/settings/notifications, find System → Actions and untick Email (not yet confirmed on GitHub's current screen). This is safe: runs on main are pushed with your own token, so you still get those. Without this, GitHub emails the second account about failed gate runs and the address can still reach you.",
];

/** The grant that means "the second account's token is set". */
export const CI_TOKEN_ENV = "GIT_CI_TOKEN";

/**
 * Closes the card as soon as GIT_CI_TOKEN is granted, instead of at the next merge that waits for GitHub's checks.
 * A revoked grant (no value left) leaves the card as it is. Never throws.
 */
export function watchCiTokenGrant(
  secrets: { onGrantChange(l: (c: { companyId: string; envName: string }) => void): void; grantedValue(companyId: string, envName: string): Promise<string | null> },
  db: Db,
): void {
  secrets.onGrantChange(({ companyId, envName }) => {
    if (envName !== CI_TOKEN_ENV) return;
    void (async () => {
      try {
        const value = await secrets.grantedValue(companyId, CI_TOKEN_ENV);
        if (value) await ensureCiIdentityCard(db, companyId, value);
      } catch {
        // The merge-time clear in ciStep is the backstop.
      }
    })();
  });
}

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
      extraOption: CI_KEEP_EMAILS,
    });
    return row ? "raised" : "none";
  } catch {
    return "none";
  }
}
