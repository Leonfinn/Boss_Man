// Skill proposals (BOS-86): the CEO proposes a skill (its own draft, or an internet link); the
// Security Reviewer checks it where the owner's rule requires; the owner decides every one.
// Nothing here writes to `skills`: only the install step (below, once decided) does.
import { createHash } from "node:crypto";
import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { agents, projects, skillProposals, skills, tickets, type SkillFinding } from "../db/schema.js";
import { record } from "./activity.js";
import { normalise, parseSkillMd, skillName, skillNameOf, SkillError, type SkillFile, type skillsService } from "./skills.js";

type SkillsSvc = ReturnType<typeof skillsService>;
type Proposal = typeof skillProposals.$inferSelect;
export type CreateTicket = (projectId: string, input: { title: string; body: string; assigneeAgentId: string; state: "ready"; risk: "high"; noCode: true; createdByAgentId: string | null }) => Promise<{ id: string }>;

/** Most of a skill's text goes into the review ticket in full; past this many bytes, the reviewer reads the rest with the proposal tool. */
const INLINE_BYTES = 600_000;
const numbered = (text: string) => text.split("\n").map((l, i) => `${String(i + 1).padStart(4)}  ${l}`).join("\n");
const lineCount = (text: string) => text.replace(/\n$/, "").split("\n").length;
const SEVERITIES = ["critical", "high", "medium", "low"];

/** The review ticket's text: every file in full with numbered lines (assets that are not text, or past the size cap, are listed with their hash). */
export function reviewBody(p: Pick<Proposal, "id" | "name" | "source" | "sourceUrl" | "pinnedRef" | "why" | "files" | "fileHashes" | "bundleHash" | "scriptFiles" | "replacesSkillId">) {
  const scripts = new Set(p.scriptFiles);
  // Scripts and instructions first, then everything else, smallest first, until the size cap.
  const order = [...p.files].sort((a, b) => Number(scripts.has(b.path)) - Number(scripts.has(a.path)) || Number(b.path === "SKILL.md") - Number(a.path === "SKILL.md") || a.content.length - b.content.length);
  let used = 0;
  const shown: string[] = [];
  const notShown: string[] = [];
  for (const f of order) {
    const bytes = Buffer.from(f.content, "base64");
    const text = bytes.includes(0) ? null : bytes.toString("utf8");
    const must = f.path === "SKILL.md" || scripts.has(f.path) || /\.(md|markdown|txt)$/i.test(f.path);
    if (text === null || (!must && used + bytes.length > INLINE_BYTES)) {
      notShown.push(`${f.path} (${bytes.length} bytes, sha256 ${p.fileHashes[f.path]})`);
      continue;
    }
    used += bytes.length;
    shown.push(`### ${f.path}${scripts.has(f.path) ? "  [script]" : ""}  (${lineCount(text)} lines, sha256 ${p.fileHashes[f.path]})\n\`\`\`\n${numbered(text)}\n\`\`\``);
  }
  return [
    `Security review of the proposed skill **${p.name}** (proposal ${p.id}). Follow the review standard in the wiki: security/skill-review-standard-bos-87.`,
    `Source: ${p.source === "link" ? `${p.sourceUrl}${p.pinnedRef ? ` pinned to commit ${p.pinnedRef}` : " (single file)"}` : "CEO draft"}${p.replacesSkillId ? "  (a new version of a skill already in the library)" : ""}`,
    `Why the CEO wants it: ${p.why}`,
    `Files: ${p.files.length}. Bundle hash: ${p.bundleHash}`,
    `Files that count as scripts: ${p.scriptFiles.length ? p.scriptFiles.join(", ") : "none"}`,
    "",
    "Give your verdict with the skills tool, action review_verdict, passing this proposal id and the bundle hash above, a verdict (recommend / recommend with conditions / advise against), a short summary, conditions, and findings. Each finding names a file and a line range (the line numbers below) inside that file. Verdicts that cite a file or lines that do not exist are refused.",
    "",
    "## Files",
    ...shown,
    ...(notShown.length ? ["", "## Not shown here (not text, or over the size cap). Read them with the skills tool, action proposal_file; they are part of the bundle hash.", ...notShown.map((n) => `- ${n}`)] : []),
  ].join("\n\n");
}

