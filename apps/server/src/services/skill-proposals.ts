// Skill proposals (BOS-86): the CEO proposes a skill (its own draft, or an internet link); the
// Security Reviewer checks it where the owner's rule requires; the owner decides every one.
// Nothing here writes to `skills`: only the install step (below, once decided) does.
import { createHash } from "node:crypto";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { agents, skillProposals, skills } from "../db/schema.js";
import { record } from "./activity.js";
import { normalise, parseSkillMd, skillName, skillNameOf, SkillError, type SkillFile, type skillsService } from "./skills.js";

type SkillsSvc = ReturnType<typeof skillsService>;

const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

/** sha256 of each file's bytes, and of the whole set (paths and file hashes, sorted by path). */
export function hashFiles(files: SkillFile[]) {
  const fileHashes: Record<string, string> = {};
  for (const f of files) fileHashes[f.path] = sha256(Buffer.from(f.content, "base64"));
  const bundleHash = sha256(
    Object.keys(fileHashes)
      .sort()
      .map((p) => `${p}\0${fileHashes[p]}\n`)
      .join(""),
  );
  return { fileHashes, bundleHash };
}

// What "contains a script" means (BOS-87 standard, section 1). The system decides, not the CEO.
const SCRIPT_EXT = /\.(sh|bash|zsh|py|js|mjs|cjs|ts|rb|ps1|bat|cmd|pl|php)$/i;
const SCRIPT_NAME = /(^|\/)(Makefile|Dockerfile)$/i;
const SCRIPT_DIR = /(^|\/)scripts\//i;
const TEXT_DOC = /\.(md|markdown|txt)$/i;
// A fenced block in the instructions in a language an agent can run.
const RUN_LANG = /^(sh|bash|zsh|shell|console|terminal|cmd|bat|powershell|ps1|pwsh|python|python3|py|js|javascript|node|ts|typescript|ruby|rb|perl|php)$/i;
const RUN_CUE = /\b(run|runs|running|execute|executes|executing|invoke|call|launch|exec)\b/i;

/** Compiled programs (ELF, Mach-O, Windows) count as scripts: they run with the agent's rights too. */
const isBinaryProgram = (b: Buffer) =>
  (b.length > 3 && b[0] === 0x7f && b[1] === 0x45 && b[2] === 0x4c && b[3] === 0x46) ||
  (b.length > 1 && b[0] === 0x4d && b[1] === 0x5a) ||
  (b.length > 3 && [0xfeedface, 0xfeedfacf, 0xcafebabe, 0xcefaedfe, 0xcffaedfe].includes(b.readUInt32BE(0)));

