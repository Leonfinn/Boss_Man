// The project brief (R-brief): one wiki page per project, written by the CEO from the code, so
// agents read the section they need instead of exploring the whole codebase.
import { and, eq, isNull, ne, inArray } from "drizzle-orm";
import { parseRepoUrl } from "@boss-man/shared";
import type { Db } from "../db/client.js";
import { agents, projects, settings, tickets, wikiPages, wikiRevisions } from "../db/schema.js";
import type { gitHostService } from "./git-hosts.js";
import type { workService } from "./work.js";
import { LESSONS_CAP, LESSONS_HEADING, addLesson, liveWikiPage, lessonLine, lessonsFrom, removeLessonLine, serialiseWrite, splitSections } from "./wiki.js";

// The lessons helpers and their decision answers live in wiki.ts beside the section parsing
// (the brief-write guard needs them there); re-exported so callers find them at the brief.
export { LESSONS_HEADING, LESSONS_CAP, LESSON_ADD, LESSON_EDIT, LESSON_DROP, LESSON_DONT_ADD, LESSON_REPLACE_PREFIX, LESSON_MAX, lessonLine, lessonsSection, lessonsFrom, addLesson, removeLessonLine, normalizeLesson } from "./wiki.js";

// A stub brief keeps its parse-off first line ("unknown" is no hex commit), so the upkeep loop
// doesn't open refresh tickets for a page nobody has mapped yet.
const STUB_FIRST_LINE = "Describes commit unknown on unknown.";
export const BRIEF_HEADINGS = ["Objectives", "Architecture", "Code map", "Conventions", "Build and test", "Gotchas", "Glossary"];

/** The project's brief page row, or null when nobody has written it. */
export async function lessonsPageRow(db: Db, companyId: string, projectId: string) {
  const [p] = await db.select().from(wikiPages).where(and(eq(wikiPages.companyId, companyId), eq(wikiPages.slug, briefSlug(projectId))));
  return p ?? null;
}

/**
 * Puts an owner-approved lesson in the project's brief: writes the page when there isn't one,
 * swaps out the line the owner chose to replace, and keeps the old text as a revision. The
 * Lessons section is capped by the caller; this only writes.
 */
export async function writeLesson(db: Db, ctx: { companyId: string; projectId: string; projectName: string }, lesson: string, replaced?: string) {
  // Queued with every wiki write, so the version saved below always matches what the page held
  // before it (BOS-496).
  await serialiseWrite(async () => {
    const bodyOf = (body: string) => addLesson(replaced ? removeLessonLine(body, replaced) : body, lesson);
    const page = await lessonsPageRow(db, ctx.companyId, ctx.projectId);
    // The page change and its version are one transaction, so neither lands without the other (BOS-496).
    await db.transaction(async (tx) => {
      if (!page) {
        const body = `${STUB_FIRST_LINE}\n\n## ${LESSONS_HEADING}\n\n${lessonLine(lesson)}\n`;
        const [p] = await tx
          .insert(wikiPages)
          .values({ companyId: ctx.companyId, slug: briefSlug(ctx.projectId), folder: briefFolder(ctx.projectName), title: briefTitle(ctx.projectName), body })
          .returning();
        await tx.insert(wikiRevisions).values({ pageId: p!.id, title: p!.title, body });
        return;
      }
      const body = bodyOf(page.body);
      if (body !== page.body) {
        // A lesson the owner approved brings a deleted brief back (BOS-2197), rather than editing a page nobody can see.
        await tx.update(wikiPages).set({ body, updatedAt: new Date(), deletedAt: null, deletedByAgentId: null }).where(eq(wikiPages.id, page.id));
        await tx.insert(wikiRevisions).values({ pageId: page.id, title: page.title, body });
      }
    });
  });
}

/** Stable across renames: the page is found by project id, never by name. */
export const briefSlug = (projectId: string) => `brief-${projectId}`;
export const briefFolder = (name: string) => `Projects/${name}`;
export const briefTitle = (name: string) => `${name} — project brief`;

export const briefCommitLine = (sha: string, branch: string) => `Describes commit ${sha} on ${branch}.`;

/** Reads the page's first line back: "Describes commit abc123 on release/1.2." */
export function parseCommitLine(body: string) {
  const m = /^Describes commit ([0-9a-f]{7,40}) on ([\w./-]{1,100})\.\s*$/i.exec(body.split("\n", 1)[0] ?? "");
  return m ? { commit: m[1]!, branch: m[2]! } : null;
}

/** The project's brief page with what its first line says, or null when nobody has written it. */
export async function findBrief(db: Db, companyId: string, projectId: string) {
  const slug = briefSlug(projectId);
  const [p] = await db.select({ body: wikiPages.body, updatedAt: wikiPages.updatedAt }).from(wikiPages).where(and(eq(wikiPages.companyId, companyId), liveWikiPage, eq(wikiPages.slug, slug)));
  if (!p) return null;
  // The headings go into wake prompts and an agent wrote them, so they're capped.
  const headings = splitSections(p.body).filter((s) => s.level === 2).slice(0, 12).map((s) => s.heading.slice(0, 60));
  return { slug, headings, updatedAt: p.updatedAt, ...(parseCommitLine(p.body) ?? { commit: null, branch: null }) };
}

// shortcut: a brief ticket is one in this project whose title is one of these; an owner who
// renames it loses the dedupe, and a second click makes a second ticket. Upgrade to a column if that bites.
export const BRIEF_TITLES = ["Write the project brief", "Refresh the project brief"];