type Verdict = "recommend" | "conditions" | "advise_against";
export type VerdictInput = { bundleHash: string; verdict: Verdict; summary: string; conditions?: string[]; findings?: SkillFinding[] };

/** Checks a reviewer's findings against the stored files: real file, real line range. */
export function checkVerdict(p: Pick<Proposal, "files" | "bundleHash">, v: VerdictInput) {
  if (v.bundleHash !== p.bundleHash) throw new SkillError(409, "That verdict is for different files than the ones proposed. Review the bundle hash in the ticket.");
  const findings = v.findings ?? [];
  findings.forEach((f, i) => {
    const file = p.files.find((x) => x.path === f.file);
    if (!file) throw new SkillError(400, `Finding ${i + 1} names ${f.file}, which isn't a file in the skill.`);
    const bytes = Buffer.from(file.content, "base64");
    if (bytes.includes(0)) throw new SkillError(400, `Finding ${i + 1}: ${f.file} isn't a text file, so it has no lines to cite.`);
    const n = lineCount(bytes.toString("utf8"));
    if (!Number.isInteger(f.lineStart) || !Number.isInteger(f.lineEnd) || f.lineStart < 1 || f.lineEnd < f.lineStart || f.lineEnd > n) throw new SkillError(400, `Finding ${i + 1}: lines ${f.lineStart}–${f.lineEnd} aren't inside ${f.file} (it has ${n} lines).`);
    if (!SEVERITIES.includes(f.severity)) throw new SkillError(400, `Finding ${i + 1}: severity must be critical, high, medium or low.`);
    if (!f.title?.trim() || !f.behaviour?.trim() || !f.harm?.trim()) throw new SkillError(400, `Finding ${i + 1} needs a title, what it does and why that's harmful.`);
  });
  const worst = findings.some((f) => f.severity === "critical") ? "critical" : findings.some((f) => f.severity === "high") ? "high" : findings.some((f) => f.severity === "medium") ? "medium" : "low";
  if (v.verdict === "recommend" && (worst === "critical" || worst === "high" || worst === "medium")) throw new SkillError(400, "A recommend verdict can't carry findings above low; use recommend with conditions or advise against.");
  if (v.verdict === "conditions" && !(v.conditions ?? []).some((c) => c.trim())) throw new SkillError(400, "Recommend with conditions needs the conditions listed.");
  if (v.verdict === "conditions" && worst === "critical") throw new SkillError(400, "A confirmed critical finding means advise against.");
  if (v.verdict === "advise_against" && !findings.length) throw new SkillError(400, "Advise against needs at least one finding saying why.");
  if (findings.some((f) => f.blocks) && v.verdict !== "advise_against") throw new SkillError(400, "A finding marked as blocking means the verdict is advise against.");
  if (!v.summary.trim()) throw new SkillError(400, "Give a short summary the owner can read.");
}

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

