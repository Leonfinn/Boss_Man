import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { RunnerCommand, RunnerEvent } from "@boss-man/shared";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { runners, tickets } from "../src/db/schema.js";
import { cut, issueRunToken } from "../src/mcp.js";
import { findSection, headingsOf, lessonLine, normalizeLesson, serialiseWrite, splitSections } from "../src/services/wiki.js";

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
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false, limits: { quickBatchMs: 0 }, workspaceRoot: "/ws" });
  await built.app.listen({ host: "127.0.0.1", port: 0 });
  const base = `127.0.0.1:${(built.app.server.address() as { port: number }).port}`;
  const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
  const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
  const req = (method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const { company } = (await req("POST", "/api/companies", { name: "App Co" })).json() as { company: { id: string } };
  const worker = (await req("POST", `/api/companies/${company.id}/agents`, { name: "Engineer" })).json() as { id: string };
  const project = (await req("POST", `/api/companies/${company.id}/projects`, { name: "Site" })).json() as { id: string };
  const reg = (await req("POST", `/api/companies/${company.id}/runner`)).json() as { runnerId: string };
  const [runnerRow] = await db.select().from(runners).where(eq(runners.id, reg.runnerId));
  const sent: RunnerCommand[] = [];
  built.runners.connect(reg.runnerId, (c) => (sent.push(c), true));
  let seq = 0;
  const emit = (event: RunnerEvent) => built.runners.ingest(runnerRow!, { seq: ++seq, at: new Date().toISOString(), event });
  const starts = () => sent.filter((c): c is Extract<RunnerCommand, { type: "run.start" }> => c.type === "run.start");
  const mcp = async (runId: string) => {
    const token = await issueRunToken(db, { companyId: company.id, agentId: worker.id, runId });
    const c = new Client({ name: "t", version: "0" });
    await c.connect(new StreamableHTTPClientTransport(new URL(`http://${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
    clients.push(c);
    return c;
  };
  return { ...built, db, close, req, company, worker, project, sent, emit, starts, mcp };
}

const textOf = (r: unknown) => ((r as { content: Array<{ text: string }> }).content[0]?.text ?? "");


async function startRun(c: Awaited<ReturnType<typeof setup>>) {
  await c.req("POST", `/api/projects/${c.project.id}/tickets`, { title: "Kick", assigneeAgentId: c.worker.id });
  await c.scheduler.tick();
  return c.starts()[0]!.runId;
}

const page = (n: number) =>
  [
    "Intro line about the handbook.",
    "# Deploy",
    "Deploying ships the build.",
    "## Steps",
    "Run the pipeline.",
    "```sh",
    "# not a heading",
    "```",
    "## Rollback",
    "Revert the release.",
    "# Billing",
    "Invoices go out monthly. " + "x".repeat(n),
  ].join("\n");

describe("wiki by section", () => {
  it("splits headings, nests paths and ignores headings inside code fences", () => {
    const s = splitSections(page(0));
    expect(s.map((x) => x.path)).toEqual(["intro", "Deploy", "Deploy > Steps", "Deploy > Rollback", "Billing"]);
    const body = page(0);
    const deploy = findSection(s, "deploy")!;
    expect(body.slice(deploy.start, deploy.end)).toContain("Revert the release.");
    expect(body.slice(deploy.start, deploy.end)).not.toContain("Invoices");
    const steps = findSection(s, "DEPLOY > steps")!;
    expect(body.slice(steps.start, steps.end)).toContain("# not a heading");
    expect(body.slice(steps.start, steps.end)).not.toContain("Revert");
  });

  it("gives an outline for a big page, then sections and offset parts, with links both ways", async () => {
    const c = (ctx = await setup());
    const client = await c.mcp((await startRun(c)));
    const body = page(9000) + "\nSee [[other-page#Intro]] and [[missing]].";
    await client.callTool({ name: "wiki", arguments: { action: "write", slug: "handbook", title: "Handbook", body } });
    await client.callTool({ name: "wiki", arguments: { action: "write", slug: "other-page", title: "Other", body: "Back to [[handbook]]." } });
    const read = async (a: Record<string, unknown>) => textOf(await client.callTool({ name: "wiki", arguments: { action: "read", slug: "handbook", ...a } }));

    const outline = await read({});
    expect(outline).toContain("# Handbook");
    expect(outline).toContain("- Deploy > Steps (");
    expect(outline).toContain("Run the pipeline.");
    expect(outline).toContain("offset=0");
    expect(outline.length).toBeLessThan(1500);

    const sec = await read({ section: "deploy > rollback" });
    expect(sec).toContain("Revert the release.");
    expect(sec).not.toContain("Run the pipeline.");
    const parent = await read({ section: "Deploy" });
    expect(parent).toContain("Run the pipeline.");
    expect(parent).toContain("Revert the release.");
    expect(await read({ section: "Billing" })).toContain("Links: other-page");
    expect(await read({ section: "Billing" })).not.toContain("missing,");
    const nope = await read({ section: "Nope" });
    expect(nope).toMatch(/^No section "Nope"/);
    expect(nope).toContain("- Billing (");

    // Parts: reaching the end by following the offsets reproduces the page.
    let got = "";
    let offset = 0;
    for (let i = 0; i < 5; i++) {
      const part = await read({ offset });
      const m = /\n\n… (\d+) more chars; continue with offset=(\d+)/.exec(part);
      const chunk = part.replace(/\n\n… \d+ more chars.*$/s, "").replace(/\n\nLinks:.*$/s, "").replace(/\n\nLinked from:.*$/s, "").replace(/^# Handbook\n\n/, "");
      got += chunk;
      if (!m) break;
      offset = Number(m[2]);
    }
    expect(got).toBe(body);
    expect(await read({ offset: 0 })).toContain("# Handbook");

    const other = textOf(await client.callTool({ name: "wiki", arguments: { action: "read", slug: "other-page" } }));
    expect(other).toContain("Links: handbook");
    expect(other).toContain("Linked from: handbook");
    // Small pages read as before.
    expect(other.startsWith("# Other\n\nBack to [[handbook]].")).toBe(true);
  });

  it("finds the section by a stemmed word, falls back to substring, and keeps list working", async () => {
    const c = (ctx = await setup());
    const client = await c.mcp(await startRun(c));
    await client.callTool({ name: "wiki", arguments: { action: "write", slug: "handbook", title: "Handbook", body: page(0) } });
    await client.callTool({ name: "wiki", arguments: { action: "write", slug: "misc", title: "Misc", body: "Nothing relevant. Frobnicator notes." } });
    const hits = textOf(await client.callTool({ name: "wiki", arguments: { action: "list", q: "deploying" } }));
    expect(hits).toContain("handbook — Handbook › Deploy");
    expect(hits).toContain('read: wiki read slug="handbook" section="Deploy"');
    expect(hits).not.toContain("misc");
    // "robnic" is no whole word, so FTS is empty and the old substring search answers.
    expect(JSON.parse(textOf(await client.callTool({ name: "wiki", arguments: { action: "list", q: "robnic" } }))).map((p: { slug: string }) => p.slug)).toEqual(["misc"]);
    expect(JSON.stringify((await c.req("GET", `/api/companies/${c.company.id}/wiki?q=deploying`)).json())).toContain("handbook");
    expect(((await c.req("GET", `/api/companies/${c.company.id}/wiki?q=robnic`)).json() as Array<{ slug: string }>).map((p) => p.slug)).toEqual(["misc"]);
  });
});

describe("headingsOf", () => {
  it("lists headings at every level in order, without the intro", () => {
    const body = "Intro text.\n# One\n## Two\n### Three\n#### Four\n##### Five\n###### Six\n";
    expect(headingsOf(body).map((h) => [h.level, h.heading])).toEqual([
      [1, "One"],
      [2, "Two"],
      [3, "Three"],
      [4, "Four"],
      [5, "Five"],
      [6, "Six"],
    ]);
  });

  it("ignores headings inside code fences and gives none for a page without headings", () => {
    const body = ["```sh", "# not a heading", "```", "~~~", "## also not", "~~~", "# Real", "## Real too"].join("\n");
    expect(headingsOf(body).map((h) => h.heading)).toEqual(["Real", "Real too"]);
    expect(headingsOf("Just prose.\nNothing here.")).toEqual([]);
  });
});

describe("lessonLine", () => {
  it("puts the lesson's wording on one bullet line", () => {
    expect(lessonLine("Read the config from the environment.")).toBe("- Read the config from the environment.");
    expect(lessonLine(normalizeLesson("  Read\n the\tconfig  "))).toBe("- Read the config");
  });

  it("wraps the text as given and leaves folding and trimming to normalizeLesson", () => {
    expect(lessonLine("Two\nlines")).toBe("- Two\nlines");
    expect(lessonLine("")).toBe("- ");
  });
});

describe("serialiseWrite", () => {
  it("runs two writes one after the other", async () => {
    const log: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const first = serialiseWrite(async () => {
      log.push("first start");
      await gate;
      log.push("first end");
      return 1;
    });
    const second = serialiseWrite(async () => {
      log.push("second start");
      log.push("second end");
      return 2;
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(log).toEqual(["first start"]);
    release();
    await expect(first).resolves.toBe(1);
    await expect(second).resolves.toBe(2);
    expect(log).toEqual(["first start", "first end", "second start", "second end"]);
  });

  it("a failed write does not block the next one", async () => {
    const bad = serialiseWrite(async () => {
      throw new Error("save failed");
    });
    await expect(bad).rejects.toThrow("save failed");
    const log: string[] = [];
    await expect(
      serialiseWrite(async () => {
        log.push("ran");
        return "ok";
      }),
    ).resolves.toBe("ok");
    expect(log).toEqual(["ran"]);
  });
});

describe("lossless caps", () => {
  it("cut says how to continue and the parts add up", () => {
    const s = "a".repeat(25);
    const first = cut(s, 10, (m) => `offset=${m}`);
    expect(first).toBe(`${"a".repeat(10)}\n\n… 15 more chars; offset=10`);
    expect(cut(s, 10, () => "", 20)).toBe("aaaaa");
  });

  it("caps a ticket description, a feedback note and the wake prompt, and the rest can be read", async () => {
    const c = (ctx = await setup());
    const long = "L".repeat(1000) + "M".repeat(45_000) + "END";
    const t = (await c.req("POST", `/api/projects/${c.project.id}/tickets`, { title: "Big one", assigneeAgentId: c.worker.id })).json() as { id: string };
    await c.db.update(tickets).set({ body: long }).where(eq(tickets.id, t.id)); // the API caps bodies at 20000; imports can exceed it
    await c.scheduler.tick();
    const start = c.starts()[0]!;
    expect(start.prompt).toContain("38003 more chars; read the full ticket with tickets read");
    expect(start.prompt).not.toContain("END");
    const client = await c.mcp(start.runId);
    const read = async (a: Record<string, unknown>) => textOf(await client.callTool({ name: "tickets", arguments: { action: "read", ticketId: t.id, ...a } }));
    const first = await read({});
    expect(first).toContain("more chars; continue with tickets read");
    expect(first).not.toContain("END");
    expect(await read({ offset: 40_000 })).toContain("END");

    const note = await c.feedback.createNote(c.company.id, { text: "F".repeat(2500) + "TAIL", source: "agent" });
    const inbox = textOf(await client.callTool({ name: "feedback", arguments: { action: "inbox" } }));
    expect(inbox).toContain(`read it all with feedback note noteId=${note.id}`);
    expect(inbox).not.toContain("TAIL");
    expect(textOf(await client.callTool({ name: "feedback", arguments: { action: "note", noteId: note.id } }))).toContain("TAIL");
  });
});
