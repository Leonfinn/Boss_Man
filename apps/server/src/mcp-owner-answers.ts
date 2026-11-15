// `owner_answers` (BOS-1593): "has the owner already decided X?" for every agent and the CEO, read-only.
// Searches what the owner answered on cards, wrote on tickets and in chat, and the lasting notes kept from
// their corrections (services/owner-answers.ts), so an agent looks it up instead of asking the owner again.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Db } from "./db/client.js";
import { describeOwnerAnswer, isRepeat, OWNER_ANSWER_KINDS, ownerAnswerSearch } from "./services/owner-answers.js";
import type { Embedder } from "./services/wiki-semantic.js";
import { text, type Scope } from "./mcp-common.js";

export const OWNER_ANSWERS_DESCRIPTION =
  "Read-only: has the owner already answered this? Before you ask the owner anything (raise_decision, notify_owner, a question in a reply), search here with the question in your own words. It searches everything the owner has said in your company: answers and notes on cards, messages on tickets, the owner chat, and the lasting notes kept from their corrections, with the ticket and date of each. A hit marked 'already answered' means the owner settled it: act on that answer, and only ask again (raise_decision stillNeeded) if you can say what has changed since. Pass since (ISO date) to look only at recent answers, kinds to narrow the sources. Words are matched by their stems, so try the key nouns if a long question finds nothing.";

export function registerOwnerAnswers(server: Pick<McpServer, "registerTool">, db: Db, scope: Scope, embedder?: (companyId: string) => Promise<Embedder | null>) {
  server.registerTool(
    "owner_answers",
    {
      description: OWNER_ANSWERS_DESCRIPTION,
      inputSchema: {
        q: z.string().min(2).max(500),
        since: z.string().datetime({ offset: true }).optional(),
        kinds: z.array(z.enum(OWNER_ANSWER_KINDS as [string, ...string[]])).max(4).optional(),
        limit: z.number().int().min(1).max(20).optional(),
      },
    },
    async ({ q, since, kinds, limit }) => {
      const { hits, meaning } = await ownerAnswerSearch(
        db,
        { companyId: scope.companyId, q, since: since ? new Date(since) : undefined, kinds: kinds as typeof OWNER_ANSWER_KINDS | undefined, limit: limit ?? 8, minScore: 0.34 },
        { embedder },
      );
      const how = meaning === "used" ? "Searched by words and by meaning." : meaning === "off" ? "Searched by words (meaning search is off for this company)." : `Searched by words only: meaning search is on but unavailable (${meaning.unavailable}).`;
      if (!hits.length) return text(`Nothing the owner has said matches "${q}". ${how} If you still need to ask, try once more with the key nouns only first.`);
      const settled = hits.filter(isRepeat);
      const lines = [
        how,
        settled.length ? `The owner has already answered this (${settled.length} match${settled.length === 1 ? "" : "es"}):` : "No exact match, but the owner said these related things:",
        ...settled.map(describeOwnerAnswer),
        ...(settled.length && settled.length < hits.length ? ["", "Related:"] : []),
        ...hits.filter((h) => !isRepeat(h)).map(describeOwnerAnswer),
      ];
      return text(lines.join("\n"));
    },
  );
}
