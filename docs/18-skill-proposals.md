# 18 · Skill proposals (BOS-86)

The CEO can propose a skill; nothing reaches the library without the owner's decision.

**Sources.** A CEO draft (SKILL.md plus files) or an internet link. A GitHub link is pinned to the commit it was read at, and every file is hashed (sha256, plus one hash over the whole set). The reviewed bytes are stored on the proposal; install writes those bytes, after re-reading the source at the pinned commit and comparing hashes. Any difference marks the proposal `stale` and installs nothing.

**When a security review is required (owner's rule, 2026-10-27).** Internet skills: always. CEO drafts: only if the system finds a script. The system decides (`scriptFilesOf` in `services/skill-proposals.ts`), never the CEO: an executable or interpreted file (`.sh .bash .zsh .py .js .mjs .cjs .ts .rb .ps1 .bat .cmd .pl .php`, `Makefile`, `Dockerfile`, anything under `scripts/`, a `#!` first line, a compiled program), or a code block in an instruction file in a runnable language, or an untagged block right after words like "run" or "execute". Every new version is judged again from its own files.

**Review.** A ticket for the agent marked as the company's security reviewer carries every text file with numbered lines. The verdict (`skills` tool, `review_verdict`) must be for the same bundle hash, and every finding must name a real file and a line range inside it. Format: the wiki page `security/skill-review-standard-bos-87`.

**Decision.** Decision kind `skill`. "Advise against" offers only "Don't add it" and "Add it anyway, against the advice"; the override is stored on the proposal and logged with who and when. A proposal that needs a review has no decision until a verdict for these exact files is in (checked again when the owner answers).

**Updates.** A new version is a new proposal for the same name. Nothing updates itself.

**Log.** `skill.proposed`, `skill.review_requested` / `skill.review_skipped`, `skill.reviewed`, `skill.awaiting_owner`, `skill.decided`, `skill.overridden`, `skill.installed`, `skill.given`, `skill.stale`, `skill.expired` in the activity log. Proposals nobody decides in 14 days expire.
