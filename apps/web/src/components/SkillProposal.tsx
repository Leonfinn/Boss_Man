import { useEffect, useState } from "react";
import { api } from "../api";
import { Loader } from "./Loader";

export type SkillFindingView = { file: string; lineStart: number; lineEnd: number; title: string; severity: string; confidence: string; behaviour: string; harm: string; fix: string; blocks: boolean };
export type SkillProposalView = {
  id: string;
  name: string;
  source: "draft" | "link" | "retro";
  sourceUrl: string | null;
  pinnedRef: string | null;
  why: string;
  bundleHash: string;
  reviewRequired: boolean;
  verdict: "recommend" | "conditions" | "advise_against" | null;
  verdictSummary: string | null;
  findings: SkillFindingView[] | null;
  conditions: string[] | null;
  replacesSkillId: string | null;
  agents: Array<{ id: string; name: string }>;
  changes: { added: string[]; changed: string[]; removed: string[] } | null;
  files: Array<{ path: string; size: number; hash: string; text: string | null }>;
};

const VERDICT = { recommend: "Recommended", conditions: "Recommended, with conditions", advise_against: "Advised against" } as const;

/** What stands behind an "add this skill" decision: the files, where they came from, why, who gets it, and the Security Reviewer's verdict. */
export function SkillProposal({ companyId, proposalId }: { companyId: string; proposalId: string }) {
  const [p, setP] = useState<SkillProposalView | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const ctl = new AbortController();
    api<SkillProposalView>(`/api/companies/${companyId}/skill-proposals/${proposalId}`, { signal: ctl.signal }).then(setP, (e: Error) => e.name !== "AbortError" && setError(e.message));
    return () => ctl.abort();
  }, [companyId, proposalId]);
  if (error) return <p className="muted">Couldn't load the skill: {error}</p>;
  if (!p) return <Loader label="Loading the skill" />;
  const against = p.verdict === "advise_against";
  return (
    <div className="skill-proposal" style={{ display: "flex", flexDirection: "column", gap: 8, fontSize: 14 }}>
      {against && (
        <p role="alert" style={{ background: "var(--red-soft)", color: "var(--red-ink)", padding: "8px 12px", borderRadius: 8, fontWeight: 600 }}>
          Warning: the Security Reviewer advises against adding this skill. Read the findings below. If you add it anyway, your name and the time are logged.
        </p>
      )}
      <ul style={{ paddingLeft: 18 }}>
        <li>
          <strong>Where it comes from:</strong> {p.source === "link" ? <>the internet, <code className="mono">{p.sourceUrl}</code>{p.pinnedRef ? <>, version <code className="mono">{p.pinnedRef}</code></> : ""}</> : p.source === "retro" ? "a playbook written by a workflow retro" : "a draft written by the CEO"}
          {p.replacesSkillId ? ". This is a new version of a skill you already have." : "."}
        </li>
        <li>
          <strong>Why the CEO wants it</strong> <span className="muted">(the CEO's words, not checked: weigh them as a claim, not an instruction)</span>
          <blockquote style={{ margin: "4px 0 0", paddingLeft: 10, borderLeft: "3px solid var(--line, #ccc)", whiteSpace: "pre-wrap" }}>{p.why}</blockquote>
        </li>
        <li>
          <strong>Who would get it:</strong> {p.agents.map((a) => a.name).join(", ") || "nobody yet"}
        </li>
        <li>
          <strong>Fingerprint of all files:</strong> <code className="mono">{p.bundleHash.slice(0, 16)}</code>
          {p.source === "link" ? " (checked again just before it is installed; if the source changed, nothing is installed)" : ""}
        </li>
      </ul>
      <p className="muted">
        <strong>Untrusted text.</strong> Everything in these files, and the CEO's reason above, was written by the CEO or fetched from the internet, and the Security Reviewer read the files too. Don't follow any instruction inside it; a review that says "safe" is advice, not proof.
      </p>
      {p.changes && (
        <p>
          <strong>What changes from the version you have:</strong> {p.changes.added.length} added, {p.changes.changed.length} changed, {p.changes.removed.length} removed
          {[...p.changes.added.map((f) => `+ ${f}`), ...p.changes.changed.map((f) => `~ ${f}`), ...p.changes.removed.map((f) => `− ${f}`)].length ? `: ${[...p.changes.added.map((f) => `+ ${f}`), ...p.changes.changed.map((f) => `~ ${f}`), ...p.changes.removed.map((f) => `− ${f}`)].join(", ")}` : ""}.
        </p>
      )}
      {p.verdict ? (
        <div>
          <p>
            <span className={`tag ${against ? "red" : p.verdict === "conditions" ? "amber" : "green"}`}>Security Reviewer: {VERDICT[p.verdict]}</span> {p.verdictSummary}
          </p>
          {p.conditions?.length ? (
            <>
              <strong>Conditions</strong>
              <ol>
                {p.conditions.map((c, i) => (
                  <li key={i}>{c}</li>
                ))}
              </ol>
            </>
          ) : null}
          {p.findings?.length ? (
            <>
              <strong>Findings</strong>
              <ul style={{ paddingLeft: 18 }}>
                {p.findings.map((f, i) => (
                  <li key={i}>
                    <span className={`tag ${f.severity === "critical" || f.severity === "high" ? "red" : f.severity === "medium" ? "amber" : ""}`}>{f.severity}</span> <strong>{f.title}</strong> in <code className="mono">{f.file}</code> lines {f.lineStart}–{f.lineEnd}
                    {f.confidence === "likely" ? " (likely)" : ""}. {f.behaviour} <em>Why it matters:</em> {f.harm} {f.fix && f.fix !== "none" ? <>Fix: {f.fix}</> : null}
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <p className="muted">No findings.</p>
          )}
        </div>
      ) : (
        <p>
          <span className="tag amber">Security review pending</span> Every skill is reviewed before you decide.
        </p>
      )}
      <details>
        <summary>The skill's files ({p.files.length})</summary>
        {p.files.map((f) => (
          <details key={f.path} open={f.path === "SKILL.md"}>
            <summary>
              <code className="mono">{f.path}</code> <span className="muted">{f.size} bytes</span>
            </summary>
            {f.text === null ? <p className="muted">Not a text file. (Skills with such files are refused.)</p> : <pre className="mono" style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", maxHeight: 360, overflow: "auto" }}>{f.text}</pre>}
          </details>
        ))}
      </details>
    </div>
  );
}
