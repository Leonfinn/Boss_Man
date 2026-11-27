// Skills Boss Man ships itself (BOS-2631): useful for any company, so every company's library
// gains them on its own, with no proposal and no security review. They are seeded by
// services/skills.ts (SEEDING built-ins), given to the matching hire template by default, and
// shown on the Skills page as "Built in to Boss Man". The text is the reviewed text installed in
// the company library it came from; a change makes a new built-in version, never a hand edit.
import type { SkillFile } from "./skills.js";

export type BuiltinSkill = {
  name: string;
  description: string;
  /** The folder's files, SKILL.md first; content is base64 (see SkillFile). */
  files: SkillFile[];
  /**
   * Agents on this hire template get the skill by default (services/agents.ts). The template's
   * `defaultSkills` lists it too, for the hire card and the Agents page.
   */
  template?: string;
};

/** Base64 of a UTF-8 string, the form SkillFile.content takes in the skills table. */
const skillMd = (text: string): SkillFile => ({ path: "SKILL.md", content: Buffer.from(text, "utf8").toString("base64") });

const PM_ALIGN_WORK_TO_FEATURES = `---
name: pm-align-work-to-features
description: Use when a ticket has no feature, when you spec new work, or in a periodic feature review. Decide whether the work deserves its own feature, attach it to an existing one, or leave it without one, and record the call.
---

# Align work to features

The feature list is how users, potential users and the owner see what the product can do. It should match the real scope of the work. Make a deliberate call for every piece of work you spec, and for tickets others created without a feature.

## The test
Would it interest someone using the product, or someone deciding whether to? Something they would notice, use, ask about, or count as a reason to choose it is a feature.

- The number of tasks does not decide it. One small task can be a feature (a new button users press). A big job can be no feature at all if users never see it.
- Usually a feature: new screens, buttons, settings or options; new capabilities; integrations and add-ons; improvements to reliability, speed, safety or ease of use that a user would feel; install and setup improvements.
- Usually not its own feature: internal refactors with no behaviour change, test-only work, one-off fixes to your own server or data, research spikes. Attach these to an open feature only if it cannot deliver its promise without them; otherwise leave them without one.

## Features are baselined
- A feature is what its title and public summary promise. Once that is live, release it. Never reopen a released feature.
- Follow-up tickets do not join a feature, except when the feature cannot deliver its promise without them (for example the follow-up carries a failed check of the build, or fixes a bug that breaks the promised behaviour). Write that reason in one line on the ticket.
- Enhancements, polish and "next version" work become a new feature written for users, or no feature if users would not care. Never move them into another existing feature.

## Steps
1. Search first: \`feedback\` action \`features\` with \`q\` set to the key nouns. Reuse an open feature that fits; never create a near-duplicate.
2. If none fits and the test says yes, create one (\`feedback\` action \`create_feature\`) with a plain title and a description of the problem it solves and for whom. Pass \`objectiveId\` or \`milestoneId\` from \`board\` when it serves one.
3. Attach the ticket: \`update_ticket\` with \`featureId\` (or pass \`featureId\` to \`create_ticket\` for new work).
4. Size every new feature (\`feedback\` action \`size\`, effort 1 to 5 with a reason). An unsized feature cannot be ranked.
5. Place it on the roadmap at once (see the skill pm-roadmap-and-portal). No feature is left unplaced.
6. Record the call in one line on the ticket or spec: "Feature: yes, users will see X" or "Feature: no, internal refactor".

## Periodic review
Run a standing review (for example every 48 hours). Part 1: look only at tickets created or finished since the last review's logged time. Part 2: check every open feature's status; release what is live, move leftover tickets off, split features that are partly live. Log each review's time and calls on one wiki page, then block the standing ticket until the next review and book a check for that time. Never close the standing ticket.

## If a tool refuses you
Say so on your ticket and tell the CEO which tool and action was refused. Never leave a list for someone else to enter and close your ticket as done.
`;

