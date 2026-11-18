// R38 (BOS-1683): a go-live card is refused until its ticket's preview checks are reported with page proof, and
// must state its undo with a source. Through the real MCP tool. On the old code a "publish" card for a ticket with an
// unreported preview criterion was raised, and a rollback field didn't exist.
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { eq } from "drizzle-orm";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { decisions, tickets } from "../src/db/schema.js";
import { issueRunToken } from "../src/mcp.js";
import { goLiveProofRefusal, rollbackRefusal } from "../src/services/go-live-card.js";

let s: Awaited<ReturnType<typeof boot>>;

async function boot() {
  const { db, close } = await openPglite();
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false, limits: { quickBatchMs: 0 }, workspaceRoot: "/ws" });
  await built.app.listen({ host: "127.0.0.1", port: 0 });
  const base = `127.0.0.1:${(built.app.server.address() as { port: number }).port}`;
  const setup = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
  const cookie = `bm_session=${setup.cookies.find((c) => c.name === "bm_session")!.value}`;
  const req = (method: "POST", url: string, payload: unknown) => built.app.inject({ method, url, headers: { cookie }, payload: payload as object });
  const co = (await req("POST", "/api/companies", { name: "Site Co" })).json() as { company: { id: string } };
  const dev = (await req("POST", `/api/companies/${co.company.id}/agents`, { name: "Dev" })).json() as { id: string };
  const project = (await req("POST", `/api/companies/${co.company.id}/projects`, { name: "Website" })).json() as { id: string };
  const token = await issueRunToken(db, { companyId: co.company.id, agentId: dev.id, runId: randomUUID() });
  const client = new Client({ name: "test", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
  const ticket = async (stateNote: string | null) =>
    (await db.insert(tickets).values({ companyId: co.company.id, projectId: project.id, title: "Roadmap link", systemState: "in_progress", acceptanceCriteria: ["The preview shows a Roadmap link in the header", "Links in the footer all open"], stateNote }).returning())[0]!;
  return { built, db, close, client, ticket };
}

beforeAll(async () => {
  s = await boot();
});
afterAll(async () => {
  await s.client.close();
  await s.built.app.close();
  await s.close();
});

const textOf = (r: unknown) => ((r as { content: Array<{ text: string }> }).content[0]?.text ?? "");
const ask = (args: Record<string, unknown>) =>
  s.client.callTool({ name: "raise_decision", arguments: { options: ["Publish it", "Not yet"], recommended: "Publish it", triedFirst: "Checked the preview myself; only the owner can press publish", ...args } });
const ROLLBACK = "tested: 17 Nov, redeployed the previous build from the host's dashboard and loaded the page";

describe("go-live card (R38)", () => {
  it("is refused while a before-merge check on the ticket is unreported", async () => {
    const t = await s.ticket(null);
    const out = textOf(await ask({ question: "Publish the new site?", goLive: true, rollback: ROLLBACK, blocksTicketId: t.id }));
    expect(out).toContain("go-live card is refused");
    expect(out).toContain("The preview shows a Roadmap link");
  });

  it("is raised once the checks are reported, with the undo on the card", async () => {
    const t = await s.ticket("1 pass; 2 pass");
    const out = textOf(await ask({ question: "Publish the new site now?", goLive: true, rollback: ROLLBACK, blocksTicketId: t.id }));
    const id = /Decision ([0-9a-f-]{36})/.exec(out)?.[1];
    expect(id, out).toBeTruthy();
    const [d] = await s.db.select({ question: decisions.question }).from(decisions).where(eq(decisions.id, id!));
    expect(d!.question).toContain("How to undo it (tested:");
  });

  it("is refused with no rollback, and an untested undo shows 'not tried yet'", async () => {
    const t = await s.ticket("1 pass; 2 pass");
    expect(textOf(await ask({ question: "Publish the site, undo unknown?", goLive: true, blocksTicketId: t.id }))).toContain("must carry rollback");
    const out = textOf(await ask({ question: "Publish the site with a docs undo?", goLive: true, rollback: "not tested: https://example.com/docs/rollback, press Rollback on the old build", blocksTicketId: t.id }));
    const id = /Decision ([0-9a-f-]{36})/.exec(out)?.[1];
    expect(id, out).toBeTruthy();
    const [d] = await s.db.select({ question: decisions.question }).from(decisions).where(eq(decisions.id, id!));
    expect(d!.question).toContain("not tried yet");
  });

  it("warns when a card says publish but isn't marked goLive", async () => {
    const out = textOf(await ask({ question: "Shall I publish the new pricing page?" }));
    expect(out).toContain("isn't marked goLive");
  });
});

describe("rollbackRefusal", () => {
  it("refuses speed claims unless tested, and untagged or source-less undos", () => {
    expect(rollbackRefusal("not tested: https://example.com/docs rolls back in seconds")).toContain("in seconds");
    expect(rollbackRefusal("tested: 17 Nov, rolled back in seconds on a copy")).toBeNull();
    expect(rollbackRefusal("press rollback")).toContain("must start with");
    expect(rollbackRefusal("not tested: ask the vendor to restore")).toContain("docs URL");
    expect(rollbackRefusal(undefined)).toContain("must carry rollback");
  });
});

describe("goLiveProofRefusal page clauses", () => {
  const criteria = ['Preview is up (page: https://preview.example.com/ shows "Roadmap")'];
  it("needs a cited screenshot and the quoted words on a pass", () => {
    expect(goLiveProofRefusal(criteria, "1 pass", [])).toContain("no screenshot");
    expect(goLiveProofRefusal(criteria, "1 pass: saw \"Roadmap\" in image abcdef12", ["abcdef12-0000-0000-0000-000000000000"])).toBeNull();
  });
});
