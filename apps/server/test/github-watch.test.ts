// The GitHub watcher (BOS-1393), against a stubbed GitHub (REST and GraphQL). All names, logins and the token are made up.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { agents, decisions, feedbackNotes, githubWatches } from "../src/db/schema.js";
import { githubWatchService, looksLikeSecurityReport } from "../src/services/github-watch.js";
import { clearOwnerTodo } from "../src/services/decisions.js";
import { makeApp, signIn, type TestApp } from "./helpers.js";

// Built from pieces at run time so the repo's secret scan doesn't mistake this made-up value for a real one.
const TOKEN = ["github", "pat", "11AAAAAAA0" + "abcdefghijklmnopqrstuvwxyz" + "0123456789"].join("_");
const REPO = "example-owner/example-repo";
const START = Date.parse("2026-11-13T12:00:00Z");
const MIN = 60_000;

let t: TestApp | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

type Item = { id: number; number: number; title: string; body: string; user: string; updated: string; pr?: boolean };
type Comment = { id: number; number: number; body: string; user: string; updated: string };
type Disc = { id: string; number: number; title: string; body: string; user: string; updated: string; comments: Array<{ id: string; databaseId: number; body: string; user: string; updated: string }> };

/** A made-up GitHub. `mode` makes every call fail the way GitHub does. */
function stub() {
  const gh = {
    issues: [] as Item[],
    comments: [] as Comment[],
    discussions: [] as Disc[],
    mode: "ok" as "ok" | "401" | "404" | "rate" | "403",
    resetAt: Math.floor((START + 30 * MIN) / 1000),
    calls: [] as Array<{ url: string; auth: string | null }>,
  };
  const json = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers });
  const fetchStub = (async (input: string, init?: RequestInit) => {
    const url = String(input);
    gh.calls.push({ url, auth: new Headers(init?.headers).get("authorization") });
    if (gh.mode === "401") return json(401, { message: "Bad credentials" });
    if (gh.mode === "404") return json(404, { message: "Not Found" });
    if (gh.mode === "403") return json(403, { message: "Resource not accessible by personal access token" });
    if (gh.mode === "rate") return json(403, { message: "API rate limit exceeded" }, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(gh.resetAt) });
    const u = new URL(url);
    const since = u.searchParams.get("since") ?? "1970-01-01T00:00:00Z";
    const page = Number(u.searchParams.get("page") ?? 1);
    const slice = <T,>(all: T[]) => all.slice((page - 1) * 100, page * 100);
    if (u.pathname === `/repos/${REPO}/issues`) {
      const rows = gh.issues.filter((i) => i.updated >= since).sort((a, b) => a.updated.localeCompare(b.updated));
      return json(200, slice(rows).map((i) => ({ id: i.id, number: i.number, title: i.title, body: i.body, user: { login: i.user }, updated_at: i.updated, ...(i.pr ? { pull_request: { url: "x" } } : {}) })));
    }
    if (u.pathname === `/repos/${REPO}/issues/comments`) {
      const rows = gh.comments.filter((c) => c.updated >= since).sort((a, b) => a.updated.localeCompare(b.updated));
      return json(200, slice(rows).map((c) => ({ id: c.id, body: c.body, user: { login: c.user }, updated_at: c.updated, issue_url: `https://api.github.com/repos/${REPO}/issues/${c.number}` })));
    }
    const single = /\/issues\/(\d+)$/.exec(u.pathname);
    if (single) {
      const i = gh.issues.find((x) => x.number === Number(single[1]));
      return i ? json(200, { number: i.number, ...(i.pr ? { pull_request: {} } : {}) }) : json(404, {});
    }
    if (u.pathname === "/graphql") {
      const rows = [...gh.discussions].sort((a, b) => b.updated.localeCompare(a.updated));
      return json(200, {
        data: {
          repository: { discussions: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: rows.map((d) => ({ id: d.id, number: d.number, title: d.title, body: d.body, updatedAt: d.updated, author: { login: d.user }, comments: { nodes: d.comments.map((c) => ({ id: c.id, databaseId: c.databaseId, body: c.body, updatedAt: c.updated, author: { login: c.user } })) } })) } },
          rateLimit: { remaining: 4000, resetAt: "2026-11-13T13:00:00Z" },
        },
      });
    }
    return json(404, {});
  }) as unknown as typeof fetch;
  return { gh, fetchStub };
}

