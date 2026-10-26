import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { ticketImages } from "../src/db/schema.js";
import { issueRunToken } from "../src/mcp.js";

// A 1x1 PNG.
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
let done: () => Promise<void> = async () => {};
afterEach(() => done());

async function setup() {
  const { db, close } = await openPglite();
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false, limits: { quickBatchMs: 0 }, workspaceRoot: "/ws" });
  await built.app.listen({ host: "127.0.0.1", port: 0 });
  const base = `127.0.0.1:${(built.app.server.address() as { port: number }).port}`;
  done = async () => (await built.app.close(), await close());
  const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
  const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
  const req = (method: "GET" | "POST", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const { company, ceo } = (await req("POST", "/api/companies", { name: "App Co" })).json();
  const other = (await req("POST", "/api/companies", { name: "Other Co" })).json().company;
  const project = (await req("POST", `/api/companies/${company.id}/projects`, { name: "App" })).json();
  const mcp = async () => {
    const c = new Client({ name: "test", version: "0" });
    await c.connect(new StreamableHTTPClientTransport(new URL(`http://${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${await issueRunToken(db, { companyId: company.id, agentId: ceo.id, runId: randomUUID() })}` } } }));
    return c;
  };
  return { db, req, company, other, project, mcp };
}

describe("images the owner pastes", () => {
  it("are stored, put in the text as Markdown, and shown to an agent with open_attachment", async () => {
    const c = await setup();
    const r = await c.req("POST", `/api/companies/${c.company.id}/images`, { data: PNG, name: "error (1).png" });
    expect(r.statusCode).toBe(201);
    const { id, markdown } = r.json();
    // Brackets in the name would break the Markdown, so they're dropped.
    expect(markdown).toBe(`![error 1.png](/api/ticket-images/${id})`);
    expect((await c.req("GET", `/api/ticket-images/${id}`)).headers["content-type"]).toBe("image/png");

    const t = (await c.req("POST", `/api/projects/${c.project.id}/tickets`, { title: "Fix the error", body: `It shows this:\n${markdown}` })).json();
    const onTicket = (await c.req("POST", `/api/companies/${c.company.id}/images`, { data: PNG, ticketId: t.id })).json();
    expect((await c.req("GET", `/api/tickets/${t.id}/images`)).json().map((i: { id: string }) => i.id)).toEqual([onTicket.id]);

    const client = await c.mcp();
    const seen = await client.callTool({ name: "open_attachment", arguments: { id } });
    expect((seen as { content: unknown[] }).content[0]).toEqual({ type: "image", data: PNG, mimeType: "image/png" });
    await client.close();
  });

  it("takes other files too: a link that downloads, text and PDFs an agent can open", async () => {
    const c = await setup();
    const up = (data: Buffer, name: string) => c.req("POST", `/api/companies/${c.company.id}/images`, { data: data.toString("base64"), name }).then((r) => r.json());
    const notes = await up(Buffer.from("Line one\nLine two"), "notes.txt");
    expect(notes.markdown).toBe(`[📎 notes.txt](/api/ticket-images/${notes.id})`);
    // Never shown in the page: always a download, so an uploaded HTML file can't run here.
    const page = await up(Buffer.from("<script>alert(1)</script>"), "evil.html");
    const got = await c.req("GET", `/api/ticket-images/${page.id}`);
    expect(got.headers["content-type"]).toBe("application/octet-stream");
    expect(got.headers["content-disposition"]).toBe('attachment; filename="evil.html"');
    const pdf = await up(Buffer.from("%PDF-1.4 fake"), "spec.pdf");
    const blob = await up(Buffer.from([0, 1, 2, 3]), "data.bin");
    const client = await c.mcp();
    const open = async (id: string) => (await client.callTool({ name: "open_attachment", arguments: { id } })) as { content: Array<Record<string, unknown>> };
    expect((await open(notes.id)).content[0]).toEqual({ type: "text", text: "notes.txt\n\nLine one\nLine two" });
    expect((await open(pdf.id)).content[0]).toMatchObject({ type: "resource", resource: { mimeType: "application/pdf", blob: Buffer.from("%PDF-1.4 fake").toString("base64") } });
    expect(String((await open(blob.id)).content[0]!.text)).toMatch(/can't be shown as text or a picture/);
    await client.close();
  });

  it("refuses an empty file, and another company's attachment", async () => {
    const c = await setup();
    expect((await c.req("POST", `/api/companies/${c.company.id}/images`, { data: "" })).statusCode).toBe(400);
    const theirs = (await c.req("POST", `/api/companies/${c.other.id}/images`, { data: PNG })).json();
    const client = await c.mcp();
    expect((await client.callTool({ name: "open_attachment", arguments: { id: theirs.id } })).isError).toBe(true);
    await client.close();
    expect((await c.db.select().from(ticketImages).where(eq(ticketImages.id, theirs.id)))[0]).toMatchObject({ ticketId: null, companyId: c.other.id });
  });
});
