// The sizing guide (docs/19-workflow-retros.md part 6): what finished tickets of each size really took, so a planner sizes by comparison.
import { and, eq, like, sql } from "drizzle-orm";
import { SIZE_SCALE, TASK_SIZES, untrusted } from "@boss-man/shared";
import type { Db } from "../db/client.js";
import { agentSkills, skills } from "../db/schema.js";
import { hrs, usd } from "./retro.js";
import { workflowService } from "./workflow.js";

const OUTPUT_CAP = 6000;
const PLAYBOOK_CAP = 2500;
/** A retro-made playbook is the sizing playbook when its name starts with this. */
export const SIZING_PLAYBOOK_PREFIX = "sizing";

export async function sizingGuideText(db: Db, companyId: string, now?: () => Date): Promise<string> {
  const sc = await workflowService(db, { now }).scorecard(companyId, 90);
  const out = [`# Sizing guide. Sizes are ${SIZE_SCALE}, relative to each other. Size by comparison: find the finished ticket below that looks most like yours ("like BOS-42, which was a 3"). Figures are from tickets finished in the last 90 days.`];
  for (const size of TASK_SIZES) {
    const mine = sc.sizeExamples.filter((e) => e.size === size);
    out.push("", `## Size ${size}`);
    if (!mine.length) out.push("- No finished ticket of this size yet.");
    else out.push(untrusted("ticket titles", mine.map((e) => `- ${e.ref ?? "a ticket"} "${e.title.replace(/\s+/g, " ").slice(0, 100)}" (${e.role ?? "unassigned"}): ${hrs(e.cycleMs)}, ${usd(e.costMicros)}, ${e.rework} send-back${e.rework === 1 ? "" : "s"}`).join("\n")));
    const typical = sc.sizes.filter((r) => r.size === size);
    if (typical.length) out.push(`Typical per role: ${typical.map((r) => `${r.role} ${hrs(r.p50CycleMs)} middle time, ${usd(r.meanCostMicros)} average, ${r.done} finished`).join("; ")}.`);
  }
  // Matched by name: a skill a retro made (source "retro") whose name starts with "sizing", and that some agent still has. A reverted playbook has nobody, so it drops out.
  const found = await db
    .select({ name: skills.name, files: skills.files, holders: sql<number>`count(${agentSkills.agentId})::int` })
    .from(skills)
    .innerJoin(agentSkills, eq(agentSkills.skillId, skills.id))
    .where(and(eq(skills.companyId, companyId), eq(skills.source, "retro"), like(skills.name, `${SIZING_PLAYBOOK_PREFIX}%`)))
    .groupBy(skills.id);
  for (const s of found) {
    const md = Buffer.from(s.files.find((f) => f.path === "SKILL.md")?.content ?? "", "base64").toString("utf8");
    out.push("", `## Sizing playbook "${s.name}" (made by a workflow retro, approved by the CEO; found because its name starts with "${SIZING_PLAYBOOK_PREFIX}")`, md.length > PLAYBOOK_CAP ? `${md.slice(0, PLAYBOOK_CAP)}\n… cut` : md);
  }
  const all = out.join("\n");
  return all.length <= OUTPUT_CAP ? all : `${all.slice(0, OUTPUT_CAP)}\n\n… cut: the rest is left out to keep this short.`;
}