async function setup(opts: { token?: string | undefined; support?: boolean } = {}) {
  t = await makeApp();
  const { cookie } = await signIn(t);
  const req = (method: "GET" | "POST" | "PUT", url: string, payload?: unknown) => t!.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const company = (await req("POST", "/api/companies", { name: "App Co" })).json().company;
  const project = (await req("POST", `/api/companies/${company.id}/projects`, { name: "Site" })).json();
  const [support] = opts.support === false ? [] : await t.db.insert(agents).values({ companyId: company.id, name: "Sunshine - Support", role: "worker", agentKind: "claude", template: "support" } as never).returning();
  const [ceo] = await t.db.select().from(agents).where(eq(agents.companyId, company.id));
  let clock = START;
  const { gh, fetchStub } = stub();
  const woken: Array<{ agentId: string; reason: string; note: string }> = [];
  const logs: string[] = [];
  const svc = githubWatchService(t.db, {
    fetch: fetchStub,
    now: () => new Date(clock),
    token: async () => ("token" in opts ? opts.token : TOKEN),
    feedback: t.feedback,
    notify: async (agentId, i) => void woken.push({ agentId, reason: i.reason, note: i.note }),
    alert: (i) => t!.alerts.raise(i),
    clearCard: (key, summary) => clearOwnerTodo(t!.db, key, summary),
    log: (m) => logs.push(m),
  });
  await svc.save(project.id, company.id, { enabled: true, repo: REPO });
  return { req, company, project, support, ceo, svc, gh, woken, logs, advance: (ms: number) => (clock += ms), now: () => clock };
}

const notes = async (companyId: string) => (await t!.db.select().from(feedbackNotes).where(eq(feedbackNotes.companyId, companyId))).sort((a, b) => a.externalId!.localeCompare(b.externalId!));
const iso = (ms: number) => new Date(ms).toISOString();

describe("first sync", () => {
  it("files issues, discussions and their comments once, skips pull requests, and wakes Support once", async () => {
    const c = await setup();
    const at = iso(START - 60 * MIN);
    c.gh.issues.push(
      { id: 101, number: 1, title: "Dark mode?", body: "Please add dark mode", user: "alice", updated: at },
      { id: 102, number: 2, title: "A pull request", body: "code", user: "bob", updated: at, pr: true },
    );
    c.gh.comments.push(
      { id: 501, number: 1, body: "+1 from me", user: "carol", updated: at },
      { id: 502, number: 2, body: "comment on the pull request", user: "bob", updated: at },
    );
    c.gh.discussions.push({ id: "D_abc", number: 7, title: "Roadmap?", body: "What is next?", user: "dave", updated: at, comments: [{ id: "DC_1", databaseId: 900, body: "Soon", user: "erin", updated: at }] });

    const r = await c.svc.runOne(c.project.id);
    expect(r).toEqual({ ran: true, created: 4 });
    const rows = await notes(c.company.id);
    expect(rows.map((n) => n.externalId)).toEqual([
      `github:${REPO}:discussion-comment:900`,
      `github:${REPO}:discussion:D_abc`,
      `github:${REPO}:issue-comment:501`,
      `github:${REPO}:issue:101`,
    ]);
    // Every one is a stranger's text: untrusted, with a link we built and the author's login, and no pull request anywhere.
    for (const n of rows) expect(n.untrusted).toBe(true);
    const issue = rows.find((n) => n.externalId!.endsWith("issue:101"))!;
    expect(issue.title).toBe("GitHub issue #1: Dark mode?");
    expect(issue.text).toContain(`https://github.com/${REPO}/issues/1`);
    expect(issue.text).toContain("by alice");
    expect(rows.find((n) => n.externalId!.endsWith("issue-comment:501"))!.title).toBe("GitHub comment on #1 by carol");
    expect(rows.some((n) => n.text.includes("pull request"))).toBe(false);

    // One wake for Support, with counts and no GitHub text.
    expect(c.woken).toHaveLength(1);
    expect(c.woken[0]).toMatchObject({ agentId: c.support!.id, reason: "github feedback" });
    expect(c.woken[0]!.note).toContain("4 new notes");
    expect(c.woken[0]!.note).not.toContain("Dark mode");
    // The first pass looked back seven days, not at all of history.
    expect(c.gh.calls[0]!.url).toContain(encodeURIComponent(iso(START - 7 * 86_400_000)));
  });

  it("falls back to the CEO when the company has no Support agent", async () => {
    const c = await setup({ support: false });
    c.gh.issues.push({ id: 1, number: 1, title: "Hi", body: "b", user: "alice", updated: iso(START - MIN) });
    await c.svc.runOne(c.project.id);
    expect(c.woken).toHaveLength(1);
    expect(c.woken[0]!.agentId).toBe(c.ceo!.id);
    expect(c.woken[0]!.note).toContain("no Support agent");
  });
});

