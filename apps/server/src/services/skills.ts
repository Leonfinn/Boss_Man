// Skills (R71): a company library of Agent Skills folders — a SKILL.md with name and
// description frontmatter, plus any supporting files — that agents load when relevant. A
// skill comes from a GitHub link (pinned to the commit it was read at), is written in Boss
// Man, or is uploaded. The owner gives skills to agents, and so can the CEO.
// Format: https://code.claude.com/docs/en/skills and https://agentskills.io.
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { and, asc, eq, ilike, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { addonById, isPrivateAddress, missingAddons, type AddonReport } from "@boss-man/shared";
import type { Db } from "../db/client.js";
import { hashFiles, scriptFilesOf, sha256 } from "./skill-files.js";
import { agentSkills, agents, companies, skillProposals, skills } from "../db/schema.js";
import { BUILTIN_SKILLS, builtinSkill, type BuiltinSkill } from "./builtin-skills.js";

// Per skill, and per agent: a run carries its agent's skills in one message to the runner.
// Skills may ship many example assets (e.g. cathrynlavery/diagram-design has 200+), so the caps are generous.
export const LIMITS = { files: 1000, bytes: 16 * 1024 * 1024, skillsPerLink: 50, perAgentBytes: 40 * 1024 * 1024 };
const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export class SkillError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export type SkillFile = { path: string; content: string };

/** "My Great Skill!" → "my-great-skill", at most 64 characters. */
export function skillName(s: string) {
  return (
    s
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9\s-]/g, "")
      .replace(/[\s_-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64)
      .replace(/-+$/, "") || "skill"
  );
}

/** The SKILL.md a written skill is built from: the form's name and description replace any frontmatter in the body. */
export function skillMarkdown(input: { name: string; description: string; body: string }) {
  const name = skillName(input.name);
  const body = input.body.trim().replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trim();
  return `---\nname: ${name}\ndescription: ${JSON.stringify(input.description.trim().replace(/\s+/g, " "))}\n---\n\n${body}\n`;
}

/** The name and description from a SKILL.md's frontmatter, and the text after it. */
export function parseSkillMd(text: string): { name: string | null; description: string | null; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text.replace(/^﻿/, ""));
  // Without frontmatter, Claude Code takes the first non-empty line as the description.
  if (!m) return { name: null, description: text.split(/\r?\n/).find((l) => l.trim() && !l.startsWith("#"))?.trim() ?? null, body: text };
  const fields: Record<string, string> = {};
  const lines = m[1]!.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(lines[i]!);
    if (!kv) continue;
    let value = kv[2]!.trim();
    // A folded or literal block (">" or "|") continues on the indented lines below.
    if (/^[>|][+-]?$/.test(value)) {
      const block: string[] = [];
      while (i + 1 < lines.length && (/^\s+\S/.test(lines[i + 1]!) || lines[i + 1] === "")) block.push(lines[++i]!.trim());
      value = value.startsWith(">") ? block.join(" ").replace(/\s+/g, " ").trim() : block.join("\n").trim();
    } else if (/^(["']).*\1$/.test(value)) {
      value = value.slice(1, -1);
    }
    fields[kv[1]!] = value;
  }
  const first = m[2]!.split(/\r?\n/).find((l) => l.trim() && !l.startsWith("#"));
  return { name: fields.name ?? null, description: fields.description ?? first?.trim() ?? null, body: m[2]! };
}

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");
const unb64 = (s: string) => Buffer.from(s, "base64");

export type SkillInstructions = { path: string | null; body: string | null; empty: boolean; unreadable: boolean };

/**
 * The instructions an agent loads: the body of SKILL.md, after its frontmatter. A skill whose
 * SKILL.md has no body does nothing when loaded, so the page marks it instead of showing an
 * empty editor. The name lookup tolerates a legacy lower-case path; every new skill is SKILL.md.
 */
export function skillInstructions(files: SkillFile[]): SkillInstructions {
  const main = files.find((f) => f.path === "SKILL.md") ?? files.find((f) => f.path.toLowerCase() === "skill.md");
  if (!main) return { path: null, body: null, empty: true, unreadable: false };
  const bytes = unb64(main.content);
  // A NUL byte means the file isn't text: never show (or overwrite) it as an empty body.
  if (bytes.includes(0)) return { path: main.path, body: null, empty: true, unreadable: true };
  const body = parseSkillMd(bytes.toString("utf8")).body.trim();
  return { path: main.path, body, empty: !body, unreadable: false };
}

/** A safe relative path inside the skill folder, or null. */
export function cleanPath(p: string) {
  // Only printable ASCII: no control characters (a newline in a name would write lines into the review task),
  // no lookalike letters or spaces that aren't ordinary ones. Simpler than guessing which non-ASCII is safe.
  if (/[^\x20-\x7e]/.test(p)) return null;
  const parts = p.replace(/\\/g, "/").split("/").filter((x) => x && x !== ".");
  if (!parts.length || parts.some((x) => x === ".." || x.includes("\0") || x !== x.trim())) return null;
  return parts.join("/");
}

/**
 * Checks a folder's files and finds its SKILL.md. Files may sit under one top folder (as a
 * zip or a dropped folder gives them); that folder becomes the default name.
 */