const PM_ROADMAP_AND_PORTAL = `---
name: pm-roadmap-and-portal
description: Use when you create or attach a feature, when work on a feature starts or ships, or in a periodic feature review. Place every feature on the roadmap, keep its status true, and decide what the public feedback portal shows.
---

# Keep the roadmap and portal true

The roadmap and the public portal are owned by the product manager. Do the updates yourself; do not hand them to the CEO.

## Place every feature
1. Read the roadmap first: \`roadmap\` action \`list\`. Reuse an objective that fits; add one (\`roadmap\` action \`add_objective\`, priority 1 most important to 5) only when none does.
2. Link the feature: \`feedback\` action \`update_feature\` with \`objectiveId\` (or \`milestoneId\`), \`horizon\` now, next or later, and a \`reason\`.
   - now: being built or next in line.
   - next: agreed and expected after the current work.
   - later: wanted but not scheduled.
3. Keep \`status\` true to the work: idea, considering, planned, in_progress, released, declined. Move it to released only when the work is merged and live, not when a ticket closes.
4. Make sure the feature is sized so it ranks (priority is value divided by effort).

## The public portal
- Features go on the portal by default. Write \`publicSummary\` first (plain words, up to 2000 characters), and a \`publicTitle\` if the summary's first line is not a good title. Then set \`portalVisible\` true.
- The public text must have no internal names, agent names, ticket numbers, hostnames, paths or secrets. Say what the user gets.
- Keep off the portal anything security-related or sensitive (permissions, credentials, secrets, network controls and similar), or anything you would hold back for another good reason. Mark it \`keepOffPortal\` with a reason.
- Put held-back features to the owner as one decision per review: list each with its reason, options Keep off / Publish, and your recommendation. Do not raise one card per feature.

## Each review
- Check that every feature touched since the last review has an objective or milestone, a horizon, a true status and a size.
- Write one line per change in the review log, with the reason.

## If a tool refuses you
Say so on your ticket and tell the CEO which tool and action was refused. Never leave a list for someone else to enter.
`;

const PM_MILESTONES = `---
name: pm-milestones
description: Use when planning a set of work that should land together by a date, when an objective needs checkpoints, or when a milestone's tickets or date drift. Create milestones under objectives, fill them with the right tickets, and keep their dates honest.
---

# Milestones

A milestone is a checkpoint under an objective: a named set of work with a target date. Its date means the work is built and live, not just merged or closed.

## Create one
1. Read first: \`roadmap\` action \`list\`. Reuse a milestone that already fits; never add a near-duplicate.
2. Pick the objective it serves. Add the milestone with \`roadmap\` action \`add_milestone\`: \`objectiveId\`, a plain \`title\` saying what the user can do once it lands, \`targetDate\` (YYYY-MM-DD) and \`horizon\` now, next or later, plus a \`reason\`.
3. Set the date from the work, not a wish. Compare the tickets with \`sizing_guide\`, count what must happen after merge (go-live, owner checks), and add the time for those.

## Fill it
- Put each ticket in with \`roadmap\` action \`set\` (or \`set_milestone\`). Only tickets the milestone needs; nice-to-haves stay out.
- Order the work: link tickets that depend on others with \`link_tickets\` so the critical path is visible.
- Attach the milestone's features too (\`feedback\` action \`update_feature\` with \`milestoneId\`).
- Owner checks or week-long watches go on their own watch tickets in the milestone, not on the build tickets.

## Keep it honest
- If the dates show it will be late, say so on the milestone's tickets and tell the CEO with the reason and a proposed fix: cut scope, move the date, or reorder. Moving a date or cutting scope the owner set is the owner's decision; raise it as one with your recommendation.
- Never mark a milestone done until its work is live.
- Close or move tickets that no longer belong, with a reason.

## If a tool refuses you
Say so on your ticket and tell the CEO which tool and action was refused.
`;

/** Every skill Boss Man ships. Adding one here seeds it in every company (services/skills.ts). */
export const BUILTIN_SKILLS: BuiltinSkill[] = [
  { name: "pm-align-work-to-features", description: "Decide whether work deserves its own feature, attach it to an existing one, or leave it without one, and record the call.", files: [skillMd(PM_ALIGN_WORK_TO_FEATURES)], template: "product-manager" },
  { name: "pm-roadmap-and-portal", description: "Place every feature on the roadmap, keep its status true, and decide what the public feedback portal shows.", files: [skillMd(PM_ROADMAP_AND_PORTAL)], template: "product-manager" },
  { name: "pm-milestones", description: "Create milestones under objectives, fill them with the right tickets, and keep their dates honest.", files: [skillMd(PM_MILESTONES)], template: "product-manager" },
];

export const BUILTIN_SKILL_NAMES = BUILTIN_SKILLS.map((s) => s.name);

export const builtinSkill = (name: string) => BUILTIN_SKILLS.find((s) => s.name === name) ?? null;

/** Every built-in a hire on this template gets by default. */
export const builtinSkillsForTemplate = (template: string | null | undefined) => BUILTIN_SKILLS.filter((s) => s.template && s.template === template).map((s) => s.name);