/** The files that make a skill "contain a script": executable or interpreted files, and instruction files with a code block the agent is told to run. */
export function scriptFilesOf(files: SkillFile[]): string[] {
  const found: string[] = [];
  for (const f of files) {
    const bytes = Buffer.from(f.content, "base64");
    if (SCRIPT_EXT.test(f.path) || SCRIPT_NAME.test(f.path) || SCRIPT_DIR.test(f.path) || bytes.subarray(0, 2).toString("latin1") === "#!" || isBinaryProgram(bytes)) {
      found.push(f.path);
      continue;
    }
    if (!TEXT_DOC.test(f.path) || bytes.includes(0)) continue;
    const lines = bytes.toString("utf8").split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const m = /^\s*(```+|~~~+)\s*([\w+-]*)/.exec(lines[i]!);
      if (!m) continue;
      // Only an opening fence: skip to the closing one afterwards.
      const tagged = m[2]!;
      const before = lines.slice(Math.max(0, i - 3), i).join(" ");
      if ((tagged && RUN_LANG.test(tagged)) || (!tagged && RUN_CUE.test(before))) {
        found.push(f.path);
        break;
      }
      const close = lines.findIndex((l, k) => k > i && l.trim().startsWith(m[1]!));
      if (close < 0) break;
      i = close;
    }
  }
  return found;
}

/** The owner's rule (2026-10-27): internet skills are always reviewed; a CEO draft only if it has a script. */
export const reviewRequired = (source: "draft" | "link", hasScripts: boolean) => source === "link" || hasScripts;

export type ProposeInput = {
  companyId: string;
  byAgentId: string | null;
  why: string;
  agentIds: string[];
} & ({ source: "draft"; files: SkillFile[]; name?: string | null } | { source: "link"; url: string; skill?: string | null });

export function skillProposalsService(db: Db, skillsSvc: SkillsSvc) {
  /** Looks the skill up in the library for update proposals. */
  async function existing(companyId: string, name: string) {
    const [s] = await db.select({ id: skills.id, files: skills.files }).from(skills).where(and(eq(skills.companyId, companyId), eq(skills.name, name)));
    return s ?? null;
  }

  return {
    /** Records a proposal. Fetches and pins a link, hashes every file, works out whether it has scripts. */
    async propose(input: ProposeInput) {
      const why = input.why.trim();
      if (!why) throw new SkillError(400, "Say why you want this skill: the owner reads it when deciding.");
      const agentIds = [...new Set(input.agentIds)];
      if (!agentIds.length) throw new SkillError(400, "Name the agents who would get this skill.");
      const team = await db.select({ id: agents.id }).from(agents).where(and(eq(agents.companyId, input.companyId), inArray(agents.id, agentIds)));
      if (team.length !== agentIds.length) throw new SkillError(400, "Every agent must be in this company.");

      let files: SkillFile[];
      let sourceUrl: string | null = null;
      let pinnedRef: string | null = null;
      let name: string;
      if (input.source === "draft") {
        files = normalise(input.files).files;
        const md = parseSkillMd(Buffer.from(files[0]!.content, "base64").toString("utf8"));
        name = skillName(input.name ?? md.name ?? "");
        if (!md.description) throw new SkillError(400, "SKILL.md needs a description saying what the skill does and when to use it.");
      } else {
        if (!/^https:\/\//.test(input.url)) throw new SkillError(400, "Give an https link to a GitHub repository, folder or SKILL.md.");
        const gh = await skillsSvc.readGitHub(input.url);
        if (gh) {
          const picked = input.skill ? gh.found.filter((f) => skillNameOf(f) === skillName(input.skill!)) : gh.found;
          if (picked.length !== 1) throw new SkillError(400, picked.length ? `That link holds ${picked.length} skills; propose one at a time, naming it (${picked.map(skillNameOf).join(", ")}).` : `No skill called ${input.skill} at that link.`);
          files = normalise(picked[0]!.files).files;
          name = skillNameOf({ folder: picked[0]!.folder, files });
          sourceUrl = picked[0]!.url;
          pinnedRef = gh.commit;
        } else {
          // A link straight to one SKILL.md file: nothing to pin but the bytes, which are hashed.
          const bytes = await skillsSvc.fetchBytes(input.url);
          files = normalise([{ path: "SKILL.md", content: bytes.toString("base64") }]).files;
          name = skillName(parseSkillMd(bytes.toString("utf8")).name ?? "");
          sourceUrl = input.url;
        }
      }
      if (!name || (input.source === "draft" && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name))) throw new SkillError(400, "A skill needs a name: lower-case letters, digits and hyphens.");

      const had = await existing(input.companyId, name);
      const { fileHashes, bundleHash } = hashFiles(files);
      if (had && hashFiles(had.files).bundleHash === bundleHash) throw new SkillError(409, `${name} is already in the library with these exact files.`);
      const scripts = scriptFilesOf(files);
      const hasScripts = scripts.length > 0;
      const needsReview = reviewRequired(input.source, hasScripts);

      let row;
      try {
        [row] = await db
          .insert(skillProposals)
          .values({
            companyId: input.companyId,
            name,
            source: input.source,
            sourceUrl,
            pinnedRef,
            files,
            fileHashes,
            bundleHash,
            why,
            proposedAgentIds: agentIds,
            proposedByAgentId: input.byAgentId,
            replacesSkillId: had?.id ?? null,
            hasScripts,
            scriptFiles: scripts,
            reviewRequired: needsReview,
          })
          .returning();
      } catch (e) {
        const cause = (e as { cause?: { code?: string; message?: string } }).cause;
        if (cause?.code === "23505" || /skill_proposals_open_name/.test(String(cause?.message ?? (e as Error).message))) throw new SkillError(409, `There's already an open proposal for ${name}; wait for the decision or ask the owner to reject it.`);
        throw e;
      }
      const p = row!;
      await record(db, {
        companyId: input.companyId,
        kind: "skill.proposed",
        agentId: input.byAgentId,
        summary: `Proposed ${had ? "a new version of" : "adding"} the skill ${name} (${input.source === "link" ? `from ${sourceUrl}${pinnedRef ? ` at ${pinnedRef.slice(0, 7)}` : ""}` : "CEO draft"}, ${files.length} file${files.length === 1 ? "" : "s"}). ${
          needsReview ? (input.source === "link" ? "Security review required: it comes from the internet." : `Security review required: the draft contains a script (${scripts.slice(0, 3).join(", ")}${scripts.length > 3 ? ", …" : ""}).`) : "No security review needed: CEO draft with no scripts."
        }`,
      });
      return p;
    },

    async get(companyId: string, id: string) {
      const [p] = await db.select().from(skillProposals).where(and(eq(skillProposals.id, id), eq(skillProposals.companyId, companyId)));
      if (!p) throw new SkillError(404, "No such proposal.");
      return p;
    },

    /** Proposals without the file bytes, newest first. */
    async list(companyId: string) {
      const rows = await db.select().from(skillProposals).where(eq(skillProposals.companyId, companyId)).orderBy(desc(skillProposals.createdAt));
      return rows.map(({ files, ...p }) => ({ ...p, fileCount: files.length }));
    },
  };
}