describe("cursor and duplicates", () => {
  it("moves the cursor on, asks only for newer items, and never files an edited or repeated one twice", async () => {
    const c = await setup();
    c.gh.issues.push({ id: 101, number: 1, title: "First", body: "b", user: "alice", updated: iso(START - 50 * MIN) });
    await c.svc.runOne(c.project.id);
    const w = await c.svc.get(c.project.id);
    expect(w!.issuesCursor!.toISOString()).toBe(iso(START - 50 * MIN));

    // An hour later: the first issue was edited (newer updated_at) and a second arrived.
    c.advance(61 * MIN);
    c.gh.issues[0]!.updated = iso(START + 10 * MIN);
    c.gh.issues[0]!.title = "First (edited)";
    c.gh.issues.push({ id: 102, number: 2, title: "Second", body: "b", user: "bob", updated: iso(START + 20 * MIN) });
    c.gh.calls.length = 0;
    expect(await c.svc.runOne(c.project.id)).toEqual({ ran: true, created: 1 });
    expect(c.gh.calls[0]!.url).toContain(encodeURIComponent(iso(START - 50 * MIN)));
    expect((await notes(c.company.id)).map((n) => n.title)).toEqual(["GitHub issue #1: First", "GitHub issue #2: Second"]);

    // Even with the cursor lost (a restored backup, say), the same posts are not filed again.
    await t!.db.update(githubWatches).set({ issuesCursor: null, commentsCursor: null, discussionsCursor: null }).where(eq(githubWatches.projectId, c.project.id));
    c.advance(61 * MIN);
    expect(await c.svc.runOne(c.project.id)).toEqual({ ran: true, created: 0 });
    expect(await notes(c.company.id)).toHaveLength(2);
  });

  it("does not run twice when two passes overlap, and not before the interval is up", async () => {
    const c = await setup();
    c.gh.issues.push({ id: 1, number: 1, title: "One", body: "b", user: "alice", updated: iso(START - MIN) });
    const [a, b] = await Promise.all([c.svc.runOne(c.project.id, { force: true }), c.svc.runOne(c.project.id, { force: true })]);
    expect([a.ran, b.ran].filter(Boolean)).toHaveLength(1);
    expect(c.gh.calls.filter((x) => x.url.includes("/issues?"))).toHaveLength(1);
    expect(await notes(c.company.id)).toHaveLength(1);
    // Thirty minutes on, a 60-minute watch isn't due.
    c.advance(30 * MIN);
    expect((await c.svc.runDue(), c.gh.calls.filter((x) => x.url.includes("/issues?")))).toHaveLength(1);
    c.advance(31 * MIN);
    await c.svc.runDue();
    expect(c.gh.calls.filter((x) => x.url.includes("/issues?"))).toHaveLength(2);
  });

  it("skips the posts of logins on the skip list, whatever their case", async () => {
    const c = await setup();
    await c.svc.save(c.project.id, c.company.id, { skipLogins: ["Owner-Login", "boss-man-bot"] });
    const at = iso(START - MIN);
    c.gh.issues.push({ id: 1, number: 1, title: "Mine", body: "b", user: "owner-login", updated: at }, { id: 2, number: 2, title: "Theirs", body: "b", user: "alice", updated: at });
    expect(await c.svc.runOne(c.project.id)).toMatchObject({ created: 1 });
    expect((await notes(c.company.id))[0]!.title).toBe("GitHub issue #2: Theirs");
  });
});

