// Skills and packs (R71), owner only. Moved out of app.ts unchanged (BOS-298 step 15).
// The caller passes its owner scope, so requireOwner and the app's error handler still apply:
// this registers routes on that instance rather than through app.register, which would add a new scope.
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { RUNNER_ADDONS } from "@boss-man/shared";
import type { Db } from "../db/client.js";
import { record } from "../services/activity.js";
import { SkillError, type skillsService } from "../services/skills.js";
import { skillChangeEntry, skillSide } from "../services/skill-files.js";
import type { skillProposalsService } from "../services/skill-proposals.js";
import { PageQuery } from "../services/list-page.js";

import { and, desc, eq, inArray, or, sql } from "drizzle-orm";
import { activity, agents } from "../db/schema.js";

const HISTORY_WORDS: Record<string, string> = {
  "skill.added_by_owner": "Added by you",
  "skill.edited_by_owner": "Edited by you",
  "skill.reverted_by_retro": "Put back by a workflow retro",
  "skill.proposed": "A new version was proposed",
  "skill.updated": "A newer version was approved",
  "skill.installed": "Added to the library after review",
};
const HISTORY_KINDS = Object.keys(HISTORY_WORDS);

const Uuid = z.string().uuid();
const IdParam = z.object({ id: Uuid });

