import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { buildApp } from "../src/app.js";
import { signedInOwner } from "./helpers/owner-session.js";
import { openPglite } from "../src/db/client.js";
import { tickets, wikiPages } from "../src/db/schema.js";
import { issueRunToken } from "../src/mcp.js";

// BOS-2759 (BOS-2731 criterion 6): the secret check reads only the text of an incoming call. Text saved before the check
// existed is not scanned, not changed and still readable. Key-shaped values are built at run time so this file holds no
// secret for the merge-line scan to find.
const old = ["sk", "ant", "api03"].join("-") + "-" + "aB3dE5gH7jK9mN1pQ3sT5vX7zC2fG4hJ6kL8";
const OLD_PAGE = `# Old notes\n\nSaved before the check: key ${old} was pasted here.`;
const OLD_TICKET = `Saved before the check: ${old}`;

let ctx: Awaited<ReturnType<typeof setup>> | undefined;
const clients: Client[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
  await ctx?.app.close();
  await ctx?.close();
  ctx = undefined;
});

async function setup() {
  const { db, close } = await openPglite();
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false, limits: { quickBatchMs: 0, wikiBatchMs: 0 }, workspaceRoot: "/ws" });
  await built.app.listen({ host: "127.0.0.1", port: 0 });
  const base = `127.0.0.1:${(built.app.server.address() as { port: number }).port}`;
  const cookie = await signedInOwner(db);
  const req = (method: "GET" | "POST", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const { company } = (await req("POST", "/api/companies", { name: "App Co" })).json() as { company: { id: string } };
  const worker = (await req("POST", `/api/companies/${company.id}/agents`, { name: "Engineer" })).json() as { id: string };
  const project = (await req("POST", `/api/companies/${company.id}/projects`, { name: "Site" })).json() as { id: string };
  const mcp = async () => {
    const token = await issueRunToken(db, { companyId: company.id, agentId: worker.id, runId: "00000000-0000-4000-8000-000000000001" });
    const c = new Client({ name: "t", version: "0" });
    await c.connect(new StreamableHTTPClientTransport(new URL(`http://${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
    clients.push(c);
    return c;
  };
  return { ...built, db, close, req, company, worker, project, mcp };
}

const textOf = (r: unknown) => ((r as { content: Array<{ text: string }> }).content[0]?.text ?? "");

describe("secret check and rows saved before it (BOS-2759)", () => {
  it("a stored wiki page with a key in it is read back whole, and a clean append to it keeps the old text", async () => {
    const c = (ctx = await setup());
    await c.db.insert(wikiPages).values({ companyId: c.company.id, slug: "old-notes", title: "Old notes", body: OLD_PAGE });
    const client = await c.mcp();

    const read = textOf(await client.callTool({ name: "wiki", arguments: { action: "read", slug: "old-notes" } }));
    expect(read).toContain(old);

    const appended = await client.callTool({ name: "wiki", arguments: { action: "append", slug: "old-notes", entry: "A clean line." } });
    expect((appended as { isError?: boolean }).isError).toBeUndefined();
    const [row] = await c.db.select().from(wikiPages).where(eq(wikiPages.slug, "old-notes"));
    // An append puts its entry below the title, so the old text is checked in its two parts, not as one block.
    expect(row!.body).toContain("# Old notes");
    expect(row!.body).toContain(`Saved before the check: key ${old} was pasted here.`);
    expect(row!.body).toContain("A clean line.");

    // Control: the same key in a new write is refused, so the pass above is the check leaving stored text alone.
    const refused = await client.callTool({ name: "wiki", arguments: { action: "append", slug: "old-notes", entry: old } });
    expect((refused as { isError?: boolean }).isError).toBe(true);
    expect(textOf(refused)).not.toContain(old);
    const [after] = await c.db.select().from(wikiPages).where(eq(wikiPages.slug, "old-notes"));
    expect(after!.body).toBe(row!.body);
  });

  it("a stored ticket with a key in its text stays as saved after a clean reply on it", async () => {
    const c = (ctx = await setup());
    const t = (await c.req("POST", `/api/projects/${c.project.id}/tickets`, { title: "Old ticket", assigneeAgentId: c.worker.id })).json() as { id: string };
    await c.db.update(tickets).set({ title: `Old ticket ${old}`, body: OLD_TICKET }).where(eq(tickets.id, t.id));
    const client = await c.mcp();

    const reply = await client.callTool({ name: "ticket_reply", arguments: { ticketId: t.id, text: "A clean reply." } });
    expect((reply as { isError?: boolean }).isError).toBeUndefined();
    const [row] = await c.db.select().from(tickets).where(eq(tickets.id, t.id));
    expect(row!.body).toBe(OLD_TICKET);
    expect(row!.title).toBe(`Old ticket ${old}`);
  });
});