/** The project's brief ticket that is not done yet (a cancelled one is done), if any. */
export async function openBriefTicket(db: Db, projectId: string) {
  const [t] = await db.select().from(tickets).where(and(eq(tickets.projectId, projectId), inArray(tickets.title, BRIEF_TITLES), ne(tickets.systemState, "done"))).limit(1);
  return t ?? null;
}

/** The company's wiki maintainer, if it has one. */
export async function findWikiKeeper(db: Db, companyId: string) {
  const [keeper] = await db.select({ id: agents.id }).from(agents).where(and(eq(agents.companyId, companyId), eq(agents.duty, "wiki"), isNull(agents.retiredAt)));
  return keeper ?? null;
}

export function briefTicketBody(p: { id: string; name: string; defaultBranch: string }, exists: boolean, extra?: string) {
  return [
    `${exists ? "Refresh" : "Write"} the project brief for "${p.name}": a short map of the codebase that other agents read instead of exploring the whole repository.`,
    "",
    "Read the repository first: the README and docs, the top-level layout, the entry points, and the build and test configuration. Then write one wiki page with the wiki tool (action write):",
    `- slug: ${briefSlug(p.id)}`,
    `- folder: ${briefFolder(p.name)}${exists ? " (only when the page doesn't exist yet; leave it out when updating)" : ""}`,
    `- title: ${briefTitle(p.name)}`,
    `- ticketId: this ticket's id`,
    "",
    `The first line of the body must be exactly: ${briefCommitLine("<sha>", p.defaultBranch)} Use the output of \`git rev-parse HEAD\` in your workspace for <sha> and the branch you read.`,
    `Then these sections, in this order, each as a level-2 heading: ${BRIEF_HEADINGS.map((h) => `## ${h}`).join(", ")}.`,
    "",
    "Keep each section short and factual, because agents read one section at a time. Say what you could not find out rather than guessing.",
    "If the page has a \"Lessons\" section, leave it exactly as it is: it holds owner-approved lessons from reviews, and the write is refused when it changes.",
    "",
    "This is a documentation task: the wiki page is its only output. Don't change, commit or push anything in the repository, tests included; read-only commands are fine. If something looks broken, such as failing tests, note it under Gotchas and tell the owner with notify_owner instead of fixing it here.",
    ...(extra ? ["", extra] : []),
  ].join("\n");
}

const REFRESH_EVERY_MS = 24 * 3_600_000;

/**
 * One pass of the brief upkeep loop: for each project whose brief names a commit, asks the git host
 * where the default branch is now, and opens a refresh ticket when it moved (merges made outside
 * Boss Man included). Goes to the wiki maintainer, else the CEO. At most one a day per project.
 */
export async function refreshBriefs(
  db: Db,
  deps: { work: ReturnType<typeof workService>; gitHosts: Pick<ReturnType<typeof gitHostService>, "branchHead">; gitToken: (companyId: string) => Promise<string | undefined>; log: (m: string) => void; now?: () => Date },
) {
  const now = deps.now ?? (() => new Date());
  for (const p of await db.select().from(projects).where(isNull(projects.archivedAt))) {
    try {
      const a = p.repoUrl ? parseRepoUrl(p.repoUrl) : null;
      if (!a || (p.gitHost !== "github" && p.gitHost !== "gitea") || !p.gitApiBase) continue;
      const brief = await findBrief(db, p.companyId, p.id);
      if (!brief?.commit || (await openBriefTicket(db, p.id))) continue;
      const key = `brief-refresh:${p.id}`;
      const [last] = await db.select().from(settings).where(eq(settings.key, key));
      if (last && now().getTime() - new Date(String(last.value)).getTime() < REFRESH_EVERY_MS) continue;
      const token = await deps.gitToken(p.companyId);
      if (!token) throw new Error("the company has no GIT_TOKEN");
      const head = await deps.gitHosts.branchHead({ kind: p.gitHost, apiBase: p.gitApiBase, owner: a.owner, repo: a.repo }, token, p.defaultBranch);
      if (head.toLowerCase().startsWith(brief.commit.toLowerCase())) continue;
      const assignee = (await findWikiKeeper(db, p.companyId)) ?? (await db.select({ id: agents.id }).from(agents).where(and(eq(agents.companyId, p.companyId), eq(agents.role, "ceo"), isNull(agents.retiredAt))))[0];
      if (!assignee) throw new Error("the company has no wiki maintainer or CEO");
      const extra = `${p.defaultBranch} moved from ${brief.commit} to ${head}. Run \`git log --oneline ${brief.commit}..${head}\` and \`git diff --stat ${brief.commit}..${head}\` in your workspace, and update only the sections those changes affect. Then set the first line to the new commit. If nothing relevant changed, only update the first line.`;
      await deps.work.createTicket(p.id, { title: BRIEF_TITLES[1]!, body: briefTicketBody(p, true, extra), assigneeAgentId: assignee.id, noCode: true });
      const value = now().toISOString();
      await db.insert(settings).values({ key, value }).onConflictDoUpdate({ target: settings.key, set: { value } });
    } catch (err) {
      deps.log(`brief upkeep for project ${p.id}: ${(err as Error).message}`);
    }
  }
}

/** The brief's Lessons section as numbered lines, for the CEO to judge a new lesson against (BOS-105). */
export async function lessonsForCeo(db: Db, companyId: string, projectId: string) {
  const page = await lessonsPageRow(db, companyId, projectId);
  const lines = page ? lessonsFrom(page.body) : [];
  return `Current Lessons section (${lines.length} of ${LESSONS_CAP}):\n${lines.length ? lines.map((l, i) => `${i + 1}. ${l}`).join("\n") : "(empty)"}`;
}
