/**
 * Whether the owner's sign-off on commit `signed` still covers the branch head (BOS-734, DR-038).
 * It does only when nothing but clean, automatic merges of the target came in since:
 *  1. `signed` is an ancestor of `head` (nothing was rewritten);
 *  2. no commit of the ticket's own (non-merge, not on the target) sits in signed..head;
 *  3. every merge in that range has two parents, its second parent is on the target, and its tree is exactly
 *     what `git merge-tree --write-tree` makes of its parents (no clashes, no hand edits).
 * Any git doubt (an unknown commit, an unexpected exit code) says "does not cover".
 */
export type SignoffCover = { covers: boolean; reason: string; newCommits: number; handMerges: number };
type GitCode = (args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;

const no = (reason: string, newCommits = 0, handMerges = 0): SignoffCover => ({ covers: false, reason, newCommits, handMerges });

export async function checkSignoffCovers(git: GitCode, signed: string, head: string, target: string): Promise<SignoffCover> {
  try {
    if (signed === head) return { covers: true, reason: "the branch is at the signed-off commit", newCommits: 0, handMerges: 0 };
    const anc = await git(["merge-base", "--is-ancestor", signed, head]);
    if (anc.code !== 0) return no("the signed-off commit is no longer part of the branch (it was rewritten)");
    const own = await git(["rev-list", "--no-merges", `${signed}..${head}`, "--not", target]);
    if (own.code !== 0) return no("the branch history couldn't be read");
    const newCommits = own.stdout.split("\n").filter(Boolean).length;
    if (newCommits > 0) return no(`${newCommits} new commit${newCommits === 1 ? "" : "s"} of the ticket's own since the sign-off`, newCommits);
    const merges = await git(["rev-list", "--merges", "--parents", `${signed}..${head}`, "--not", target]);
    if (merges.code !== 0) return no("the branch history couldn't be read");
    let hand = 0;
    for (const line of merges.stdout.split("\n").filter(Boolean)) {
      const [m, ...parents] = line.split(" ");
      let clean = false;
      if (m && parents.length === 2) {
        const [p1, p2] = parents as [string, string];
        const onTarget = await git(["merge-base", "--is-ancestor", p2, target]);
        const tried = onTarget.code === 0 ? await git(["merge-tree", "--write-tree", p1, p2]) : null;
        const tree = tried?.code === 0 ? await git(["rev-parse", "--verify", `${m}^{tree}`]) : null;
        clean = !!tried && tried.code === 0 && !!tree && tree.code === 0 && tried.stdout.split("\n")[0] === tree.stdout.trim();
      }
      if (!clean) hand++;
    }
    if (hand > 0) return no(`${hand} merge${hand === 1 ? "" : "s"} with fixes made by hand or code from outside the target`, 0, hand);
    return { covers: true, reason: "since the sign-off, main was only merged in automatically, with no clashes and no new code from the ticket", newCommits: 0, handMerges: 0 };
  } catch {
    return no("the branch couldn't be checked");
  }
}