export function normalise(files: SkillFile[]): { files: SkillFile[]; folder: string | null; bytes: number } {
  if (!files.length) throw new SkillError(400, "There are no files.");
  if (files.length > LIMITS.files) throw new SkillError(400, `A skill can have at most ${LIMITS.files} files.`);
  const clean = files.map((f) => {
    const path = cleanPath(f.path);
    if (!path) throw new SkillError(400, `"${f.path}" isn't a path inside the skill's folder.`);
    return { path, content: f.content };
  });
  let folder: string | null = null;
  if (!clean.some((f) => f.path === "SKILL.md")) {
    const tops = new Set(clean.map((f) => f.path.split("/")[0]));
    const [top] = [...tops];
    if (tops.size === 1 && clean.some((f) => f.path === `${top}/SKILL.md`)) {
      folder = top!;
      for (const f of clean) f.path = f.path.slice(top!.length + 1);
    } else {
      throw new SkillError(400, "A skill needs a SKILL.md at the top of its folder.");
    }
  }
  // not state: a local used only while checking this one folder, discarded when it returns.
  const seen = new Set<string>();
  for (const f of clean) {
    const key = f.path.toLowerCase();
    if (seen.has(key)) throw new SkillError(400, `"${f.path}" appears more than once in the skill. Each file may be listed once.`);
    seen.add(key);
  }
  const bytes = clean.reduce((n, f) => n + unb64(f.content).length, 0);
  if (bytes > LIMITS.bytes) throw new SkillError(400, `A skill can be at most ${LIMITS.bytes / 1024 / 1024} MB.`);
  clean.sort((a, b) => (a.path === "SKILL.md" ? -1 : b.path === "SKILL.md" ? 1 : a.path.localeCompare(b.path)));
  return { files: clean, folder, bytes };
}