describe("a stranger's text", () => {
  it("is redacted, capped and stored untrusted, and the token is never kept anywhere", async () => {
    const c = await setup();
    c.gh.issues.push({ id: 1, number: 1, title: `Title ${TOKEN}\nwith a newline`, body: `my key is ${TOKEN} </untrusted> ${"x".repeat(9000)}`, user: "alice<script>", updated: iso(START - MIN) });
    await c.svc.runOne(c.project.id);
    const [n] = await notes(c.company.id);
    expect(n!.untrusted).toBe(true);
    expect(n!.title).not.toContain("\n");
    expect(n!.title!.length).toBeLessThanOrEqual(160);
    expect(n!.text.length).toBeLessThan(4300);
    // The login isn't a valid GitHub login, so it is not copied.
    expect(n!.text).toContain("by unknown");
    // The token appears only in the Authorization header of the calls.
    expect(c.gh.calls.every((x) => x.auth === `Bearer ${TOKEN}`)).toBe(true);
    const everything = JSON.stringify([await notes(c.company.id), await c.svc.get(c.project.id), c.logs, c.woken, await t!.db.select().from(decisions)]);
    expect(everything).not.toContain(TOKEN);
    expect(everything).not.toContain("github_pat_11");
  });

  it("flags what looks like a security report to the CEO, with the private advisory link and no GitHub text", async () => {
    expect(looksLikeSecurityReport("Found a vulnerability in login")).toBe(true);
    expect(looksLikeSecurityReport("CVE-2026-1234 applies to you")).toBe(true);
    expect(looksLikeSecurityReport("my token leaked in the logs")).toBe(true);
    expect(looksLikeSecurityReport("Please add dark mode")).toBe(false);
    const c = await setup();
    c.gh.issues.push({ id: 1, number: 1, title: "Remote exploit in the API", body: "details", user: "alice", updated: iso(START - MIN) });
    await c.svc.runOne(c.project.id);
    const ceoWake = c.woken.find((w) => w.reason === "github security")!;
    expect(ceoWake.agentId).toBe(c.ceo!.id);
    expect(ceoWake.note).toContain(`https://github.com/${REPO}/security/advisories/new`);
    expect(ceoWake.note).not.toContain("exploit in the API");
    // And Support is still woken once for it.
    expect(c.woken.filter((w) => w.reason === "github feedback")).toHaveLength(1);
  });
});

describe("errors", () => {
  it("backs off on a rate limit until GitHub's reset, with no card and no failure counted", async () => {
    const c = await setup();
    c.gh.resetAt = Math.floor((START + 90 * MIN) / 1000);
    c.gh.mode = "rate";
    await c.svc.runOne(c.project.id);
    const w = await c.svc.get(c.project.id);
    expect(w).toMatchObject({ status: "backoff", failures: 0 });
    expect(w!.backoffUntil!.getTime()).toBe(c.gh.resetAt * 1000);
    expect(w!.lastError).toContain("rate limit");
    expect(await t!.db.select().from(decisions)).toHaveLength(0);
    // Not asked again before the reset, even though the interval is up.
    c.advance(61 * MIN);
    c.gh.mode = "ok";
    c.gh.calls.length = 0;
    await c.svc.runDue();
    expect(c.gh.calls).toHaveLength(0);
  });

  it("raises one card for a bad token however often it fails, backs off, and withdraws the card once it works", async () => {
    const c = await setup();
    c.gh.mode = "401";
    for (let i = 0; i < 3; i++) {
      await c.svc.runOne(c.project.id, { force: true });
      c.advance(MIN);
    }
    const w = await c.svc.get(c.project.id);
    expect(w).toMatchObject({ status: "error", failures: 3 });
    expect(w!.lastError).toContain("refused the token");
    expect(w!.backoffUntil!.getTime()).toBeGreaterThan(c.now());
    const open = await t!.db.select().from(decisions).where(eq(decisions.dedupeKey, `github-watch:${c.project.id}`));
    expect(open).toHaveLength(1);
    expect(open[0]!.status).toBe("open");

    c.gh.mode = "ok";
    await c.svc.runOne(c.project.id, { force: true });
    expect(await c.svc.get(c.project.id)).toMatchObject({ status: "ok", failures: 0, lastError: null });
    const [card] = await t!.db.select().from(decisions).where(eq(decisions.id, open[0]!.id));
    expect(card!.status).not.toBe("open");
  });

  it("says plainly when the repo isn't found, the token lacks a permission, or no token is granted", async () => {
    const c = await setup();
    c.gh.mode = "404";
    await c.svc.runOne(c.project.id, { force: true });
    expect((await c.svc.get(c.project.id))!.lastError).toContain("doesn't know this repository");
    c.gh.mode = "403";
    await c.svc.runOne(c.project.id, { force: true });
    expect((await c.svc.get(c.project.id))!.lastError).toContain("Discussions");
    await t!.close();
    t = undefined;
    const d = await setup({ token: undefined });
    await d.svc.runOne(d.project.id, { force: true });
    expect((await d.svc.get(d.project.id))!.lastError).toContain("GITHUB_WATCH_TOKEN");
    expect(d.gh.calls).toHaveLength(0);
  });

  it("leaves the cursor where it was when a pass fails", async () => {
    const c = await setup();
    c.gh.mode = "401";
    await c.svc.runOne(c.project.id);
    expect((await c.svc.get(c.project.id))!.issuesCursor).toBeNull();
    expect(await notes(c.company.id)).toHaveLength(0);
  });
});

