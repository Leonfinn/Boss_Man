// BOS-1933: Support answers and closes a GitHub issue or discussion through the server, against a stubbed GitHub.
// The notes are filed by the real watcher from the stub's feeds, so the reply path reads exactly what the watcher
// writes. Every name, repo and the token are made up; the token is built from pieces so the repo's secret scan ignores it.
import { afterEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { activity, agents, decisions, feedbackNotes, githubWatches } from "../src/db/schema.js";
import { githubWatchService, publicReplyProblem } from "../src/services/github-watch.js";
import { clearOwnerTodo } from "../src/services/decisions.js";
import { makeApp, signIn, type TestApp } from "./helpers.js";

const TOKEN = ["github", "pat", "11CCCCCCC0" + "abcdefghijklmnopqrstuvwxyz" + "0123456789"].join("_");
const LEAKED = ["ghp", "ZZ" + "yyxxwwvvuuttssrrqqppoonnmmllkkjjiihh"].join("_");
const REPO = "Example-Owner/example.repo";
const API = `https://api.github.com/repos/${REPO}`;

let t: TestApp | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

type Call = { url: string; method: string; auth: string | null; body: Record<string, unknown> | null };

async function setup() {
  t = await makeApp();
  const { cookie } = await signIn(t);
  const req = (url: string, payload: unknown) => t!.app.inject({ method: "POST", url, headers: { cookie }, payload: payload as object });
  const company = (await req("/api/companies", { name: "App Co" })).json().company;
  const project = (await req(`/api/companies/${company.id}/projects`, { name: "Site" })).json();
  const ceo = (await t.db.select().from(agents).where(eq(agents.companyId, company.id)))[0]!;
  const mk = async (name: string, template: string | null) => (await t!.db.insert(agents).values({ companyId: company.id, name, role: "worker", agentKind: "claude", template } as never).returning())[0]!;
  const support = await mk("Sam - Support", "support");
  const dev = await mk("Dev - Developer", "engineer");
  await t.db.insert(githubWatches).values({ projectId: project.id, companyId: company.id, repo: REPO, enabled: true, watchAlerts: false });

  const gh = { writes: "ok" as "ok" | "403", issueId: 1007, locked: false, calls: [] as Call[] };
  const at = new Date().toISOString();
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
  const fetchStub = (async (input: string, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    gh.calls.push({ url, method, auth: new Headers(init?.headers).get("authorization"), body });
    const u = new URL(url);
    if (u.pathname === "/graphql") {
      const q = String(body?.query ?? "");
      const mutation = q.startsWith("mutation");
      if (mutation && gh.writes === "403") return json(200, { data: null, errors: [{ type: "FORBIDDEN", message: "Resource not accessible by personal access token" }] });
      if (q.includes("discussions(first:30"))
        return json(200, { data: { repository: { discussions: { pageInfo: { hasNextPage: false }, nodes: [{ id: "D_kwDOexample", number: 4, title: "An idea", body: "Could it do X?", updatedAt: at, author: { login: "visitor" }, comments: { nodes: [{ id: "DC_kwDOexample", databaseId: 3001, body: "Yes please", updatedAt: at, author: { login: "other-person" } }] } }] } }, rateLimit: { remaining: 100 } } });
      if (q.includes("node(id:")) return json(200, { data: { node: { id: "D_kwDOexample", repository: { nameWithOwner: REPO } } } });
      if (q.includes("discussion(number:")) return json(200, { data: { repository: { discussion: { id: "D_kwDOexample", comments: { pageInfo: { hasNextPage: false }, nodes: [{ id: "DC_kwDOexample", databaseId: 3001 }] } } } } });
      if (q.includes("addDiscussionComment")) return json(200, { data: { addDiscussionComment: { comment: { id: "DC_new" } } } });
      if (q.includes("closeDiscussion")) return json(200, { data: { closeDiscussion: { discussion: { id: "D_kwDOexample" } } } });
      return json(200, { errors: [{ type: "NOT_FOUND" }] });
    }
    if (method !== "GET" && gh.writes === "403") return json(403, { message: "Resource not accessible by personal access token" });
    if (method === "POST" && u.pathname === `/repos/${REPO}/issues/7/comments`) return gh.locked ? json(403, { message: "Unable to create comment because issue is locked." }) : json(201, { id: 9999 });
    if (method === "PATCH" && u.pathname === `/repos/${REPO}/issues/7`) return json(200, { state: "closed" });
    if (u.pathname === `/repos/${REPO}/issues`) return json(200, [{ id: 1007, number: 7, title: "Crash on start", body: "It crashes", updated_at: at, user: { login: "visitor" } }]);
    if (u.pathname === `/repos/${REPO}/issues/comments`) return json(200, [{ id: 2001, issue_url: `${API}/issues/7`, body: "Me too", updated_at: at, user: { login: "other-person" } }]);
    if (u.pathname === `/repos/${REPO}/issues/7`) return json(200, { id: gh.issueId, number: 7 });
    if (u.pathname === `/repos/${REPO}/issues/comments/2001`) return json(200, { id: 2001, issue_url: `${API}/issues/7` });
    return json(404, { message: "Not Found" });
  }) as unknown as typeof fetch;

  const svc = githubWatchService(t.db, {
    fetch: fetchStub,
    token: async () => TOKEN,
    feedback: t.feedback,
    notify: async () => undefined,
    alert: (i) => t!.alerts.raise(i),
    clearCard: (key, summary) => clearOwnerTodo(t!.db, key, summary),
    createTicket: (projectId, input) => t!.work.createTicket(projectId, input),
    closeTicket: async () => undefined,
  });
  expect((await svc.runOne(project.id, { force: true })).created).toBe(4);
  const noteOf = async (kind: string, id: string | number) => (await t!.db.select().from(feedbackNotes).where(and(eq(feedbackNotes.companyId, company.id), eq(feedbackNotes.externalId, `github:${REPO.toLowerCase()}:${kind}:${id}`))))[0]!;
  const notes = { issue: await noteOf("issue", 1007), comment: await noteOf("issue-comment", 2001), discussion: await noteOf("discussion", "D_kwDOexample"), discussionComment: await noteOf("discussion-comment", 3001) };
  gh.calls.length = 0;
  return { company, project, ceo, support, dev, svc, gh, notes };
}

const writes = (gh: { calls: Call[] }) => gh.calls.filter((c) => c.method !== "GET" && !(c.url.endsWith("/graphql") && !String(c.body?.query ?? "").startsWith("mutation")));
const noteState = async (id: string) => (await t!.db.select({ s: feedbackNotes.state }).from(feedbackNotes).where(eq(feedbackNotes.id, id)))[0]!.s;

describe("github_reply on issues", () => {
  it("Support replies on an issue; the note stays open, and the token only rides in the header", async () => {
    const c = await setup();
    const r = await c.svc.issueReply(c.company.id, c.support.id, c.notes.issue.id, { text: "Thanks, we can reproduce it and are working on a fix." });
    expect(r.ok, r.text).toBe(true);
    const w = writes(c.gh);
    expect(w).toHaveLength(1);
    expect(w[0]!.url).toBe(`${API}/issues/7/comments`);
    expect(w[0]!.body).toEqual({ body: "Thanks, we can reproduce it and are working on a fix." });
    expect(c.gh.calls.every((x) => x.auth === `Bearer ${TOKEN}` && !x.url.includes(TOKEN) && !JSON.stringify(x.body ?? {}).includes(TOKEN))).toBe(true);
    expect(await noteState(c.notes.issue.id)).toBe("unprocessed");
    const logged = (await t!.db.select().from(activity).where(and(eq(activity.companyId, c.company.id), eq(activity.kind, "github_reply"))))[0];
    expect(logged?.agentId).toBe(c.support.id);
    expect(logged?.detail).toMatchObject({ noteId: c.notes.issue.id, closed: null });
  });

  it("replies and closes an issue as completed, and marks the note processed", async () => {
    const c = await setup();
    const r = await c.svc.issueReply(c.company.id, c.support.id, c.notes.issue.id, { text: "Fixed in the latest release.", close: "completed" });
    expect(r.ok, r.text).toBe(true);
    const w = writes(c.gh);
    expect(w.map((x) => `${x.method} ${x.url}`)).toEqual([`POST ${API}/issues/7/comments`, `PATCH ${API}/issues/7`]);
    expect(w[1]!.body).toEqual({ state: "closed", state_reason: "completed" });
    expect(await noteState(c.notes.issue.id)).toBe("processed");
    const logged = (await t!.db.select().from(activity).where(and(eq(activity.companyId, c.company.id), eq(activity.kind, "github_reply"))))[0];
    expect(logged?.detail).toMatchObject({ closed: "completed" });
  });

  it("a reply on an issue comment goes on its issue, and close closes that issue (the CEO may do it too)", async () => {
    const c = await setup();
    const r = await c.svc.issueReply(c.company.id, c.ceo.id, c.notes.comment.id, { text: "We won't add this, sorry.", close: "not_planned" });
    expect(r.ok, r.text).toBe(true);
    const w = writes(c.gh);
    expect(w.map((x) => `${x.method} ${x.url}`)).toEqual([`POST ${API}/issues/7/comments`, `PATCH ${API}/issues/7`]);
    expect(w[1]!.body).toEqual({ state: "closed", state_reason: "not_planned" });
  });
});

describe("github_reply on discussions", () => {
  it("replies on a discussion and closes it as resolved", async () => {
    const c = await setup();
    const r = await c.svc.issueReply(c.company.id, c.support.id, c.notes.discussion.id, { text: "Good idea: it is on the roadmap now.", close: "completed" });
    expect(r.ok, r.text).toBe(true);
    const w = writes(c.gh);
    expect(w).toHaveLength(2);
    expect(w[0]!.body?.variables).toEqual({ d: "D_kwDOexample", b: "Good idea: it is on the roadmap now.", r: null });
    expect(w[1]!.body?.variables).toEqual({ d: "D_kwDOexample", why: "RESOLVED" });
    expect(await noteState(c.notes.discussion.id)).toBe("processed");
  });

  it("a reply to a discussion comment goes under that comment", async () => {
    const c = await setup();
    const r = await c.svc.issueReply(c.company.id, c.support.id, c.notes.discussionComment.id, { text: "Thanks for the vote." });
    expect(r.ok, r.text).toBe(true);
    const w = writes(c.gh);
    expect(w).toHaveLength(1);
    expect(w[0]!.body?.variables).toEqual({ d: "D_kwDOexample", b: "Thanks for the vote.", r: "DC_kwDOexample" });
  });
});

describe("github_reply refusals", () => {
  it("refuses an agent that is not Support or the CEO", async () => {
    const c = await setup();
    expect((await c.svc.issueReply(c.company.id, c.dev.id, c.notes.issue.id, { text: "Hello there" })).ok).toBe(false);
    expect((await c.svc.issueReply(c.company.id, null, c.notes.issue.id, { text: "Hello there" })).ok).toBe(false);
    expect(c.gh.calls).toHaveLength(0);
  });

  it("refuses a note that isn't from the GitHub watcher, and one whose repo is no longer watched", async () => {
    const c = await setup();
    const owner = await t!.feedback.createNote(c.company.id, { text: "From the owner", source: "owner" } as never);
    const r = await c.svc.issueReply(c.company.id, c.support.id, (owner as { id: string }).id, { text: "Hello there" });
    expect(r.ok).toBe(false);
    expect(r.text).toContain("GitHub watcher");
    // A note made to look like a GitHub one for a repo nobody watches.
    const fake = await t!.feedback.createExternalNote(c.company.id, { title: "x", text: "Issue #1 by someone\nhttps://github.com/other-owner/other/issues/1\n\nx", externalId: "github:other-owner/other:issue:1" });
    expect((await c.svc.issueReply(c.company.id, c.support.id, fake!.id, { text: "Hello there" })).text).toContain("watches");
    await t!.db.update(githubWatches).set({ enabled: false }).where(eq(githubWatches.projectId, c.project.id));
    expect((await c.svc.issueReply(c.company.id, c.support.id, c.notes.issue.id, { text: "Hello there" })).ok).toBe(false);
    expect(c.gh.calls).toHaveLength(0);
  });

  it("refuses when GitHub's item doesn't match the note, and when the note's link was not the watcher's", async () => {
    const c = await setup();
    c.gh.issueId = 5555; // issue #7 on GitHub is now some other item
    const r = await c.svc.issueReply(c.company.id, c.support.id, c.notes.issue.id, { text: "Hello there" });
    expect(r.ok).toBe(false);
    expect(r.text).toContain("doesn't match");
    await t!.db.update(feedbackNotes).set({ text: "Issue #7 by visitor\nhttps://github.com/elsewhere/repo/issues/7\n\nx" }).where(eq(feedbackNotes.id, c.notes.issue.id));
    expect((await c.svc.issueReply(c.company.id, c.support.id, c.notes.issue.id, { text: "Hello there" })).ok).toBe(false);
    expect(writes(c.gh)).toHaveLength(0);
  });

  it("refuses public text with an address, internal host, machine path or a key, and sends nothing", async () => {
    const c = await setup();
    for (const text of ["Try 192.168.1.50 instead", "It runs on nas.local", "See /home/someone/app/logs", `Use ${LEAKED} for now`, "Look in C:\\Users\\x"]) {
      const r = await c.svc.issueReply(c.company.id, c.support.id, c.notes.issue.id, { text });
      expect(r.ok, text).toBe(false);
      expect(r.text).toContain("public");
      expect(r.text).not.toContain(LEAKED);
    }
    expect(c.gh.calls).toHaveLength(0);
    expect(JSON.stringify(await t!.db.select().from(activity).where(eq(activity.companyId, c.company.id)))).not.toContain(LEAKED);
    // Ordinary replies with a link or a version number pass.
    expect(publicReplyProblem("Fixed in v1.2.3, see https://example.com/docs/setup")).toBeNull();
  });

  it("a locked issue is refused without a card", async () => {
    const c = await setup();
    c.gh.locked = true;
    const r = await c.svc.issueReply(c.company.id, c.support.id, c.notes.issue.id, { text: "Hello there" });
    expect(r.ok).toBe(false);
    expect(r.text).toContain("locked");
    expect(await t!.db.select().from(decisions).where(eq(decisions.companyId, c.company.id))).toHaveLength(0);
  });

  it("GitHub refusing the write raises one owner card naming the permission; a reply that works withdraws it", async () => {
    const c = await setup();
    c.gh.writes = "403";
    expect((await c.svc.issueReply(c.company.id, c.support.id, c.notes.issue.id, { text: "Hello there" })).ok).toBe(false);
    expect((await c.svc.issueReply(c.company.id, c.support.id, c.notes.discussion.id, { text: "Hello there" })).ok).toBe(false);
    expect((await c.svc.issueReply(c.company.id, c.support.id, c.notes.issue.id, { text: "Hello again" })).ok).toBe(false);
    const cards = await t!.db.select().from(decisions).where(eq(decisions.companyId, c.company.id));
    expect(cards).toHaveLength(1);
    for (const s of ['"Issues"', '"Discussions"', "Read and write", "Secrets page"]) expect(cards[0]!.question).toContain(s);
    expect(cards[0]!.question).not.toContain(TOKEN);
    expect(await noteState(c.notes.issue.id)).toBe("unprocessed");
    c.gh.writes = "ok";
    expect((await c.svc.issueReply(c.company.id, c.support.id, c.notes.issue.id, { text: "Hello there", close: "completed" })).ok).toBe(true);
    const after = await t!.db.select().from(decisions).where(eq(decisions.companyId, c.company.id));
    expect(after).toHaveLength(1);
    expect(after[0]!.status).not.toBe("open");
    // A later episode can raise a card again (the key is freed once it is closed).
    c.gh.writes = "403";
    await c.svc.issueReply(c.company.id, c.support.id, c.notes.comment.id, { text: "Hello there" });
    expect((await t!.db.select().from(decisions).where(and(eq(decisions.companyId, c.company.id), eq(decisions.status, "open"))))).toHaveLength(1);
  });
});
