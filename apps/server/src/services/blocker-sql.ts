// A leaf module (imports only drizzle) so modules that build SQL at load time, like agent-wip.ts, can use the
// blocker-finished twin without pulling in ticket-links.ts and its import cycle.
import { sql } from "drizzle-orm";

/**
 * The SQL twin of `!ticketBlockerFinished` (DR-061 Q1) for set queries that can't call the function: true while the
 * blocker ticket (alias `b`) still holds the link (alias `d`). The aliases are fixed names written by the caller,
 * never user input. A parity test runs it over the same rows as the TS function.
 */
export const ticketBlockerOpenSql = (d: string, b: string) => sql`(${sql.raw(b)}.system_state <> 'done' and not (${sql.raw(d)}.until = 'merged' and ${sql.raw(b)}.merge_commit is not null))`;