/** github.com/<owner>/<repo>[/tree|blob/<ref>/<path>], with the ref taken as one segment. */
export function parseGitHub(url: string): { owner: string; repo: string; ref: string | null; path: string } | null {
  const m = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:\/(?:tree|blob)\/([^/]+)((?:\/[^?#]*)?))?\/?(?:[?#].*)?$/.exec(url.trim());
  if (!m) return null;
  let path = (m[4] ?? "").replace(/^\/+|\/+$/g, "");
  if (path.endsWith("SKILL.md")) path = path.slice(0, -"SKILL.md".length).replace(/\/+$/, "");
  return { owner: m[1]!, repo: m[2]!, ref: m[3] ?? null, path };
}

/** The name a fetched skill will have: its frontmatter name, else its folder. */
export const skillNameOf = (f: { folder: string; files: SkillFile[] }) => skillName(parseSkillMd(Buffer.from(f.files.find((x) => x.path === "SKILL.md")!.content, "base64").toString("utf8")).name ?? f.folder);

const realLookup = async (host: string) => (await dnsLookup(host, { all: true })).map((a) => a.address);

/** The only hosts the company's git token is ever sent to (BOS-1891), matched exactly per request, so a redirect elsewhere goes without it. */
const TOKEN_HOSTS = new Set(["github.com", "api.github.com", "raw.githubusercontent.com"]);

/** Who a fetch is for: the company whose GIT_TOKEN may be used, and the agent run asking, if any (its per-agent grant limits apply). */
export type FetchScope = { companyId?: string; runId?: string };

/**
 * One import's use of the token, resolved fresh per import (never cached, so a token added or rotated in Settings →
 * Secrets counts on the next import). `refused` is set when GitHub answers 401: the token is dropped for the rest of
 * the import so public links still work, and a later 404 can say the token was the problem.
 */
type Auth = { token: string | null; had: boolean; refused: boolean };

/** How long a source's answer is kept before GitHub is asked again (BOS-2410). */
export const UPSTREAM_TTL_MS = 6 * 60 * 60 * 1000;
export type UpstreamResult = { status: "current" | "unchecked" } | { status: "newer"; commit: string; date: string | null } | { status: "error"; reason: string };

const ADD_TOKEN ="add a git token that can read it: Settings → Secrets, a GIT_TOKEN granted to this company";

// Built-in skills (BOS-2631): Boss Man ships them, so every company's library has them without a
// proposal or a security review (they are reviewed once, as part of Boss Man). A fixed updatedAt
// keeps a redeploy from churning the rows; only a text change replaces one.
const BUILTIN_AT = new Date("2026-11-26T00:00:00.000Z");

/**
 * Adds every built-in skill a company doesn't have yet, and gives each to that company's agents on
 * the matching hire template (the product manager). Never touches a skill already in the library
 * under the same name, so an owner's install or edit wins, and never re-gives one: once the row is
 * there a `take` is final until a CEO gives it again. Safe to call on every list, give and run.
 */
export async function seedBuiltins(db: Db, companyId: string) {
  const have = await db.select({ name: skills.name }).from(skills).where(and(eq(skills.companyId, companyId), inArray(skills.name, BUILTIN_SKILLS.map((s) => s.name))));
  const present = new Set(have.map((r) => r.name));
  const missing = BUILTIN_SKILLS.filter((s) => !present.has(s.name));
  if (!missing.length) return;
  const sizeOf = (s: BuiltinSkill) => s.files.reduce((n, f) => n + Buffer.from(f.content, "base64").length, 0);
  await db
    .insert(skills)
    .values(missing.map((s) => ({ companyId, name: s.name, description: s.description, source: "builtin" as const, files: s.files, sizeBytes: sizeOf(s), updatedAt: BUILTIN_AT })))
    .onConflictDoNothing({ target: [skills.companyId, skills.name] });
  await giveBuiltinsToTemplates(db, companyId, missing.map((s) => s.name));
}

/** Adds one built-in to a company on demand (e.g. a CEO gives it), if it isn't there yet. */
export async function ensureBuiltin(db: Db, companyId: string, name: string) {
  const skill = builtinSkill(name);
  if (!skill) return false;
  const [have] = await db.select({ id: skills.id }).from(skills).where(and(eq(skills.companyId, companyId), eq(skills.name, name)));
  if (have) return true;
  const sizeBytes = skill.files.reduce((n, f) => n + Buffer.from(f.content, "base64").length, 0);
  await db
    .insert(skills)
    .values({ companyId, name: skill.name, description: skill.description, source: "builtin", files: skill.files, sizeBytes, updatedAt: BUILTIN_AT })
    .onConflictDoNothing({ target: [skills.companyId, skills.name] });
  await giveBuiltinsToTemplates(db, companyId, [name]);
  return true;
}

/**
 * Gives the named built-ins to each agent on the matching hire template. Only seeded built-ins reach
 * here, so a skill an agent was told to drop (take()) is not re-given: its row already existed.
 */
async function giveBuiltinsToTemplates(db: Db, companyId: string, names: string[]) {
  for (const name of names) {
    const skill = builtinSkill(name);
    if (!skill?.template) continue;
    const [row] = await db.select({ id: skills.id }).from(skills).where(and(eq(skills.companyId, companyId), eq(skills.name, name)));
    if (!row) continue;
    const holders = await db.select({ id: agents.id }).from(agents).where(and(eq(agents.companyId, companyId), eq(agents.template, skill.template), isNull(agents.retiredAt)));
    for (const a of holders) await db.insert(agentSkills).values({ agentId: a.id, skillId: row.id, assignedByAgentId: null }).onConflictDoNothing();
  }
}

export function skillsService(db: Db, deps: { fetch?: typeof fetch; lookup?: (host: string) => Promise<string[]>; gitToken?: (companyId: string, runId?: string) => Promise<string | undefined> } = {}) {
  const get = deps.fetch ?? fetch;

  /** `url`: a link to another host doesn't read the secret at all (each read is an entry in the secrets' access log). */
  async function authFor(scope: FetchScope | undefined, url?: string): Promise<Auth> {
    const forGitHub = url === undefined || TOKEN_HOSTS.has(URL.canParse(url) ? new URL(url).hostname : "");
    const token = forGitHub && scope?.companyId && deps.gitToken ? ((await deps.gitToken(scope.companyId, scope.runId)) ?? null) : null;
    return { token, had: !!token, refused: false };
  }
  // A test that injects its own fetch never touches the network, so it needs no real DNS; production resolves every host.
  const lookup = deps.lookup ?? (deps.fetch ? undefined : realLookup);

  /** True for loopback, private, link-local and other addresses a public skill link has no business on. */
  async function privateHost(host: string) {
    const h = host.replace(/^\[|\]$/g, "");
    const addrs = isIP(h) ? [h] : lookup ? await lookup(h) : [];
    return addrs.some(isPrivateAddress);
  }

  /** Fetches an https address: no private hosts (also after each redirect), redirects followed by hand, and the body read with a cap. */
  async function fetchOk(url: string, as: "json" | "bytes", maxBytes = LIMITS.bytes, auth?: Auth) {
    let res: Response | undefined;
    let at = url;
    for (let hop = 0; hop <= 5; hop++) {
      const u = new URL(at);
      if (u.protocol !== "https:") throw new SkillError(400, "Only https links are supported.");
      if (await privateHost(u.hostname).catch(() => true)) throw new SkillError(400, `${u.host} isn't a public address; skill links must point to the public internet.`);
      // Checked on every hop: a redirect to any other host (codeload, a CDN, anyone's server) goes without the token.
      const token = auth?.token && TOKEN_HOSTS.has(u.hostname) && !u.port ? auth.token : null;
      const headers: Record<string, string> = { "user-agent": "Boss-Man", accept: as === "json" ? "application/vnd.github+json" : "*/*", ...(token ? { authorization: `Bearer ${token}` } : {}) };
      try {
        res = await get(at, { headers, signal: AbortSignal.timeout(20_000), redirect: "manual" });
      } catch {
        throw new SkillError(502, `Couldn't reach ${u.host}.`);
      }
      if (token && res.status === 401) {
        // Expired or revoked: carry on without it (public links keep working); a later 404 says why.
        auth!.token = null;
        auth!.refused = true;
        await res.body?.cancel().catch(() => {});
        res = undefined;
        hop--;
        continue;
      }
      if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
        at = new URL(res.headers.get("location")!, at).toString();
        await res.body?.cancel().catch(() => {});
        res = undefined;
        continue;
      }
      break;
    }
    if (!res) throw new SkillError(502, "Too many redirects.");
    const host = new URL(at).host;
    if (res.status === 404) {
      await res.body?.cancel().catch(() => {});
      if (auth?.refused) throw new SkillError(404, "GitHub refused the company's git token (it may have expired or been revoked), and without it nothing is visible at that link. Replace it: Settings → Secrets, find GIT_TOKEN and press Rotate.");
      if (auth?.token) throw new SkillError(404, "Nothing found at that link, or the company's git token can't read that repository: give the token Contents: Read-only on it (GitHub → Settings → Developer settings → Personal access tokens), or check the link.");
      throw new SkillError(404, `Nothing found at that link. If it's a private repository, ${ADD_TOKEN}.`);
    }
    // GitHub's primary limit is a 403 with x-ratelimit-remaining 0; its secondary limit a 403 or 429 with retry-after.
    if (res.status === 429 || (res.status === 403 && (res.headers.get("x-ratelimit-remaining") === "0" || res.headers.has("retry-after")))) {
      await res.body?.cancel().catch(() => {});
      throw new SkillError(429, `GitHub is rate-limiting requests from this server. Try again in an hour.${auth?.token ? "" : " A git token in Settings → Secrets (GIT_TOKEN) raises GitHub's limit."}`);
    }
    if (res.status === 403) {
      await res.body?.cancel().catch(() => {});
      throw new SkillError(400, auth?.token ? "GitHub won't let the company's git token read that repository: give the token Contents: Read-only on it, or replace it in Settings → Secrets." : `${host} refused the request. If it's a private repository, ${ADD_TOKEN}.`);
    }
    if (!res.ok) throw new SkillError(502, `${host} answered ${res.status}.`);
    const tooBig = new SkillError(400, `That file is over ${Math.round(maxBytes / 1024 / 1024) || maxBytes / 1024 / 1024} MB.`);
    if (Number(res.headers.get("content-length") ?? 0) > maxBytes) throw tooBig;
    const chunks: Buffer[] = [];
    let n = 0;
    if (res.body) {
      for await (const c of res.body as unknown as AsyncIterable<Uint8Array>) {
        n += c.length;
        if (n > maxBytes) {
          await res.body.cancel().catch(() => {});
          throw tooBig;
        }
        chunks.push(Buffer.from(c));
      }
    }
    const body = Buffer.concat(chunks);
    return as === "json" ? (JSON.parse(body.toString("utf8")) as unknown) : body;
  }

  async function save(companyId: string, input: { files: SkillFile[]; source: "written" | "link" | "upload" | "retro"; sourceUrl?: string | null; sourceRef?: string | null; name?: string | null; replaceId?: string | null; pack?: string | null; packUrl?: string | null }) {
    const n = normalise(input.files);
    const md = parseSkillMd(unb64(n.files[0]!.content).toString("utf8"));
    const name = skillName(input.name ?? md.name ?? n.folder ?? "");
    if (!NAME.test(name)) throw new SkillError(400, "A skill's name can only have lower-case letters, digits and hyphens.");
    const description = (md.description ?? "").slice(0, 1024);
    if (!description) throw new SkillError(400, "SKILL.md needs a description saying what the skill does and when to use it.");
    const values = { name, description, source: input.source, sourceUrl: input.sourceUrl ?? null, sourceRef: input.sourceRef ?? null, ...(input.pack !== undefined ? { pack: input.pack, packUrl: input.packUrl ?? null } : {}), files: n.files, sizeBytes: n.bytes, updatedAt: new Date() };
    const [clash] = await db.select({ id: skills.id }).from(skills).where(and(eq(skills.companyId, companyId), eq(skills.name, name)));
    if (clash && clash.id !== input.replaceId) throw new SkillError(409, `There's already a skill called ${name}.`);
    if (input.replaceId) {
      const [s] = await db.update(skills).set(values).where(and(eq(skills.id, input.replaceId), eq(skills.companyId, companyId))).returning();
      if (!s) throw new SkillError(404, "No such skill.");
      return s;
    }
    const [s] = await db.insert(skills).values({ companyId, ...values }).returning();
    return s!;
  }

  /** Reads every skill under a GitHub link, pinned to the commit the link points at now. */
  async function readGitHub(url: string, at?: string, scope?: FetchScope) {
    const gh = parseGitHub(url);
    if (!gh) return null;
    const auth = await authFor(scope);
    const api = `https://api.github.com/repos/${gh.owner}/${gh.repo}`;
    const ref = gh.ref ?? ((await fetchOk(api, "json", LIMITS.bytes, auth)) as { default_branch: string }).default_branch;
    const commit = at ?? ((await fetchOk(`${api}/commits/${encodeURIComponent(ref)}`, "json", LIMITS.bytes, auth)) as { sha: string }).sha;
    const tree = (await fetchOk(`${api}/git/trees/${commit}?recursive=1`, "json", LIMITS.bytes, auth)) as { tree: Array<{ path: string; type: string; size?: number }>; truncated?: boolean };
    const under = (p: string) => !gh.path || p === gh.path || p.startsWith(`${gh.path}/`);
    const all = tree.tree.filter((e) => e.type === "blob" && (e.path === "SKILL.md" || e.path.endsWith("/SKILL.md"))).map((e) => e.path.slice(0, -"SKILL.md".length).replace(/\/$/, ""));
    const isClaude = (d: string) => /(^|\/)\.claude\/skills\/[^/]+$/.test(d);
    let dirs = all.filter((d) => under(`${d ? `${d}/` : ""}SKILL.md`));
    if (!dirs.length) {
      // Point at where the repository's skills really are, Claude Code's copies first.
      const elsewhere = [...all.filter(isClaude), ...all.filter((d) => !isClaude(d))].slice(0, 5);
      throw new SkillError(
        404,
        elsewhere.length
          ? `There's no SKILL.md ${gh.path ? `in ${gh.path}/` : "in that repository"}. This repository has skills in: ${elsewhere.map((d) => d || "the top folder").join(", ")}. Link to one of those, e.g. https://github.com/${gh.owner}/${gh.repo}/tree/${ref}/${elsewhere[0]}`
          : "There's no SKILL.md in that repository.",
      );
    }
    // Repositories that ship a copy of each skill per tool (.claude, .cursor, .codex, …): take
    // Claude Code's copies when there are any, and one skill per folder name.
    const claude = dirs.filter(isClaude);
    if (claude.length && claude.length < dirs.length) dirs = claude;
    const seen = new Set<string>();
    dirs = dirs.filter((d) => {
      const name = d.split("/").at(-1) || gh.repo;
      return seen.has(name) ? false : (seen.add(name), true);
    });
    if (dirs.length > LIMITS.skillsPerLink) throw new SkillError(400, `That link holds ${dirs.length} skills; link to a folder with at most ${LIMITS.skillsPerLink}.`);
    const found: Array<{ folder: string; files: SkillFile[]; url: string }> = [];
    for (const dir of dirs) {
      // A skill's files are everything in its folder, except other skills nested inside it.
      const nested = all.filter((d) => d !== dir && (dir === "" || d.startsWith(`${dir}/`)));
      const blobs = tree.tree.filter((e) => e.type === "blob" && (dir === "" || e.path.startsWith(`${dir}/`)) && !nested.some((d) => e.path.startsWith(`${d}/`)));
      if (blobs.length > LIMITS.files) throw new SkillError(400, `${dir || "That skill"} has ${blobs.length} files; a skill can have at most ${LIMITS.files}.`);
      if (blobs.reduce((n, b) => n + (b.size ?? 0), 0) > LIMITS.bytes) throw new SkillError(400, `${dir || "That skill"} is over ${LIMITS.bytes / 1024 / 1024} MB.`);
      const files: SkillFile[] = [];
      // Eight downloads at a time: big skills have hundreds of files.
      for (let i = 0; i < blobs.length; i += 8) {
        const batch = await Promise.all(blobs.slice(i, i + 8).map((b) => fetchOk(`https://raw.githubusercontent.com/${gh.owner}/${gh.repo}/${commit}/${b.path.split("/").map(encodeURIComponent).join("/")}`, "bytes", LIMITS.bytes, auth) as Promise<Buffer>));
        batch.forEach((bytes, j) => files.push({ path: dir ? blobs[i + j]!.path.slice(dir.length + 1) : blobs[i + j]!.path, content: bytes.toString("base64") }));
      }
      found.push({ folder: dir.split("/").at(-1) || gh.repo, files, url: `https://github.com/${gh.owner}/${gh.repo}/tree/${ref}${dir ? `/${dir}` : ""}` });
    }
    return { commit, found };
  }

  /** Refuses when giving the skill would take an agent over its skills allowance. */
  async function fits(agentIds: string[], skillId: string) {
    const [s] = await db.select({ size: skills.sizeBytes }).from(skills).where(eq(skills.id, skillId));
    for (const agentId of agentIds) {
      const held = await db.select({ size: skills.sizeBytes, id: skills.id }).from(agentSkills).innerJoin(skills, eq(skills.id, agentSkills.skillId)).where(eq(agentSkills.agentId, agentId));
      const total = held.filter((h) => h.id !== skillId).reduce((n, h) => n + h.size, 0) + (s?.size ?? 0);
      if (total > LIMITS.perAgentBytes) throw new SkillError(400, `An agent's skills can be at most ${LIMITS.perAgentBytes / 1024 / 1024} MB in all; take another skill away first.`);
    }
  }

  // lost on restart, harmless because it only means one more GitHub call; no file or row depends on it (BOS-2410).
  const upstreamCache = new Map<string, { at: number; result: UpstreamResult }>();

  /** The latest commit that touched a skill's folder, on the source's branch and as of the pinned commit. Read-only. */
  async function checkUpstream(companyId: string, s: { sourceUrl: string; sourceRef: string }): Promise<UpstreamResult> {
    const gh = parseGitHub(s.sourceUrl);
    if (!gh) return { status: "unchecked" };
    const key = `${companyId}|${s.sourceUrl}|${s.sourceRef}`;
    const hit = upstreamCache.get(key);
    if (hit && Date.now() - hit.at < UPSTREAM_TTL_MS) return hit.result;
    let result: UpstreamResult;
    try {
      const auth = await authFor({ companyId });
      const api = `https://api.github.com/repos/${gh.owner}/${gh.repo}/commits`;
      const last = async (sha: string | null) => {
        const q = `per_page=1${sha ? `&sha=${encodeURIComponent(sha)}` : ""}${gh.path ? `&path=${encodeURIComponent(gh.path)}` : ""}`;
        const rows = (await fetchOk(`${api}?${q}`, "json", LIMITS.bytes, auth)) as Array<{ sha: string; commit?: { committer?: { date?: string }; author?: { date?: string } } }>;
        return rows[0] ?? null;
      };
      const latest = await last(gh.ref);
      if (!latest) throw new SkillError(404, "Nothing found at that link any more.");
      // The pin is the repository's head when the skill was added, so compare the folder's last commit then and now.
      const pinned = latest.sha === s.sourceRef ? latest : await last(s.sourceRef);
      result = pinned && pinned.sha === latest.sha ? { status: "current" } : { status: "newer", commit: latest.sha, date: latest.commit?.committer?.date ?? latest.commit?.author?.date ?? null };
    } catch (e) {
      result = { status: "error", reason: e instanceof SkillError ? e.message : "GitHub didn't answer." };
    }
    upstreamCache.set(key, { at: Date.now(), result });
    return result;
  }

  return {
    /** For each skill added from a GitHub link: has its source moved on? Cached 6 hours per source; one bad source never fails the rest. */
    async upstream(companyId: string): Promise<Record<string, UpstreamResult>> {
      const rows = await db.select({ id: skills.id, sourceUrl: skills.sourceUrl, sourceRef: skills.sourceRef }).from(skills).where(and(eq(skills.companyId, companyId), eq(skills.source, "link")));
      const out: Record<string, UpstreamResult> = {};
      for (const r of rows) if (r.sourceUrl && r.sourceRef && /^[0-9a-f]{40}$/.test(r.sourceRef)) out[r.id] = await checkUpstream(companyId, { sourceUrl: r.sourceUrl, sourceRef: r.sourceRef });
      return out;
    },
    /** For the proposals flow: read a link, optionally at an exact commit (never re-resolving a branch). */
    readGitHub,
    /** For the proposals flow: the bytes at a non-GitHub link. */
    fetchBytes: async (url: string, scope?: FetchScope) => fetchOk(url, "bytes", 1_000_000, await authFor(scope, url)) as Promise<Buffer>,
    save,

    async list(companyId: string) {
      await seedBuiltins(db, companyId);
      const rows = await db
        .select({ id: skills.id, name: skills.name, description: skills.description, source: skills.source, sourceUrl: skills.sourceUrl, sourceRef: skills.sourceRef, pack: skills.pack, packUrl: skills.packUrl, sizeBytes: skills.sizeBytes, files: skills.files, requiresAddons: skills.requiresAddons, updatedAt: skills.updatedAt })
        .from(skills)
        .where(eq(skills.companyId, companyId))
        .orderBy(asc(skills.name));
      const held = rows.length
        ? await db
            .select({ skillId: agentSkills.skillId, agentId: agents.id, agent: agents.name })
            .from(agentSkills)
            .innerJoin(agents, eq(agents.id, agentSkills.agentId))
            .where(inArray(agentSkills.skillId, rows.map((r) => r.id)))
        : [];
      // A skill that came through a proposal was reviewed as the owner's rule requires, but only while
      // its bytes are still the exact bytes that review covered: an edit makes the reviewed mark stale.
      const installed = rows.length
        ? await db
            .select({ skillId: skillProposals.installedSkillId, bundleHash: skillProposals.bundleHash })
            .from(skillProposals)
            .where(inArray(skillProposals.installedSkillId, rows.map((r) => r.id)))
        : [];
      const reviewed = new Set(installed.filter((p) => p.skillId).map((p) => `${p.skillId}\0${p.bundleHash}`));
      return rows.map(({ files, ...r }) => {
        const instructions = skillInstructions(files);
        return { ...r, fileCount: files.length, hasInstructions: !instructions.empty, instructionsPath: instructions.path, instructionsUnreadable: instructions.unreadable, hasScripts: scriptFilesOf(files).length > 0, addedByOwner: !reviewed.has(`${r.id}\0${hashFiles(files).bundleHash}`), agents: held.filter((h) => h.skillId === r.id).map((h) => ({ id: h.agentId, name: h.agent })) };
      });
    },

    /** Skills of the owner's other companies, to add here instead of importing again. */
    async searchElsewhere(companyId: string, q: string) {
      const like = `%${q.trim().replace(/[\\%_]/g, "\\$&")}%`;
      return db
        .select({
          id: skills.id,
          name: skills.name,
          description: skills.description,
          companyName: companies.name,
          requiresAddons: skills.requiresAddons,
          fileCount: sql<number>`jsonb_array_length(${skills.files})::int`,
          hasScripts: sql<boolean>`exists (select 1 from jsonb_array_elements(${skills.files}) f where f->>'path' ~ '(^|/)scripts/|\\.(sh|py|js|mjs|ts|rb|ps1)$')`,
        })
        .from(skills)
        .innerJoin(companies, eq(companies.id, skills.companyId))
        .where(and(ne(skills.companyId, companyId), q.trim() ? or(ilike(skills.name, like), ilike(skills.description, like)) : undefined))
        .orderBy(asc(companies.name), asc(skills.name))
        .limit(50);
    },

    /** Copies a skill from another company: its files and details, not which agents hold it. */
    async copyFrom(companyId: string, skillId: string) {
      const [src] = await db.select().from(skills).where(eq(skills.id, skillId));
      if (!src) throw new SkillError(404, "No such skill.");
      if (src.companyId === companyId) throw new SkillError(400, "That skill is already in this company.");
      const [clash] = await db.select({ id: skills.id }).from(skills).where(and(eq(skills.companyId, companyId), eq(skills.name, src.name)));
      if (clash) throw new SkillError(409, `There's already a skill called ${src.name}.`);
      // Not the pack: the copy is one skill, so a pack's update and give-all don't reach it.
      const { id: _id, companyId: _company, pack: _pack, packUrl: _packUrl, createdAt: _created, ...values } = src;
      const [s] = await db.insert(skills).values({ ...values, companyId, updatedAt: new Date() }).returning({ id: skills.id, name: skills.name });
      return s!;
    },

    /** One skill with its files; text files are decoded for reading. */
    async get(companyId: string, id: string) {
      const [s] = await db.select().from(skills).where(and(eq(skills.id, id), eq(skills.companyId, companyId)));
      if (!s) throw new SkillError(404, "No such skill.");
      const held = await db.select({ id: agents.id, name: agents.name }).from(agentSkills).innerJoin(agents, eq(agents.id, agentSkills.agentId)).where(eq(agentSkills.skillId, id));
      return {
        ...s,
        agents: held,
        // The same fingerprint the reviewed mark and the log use, so a reader can pin exact bytes.
        bundleHash: hashFiles(s.files).bundleHash,
        hasScripts: scriptFilesOf(s.files).length > 0,
        instructions: skillInstructions(s.files),
        files: s.files.map((f) => {
          const bytes = unb64(f.content);
          const text = bytes.includes(0) ? null : bytes.toString("utf8");
          return { path: f.path, size: bytes.length, sha256: sha256(bytes), text };
        }),
      };
    },

    /** The runner add-ons a skill needs (docs/12); only add-ons Boss Man knows. */
    async setRequires(companyId: string, id: string, requires: string[]) {
      const unknown = requires.filter((r) => !addonById(r));
      if (unknown.length) throw new SkillError(400, `Unknown add-on: ${unknown.join(", ")}.`);
      const [s] = await db.update(skills).set({ requiresAddons: requires.length ? [...new Set(requires)] : null }).where(and(eq(skills.id, id), eq(skills.companyId, companyId))).returning({ id: skills.id });
      if (!s) throw new SkillError(404, "No such skill.");
    },

    /** A skill written in Boss Man: its SKILL.md is built from the form. */
    async write(companyId: string, input: { name: string; description: string; body: string; replaceId?: string | null; confirmEmptyBody?: boolean; /** "retro" marks a playbook a workflow retro made. */ source?: "written" | "retro" }) {
      const name = skillName(input.name);
      // An empty editor must never quietly wipe real instructions: the page asks first, then
      // sends confirmEmptyBody, so only an explicit answer replaces a body with nothing.
      if (input.replaceId && !input.body.trim() && !input.confirmEmptyBody) {
        const [old] = await db.select({ files: skills.files }).from(skills).where(and(eq(skills.id, input.replaceId), eq(skills.companyId, companyId)));
        const before = old ? skillInstructions(old.files) : null;
        if (before?.body || before?.unreadable) throw new SkillError(409, "This skill has instructions. Saving an empty Instructions box would delete them; confirm the change to remove them.");
      }
      const md = skillMarkdown(input);
      return save(companyId, { files: [{ path: "SKILL.md", content: b64(md) }], source: input.source ?? "written", name, replaceId: input.replaceId });
    },

    async upload(companyId: string, files: SkillFile[], name?: string | null) {
      return save(companyId, { files, source: "upload", name });
    },

    /** Adds every skill under a GitHub link (or a link straight to one SKILL.md file). */
    async fromLink(companyId: string, url: string) {
      if (!/^https:\/\//.test(url)) throw new SkillError(400, "Give an https link to a GitHub repository, folder or SKILL.md.");
      const gh = await readGitHub(url, undefined, { companyId });
      if (gh) {
        // Several skills from one link are a pack, given and updated together (e.g. obra/superpowers).
        const p = parseGitHub(url)!;
        const pack = gh.found.length > 1 ? `${p.owner}/${p.repo}` : null;
        const [taken] = pack ? await db.select({ id: skills.id }).from(skills).where(and(eq(skills.companyId, companyId), eq(skills.pack, pack))) : [];
        if (taken) throw new SkillError(409, `The ${pack} pack is already in the library; check it for updates instead.`);
        const names = gh.found.map((f) => skillNameOf(f));
        const clashes = names.length ? await db.select({ name: skills.name }).from(skills).where(and(eq(skills.companyId, companyId), inArray(skills.name, names))) : [];
        if (clashes.length) throw new SkillError(409, `There's already a skill called ${clashes.map((c) => c.name).join(", ")}.`);
        const added = [];
        for (const f of gh.found) added.push(await save(companyId, { files: f.files, source: "link", sourceUrl: f.url, sourceRef: gh.commit, name: skillNameOf(f), pack, packUrl: pack ? url : null }));
        return added;
      }
      // Anything else must be a single SKILL.md file.
      const bytes = (await fetchOk(url, "bytes", LIMITS.bytes, await authFor({ companyId }, url))) as Buffer;
      // Nothing versions a plain link, so it is pinned by its content: a later check can tell if it changed.
      return [await save(companyId, { files: [{ path: "SKILL.md", content: bytes.toString("base64") }], source: "link", sourceUrl: url, sourceRef: `sha256:${sha256(bytes)}` })];
    },

    // No refresh here: a new version of a skill goes through a proposal (services/skill-proposals.ts), so it is reviewed and the owner decides.

    async remove(companyId: string, id: string) {
      const [s] = await db.select({ source: skills.source }).from(skills).where(and(eq(skills.id, id), eq(skills.companyId, companyId)));
      if (!s) throw new SkillError(404, "No such skill.");
      if (s.source === "builtin") throw new SkillError(400, "This skill is built in to Boss Man, so it has to stay in the library. To stop an agent using it, take it from that agent instead.");
      await db.delete(skills).where(eq(skills.id, id));
    },

    /** Sets exactly which agents of the company have a skill. */
    /** Sets exactly which agents have every skill in a pack. */
    async setPackHolders(companyId: string, pack: string, agentIds: string[], by: string | null = null) {
      const rows = await db.select({ id: skills.id }).from(skills).where(and(eq(skills.companyId, companyId), eq(skills.pack, pack)));
      if (!rows.length) throw new SkillError(404, "No such pack.");
      for (const r of rows) await this.setHolders(companyId, r.id, agentIds, by);
    },

    async removePack(companyId: string, pack: string) {
      const gone = await db.delete(skills).where(and(eq(skills.companyId, companyId), eq(skills.pack, pack))).returning({ id: skills.id });
      if (!gone.length) throw new SkillError(404, "No such pack.");
    },

    async setHolders(companyId: string, skillId: string, agentIds: string[], by: string | null = null) {
      const [s] = await db.select({ id: skills.id }).from(skills).where(and(eq(skills.id, skillId), eq(skills.companyId, companyId)));
      if (!s) throw new SkillError(404, "No such skill.");
      const team = agentIds.length ? await db.select({ id: agents.id }).from(agents).where(and(eq(agents.companyId, companyId), inArray(agents.id, agentIds))) : [];
      if (team.length !== new Set(agentIds).size) throw new SkillError(400, "Every agent must be in this company.");
      await fits(team.map((a) => a.id), skillId);
      await db.transaction(async (tx) => {
        await tx.delete(agentSkills).where(eq(agentSkills.skillId, skillId));
        if (team.length) await tx.insert(agentSkills).values(team.map((a) => ({ agentId: a.id, skillId, assignedByAgentId: by })));
      });
    },

    async give(companyId: string, skillName_: string, agentId: string, by: string | null) {
      // A pack's name gives every skill in it.
      const inPack = await db.select({ name: skills.name }).from(skills).where(and(eq(skills.companyId, companyId), eq(skills.pack, skillName_)));
      if (inPack.length) {
        for (const p of inPack) await this.give(companyId, p.name, agentId, by);
        return;
      }
      // A built-in is in every company, so giving one never needs a proposal: seed it here if it isn't yet.
      await ensureBuiltin(db, companyId, skillName_);
      const [s] = await db.select({ id: skills.id }).from(skills).where(and(eq(skills.companyId, companyId), eq(skills.name, skillName_)));
      const [a] = await db.select({ id: agents.id }).from(agents).where(and(eq(agents.id, agentId), eq(agents.companyId, companyId)));
      if (!s || !a) throw new SkillError(404, !s ? `No skill called ${skillName_}.` : "No such agent in this company.");
      await fits([agentId], s.id);
      await db.insert(agentSkills).values({ agentId, skillId: s.id, assignedByAgentId: by }).onConflictDoNothing();
    },

    async take(companyId: string, skillName_: string, agentId: string) {
      const inPack = await db.select({ name: skills.name }).from(skills).where(and(eq(skills.companyId, companyId), eq(skills.pack, skillName_)));
      if (inPack.length) {
        for (const p of inPack) await this.take(companyId, p.name, agentId);
        return;
      }
      const [s] = await db.select({ id: skills.id }).from(skills).where(and(eq(skills.companyId, companyId), eq(skills.name, skillName_)));
      if (!s) throw new SkillError(404, `No skill called ${skillName_}.`);
      await db.delete(agentSkills).where(and(eq(agentSkills.agentId, agentId), eq(agentSkills.skillId, s.id)));
    },

  };
}

/** The skills an agent's run loads, as folders of files. */
/** An agent's skills for a run; a skill needing an add-on the runner lacks is held back (docs/12). */
export async function skillsForRun(db: Db, agentId: string, addons: AddonReport[] | null = null) {
  // Seed the company's built-in skills first, so a product manager's first run has them (BOS-2631).
  const [owner] = await db.select({ companyId: agents.companyId }).from(agents).where(eq(agents.id, agentId));
  if (owner) await seedBuiltins(db, owner.companyId);
  const rows = await db
    .select({ name: skills.name, files: skills.files, requiresAddons: skills.requiresAddons })
    .from(agentSkills)
    .innerJoin(skills, eq(skills.id, agentSkills.skillId))
    .where(eq(agentSkills.agentId, agentId))
    .orderBy(asc(skills.name));
  const give: Array<{ name: string; files: SkillFile[] }> = [];
  const withheld: Array<{ name: string; missing: string[] }> = [];
  for (const { requiresAddons, ...s } of rows) {
    const missing = missingAddons(requiresAddons, addons);
    if (missing.length) withheld.push({ name: s.name, missing });
    else give.push(s);
  }
  return { give, withheld };
}
