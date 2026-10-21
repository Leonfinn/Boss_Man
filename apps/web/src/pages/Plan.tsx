import { useMemo, useState } from "react";
import { api, type Company, type Plan as PlanData, type PlanNode } from "../api";
import { usePoll } from "../hooks";

const W = 230;
const H = 84;
const GAP_X = 70;
const GAP_Y = 18;
const PAD = 12;

const KIND = { ticket: "Task", engagement: "Engagement", decision: "Decision" } as const;

function nodeClass(n: PlanNode) {
  if (!n.open) return "pl-node done";
  if (n.blocked) return "pl-node blocked";
  if (n.holdingUp > 0) return "pl-node cause";
  return "pl-node";
}

/** Everything upstream and downstream of a node, to light up its chains. */
function related(id: string, edges: PlanData["edges"]) {
  const out = new Set([id]);
  const walk = (start: string, dir: "up" | "down") => {
    const stack = [start];
    while (stack.length) {
      const cur = stack.pop()!;
      for (const e of edges) {
        const next = dir === "up" ? (e.to === cur ? e.from : null) : e.from === cur ? e.to : null;
        if (next && !out.has(next)) (out.add(next), stack.push(next));
      }
    }
  };
  walk(id, "up");
  walk(id, "down");
  return out;
}

function Graph({ plan }: { plan: PlanData }) {
  const [focus, setFocus] = useState<string | null>(null);
  const byId = useMemo(() => new Map(plan.nodes.map((n) => [n.id, n])), [plan]);
  const pos = useMemo(() => {
    const p = new Map<string, { x: number; y: number }>();
    plan.columns.forEach((col, c) => col.forEach((id, r) => p.set(id, { x: PAD + c * (W + GAP_X), y: PAD + r * (H + GAP_Y) })));
    return p;
  }, [plan]);
  const lit = focus ? related(focus, plan.edges) : null;
  const width = PAD * 2 + plan.columns.length * W + (plan.columns.length - 1) * GAP_X;
  const height = PAD * 2 + Math.max(...plan.columns.map((c) => c.length)) * (H + GAP_Y) - GAP_Y;
  return (
    <div className="pl-scroll" role="region" aria-label="Dependency graph" tabIndex={0}>
      <div className="pl-canvas" style={{ width, height }}>
        <svg width={width} height={height} aria-hidden="true">
          <defs>
            {(["red", "grey"] as const).map((c) => (
              <marker key={c} id={`pl-arrow-${c}`} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
                <path d="M0,0 L8,4 L0,8 z" fill={c === "red" ? "var(--red-ink)" : "var(--muted)"} />
              </marker>
            ))}
          </defs>
          {plan.edges.map((e) => {
            const a = pos.get(e.from);
            const b = pos.get(e.to);
            if (!a || !b) return null;
            const from = byId.get(e.from)!;
            const x1 = a.x + W;
            const y1 = a.y + H / 2;
            const x2 = b.x - 2;
            const y2 = b.y + H / 2;
            const mid = (x1 + x2) / 2;
            const holding = from.open;
            const dim = lit && !(lit.has(e.from) && lit.has(e.to));
            return (
              <path
                key={e.id}
                d={`M${x1},${y1} C${mid},${y1} ${mid},${y2} ${x2},${y2}`}
                fill="none"
                stroke={holding ? "var(--red-ink)" : "var(--muted)"}
                strokeWidth={holding ? 2 : 1.5}
                strokeDasharray={holding ? undefined : "4 4"}
                opacity={dim ? 0.15 : 1}
                markerEnd={`url(#pl-arrow-${holding ? "red" : "grey"})`}
              />
            );
          })}
        </svg>
        {plan.nodes.map((n) => {
          const p = pos.get(n.id)!;
          return (
            <div key={n.id} className={nodeClass(n)} style={{ left: p.x, top: p.y, width: W, height: H, opacity: lit && !lit.has(n.id) ? 0.25 : 1 }}>
              <button type="button" className="pl-hit" aria-pressed={focus === n.id} aria-label={`Show ${n.title}'s chain`} onClick={() => setFocus(focus === n.id ? null : n.id)} />
              <div className="pl-top">
                <span className="label">{KIND[n.kind]}</span>
                <span className="pl-state">{n.state.replace(/_/g, " ")}</span>
              </div>
              <a href={n.link} className="pl-title" title={n.title}>
                {n.title}
              </a>
              <div className="pl-foot">
                {n.blocked ? (
                  <span title={n.causes.map((c) => byId.get(c)?.title).join(", ")}>
                    Waiting on {byId.get(n.causes[0] ?? "")?.title ?? "an earlier step"}
                    {n.causes.length > 1 ? ` +${n.causes.length - 1}` : ""}
                  </span>
                ) : n.open && n.holdingUp > 0 ? (
                  <b>Holding up {n.holdingUp}</b>
                ) : (
                  <span>{n.assignee ?? n.project ?? ""}</span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** The things to move first: open blockers that aren't waiting on anything, biggest first. */
function Causes({ plan }: { plan: PlanData }) {
  const causes = plan.nodes.filter((n) => n.open && !n.blocked && n.holdingUp > 0).sort((a, b) => b.holdingUp - a.holdingUp);
  const byId = new Map(plan.nodes.map((n) => [n.id, n]));
  if (!causes.length) return null;
  return (
    <section className="card" aria-labelledby="causes-h" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <h2 id="causes-h" style={{ fontSize: 17, fontWeight: 600 }}>
        What's holding work up
      </h2>
      <ul className="pl-causes">
        {causes.map((c) => {
          const waiting = plan.nodes.filter((n) => n.causes.includes(c.id));
          return (
            <li key={c.id}>
              <span className="tag amber">{KIND[c.kind]}</span> <a href={c.link}>{c.title}</a>{" "}
              <span className="muted">
                ({c.state.replace(/_/g, " ")}
                {c.assignee ? `, ${c.assignee}` : ""}) holds up {c.holdingUp}: {waiting.map((w) => byId.get(w.id)!.title).join(", ")}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export function Plan({ companies, companyId, go }: { companies: Company[]; companyId: string | undefined; go: (to: string) => void }) {
  const company = companies.find((c) => c.id === companyId) ?? companies[0];
  const plan = usePoll((signal) => (company ? api<PlanData>(`/api/companies/${company.id}/plan`, { signal }) : Promise.resolve(null)), 30_000, company?.id ?? "none");
  const p = plan.data;
  const blocked = p?.nodes.filter((n) => n.blocked).length ?? 0;
  return (
    <>
      <header className="page-head">
        <div>
          <h1>Plan</h1>
          <p className="sub">Open tasks that wait on something, and what they wait on. Red lines still hold work up. Tap a card to light up its chain.</p>
        </div>
      </header>
      {plan.error && <p className="error">{plan.error.message}</p>}
      {!company ? (
        <p>Create a company on the Kanban first.</p>
      ) : p && !p.nodes.length ? (
        <p className="muted">No open task waits on anything. Add what a task waits on from its page.</p>
      ) : p ? (
        <>
          <p className="muted" style={{ fontSize: 14 }}>
            {blocked} blocked task{blocked === 1 ? "" : "s"} across {p.nodes.length} items.
          </p>
          <Causes plan={p} />
          <Graph plan={p} />
        </>
      ) : null}
    </>
  );
}
