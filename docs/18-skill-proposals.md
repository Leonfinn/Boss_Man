# 18 · Skill proposals (BOS-86)

The CEO can propose a skill; nothing reaches the library without the owner's decision.

**Sources.** A CEO draft (SKILL.md plus files) or an internet link. A GitHub link is pinned to the commit it was read at, and every file is hashed (sha256, plus one hash over the whole set). The reviewed bytes are stored on the proposal; install writes those bytes, after re-reading the source at the pinned commit and comparing hashes. Any difference marks the proposal `stale` and installs nothing.

**When a security review is required (owner's rule, 2026-10-27).** Internet skills: always. CEO drafts: only if the system finds a script. The system decides (`scriptFilesOf` in `services/skill-files.ts`), never the CEO. Stricter than the BOS-87 wording after the BOS-89 attacks: only plain documents (`.md`, `.markdown`, `.txt`) can be instructions; every other file counts as a script, whatever it is called or however it is cased (`bin/evil`, `run`, `evil.PY`, `Makefile`, binaries, images). A document still counts if it starts with `#!`, contains a NUL byte, or has a code block in a runnable language (or an untagged block right after words like "run"). Every new version is judged again from its own files.

**Updates and the old doors (BOS-89).** "Check for updates" (one skill or a pack) no longer writes the library: it makes a proposal like any internet skill. Plain (non-GitHub) links are pinned as `sha256:<hash of the file>` and re-checked at install. Each file shows its sha256 on the review ticket, the decision card and the skill page. A test (`skill-proposals.test.ts`) fails if any code other than `services/skills.ts` writes the skills table, or if the CEO/reviewer code calls anything but `save` and `give` on it.

**Review.** A ticket for the agent marked as the company's security reviewer carries every text file with numbered lines. The verdict (`skills` tool, `review_verdict`) must be for the same bundle hash, and every finding must name a real file and a line range inside it. Format: the wiki page `security/skill-review-standard-bos-87`.

**Decision.** Decision kind `skill`. "Advise against" offers only "Don't add it" and "Add it anyway, against the advice"; the override is stored on the proposal and logged with who and when. A proposal that needs a review has no decision until a verdict for these exact files is in (checked again when the owner answers).

**Updates.** A new version is a new proposal for the same name. Nothing updates itself.

**Log.** `skill.proposed`, `skill.review_requested` / `skill.review_skipped`, `skill.reviewed`, `skill.awaiting_owner`, `skill.decided`, `skill.overridden`, `skill.installed`, `skill.given`, `skill.stale`, `skill.expired` in the activity log. Proposals nobody decides in 14 days expire.
