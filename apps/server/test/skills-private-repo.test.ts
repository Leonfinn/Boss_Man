import { randomBytes, randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { activity, secretAccessLog, skills } from "../src/db/schema.js";
import { issueRunToken } from "../src/mcp.js";
import { nameSecurityReviewer } from "./helpers.js";

// BOS-1891: skill links to a private GitHub repository use the company's GIT_TOKEN, sent only to GitHub's own
// hosts, read fresh on every import, and never shown in an error, a log or the stored skill.

const GOOD = "made-up-git-token-good-0001";
const NEW = "made-up-git-token-rotated-0002";
const EXPIRED = "made-up-git-token-expired-0003";

const md = (name: string) => `---\nname: ${name}\ndescription: Does ${name} things.\n---\nSteps.`;

/** A fake GitHub: acme/secret is private (404 without a token GitHub accepts, as GitHub answers), acme/open is public. */
function fakeGitHub() {
  const seen: Array<{ url: string; auth: string | null }> = [];
  const repos: Record<string, { private: boolean; commit: string; files: Record<string, string> }> = {
    secret: { private: true, commit: "a".repeat(40), files: { "tidy/SKILL.md": md("tidy") } },
    open: { private: false, commit: "b".repeat(40), files: { "neat/SKILL.md": md("neat"), "neat/big.md": "moved" } },
  };
  let mode: "normal" | "ratelimit" | "forbidden" = "normal";
  const valid = new Set([GOOD, NEW]);
  const fakeFetch = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const auth = (init?.headers as Record<string, string> | undefined)?.authorization ?? null;
    seen.push({ url, auth });
    const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200 });
    const host = new URL(url).hostname;
    if (host === "objects.example.com") return new Response("moved body");
    if (host === "files.example.com" || host === "raw.githubusercontent.com.example.com") return new Response(md("loose"));
    if (auth && !valid.has(auth.replace(/^Bearer /, ""))) return new Response('{"message":"Bad credentials"}', { status: 401 });
    if (mode === "ratelimit") return new Response("{}", { status: 403, headers: { "x-ratelimit-remaining": "0" } });
    if (mode === "forbidden") return new Response("{}", { status: 403 });
    const m = /^https:\/\/(api\.github\.com\/repos|raw\.githubusercontent\.com)\/acme\/(\w+)(.*)$/.exec(url);
    const repo = m ? repos[m[2]!] : undefined;
    if (!m || !repo || (repo.private && !auth)) return new Response('{"message":"Not Found"}', { status: 404 });
    const rest = m[3]!;
    if (m[1] === "raw.githubusercontent.com") {
      const path = decodeURIComponent(rest.replace(/^\/[0-9a-f]{40}\//, ""));
      // One file is served from a CDN on another host, as GitHub does for some files.
      if (path === "neat/big.md") return new Response(null, { status: 302, headers: { location: "https://objects.example.com/blob/1" } });
      return repo.files[path] !== undefined ? new Response(repo.files[path]) : new Response("", { status: 404 });
    }
    if (rest === "") return json({ default_branch: "main" });
    if (rest.startsWith("/commits/")) return json({ sha: repo.commit });
    if (rest.startsWith("/git/trees/")) return json({ tree: Object.entries(repo.files).map(([path, c]) => ({ path, type: "blob", size: c.length })) });
    return new Response("", { status: 404 });
  }) as typeof fetch;
  return { fetch: fakeFetch, seen, repos, valid, setMode: (m: typeof mode) => (mode = m) };
}

let ctx: Awaited<ReturnType<typeof setup>> | undefined;
const clients: Client[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close().catch(() => undefined)));
  await ctx?.app.close();
  await ctx?.close();
  ctx = undefined;
});

