// The PA's server, moved out of mcp.ts unchanged (BOS-298 step 15). Built in the same place as before,
// so the PA sees the same tools and may still cite only what its read tools showed it (PA_READS).
import { and, eq } from "drizzle-orm";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Db } from "./db/client.js";
import { decisions as decisionsTable } from "./db/schema.js";
import { markSearched, remember } from "./services/pa.js";
import { fail, text, type Scope } from "./mcp-common.js";
import type { Services } from "./mcp.js";
import { guardSecrets } from "./mcp-secret-guard.js";

/** The shared registrars still living in mcp.ts, handed in so this file never imports mcp.ts at run time. */
export type PaTools = {
  registerSharedTools: (server: McpServer, db: Db, services: Pick<Services, "notes" | "wiki" | "skills" | "skillProposals" | "review" | "agents">, scope: Scope) => void;
  registerViewImage: (server: McpServer, images: Services["images"], scope: Scope) => void;
  registerBoard: (server: Pick<McpServer, "registerTool">, db: Db, scope: Scope) => void;
  registerListMyWork: (server: Pick<McpServer, "registerTool">, db: Db, scope: Scope) => void;
};

/** The tools a PA may have (R87): all reads. Anything else is never registered for it. */
const PA_READS = new Set(["tickets", "decisions", "list_my_work", "wiki", "whats_new", "board"]);

/**
 * A view of the server that registers only the PA's read tools. What they return is remembered
 * for the run, since pa_reply may cite only that; a wiki write is refused.
 */
function readOnly(server: McpServer, runId: string): Pick<McpServer, "registerTool"> {
  return {
    registerTool: ((name: string, config: never, cb: (input: { action?: string }, extra: never) => Promise<unknown>) => {
      if (!PA_READS.has(name)) return undefined;
      return server.registerTool(name, config, (async (input: { action?: string }, extra: never) => {
        if (name === "wiki" && input.action !== "list" && input.action !== "read") return fail("You can only read the wiki.");
        const r = await cb(input, extra);
        // Only a search can show "nothing found"; reading one ticket can't.
        if ((name === "tickets" && input.action === "find") || (name === "decisions" && input.action === "list")) markSearched(runId);
        if (name !== "wiki" && input.action !== "file") remember(runId, JSON.stringify(r));
        return r;
      }) as never);
    }) as never,
  };
}

/** The PA's server: the read tools plus pa_reply and pa_escalate, and nothing that writes (R87). */
export function buildPaServer(db: Db, { notes, wiki, skills, skillProposals, review, agents: team, pa, images }: Services, scope: Scope, { registerSharedTools, registerViewImage, registerBoard, registerListMyWork }: PaTools) {
  // pa_reply goes to the owner and is stored, so it gets the same secret check as every other writing tool (BOS-2760).
  const server = guardSecrets(new McpServer({ name: "bossman", version: "0.1.0" }));
  const reads = readOnly(server, scope.runId);
  registerSharedTools(reads as McpServer, db, { notes, wiki, skills, skillProposals, review, agents: team }, scope);
  registerViewImage(server, images, scope);
  registerBoard(reads, db, scope);
  registerListMyWork(reads, db, scope);
  reads.registerTool(
    "decisions",
    { description: "Decisions that are waiting on the owner or the CEO: id, question, options and who raised it.", inputSchema: { action: z.literal("list") } },
    async () => {
      const open = await db.select().from(decisionsTable).where(and(eq(decisionsTable.companyId, scope.companyId), eq(decisionsTable.status, "open"))).orderBy(decisionsTable.createdAt).limit(40);
      return text(open.length ? JSON.stringify(open.map((d) => ({ id: d.id, question: d.question, options: d.options, recommended: d.recommendedOption, waitingOn: d.tier, raisedAt: d.createdAt }))) : "No decisions are waiting.");
    },
  );

  server.registerTool(
    "pa_reply",
    {
      description:
        "Answer the owner's last message. The only way you answer them. text is the answer, in plain words, from what your tools returned. cites lists every ticket or decision it rests on, each with its id (ids your tools returned in this run only). An empty list is allowed for a \"nothing found\" answer, but only after you searched with the tickets or decisions tool. confidence is high only when the tools show the answer plainly. Boss Man checks the reply and may hand the question to the CEO instead; the result says so.",
      inputSchema: {
        text: z.string().min(1).max(4000),
        cites: z.array(z.object({ kind: z.enum(["ticket", "decision", "run"]), id: z.string().uuid() })).max(20),
        confidence: z.enum(["high", "low"]),
      },
    },
    async (input) => {
      const r = await pa.reply(scope.runId, input);
      return r.posted ? text(r.note) : fail(r.note);
    },
  );

  server.registerTool(
    "pa_escalate",
    { description: "Pass the owner's last message to the CEO when you can't answer it from your tools or it needs judgement. summary is what you found, for the CEO. The owner is told it's with the CEO.", inputSchema: { summary: z.string().min(1).max(2000) } },
    async ({ summary }) => ((await pa.escalate(scope.runId, summary)).ok ? text("Passed to the CEO; the owner was told. Don't answer it yourself.") : fail("There's no unanswered owner message to pass on.")),
  );

  return server;
}
