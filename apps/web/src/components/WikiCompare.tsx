// Compare two saved versions of a wiki page, line by line (BOS-2198).
import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { diffCounts, diffLines, foldDiff } from "../line-diff";
import { when } from "../pages/Runs";
import { Loader } from "./Loader";

export type CompareVersion = { id: string; createdAt: string; agent: string | null };
type Body = { id: string; body: string; createdAt: string; agent: string | null };

const MARK = { add: "+", del: "−", same: " " } as const;
const STYLE = {
  add: { background: "var(--green-soft)", color: "var(--green-ink)" },
  del: { background: "var(--red-soft)", color: "var(--red-ink)" },
  same: {},
} as const;

function Row({ kind, text }: { kind: "add" | "del" | "same"; text: string }) {
  return (
    <div style={{ display: "flex", gap: 8, fontFamily: "var(--mono)", fontSize: 13, whiteSpace: "pre-wrap", overflowWrap: "anywhere", padding: "0 6px", ...STYLE[kind] }}>
      <span aria-hidden="true" style={{ flex: "0 0 1ch" }}>{MARK[kind]}</span>
      <span className="sr-only" style={{ position: "absolute", left: -9999 }}>{kind === "add" ? "Added: " : kind === "del" ? "Removed: " : ""}</span>
      <span style={{ flex: 1, minWidth: 0 }}>{text || " "}</span>
    </div>
  );
}

export function WikiCompare({ companyId, versions, from, to, onRestore, onClose }: { companyId: string; versions: CompareVersion[]; from: string; to: string; onRestore: (id: string) => void; onClose: () => void }) {
  // `from` is the older side, `to` the newer; the picker lets the owner choose any two.
  const [a, setA] = useState(from);
  const [b, setB] = useState(to);
  const [bodies, setBodies] = useState<Record<string, Body>>({});
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<Set<number>>(new Set());
  useEffect(() => (setA(from), setB(to)), [from, to]);
  useEffect(() => {
    setError(null);
    setOpen(new Set());
    for (const id of [a, b]) {
      if (bodies[id]) continue;
      api<Body>(`/api/companies/${companyId}/wiki-revisions/${id}`).then(
        (r) => setBodies((s) => ({ ...s, [id]: r })),
        () => setError("Couldn't open one of those versions. Try again; nothing on the page has changed."),
      );
    }
  }, [a, b, companyId]); // eslint-disable-line react-hooks/exhaustive-deps
  const ra = bodies[a];
  const rb = bodies[b];
  const lines = useMemo(() => (ra && rb ? diffLines(ra.body, rb.body) : null), [ra, rb]);
  const blocks = useMemo(() => (lines ? foldDiff(lines) : []), [lines]);
  const counts = lines ? diffCounts(lines) : null;
  const label = (v: CompareVersion) => `${when(v.createdAt)} by ${v.agent ?? "you"}`;
  const who = (r: Body | undefined, v: CompareVersion | undefined) => (r ? `${when(r.createdAt)} by ${r.agent ?? "you"}` : v ? label(v) : "");
  const va = versions.find((v) => v.id === a);
  const vb = versions.find((v) => v.id === b);
  return (
    <section aria-label="Compare versions" style={{ display: "flex", flexDirection: "column", gap: 8, border: "1px solid var(--line)", borderRadius: 8, padding: 10 }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", fontSize: 14 }}>
        <label>
          From{" "}
          <select value={a} onChange={(e) => setA(e.target.value)} style={{ maxWidth: "100%" }}>
            {versions.map((v) => (
              <option key={v.id} value={v.id}>{label(v)}</option>
            ))}
          </select>
        </label>
        <label>
          to{" "}
          <select value={b} onChange={(e) => setB(e.target.value)} style={{ maxWidth: "100%" }}>
            {versions.map((v) => (
              <option key={v.id} value={v.id}>{label(v)}</option>
            ))}
          </select>
        </label>
        <button type="button" className="btn" onClick={onClose}>Close compare</button>
      </div>
      <p className="muted" style={{ fontSize: 13, margin: 0 }}>
        Old: {who(ra, va)}. New: {who(rb, vb)}.
      </p>
      {error && <p className="error" role="alert">{error}</p>}
      {!lines && !error && <Loader label="Loading versions" size={16} />}
      {a === b && <p className="muted">Both sides are the same version.</p>}
      {counts && (
        <>
          <p style={{ margin: 0, fontWeight: 600 }} aria-label={`${counts.added} lines added, ${counts.removed} lines removed`}>
            +{counts.added} −{counts.removed} lines
          </p>
          {counts.added + counts.removed === 0 ? (
            <p className="muted">These two versions have the same text.</p>
          ) : (
            <div role="group" aria-label="Changes" style={{ overflowX: "auto", border: "1px solid var(--line)", borderRadius: 6 }}>
              {blocks.map((blk, i) =>
                blk.kind === "folded" && !open.has(i) ? (
                  <div key={i} className="muted" style={{ padding: "2px 6px", fontSize: 13 }}>
                    {`${blk.lines.length} unchanged lines `}
                    <button type="button" className="link" onClick={() => setOpen((s) => new Set(s).add(i))}>Show</button>
                  </div>
                ) : (
                  blk.lines.map((l, j) => <Row key={`${i}-${j}`} kind={l.kind} text={l.text} />)
                ),
              )}
            </div>
          )}
        </>
      )}
      {rb && (
        <div>
          <button type="button" className="btn primary" onClick={() => onRestore(b)}>Restore this version</button>
          <span className="muted" style={{ fontSize: 13 }}> (the newer side, {who(rb, vb)})</span>
        </div>
      )}
    </section>
  );
}