async function setup() {
  const gh = fakeGitHub();
  const { db, close } = await openPglite();
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false, limits: { quickBatchMs: 0 }, workspaceRoot: "/ws", fetch: gh.fetch });
  await built.app.listen({ host: "127.0.0.1", port: 0 });
  const base = `127.0.0.1:${(built.app.server.address() as { port: number }).port}`;
  const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
  const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
  const req = (method: "GET" | "POST" | "PUT", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const { company, ceo } = (await req("POST", "/api/companies", { name: "App Co" })).json() as { company: { id: string }; ceo: { id: string } };
  const worker = (await req("POST", `/api/companies/${company.id}/agents`, { name: "Engineer" })).json() as { id: string };
  const reviewer = (await req("POST", `/api/companies/${company.id}/agents`, { name: "Security Reviewer" })).json() as { id: string };
  await nameSecurityReviewer(db, reviewer.id);
  await req("POST", `/api/companies/${company.id}/projects`, { name: "Site" });
  const addToken = async (value: string) => {
    const { secret } = (await req("POST", "/api/secrets", { name: "Git", kind: "generic", value, acceptUnusualFormat: true })).json() as { secret: { id: string } };
    const grant = (await req("POST", `/api/secrets/${secret.id}/grants`, { companyId: company.id, envName: "GIT_TOKEN" })).json() as { id: string };
    return { secretId: secret.id, grantId: grant.id };
  };
  const addLink = (url: string) => req("POST", `/api/companies/${company.id}/skills`, { from: "link", url });
  const mcp = async (agentId: string) => {
    const token = await issueRunToken(db, { companyId: company.id, agentId, runId: randomUUID() });
    const c = new Client({ name: "t", version: "0" });
    await c.connect(new StreamableHTTPClientTransport(new URL(`http://${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
    clients.push(c);
    return c;
  };
  return { ...built, db, close, company, ceo, worker, gh, req, addToken, addLink, mcp };
}

/** Everything a person could read afterwards: skill rows, the company's log. None of it may hold a token. */
async function readable(c: NonNullable<typeof ctx>) {
  return JSON.stringify([await c.db.select().from(skills), await c.db.select().from(activity)]);
}

const txt = (r: unknown) => ((r as { content: Array<{ text: string }> }).content[0]?.text ?? "");

describe("BOS-1891: skills from a private GitHub repository", () => {
  it("day 1: with no token the error names Settings → Secrets; once one is added the same link imports, no restart", async () => {
    const c = (ctx = await setup());
    const before = await c.addLink("https://github.com/acme/secret");
    expect(before.statusCode).toBe(404);
    expect(before.json().message).toContain("Settings → Secrets");
    expect(before.json().message).toContain("GIT_TOKEN");

    await c.addToken(GOOD);
    const after = await c.addLink("https://github.com/acme/secret");
    expect(after.statusCode).toBe(201);
    const [row] = await c.db.select().from(skills).where(eq(skills.name, "tidy"));
    expect(row!.sourceUrl).toBe("https://github.com/acme/secret/tree/main/tidy");
    // The token went to GitHub's API and raw hosts, and is nowhere a person can read it.
    expect(c.gh.seen.filter((s) => s.auth === `Bearer ${GOOD}`).map((s) => new URL(s.url).hostname).sort()).toEqual(["api.github.com", "api.github.com", "api.github.com", "raw.githubusercontent.com"]);
    expect(await readable(c)).not.toContain(GOOD);
    // Each import is one entry in the secret's access log, under its own purpose.
    expect((await c.db.select().from(secretAccessLog)).some((l) => l.purpose === "skill_import")).toBe(true);
  });

  it("sends the token to GitHub's hosts only: not after a redirect to another host, not to a look-alike or any other link", async () => {
    const c = (ctx = await setup());
    await c.addToken(GOOD);
    expect((await c.addLink("https://github.com/acme/open")).statusCode).toBe(201);
    const cdn = c.gh.seen.find((s) => s.url.startsWith("https://objects.example.com/"));
    expect(cdn).toEqual({ url: "https://objects.example.com/blob/1", auth: null });

    expect((await c.addLink("https://raw.githubusercontent.com.example.com/x/SKILL.md")).statusCode).toBe(201);
    expect(c.gh.seen.find((s) => s.url.startsWith("https://raw.githubusercontent.com.example.com/"))!.auth).toBeNull();

    await c.db.delete(skills);
    const logged = (await c.db.select().from(secretAccessLog)).length;
    expect((await c.addLink("https://files.example.com/SKILL.md")).statusCode).toBe(201);
    expect(c.gh.seen.find((s) => s.url.startsWith("https://files.example.com/"))!.auth).toBeNull();
    // A link to another host doesn't even read the secret.
    expect((await c.db.select().from(secretAccessLog)).length).toBe(logged);
  });

  it("a week on: an expired token still lets public links work, and a private link says to rotate it in Settings → Secrets", async () => {
    const c = (ctx = await setup());
    const { secretId } = await c.addToken(EXPIRED);
    expect((await c.addLink("https://github.com/acme/open")).statusCode).toBe(201);

    const res = await c.addLink("https://github.com/acme/secret");
    expect(res.statusCode).toBe(404);
    expect(res.json().message).toContain("Settings → Secrets");
    expect(res.json().message).toContain("Rotate");
    expect(res.body).not.toContain(EXPIRED);

    // Rotated: the very next import uses the new value (read fresh, never cached).
    expect((await c.req("PUT", `/api/secrets/${secretId}/value`, { value: NEW, acceptUnusualFormat: true })).statusCode).toBe(200);
    expect((await c.addLink("https://github.com/acme/secret")).statusCode).toBe(201);
    expect(c.gh.seen.at(-1)!.auth).toBe(`Bearer ${NEW}`);
    const all = await readable(c);
    expect(all).not.toContain(EXPIRED);
    expect(all).not.toContain(NEW);
  });

  it("a token that can't see the repository, a rate limit and a refusal each say what to do", async () => {
    const c = (ctx = await setup());
    await c.addToken(GOOD);
    // GitHub answers 404, not 403, to a valid token without access to a private repository.
    const missing = await c.addLink("https://github.com/acme/nothing-here");
    expect(missing.statusCode).toBe(404);
    expect(missing.json().message).toContain("git token can't read that repository");

    c.gh.setMode("ratelimit");
    const limited = await c.addLink("https://github.com/acme/open");
    expect(limited.statusCode).toBe(429);
    expect(limited.json().message).toContain("rate-limiting");

    c.gh.setMode("forbidden");
    const refused = await c.addLink("https://github.com/acme/open");
    expect(refused.statusCode).toBe(400);
    expect(refused.json().message).toContain("Contents: Read-only");
    for (const r of [missing, limited, refused]) expect(r.body).not.toContain(GOOD);
  });

  it("check for updates on an installed private-repo skill reads it with the token", async () => {
    const c = (ctx = await setup());
    const { secretId } = await c.addToken(GOOD);
    expect((await c.addLink("https://github.com/acme/secret")).statusCode).toBe(201);
    const [row] = await c.db.select().from(skills).where(eq(skills.name, "tidy"));
    c.gh.repos.secret!.commit = "c".repeat(40);
    c.gh.repos.secret!.files["tidy/SKILL.md"] = md("tidy") + "\nMore steps.";
    const refresh = await c.req("POST", `/api/companies/${c.company.id}/skills/${row!.id}/refresh`);
    expect(refresh.statusCode).toBe(200);
    expect(refresh.json().changed).toBe(true);

    // Expired since: the update check says to rotate the token, and never shows it.
    await c.req("PUT", `/api/secrets/${secretId}/value`, { value: EXPIRED, acceptUnusualFormat: true });
    c.gh.repos.secret!.commit = "d".repeat(40);
    const stale = await c.req("POST", `/api/companies/${c.company.id}/skills/${row!.id}/refresh`);
    expect(stale.statusCode).toBe(404);
    expect(stale.json().message).toContain("Settings → Secrets");
    expect(stale.body).not.toContain(EXPIRED);
  });

  it("owner away: the CEO proposes a private-repo skill with the company token; an agent kept from GIT_TOKEN can't", async () => {
    const c = (ctx = await setup());
    const { grantId } = await c.addToken(GOOD);
    const ceo = await c.mcp(c.ceo.id);
    const ok = await ceo.callTool({ name: "skills", arguments: { action: "propose", url: "https://github.com/acme/secret", why: "Our house style.", agents: ["Engineer"] } });
    expect(txt(ok)).toContain("Proposed tidy");

    // The owner limits the token to the Engineer only: the CEO's run no longer gets it, so the server won't read for it either.
    expect(await c.secrets.setGrantAgents(grantId, [c.worker.id])).toEqual({ ok: true });
    const refused = await ceo.callTool({ name: "skills", arguments: { action: "propose", url: "https://github.com/acme/secret/tree/main/tidy", why: "Again.", agents: ["Engineer"] } });
    expect(txt(refused)).toContain("Settings → Secrets");
    expect(txt(refused)).not.toContain(GOOD);
  });
});
