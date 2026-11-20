// Every outside source Boss Man watches, and who closes each item where it came from (BOS-1933, R53; spec: the wiki
// page "Cock-ups answer 19 Nov: every inbound source names who closes it"). GitHub secret-scanning alerts sat open
// because the watcher could only read: Boss Man learned of each alert, but only the owner could close it on GitHub.
// The usability gate asked what the owner repeats to keep the *watcher* working, and nothing asked about each
// *item's* life after it arrives. This list is that question, answered once per source in code.
//
// The rule: every row names an agent role that acts on the item and one that closes it at the source, and the
// closer is never the owner. One-time owner setup (a token permission) is allowed and goes in `ownerSetup`; a step
// per item is not. test/inbound-sources.test.ts reads the watchers' code and fails when a source they file has no
// row here, when a row has no closer or names the owner, or when its closing tool isn't a registered MCP tool. So a
// new outside source can't ship until it says who closes it.
import type { NoteSource } from "@boss-man/shared";

/** Who acts or closes: an agent role, or Boss Man itself (code that closes the item when its cause is gone). Never the owner. */
export type InboundRole = "support" | "security-reviewer" | "ceo" | "developer" | "boss-man";

export type InboundSource = {
  id: string;
  /** What it is, in plain words. */
  what: string;
  /** The server file that watches it and files the item. */
  watcher: string;
  /** How an item reaches the team. */
  arrivesAs: "ticket" | "inbox-note";
  /** How the test finds this source in the watcher's code: the externalId kind (github:<repo>:<kind>:<id>), the alert key kind, or the note source. */
  match: { externalIdKind: string } | { alertKind: string } | { noteSource: NoteSource } | { file: string };
  /** Who reads it and acts on it. */
  actor: InboundRole;
  /** Who closes it where it came from. */
  closer: InboundRole;
  /** How it closes at the source. */
  closesAt: string;
  /** The Boss Man tool the closer uses, or null when Boss Man's own code closes it (then `closedBy` names the file). */
  closeTool: string | null;
  closedBy?: string;
  /** One-time owner setup, if any (a token permission). Never a step per item. */
  ownerSetup?: string;
};

const GITHUB_WRITE = 'GITHUB_WATCH_TOKEN with "Issues" and "Discussions" set to "Read and write" (one time; a refused reply raises one card that says so)';
const GITHUB_ITEM = "Support answers the person on GitHub with github_reply, and closes the issue or discussion with it (close completed or not_planned) once the outcome is known; that also marks the note processed.";

export const INBOUND_SOURCES: readonly InboundSource[] = [
  {
    id: "main-ci",
    what: "GitHub CI failing on a project's main branch",
    watcher: "services/main-ci.ts",
    arrivesAs: "ticket",
    match: { file: "services/main-ci.ts" },
    actor: "ceo",
    closer: "developer",
    closesAt: "The developer's fix merges and main's next CI run is green; the watcher says so on the ticket. A CI run has nothing to close on GitHub.",
    closeTool: null,
    closedBy: "services/main-ci.ts",
  },
  {
    id: "github-secret-alert",
    what: "A GitHub secret-scanning alert",
    watcher: "services/github-watch.ts",
    arrivesAs: "ticket",
    match: { alertKind: "secret" },
    actor: "security-reviewer",
    closer: "security-reviewer",
    closesAt: "The security reviewer rotates the secret, then closes the alert with security_alert close (the server makes the call); the ticket closes with it.",
    closeTool: "security_alert",
    ownerSetup: 'GITHUB_WATCH_TOKEN with "Secret scanning alerts" set to "Read and write" (one time, BOS-1931)',
  },
  {
    id: "github-dependabot-alert",
    what: "A GitHub Dependabot alert",
    watcher: "services/github-watch.ts",
    arrivesAs: "ticket",
    match: { alertKind: "dependabot" },
    actor: "developer",
    closer: "boss-man",
    closesAt: "A merged bump to the fixed version closes it on GitHub, and the watcher then closes the ticket. A false positive is dismissed with security_alert close by the security reviewer or the CEO.",
    closeTool: "security_alert",
    closedBy: "services/github-watch.ts",
    ownerSetup: 'GITHUB_WATCH_TOKEN with "Dependabot alerts" set to "Read and write" (one time, BOS-1931)',
  },
  { id: "github-issue", what: "A GitHub issue", watcher: "services/github-watch.ts", arrivesAs: "inbox-note", match: { externalIdKind: "issue" }, actor: "support", closer: "support", closesAt: GITHUB_ITEM, closeTool: "github_reply", ownerSetup: GITHUB_WRITE },
  { id: "github-issue-comment", what: "A comment on a GitHub issue", watcher: "services/github-watch.ts", arrivesAs: "inbox-note", match: { externalIdKind: "issue-comment" }, actor: "support", closer: "support", closesAt: `${GITHUB_ITEM} A reply goes on the comment's issue.`, closeTool: "github_reply", ownerSetup: GITHUB_WRITE },
  { id: "github-discussion", what: "A GitHub discussion", watcher: "services/github-watch.ts", arrivesAs: "inbox-note", match: { externalIdKind: "discussion" }, actor: "support", closer: "support", closesAt: `${GITHUB_ITEM} A discussion closes as resolved or outdated.`, closeTool: "github_reply", ownerSetup: GITHUB_WRITE },
  { id: "github-discussion-comment", what: "A comment on a GitHub discussion", watcher: "services/github-watch.ts", arrivesAs: "inbox-note", match: { externalIdKind: "discussion-comment" }, actor: "support", closer: "support", closesAt: `${GITHUB_ITEM} A reply goes under the comment.`, closeTool: "github_reply", ownerSetup: GITHUB_WRITE },
  {
    id: "feedback-portal",
    what: "An idea, comment or vote on the company's feedback portal",
    watcher: "services/feedback.ts",
    arrivesAs: "inbox-note",
    match: { noteSource: "portal" },
    actor: "ceo",
    closer: "ceo",
    closesAt: "The portal is Boss Man's own, so closing it in Boss Man is closing it at the source: the CEO or a product manager links the note to a feature or marks it (feedback link or mark), and the visitor sees the feature's status on the portal. A bare vote arrives processed.",
    closeTool: "feedback",
  },
];

/**
 * Every note source, classed: from inside the company (nobody outside waits for an answer), or from outside with
 * the rows that close it. The test fails when NOTE_SOURCES gains a value that isn't classed here.
 */
export const NOTE_SOURCE_CLASS: Record<NoteSource, { from: "inside"; why: string } | { from: "outside"; rows: string[] }> = {
  owner: { from: "inside", why: "the owner logged it themselves" },
  chat: { from: "inside", why: "the owner said it in chat" },
  agent: { from: "inside", why: "an agent logged what it heard; the agent who heard it answers through its own channel" },
  portal: { from: "outside", rows: ["feedback-portal"] },
  // No watcher writes "email" today: only the owner picks it when logging a note by hand. A watcher that starts
  // writing it must give its row above and move this to "outside".
  email: { from: "inside", why: "only the owner logs it, by hand; no watcher reads email" },
  // The GitHub watcher's notes carry this source; they are matched by their externalId kind (the github-* rows).
  // The owner can also log an "import" note by hand, which nobody outside waits on.
  import: { from: "outside", rows: ["github-issue", "github-issue-comment", "github-discussion", "github-discussion-comment"] },
};
