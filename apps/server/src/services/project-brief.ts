// The project brief (R-brief): one wiki page per project, written by the CEO from the code, so
// agents read the section they need instead of exploring the whole codebase.
import { and, eq, ne, inArray } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { tickets, wikiPages } from "../db/schema.js";
import { splitSections } from "./wiki.js";

export const BRIEF_HEADINGS = ["Objectives", "Architecture", "Code map", "Conventions", "Build and test", "Gotchas", "Glossary"];

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
  const [p] = await db.select({ body: wikiPages.body, updatedAt: wikiPages.updatedAt }).from(wikiPages).where(and(eq(wikiPages.companyId, companyId), eq(wikiPages.slug, slug)));
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

export function briefTicketBody(p: { id: string; name: string; defaultBranch: string }, exists: boolean) {
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
  ].join("\n");
}
