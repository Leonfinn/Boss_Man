import { and, asc, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { projects, ticketArtifacts, ticketImages, tickets, wikiPages } from "../db/schema.js";

/**
 * BOS-2820 (F25): wording for a ticket in a project with no code repo (a knowledge-work company).
 * There the result is a wiki page written with the ticket's id, or files and links on the ticket, and
 * that is what the reviewer reads. Agents used to be told only what not to do, and reviewers to "read
 * the changes" with a diff that answered there was nothing to read. Projects with a repo keep their wording.
 */

/** Said to an agent working a ticket whose project has no repo: what a result is and where it goes. */
export const NO_REPO_RESULT_LINE =
  "This ticket's project has no code repo, so your result is not code. Deliver it as a wiki page written with this ticket's id (wiki write with ticketId), or as files on the ticket: attach_image for a picture or screenshot, wiki attach with url for a web link. That is what the reviewer reads and the owner approves, so name the page or files in your summary when you move the ticket to review.";

/** The no-checkout line (scheduler.ts noCheckoutNote) for a run on a no-repo ticket: its folder is scratch space, not where the result goes. */
export const noRepoFolderNote = (folder: string) =>
  `\n\nThis run is on a ticket in a project with no code repo: it started in ${folder}, a working folder only. Nothing left there reaches the ticket: put your result in the wiki with the ticket's id, or attach it to the ticket.`;

/** How a reviewer is told to read a ticket: the diff for a repo project, what it produced for one without. */
export const reviewReadLine = (hasRepo: boolean) =>
  hasRepo
    ? "Read the changes with the review tool (action diff), then give your verdict with action submit"
    : "This project has no code repo: read what it produced (wiki pages, files and links on the ticket) with the review tool (action diff lists them), then give your verdict with action submit";

/** Whether the ticket's project has a code repo. A ticket that can't be found counts as having one, so the wording stays the familiar one. */
export async function ticketHasRepo(db: Db, ticketId: string): Promise<boolean> {
  const [row] = await db.select({ repoUrl: projects.repoUrl }).from(tickets).innerJoin(projects, eq(projects.id, tickets.projectId)).where(eq(tickets.id, ticketId));
  return row ? !!row.repoUrl : true;
}

/**
 * The "What it produced" block the review tool's diff action gives for a ticket in a project with no repo:
 * the wiki pages, links and repo files recorded as its output, and the files attached to it, each with
 * the tool that reads it. Says plainly when there is nothing, so the reviewer requests changes rather
 * than approving an empty result.
 */
export async function producedBlock(db: Db, companyId: string, ticketId: string): Promise<string> {
  const made = await db
    .select({ kind: ticketArtifacts.kind, title: ticketArtifacts.title, slug: wikiPages.slug, path: ticketArtifacts.path, ref: ticketArtifacts.ref, url: ticketArtifacts.url })
    .from(ticketArtifacts)
    .leftJoin(wikiPages, eq(wikiPages.id, ticketArtifacts.wikiPageId))
    .where(and(eq(ticketArtifacts.ticketId, ticketId), eq(ticketArtifacts.companyId, companyId)))
    .orderBy(asc(ticketArtifacts.createdAt));
  const files = await db
    .select({ id: ticketImages.id, name: ticketImages.name, caption: ticketImages.caption, type: ticketImages.type })
    .from(ticketImages)
    .where(and(eq(ticketImages.ticketId, ticketId), eq(ticketImages.companyId, companyId)))
    .orderBy(asc(ticketImages.createdAt));
  const lines = [
    ...made.map((m) =>
      m.kind === "wiki_page"
        ? `- wiki page "${m.title}": wiki read slug="${m.slug}"`
        : m.kind === "url"
          ? `- link "${m.title}": ${m.url}`
          : `- repo file ${m.path}${m.ref ? ` at ${m.ref}` : ""}: tickets file`,
    ),
    ...files.map((f) => `- ${f.type.startsWith("image/") ? "picture" : "file"} ${f.name}${f.caption ? ` (${f.caption})` : ""}: open_attachment id="${f.id}"`),
  ];
  return [
    "This ticket's project has no code repo, so there is no diff: review what it produced. Read each item in full before your verdict; the ticket's description says what it should deliver.",
    "",
    "## What it produced",
    ...(lines.length
      ? lines
      : ["(nothing: no wiki page was written with this ticket's id and nothing is attached to it. Check the ticket's conversation with tickets read; if the result is not there either, request changes and ask for it as a wiki page with the ticket's id.)"]),
  ].join("\n");
}
