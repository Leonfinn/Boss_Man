# 26 · Skill proposals (BOS-86)

The CEO can propose a skill; nothing reaches the library without the owner's decision.

**Sources.** A CEO draft (SKILL.md plus files) or an internet link. A GitHub link is pinned to the commit it was read at, and every file is hashed (sha256, plus one hash over the whole set). The reviewed bytes are stored on the proposal; install writes those bytes, after re-reading the source at the pinned commit and comparing hashes. Any difference marks the proposal `stale` and installs nothing.

**When a security review is required (owner's rule, 2026-10-28, decision 21f7791b).** Every skill, from either source, gets a Security Reviewer verdict before the owner decides. The earlier rule (internet always, CEO drafts only when the system found a script) was replaced after adversarial rounds showed that "is this a script?" is a guess: a plain sentence can tell an agent to read secrets. The script check (`scriptFilesOf` in `services/skill-files.ts`) remains only as information (the proposal list's `hasScripts`, the activity log); it no longer decides whether a review happens. It looks for a command anywhere in a line, not only at its start: an argument that is a file path, or a dotted path like `~/.aws/credentials` or `.env`, after a file-reading command (`cat`, `cp`, `tar`, `head`, …) counts as a script, while prose that only mentions the word ("copy the notes with cat") stays prose (BOS-177). Every new version is reviewed again from its own files.

**File paths.** Only printable ASCII is allowed, and no leading or trailing space in any part of the path. Invisible characters, lookalike letters and stray spaces are refused outright, so a name can't hide what a file is.

**Updates and the old doors (BOS-89).** "Check for updates" (one skill or a pack) no longer writes the library: it makes a proposal like any internet skill. Plain (non-GitHub) links are pinned as `sha256:<hash of the file>` and re-checked at install. Each file shows its sha256 on the review ticket, the decision card and the skill page. A test (`skill-proposals.test.ts`) fails if any code other than `services/skills.ts` writes the skills table, or if the CEO/reviewer code calls anything but `save` and `give` on it.

**Review.** A ticket for a Security Reviewer (any agent the company's Settings > Reviews names for security reviews at any risk level; the least loaded one, never the proposer) carries every text file with numbered lines. The verdict (`skills` tool, `review_verdict`) must be for the same bundle hash, and every finding must name a real file and a line range inside it. Format: the wiki page `security/skill-review-standard-bos-87`.

**Decision.** Decision kind `skill`. "Advise against" offers only "Don't add it" and "Add it anyway, against the advice"; the override is stored on the proposal and logged with who and when. No proposal has a decision until a verdict for its exact files is in (checked again when the owner answers).

**Updates.** A new version is a new proposal for the same name. Nothing updates itself.

**Log.** `skill.proposed`, `skill.review_requested`, `skill.reviewed`, `skill.awaiting_owner`, `skill.decided`, `skill.overridden`, `skill.installed`, `skill.given`, `skill.stale`, `skill.expired` in the activity log. Proposals nobody decides in 14 days expire.
