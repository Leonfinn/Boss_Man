// "Download" on the ticket page (BOS-2314): the whole ticket as one Markdown file the owner can keep or share.
// Kept apart from Ticket.tsx and Chat.tsx so the Markdown is testable without rendering the page.
import { isAfterMerge, readVerdicts, systemAuthor, type Criterion } from "@boss-man/shared";
import { api } from "./api";

export type ExportMessage = { id: string; author: "owner" | "agent" | "system"; agent: string | null; text: string; delivery: string | null; createdAt: string };
type Page = { items: ExportMessage[]; hasMore?: boolean };

export type ExportTicket = {
  ref?: string | null;
  title: string;
  systemState: string;
  outcome: string | null;
  assignee: string | null;
  risk: string | null;
  size?: number | null;
  body: string | null;
  acceptanceCriteria: Criterion[];
  stateNote: string | null;
};

const STATE: Record<string, string> = { backlog: "Backlog", ready: "Ready", in_progress: "In progress", blocked: "Blocked", review: "In review", done: "Done" };
const VERDICT: Record<string, string> = { pass: "pass", fail: "fail", none: "not reported" };

/** "BOS-12-fix-the-login-page.md": the ref, then the title cut to a few words, safe on every file system. */
export function ticketFileName(ref: string | null | undefined, title: string): string {
  const short = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50)
    .replace(/-+$/, "");
  return `${[ref, short].filter(Boolean).join("-") || "ticket"}.md`;
}

/** "2026-11-23 07:46 UTC": a fixed zone, so the file reads the same wherever it is opened. */
const utc = (iso: string) => `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;

function who(m: ExportMessage): string {
  if (m.author === "owner") return m.agent ? `Owner to ${m.agent}` : "Owner";
  if (m.author === "agent") return m.agent ?? "An agent";
  return systemAuthor(m.delivery);
}

/** The ticket as Markdown: heading, facts, description, criteria with verdicts, state note, then the conversation oldest first. */
export function ticketMarkdown(t: ExportTicket, messages: ExportMessage[], feature: string | null): string {
  const state = t.systemState === "done" && t.outcome === "cancelled" ? "Cancelled" : (STATE[t.systemState] ?? t.systemState);
  const out: string[] = [`# ${t.ref ? `${t.ref}: ` : ""}${t.title}`, ""];
  out.push(`- State: ${state}`, `- Assignee: ${t.assignee ?? "nobody"}`, `- Risk: ${t.risk ?? "not rated"}`, `- Size: ${t.size ?? "not sized"}`, `- Feature: ${feature ?? "none"}`, "");
  out.push("## Description", "", t.body?.trim() || "_No description._", "");
  out.push("## Acceptance criteria", "");
  const criteria = t.acceptanceCriteria ?? [];
  if (!criteria.length) out.push("_None._");
  readVerdicts(criteria, t.stateNote).forEach((r, i) => {
    out.push(`${i + 1}. **${VERDICT[r.verdict ?? "none"]}**: ${r.criterion}${isAfterMerge(criteria[i]!) ? " _(checked after merge)_" : ""}`);
  });
  out.push("", "## State note", "", t.stateNote?.trim() || "_None._", "");
  out.push("## Conversation", "");
  out.push(messages.length ? messages.map((m) => `**${who(m)}** · ${utc(m.createdAt)}\n\n${m.text.trim()}`).join("\n\n---\n\n") : "_No messages._");
  return `${out.join("\n")}\n`;
}

/**
 * Every message on the ticket, oldest first: the newest page, then older pages by `?before=` while the server
 * says there are more (BOS-2168), as "Load older messages" does. Duplicates across pages are dropped by id.
 */
export async function fetchAllMessages(ticketId: string): Promise<ExportMessage[]> {
  const seen = new Map<string, ExportMessage>();
  let page = await api<Page>(`/api/tickets/${ticketId}/messages`);
  for (;;) {
    const before = seen.size;
    for (const m of page.items) seen.set(m.id, m);
    // A page that adds nothing new would ask for itself again: stop rather than loop.
    if (!page.hasMore || seen.size === before) break;
    const oldest = page.items.reduce((a, b) => (byTime(a, b) <= 0 ? a : b));
    page = await api<Page>(`/api/tickets/${ticketId}/messages?before=${encodeURIComponent(oldest.id)}`);
  }
  return [...seen.values()].sort(byTime);
}

/** The server's order: by time, then by id for messages sharing a time. */
const byTime = (a: ExportMessage, b: ExportMessage) => a.createdAt.localeCompare(b.createdAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