export function skillRoutes(
  owner: FastifyInstance,
  db: Db,
  { skillsSvc, skillProposals }: { skillsSvc: ReturnType<typeof skillsService>; skillProposals: ReturnType<typeof skillProposalsService> },
) {
  // Skills (R71): the company's library, and who has what.
  const skillErrors = (reply: FastifyReply) => (err: unknown) => {
    if (err instanceof SkillError) return reply.code(err.status).send({ error: "skill", message: err.message });
    throw err;
  };
  const SkillParams = z.object({ id: Uuid, skillId: Uuid });
  const SkillFiles = z.array(z.object({ path: z.string().min(1).max(500), content: z.string().max(4_000_000) })).min(1).max(200);
  // Skills the CEO proposed: the owner answers through the decision; these show what is behind it.
  owner.get("/api/companies/:id/skill-proposals", async (req) => skillProposals.list(IdParam.parse(req.params).id, PageQuery.parse(req.query)));
  owner.get("/api/companies/:id/skill-proposals/:pid", async (req, reply) => {
    const { id, pid } = z.object({ id: Uuid, pid: Uuid }).parse(req.params);
    return skillProposals.detail(id, pid).catch(skillErrors(reply));
  });
  owner.get("/api/companies/:id/skills", async (req) => skillsSvc.list(IdParam.parse(req.params).id));
  owner.post("/api/companies/:id/skills", { bodyLimit: 8 * 1024 * 1024 }, async (req, reply) => {
    const { id } = IdParam.parse(req.params);
    const b = z
      .discriminatedUnion("from", [
        z.object({ from: z.literal("link"), url: z.string().url().max(2000) }),
        z.object({ from: z.literal("written"), name: z.string().trim().min(1).max(64), description: z.string().trim().min(1).max(1024), body: z.string().max(100_000) }),
        z.object({ from: z.literal("upload"), name: z.string().trim().max(64).optional(), files: SkillFiles }),
      ])
      .parse(req.body);
    try {
      const added = b.from === "link" ? await skillsSvc.fromLink(id, b.url) : b.from === "written" ? [await skillsSvc.write(id, b)] : [await skillsSvc.upload(id, b.files, b.name)];
      // The owner's own add is their call, but it skips the review: say so in the log.
      for (const x of added) await record(db, { companyId: id, kind: "skill.added_by_owner", summary: `The owner added the skill ${x.name} directly (${b.from === "link" ? `from ${b.url}` : b.from}). Added by the owner, not security-reviewed.` });
      return reply.code(201).send(added.map((s) => ({ id: s.id, name: s.name, sourceRef: s.sourceRef })));
    } catch (err) {
      return skillErrors(reply)(err);
    }
  });
  // Other companies' skills, to copy into this one (not which agents hold them).
  owner.get("/api/companies/:id/skills/elsewhere", async (req) => {
    const { id } = IdParam.parse(req.params);
    const { q } = z.object({ q: z.string().max(100).default("") }).parse(req.query);
    return skillsSvc.searchElsewhere(id, q);
  });
  owner.post("/api/companies/:id/skills/copy", async (req, reply) => {
    const { id } = IdParam.parse(req.params);
    const { skillId } = z.object({ skillId: Uuid }).parse(req.body);
    return skillsSvc.copyFrom(id, skillId).then((s) => reply.code(201).send(s), skillErrors(reply));
  });
  owner.get("/api/companies/:id/skills/:skillId", async (req, reply) => {
    const { id, skillId } = SkillParams.parse(req.params);
    return skillsSvc.get(id, skillId).catch(skillErrors(reply));
  });
  // What changed in one skill and when (BOS-2376): the activity log's skill rows, newest first. Edits, newer
  // versions and retro reverts carry the skill id in `detail`; a proposal or install names it in the summary.
  owner.get("/api/companies/:id/skills/:skillId/history", async (req, reply) => {
    const { id, skillId } = SkillParams.parse(req.params);
    const skill = await skillsSvc.get(id, skillId).catch(skillErrors(reply));
    if (!skill) return reply;
    const rows = await db
      .select({ id: activity.id, at: activity.at, kind: activity.kind, summary: activity.summary, detail: activity.detail, agentName: agents.name })
      .from(activity)
      .leftJoin(agents, eq(agents.id, activity.agentId))
      .where(
        and(
          eq(activity.companyId, id),
          inArray(activity.kind, [...HISTORY_KINDS]),
          or(sql`${activity.detail}->>'skillId' = ${skillId}`, sql`strpos(lower(${activity.summary}), lower(${`skill ${skill.name}`})) > 0`, sql`strpos(lower(${activity.summary}), lower(${`installed ${skill.name} `})) = 1`, sql`strpos(lower(${activity.summary}), lower(${`installed ${skill.name},`})) = 1`),
        ),
      )
      .orderBy(desc(activity.at))
      .limit(50);
    return rows.map((r) => {
      const d = r.detail as { skillMd?: { before?: string; after?: string } } | null;
      const text = d?.skillMd && typeof d.skillMd.before === "string" && typeof d.skillMd.after === "string" ? { before: d.skillMd.before, after: d.skillMd.after } : null;
      return {
        id: r.id,
        at: r.at.toISOString(),
        what: HISTORY_WORDS[r.kind] ?? r.kind,
        who: r.agentName ?? (r.kind.endsWith("_by_owner") ? "you" : "Boss Man"),
        summary: r.summary,
        change: text && text.before !== text.after ? text : null,
      };
    });
  });
  owner.put("/api/companies/:id/skills/:skillId", async (req, reply) => {
    const { id, skillId } = SkillParams.parse(req.params);
    const b = z.object({ name: z.string().trim().min(1).max(64), description: z.string().trim().min(1).max(1024), body: z.string().max(100_000), confirmEmptyBody: z.boolean().optional() }).parse(req.body);
    try {
      // The edit replaces the skill's files: keep the old text so the log says what actually changed.
      const old = await skillsSvc.get(id, skillId);
      const oldSkillMd = old.files.find((f) => f.path === "SKILL.md")?.text ?? "";
      const s = await skillsSvc.write(id, { ...b, replaceId: skillId });
      // An edited skill is new, unreviewed text: log it so an approved skill can never change without a trace.
      const entry = skillChangeEntry(
        skillId,
        { name: old.name, description: old.description, bundleHash: old.bundleHash, skillMd: oldSkillMd, paths: old.files.map((f) => f.path) },
        skillSide(s),
        (from, to, was) => `Owner edited the skill ${s.name}${was} from ${from} to ${to}`,
        " Not security-reviewed; full text in detail.",
      );
      await record(db, { companyId: id, kind: "skill.edited_by_owner", ...entry });
      return { id: s.id, name: s.name };
    } catch (err) {
      return skillErrors(reply)(err);
    }
  });
  owner.post("/api/companies/:id/skills/:skillId/refresh", async (req, reply) => {
    const { id, skillId } = SkillParams.parse(req.params);
    return skillProposals.proposeRefresh(id, skillId).then((p) => ({ changed: !!p, proposalId: p?.id ?? null, status: p?.status ?? null }), skillErrors(reply));
  });
  owner.delete("/api/companies/:id/skills/:skillId", async (req, reply) => {
    const { id, skillId } = SkillParams.parse(req.params);
    return skillsSvc.remove(id, skillId).then(() => reply.code(204).send(), skillErrors(reply));
  });
  // Packs: skills added together from one link (R71), given and updated as one. A pack's name
  // has a slash in it (owner/repo), so it travels in the body or the query.
  const PackName = z.string().min(1).max(200);
  owner.put("/api/companies/:id/skill-packs/agents", async (req, reply) => {
    const { id } = IdParam.parse(req.params);
    const { pack, agentIds } = z.object({ pack: PackName, agentIds: z.array(Uuid).max(200) }).parse(req.body);
    return skillsSvc.setPackHolders(id, pack, agentIds).then(() => ({ pack, agentIds }), skillErrors(reply));
  });
  owner.post("/api/companies/:id/skill-packs/refresh", async (req, reply) => {
    const { id } = IdParam.parse(req.params);
    const { pack } = z.object({ pack: PackName }).parse(req.body);
    return skillProposals.proposeRefreshPack(id, pack).catch(skillErrors(reply));
  });
  owner.delete("/api/companies/:id/skill-packs", async (req, reply) => {
    const { id } = IdParam.parse(req.params);
    const { pack } = z.object({ pack: PackName }).parse(req.query);
    return skillsSvc.removePack(id, pack).then(() => reply.code(204).send(), skillErrors(reply));
  });
  owner.put("/api/companies/:id/skills/:skillId/addons", async (req, reply) => {
    const { id, skillId } = SkillParams.parse(req.params);
    const { requires } = z.object({ requires: z.array(z.string().max(40)).max(10) }).parse(req.body);
    return skillsSvc.setRequires(id, skillId, requires).then(() => ({ requires }), skillErrors(reply));
  });
  owner.get("/api/runner-addons", async () => RUNNER_ADDONS);
  owner.put("/api/companies/:id/skills/:skillId/agents", async (req, reply) => {
    const { id, skillId } = SkillParams.parse(req.params);
    const { agentIds } = z.object({ agentIds: z.array(Uuid).max(200) }).parse(req.body);
    return skillsSvc.setHolders(id, skillId, agentIds).then(() => ({ agentIds }), skillErrors(reply));
  });
}
