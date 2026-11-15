// `permission_report` (BOS-1456): the CEO's read-only view of owner-tier permission cards across every company the
// owner owns, grouped by the rule that sent them. Each company has one owner, so "every company" is every company on
// this server. Only what the card already shows the owner leaves the server (services/permission-report.ts).
import { eq } from "drizzle-orm";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Db } from "./db/client.js";
import { agents } from "./db/schema.js";
import { PERMISSION_REPORT_DEFAULT_HOURS, PERMISSION_REPORT_MAX_HOURS, formatPermissionReport, permissionReport } from "./services/permission-report.js";
import { fail, text, type Scope } from "./mcp-common.js";

export function registerPermissionReport(server: Pick<McpServer, "registerTool">, db: Db, scope: Scope) {
  server.registerTool(
    "permission_report",
    {
      description: `CEO only, read-only: permission cards that reached the owner in the last N hours (default ${PERMISSION_REPORT_DEFAULT_HOURS}, 1 to ${PERMISSION_REPORT_MAX_HOURS}), in every company the owner owns, grouped by the rule that sent them (and whether the CEO had them first). Per group: count, cards per hour, the card's ownerWhy line, and one example (time, company, agent, ticket, card id, wait in minutes, answer). It never shows command text beyond the card's own title and summary. Use it for a permission ticket's after-merge check instead of asking another company's CEO.`,
      inputSchema: { hours: z.number().int().min(1).max(PERMISSION_REPORT_MAX_HOURS).optional(), format: z.enum(["text", "json"]).optional() },
    },
    async ({ hours, format }) => {
      const [me] = scope.agentId ? await db.select({ role: agents.role }).from(agents).where(eq(agents.id, scope.agentId)) : [];
      if (me?.role !== "ceo") return fail("Only the CEO reads the permission report.");
      const r = await permissionReport(db, { hours });
      return text(format === "json" ? JSON.stringify(r) : formatPermissionReport(r));
    },
  );
}