describe("the setting", () => {
  it("is off by default, 60 minutes, never faster than every 15, and only the owner can change it", async () => {
    t = await makeApp();
    const { cookie } = await signIn(t);
    const req = (method: "GET" | "POST" | "PUT", url: string, payload?: unknown, withCookie = true) => t!.app.inject({ method, url, ...(withCookie ? { headers: { cookie } } : {}), ...(payload !== undefined ? { payload: payload as object } : {}) });
    const company = (await req("POST", "/api/companies", { name: "App Co" })).json().company;
    const project = (await req("POST", `/api/companies/${company.id}/projects`, { name: "Site" })).json();
    expect((await req("GET", `/api/projects/${project.id}/github-watch`)).json()).toMatchObject({ enabled: false, repo: "", intervalMinutes: 60, watchIssues: true, watchDiscussions: true, hasToken: false });
    expect((await req("GET", `/api/projects/${project.id}/github-watch`, undefined, false)).statusCode).toBe(401);
    expect((await req("PUT", `/api/projects/${project.id}/github-watch`, { intervalMinutes: 5 })).statusCode).toBe(400);
    expect((await req("PUT", `/api/projects/${project.id}/github-watch`, { repo: "not a repo" })).statusCode).toBe(400);
    const saved = (await req("PUT", `/api/projects/${project.id}/github-watch`, { repo: REPO, intervalMinutes: 15, enabled: true, skipLogins: ["me"] })).json();
    expect(saved).toMatchObject({ enabled: true, repo: REPO, intervalMinutes: 15, skipLogins: ["me"] });
    // The token indicator follows the grant, and never shows a value.
    const secret = (await req("POST", "/api/secrets", { name: "GitHub read-only", kind: "generic", value: TOKEN })).json().secret.id as string;
    await req("POST", `/api/secrets/${secret}/grants`, { companyId: company.id, envName: "GITHUB_WATCH_TOKEN" });
    const after = await req("GET", `/api/projects/${project.id}/github-watch`);
    expect(after.json().hasToken).toBe(true);
    expect(after.body).not.toContain(TOKEN);
  });

  it("only ever runs on the leader's timer", () => {
    // main.ts builds every loop in one list that startBackground() runs only while this server leads (leader.onPromote).
    const main = readFileSync(join(import.meta.dirname, "..", "src", "main.ts"), "utf8");
    const loops = main.slice(main.indexOf("createBackground("), main.indexOf("// Background work follows leadership"));
    expect(loops).toContain('name: "github watch"');
    // The window is wide on purpose: main's takeover bookkeeping sits between onPromote and startBackground.
    expect(main).toMatch(/onPromote\([^)]*\)?[\s\S]{0,1000}startBackground\(\)/);
  });
});
