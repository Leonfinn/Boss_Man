// github_reply (BOS-1933): Support (or the CEO) answers the person behind a GitHub issue, discussion or comment from
// its feedback-inbox note, and closes the issue or discussion once the outcome is known. The server makes the GitHub
// call with the company's stored token; the token never enters a run. The tool names a note, never a repo or a
// number: the item is found through the note's externalId, which only the watcher writes. The rules (who may, what
// text may go on a public page, the owner's one card when the token can't write) live in the service.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { REPLY_CAP, REPLY_CLOSE_REASONS, type githubWatchService } from "./services/github-watch.js";
import { fail, text, type Scope } from "./mcp-common.js";

export function registerGithubReply(server: Pick<McpServer, "registerTool">, watch: ReturnType<typeof githubWatchService> | undefined, scope: Scope) {
  if (!watch) return;
  server.registerTool(
    "github_reply",
    {
      description:
        "Answer a GitHub issue, discussion or comment that the GitHub watcher filed in the feedback inbox, and close it there once its outcome is known. Only the Support agent and the CEO can use it. The server calls GitHub; you never see a token. " +
        "noteId: the inbox note (feedback inbox shows it). text: your reply, posted publicly under the company's GitHub account, so plain words, no internal names, addresses, host paths or keys (a reply with an IP address, internal host name, machine path or key-shaped value is refused). A reply to a comment goes on its issue, or under that comment in a discussion. " +
        "close (optional): completed (done, fixed or answered; a discussion closes as resolved) or not_planned (won't do, out of date or a duplicate; a discussion closes as outdated). With close the note is marked processed; without it the note stays as it is, so close it once the outcome is known. Each reply is logged.",
      inputSchema: {
        noteId: z.string().uuid(),
        text: z.string().min(1).max(REPLY_CAP + 200),
        close: z.enum(REPLY_CLOSE_REASONS).optional(),
      },
    },
    async ({ noteId, text: body, close }) => {
      const r = await watch.issueReply(scope.companyId, scope.agentId, noteId, { text: body, close });
      return r.ok ? text(r.text) : fail(r.text);
    },
  );
}
