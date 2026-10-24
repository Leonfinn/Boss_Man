# 13 — Team plan from a project's scope

Status: design, not built (asked 24 Oct 2026).

## Today

- The owner can create agents by hand from a template.
- The CEO can `propose_hire`: from a template, with a tailored title, instructions and model. Each hire waits for the owner unless approvals are off.
- The CEO is told to hire only reactively: "if the same gap keeps coming up, propose_hire the missing role".
- Creating a project, or growing its scope, wakes nobody.

## Change

1. **When it runs:**
   - a project is created;
   - an objective or milestone is added to a project that has a team;
   - the owner asks in chat ("recommend a team for X").

   The first two wake the CEO with reason `team plan`. Repeated triggers within a day merge into one wake.
2. **What the CEO does:**
   - reads the project (repo, brief if any, objectives, milestones, open tickets) and the current team;
   - drafts a plan with one tool call, `propose_team`. The plan holds who already covers what, plus each proposed hire: template, name, model, skills to give from the library, the reason, and which objectives the hire serves.
   - The CEO is told to propose the **smallest team that covers the scope**, and to reuse existing agents first.
3. **What the owner sees:** one decision, "Team plan for <project>". It lists each hire with a tick box, and has the options "Hire the ticked ones" and "Not now".
   - Ticked hires go through the normal hire path. A hire still waits on the owner's approval setting; approving the plan counts as that approval.
   - Each hire is given its listed skills.
   - "Not now" records the decision, so the CEO doesn't propose the same plan again until the scope changes.
4. **Manual path unchanged.** The owner can still create agents by hand, or ignore the plan.

## Build order

1. `propose_team` tool, the team-plan decision with per-hire choices, and CEO template guidance. Triggered from chat only.
2. Wake on project creation and on scope growth, with coalescing.
