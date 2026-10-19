// Skills (R71): a company library of Agent Skills folders — a SKILL.md with name and
// description frontmatter, plus any supporting files — that agents load when relevant. A
// skill comes from a GitHub link (pinned to the commit it was read at), is written in Boss
// Man, or is uploaded. The owner gives skills to agents, and so can the CEO.
// Format: https://code.claude.com/docs/en/skills and https://agentskills.io.
import { and, asc, eq, inArray } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { agentSkills, agents, skills } from "../db/schema.js";

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

/** A safe relative path inside the skill folder, or null. */
export function cleanPath(p: string) {
  const parts = p.replace(/\\/g, "/").split("/").filter((x) => x && x !== ".");
  if (!parts.length || parts.some((x) => x === ".." || x.includes("\0"))) return null;
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
const skillNameOf = (f: { folder: string; files: SkillFile[] }) => skillName(parseSkillMd(Buffer.from(f.files.find((x) => x.path === "SKILL.md")!.content, "base64").toString("utf8")).name ?? f.folder);

export function skillsService(db: Db, deps: { fetch?: typeof fetch } = {}) {
  const get = deps.fetch ?? fetch;

  async function fetchOk(url: string, as: "json" | "bytes") {
    let res: Response;
    try {
      res = await get(url, { headers: { "user-agent": "Boss-Man", accept: as === "json" ? "application/vnd.github+json" : "*/*" }, signal: AbortSignal.timeout(20_000) });
    } catch {
      throw new SkillError(502, `Couldn't reach ${new URL(url).host}.`);
    }
    if (res.status === 404) throw new SkillError(404, "Nothing found at that link. Private repositories aren't supported yet; check the link is public.");
    if (res.status === 403 || res.status === 429) throw new SkillError(429, "GitHub is rate-limiting requests from this server. Try again in an hour.");
    if (!res.ok) throw new SkillError(502, `${new URL(url).host} answered ${res.status}.`);
    return as === "json" ? ((await res.json()) as unknown) : Buffer.from(await res.arrayBuffer());
  }

  async function save(companyId: string, input: { files: SkillFile[]; source: "written" | "link" | "upload"; sourceUrl?: string | null; sourceRef?: string | null; name?: string | null; replaceId?: string | null; pack?: string | null; packUrl?: string | null }) {
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
  async function readGitHub(url: string) {
    const gh = parseGitHub(url);
    if (!gh) return null;
    const api = `https://api.github.com/repos/${gh.owner}/${gh.repo}`;
    const ref = gh.ref ?? ((await fetchOk(api, "json")) as { default_branch: string }).default_branch;
    const commit = ((await fetchOk(`${api}/commits/${encodeURIComponent(ref)}`, "json")) as { sha: string }).sha;
    const tree = (await fetchOk(`${api}/git/trees/${commit}?recursive=1`, "json")) as { tree: Array<{ path: string; type: string; size?: number }>; truncated?: boolean };
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
        const batch = await Promise.all(blobs.slice(i, i + 8).map((b) => fetchOk(`https://raw.githubusercontent.com/${gh.owner}/${gh.repo}/${commit}/${b.path.split("/").map(encodeURIComponent).join("/")}`, "bytes") as Promise<Buffer>));
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

  return {
    async list(companyId: string) {
      const rows = await db
        .select({ id: skills.id, name: skills.name, description: skills.description, source: skills.source, sourceUrl: skills.sourceUrl, sourceRef: skills.sourceRef, pack: skills.pack, packUrl: skills.packUrl, sizeBytes: skills.sizeBytes, files: skills.files, updatedAt: skills.updatedAt })
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
      return rows.map(({ files, ...r }) => ({ ...r, fileCount: files.length, agents: held.filter((h) => h.skillId === r.id).map((h) => ({ id: h.agentId, name: h.agent })) }));
    },

    /** One skill with its files; text files are decoded for reading. */
    async get(companyId: string, id: string) {
      const [s] = await db.select().from(skills).where(and(eq(skills.id, id), eq(skills.companyId, companyId)));
      if (!s) throw new SkillError(404, "No such skill.");
      const held = await db.select({ id: agents.id, name: agents.name }).from(agentSkills).innerJoin(agents, eq(agents.id, agentSkills.agentId)).where(eq(agentSkills.skillId, id));
      return {
        ...s,
        agents: held,
        files: s.files.map((f) => {
          const bytes = unb64(f.content);
          const text = bytes.includes(0) ? null : bytes.toString("utf8");
          return { path: f.path, size: bytes.length, text };
        }),
      };
    },

    /** A skill written in Boss Man: its SKILL.md is built from the form. */
    async write(companyId: string, input: { name: string; description: string; body: string; replaceId?: string | null }) {
      const name = skillName(input.name);
      const md = `---\nname: ${name}\ndescription: ${JSON.stringify(input.description.trim().replace(/\s+/g, " "))}\n---\n\n${input.body.trim()}\n`;
      return save(companyId, { files: [{ path: "SKILL.md", content: b64(md) }], source: "written", name, replaceId: input.replaceId });
    },

    async upload(companyId: string, files: SkillFile[], name?: string | null) {
      return save(companyId, { files, source: "upload", name });
    },

    /** Adds every skill under a GitHub link (or a link straight to one SKILL.md file). */
    async fromLink(companyId: string, url: string) {
      if (!/^https:\/\//.test(url)) throw new SkillError(400, "Give an https link to a GitHub repository, folder or SKILL.md.");
      const gh = await readGitHub(url);
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
      const bytes = (await fetchOk(url, "bytes")) as Buffer;
      return [await save(companyId, { files: [{ path: "SKILL.md", content: bytes.toString("base64") }], source: "link", sourceUrl: url })];
    },

    /** Reads a linked skill again at its link's latest commit. */
    async refresh(companyId: string, id: string) {
      const [s] = await db.select().from(skills).where(and(eq(skills.id, id), eq(skills.companyId, companyId)));
      if (!s?.sourceUrl) throw new SkillError(409, "Only a skill added from a link can be checked for updates.");
      const gh = await readGitHub(s.sourceUrl);
      if (!gh) {
        const bytes = (await fetchOk(s.sourceUrl, "bytes")) as Buffer;
        return { skill: await save(companyId, { files: [{ path: "SKILL.md", content: bytes.toString("base64") }], source: "link", sourceUrl: s.sourceUrl, name: s.name, replaceId: s.id }), changed: true };
      }
      if (gh.commit === s.sourceRef) return { skill: s, changed: false };
      const f = gh.found.length === 1 ? gh.found[0]! : gh.found.find((x) => x.folder === s.name);
      if (!f) throw new SkillError(404, "The skill is no longer at its link.");
      return { skill: await save(companyId, { files: f.files, source: "link", sourceUrl: s.sourceUrl, sourceRef: gh.commit, name: s.name, replaceId: s.id }), changed: true };
    },

    async remove(companyId: string, id: string) {
      const rows = await db.delete(skills).where(and(eq(skills.id, id), eq(skills.companyId, companyId))).returning({ id: skills.id });
      if (!rows.length) throw new SkillError(404, "No such skill.");
    },

    /** Sets exactly which agents of the company have a skill. */
    /** Reads a pack's link again: changed skills are updated, new ones added; gone ones are listed. */
    async refreshPack(companyId: string, pack: string) {
      const rows = await db.select().from(skills).where(and(eq(skills.companyId, companyId), eq(skills.pack, pack)));
      const url = rows.find((r) => r.packUrl)?.packUrl;
      if (!url) throw new SkillError(404, "No such pack.");
      const gh = await readGitHub(url);
      if (!gh) throw new SkillError(409, "That pack's link no longer points at GitHub.");
      if (rows.every((r) => r.sourceRef === gh.commit)) return { changed: 0, added: [] as string[], gone: [] as string[] };
      const byName = new Map(rows.map((r) => [r.name, r]));
      let changed = 0;
      const added: string[] = [];
      for (const f of gh.found) {
        const name = skillNameOf(f);
        const had = byName.get(name);
        const before = had ? JSON.stringify(had.files) : null;
        const saved = await save(companyId, { files: f.files, source: "link", sourceUrl: f.url, sourceRef: gh.commit, name, replaceId: had?.id ?? null, pack, packUrl: url });
        if (!had) added.push(saved.name);
        else if (JSON.stringify(saved.files) !== before) changed++;
      }
      const found = new Set(gh.found.map(skillNameOf));
      return { changed, added, gone: rows.filter((r) => !found.has(r.name)).map((r) => r.name) };
    },

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
export async function skillsForRun(db: Db, agentId: string) {
  return db
    .select({ name: skills.name, files: skills.files })
    .from(agentSkills)
    .innerJoin(skills, eq(skills.id, agentSkills.skillId))
    .where(eq(agentSkills.agentId, agentId))
    .orderBy(asc(skills.name));
}