export function skillProposalsService(db: Db, skillsSvc: SkillsSvc, deps: { createTicket: CreateTicket }) {
  /** The agent marked as the company's security reviewer, never the proposer. */
  async function securityReviewer(companyId: string, not: string | null) {
    const pool = await db.select({ id: agents.id, name: agents.name, paused: agents.paused }).from(agents).where(and(eq(agents.companyId, companyId), eq(agents.reviewKind, "security"), isNull(agents.retiredAt))).orderBy(asc(agents.createdAt));
    return pool.find((a) => !a.paused && a.id !== not) ?? null;
  }
  async function reviewProject(companyId: string) {
    const [p] = await db.select({ id: projects.id }).from(projects).where(and(eq(projects.companyId, companyId), isNull(projects.archivedAt))).orderBy(asc(projects.createdAt));
    return p?.id ?? null;
  }

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

      // A review that nobody can do must not leave a proposal stuck: check before storing.
      const reviewer = needsReview ? await securityReviewer(input.companyId, input.byAgentId) : null;
      const projectId = needsReview ? await reviewProject(input.companyId) : null;
      if (needsReview && !reviewer) throw new SkillError(409, "This skill needs a security review, but the company has no Security Reviewer available. Ask the owner to hire one.");
      if (needsReview && !projectId) throw new SkillError(409, "This skill needs a security review, but the company has no open project to put the review task in.");

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
      let p: Proposal = row!;
      await record(db, {
        companyId: input.companyId,
        kind: "skill.proposed",
        agentId: input.byAgentId,
        summary: `Proposed ${had ? "a new version of" : "adding"} the skill ${name} (${input.source === "link" ? `from ${sourceUrl}${pinnedRef ? ` at ${pinnedRef.slice(0, 7)}` : ""}` : "CEO draft"}, ${files.length} file${files.length === 1 ? "" : "s"}). ${
          needsReview ? (input.source === "link" ? "Security review required: it comes from the internet." : `Security review required: the draft contains a script (${scripts.slice(0, 3).join(", ")}${scripts.length > 3 ? ", …" : ""}).`) : "No security review needed: CEO draft with no scripts."
        }`,
      });
      if (needsReview) {
        try {
          const t = await deps.createTicket(projectId!, { title: `Security review: skill ${name}${had ? " (new version)" : ""}`, body: reviewBody(p), assigneeAgentId: reviewer!.id, state: "ready", risk: "high", noCode: true, createdByAgentId: input.byAgentId });
          p = (await db.update(skillProposals).set({ status: "in_review", reviewTicketId: t.id, updatedAt: new Date() }).where(eq(skillProposals.id, p.id)).returning())[0]!;
          await record(db, { companyId: input.companyId, ticketId: t.id, agentId: input.byAgentId, kind: "skill.review_requested", summary: `Security review of ${name} sent to ${reviewer!.name}.` });
        } catch (e) {
          await db.delete(skillProposals).where(eq(skillProposals.id, p.id));
          throw e;
        }
      }
      return p!;
    },

    /**
     * The Security Reviewer's verdict, on its own review ticket only. The findings are checked
     * against the stored files; the verdict counts only for the exact bundle that was reviewed.
     */
    async recordVerdict(companyId: string, reviewerId: string | null, proposalId: string, v: VerdictInput) {
      const p = await this.get(companyId, proposalId);
      if (!reviewerId) throw new SkillError(403, "Only the Security Reviewer can give a verdict.");
      const [me] = await db.select({ kind: agents.reviewKind }).from(agents).where(and(eq(agents.id, reviewerId), eq(agents.companyId, companyId)));
      if (me?.kind !== "security") throw new SkillError(403, "Only the Security Reviewer can give a verdict.");
      if (p.status !== "in_review" || !p.reviewTicketId) throw new SkillError(409, "This proposal isn't waiting for a review.");
      const [t] = await db.select({ assignee: tickets.assigneeAgentId }).from(tickets).where(eq(tickets.id, p.reviewTicketId));
      if (t?.assignee !== reviewerId) throw new SkillError(403, "This proposal's review was given to another reviewer.");
      checkVerdict(p, v);
      const [row] = await db
        .update(skillProposals)
        .set({ verdict: v.verdict, verdictSummary: v.summary.trim(), findings: v.findings ?? [], conditions: (v.conditions ?? []).filter((c) => c.trim()), reviewedBundleHash: v.bundleHash, status: "awaiting_owner", updatedAt: new Date() })
        .where(and(eq(skillProposals.id, p.id), eq(skillProposals.status, "in_review")))
        .returning();
      if (!row) throw new SkillError(409, "This proposal isn't waiting for a review.");
      await record(db, { companyId, ticketId: p.reviewTicketId, agentId: reviewerId, kind: "skill.reviewed", summary: `Security review of ${p.name}: ${v.verdict === "conditions" ? "recommend with conditions" : v.verdict === "advise_against" ? "advise against" : "recommend"} (${(v.findings ?? []).length} finding${(v.findings ?? []).length === 1 ? "" : "s"}).` });
      return row;
    },

    async get(companyId: string, id: string): Promise<Proposal> {
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
