import { useEffect, useMemo, useRef, useState } from "react";
import { api, type Company, type Plan as PlanData, type PlanNode } from "../api";
import { usePoll } from "../hooks";
import { away } from "../server-watch";
import { ageLabel } from "../age";

const MIN_W = 230;
const MAX_W = 360;
const H = 108;
const GAP_X = 70;
const GAP_Y = 18;
const PAD = 12;

/** Cards fill the width, within a readable range; many columns still scroll on a phone. */
function cardWidth(available: number, columns: number) {
  if (!available || columns < 1) return MIN_W;
  const room = (available - PAD * 2 - (columns - 1) * GAP_X) / columns;
  return Math.max(MIN_W, Math.min(MAX_W, Math.floor(room)));
}

const KIND = { ticket: "Task", engagement: "Engagement", decision: "Decision" } as const;

function nodeClass(n: PlanNode) {
  if (!n.open) return "pl-node done";
  if (n.blocked) return "pl-node blocked";
  if (n.holdingUp > 0) return "pl-node cause";
  return "pl-node";
}

/** A blocker named by its ticket reference first, then its title, so the reference survives truncation. */
function causeLabel(node: PlanNode | undefined) {
  if (!node) return "an earlier step";
  return node.ref ? `${node.ref} ${node.title}` : node.title;
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
  const scrollRef = useRef<HTMLDivElement>(null);
  const [available, setAvailable] = useState(0);
  useEffect(() => {
    if (!scrollRef.current || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([e]) => setAvailable(e!.contentRect.width));
    ro.observe(scrollRef.current);
    return () => ro.disconnect();
  }, []);
  const W = cardWidth(available, plan.columns.length);
  const byId = useMemo(() => new Map(plan.nodes.map((n) => [n.id, n])), [plan]);
  const pos = useMemo(() => {
    const p = new Map<string, { x: number; y: number }>();
    plan.columns.forEach((col, c) => col.forEach((id, r) => p.set(id, { x: PAD + c * (W + GAP_X), y: PAD + r * (H + GAP_Y) })));
    return p;
  }, [plan, W]);
  const lit = focus ? related(focus, plan.edges) : null;
  const width = PAD * 2 + plan.columns.length * W + (plan.columns.length - 1) * GAP_X;
  const height = PAD * 2 + Math.max(...plan.columns.map((c) => c.length)) * (H + GAP_Y) - GAP_Y;
  return (
    <div ref={scrollRef} className="pl-scroll" role="region" aria-label="Dependency graph" tabIndex={0}>
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
                <span className="pl-kind">
                  <span className="label">{KIND[n.kind]}</span>
                  {n.ref && <span className="pl-ref">{n.ref}</span>}
                </span>
                <span className="pl-state">{n.state.replace(/_/g, " ")}</span>
              </div>
              <a href={n.link} className="pl-title" title={n.title}>
                {n.title}
              </a>
              <div className="pl-foot">
                {n.blocked ? (
                  <span title={n.causes.map((c) => byId.get(c)?.title).join(", ")}>
                    Waiting on {causeLabel(byId.get(n.causes[0] ?? ""))}
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

const CAUSES_OPEN_KEY = "bossman.plan.causesOpen";
const CAUSES_ROLLED_KEY = "bossman.plan.causesRolledUp";
/** How many items show before "Show all" (BOS-745). */
export const CAUSES_SHOWN = 5;

/**
 * A choice kept in the browser as "1" (on) or "0" (off). Read is guarded so a page without a
 * local store (a server render, or a browser that refuses it) still works.
 */
function readChoice(key: string): boolean {
  try {
    return globalThis.localStorage?.getItem(key) === "1";
  } catch {
    return false;
  }
}

function writeChoice(key: string, value: boolean) {
  try {
    globalThis.localStorage?.setItem(key, value ? "1" : "0");
  } catch {}
}

/** The things to move first: open blockers that aren't waiting on anything, biggest first. */
export function Causes({ plan }: { plan: PlanData }) {
  const causes = plan.nodes.filter((n) => n.open && !n.blocked && n.holdingUp > 0).sort((a, b) => b.holdingUp - a.holdingUp);
  const byId = new Map(plan.nodes.map((n) => [n.id, n]));
  const [showAll, setShowAll] = useState(() => readChoice(CAUSES_OPEN_KEY));
  const [rolled, setRolled] = useState(() => readChoice(CAUSES_ROLLED_KEY));
  if (!causes.length) return null;
  const total = causes.length;
  const shown = showAll ? causes : causes.slice(0, CAUSES_SHOWN);
  const toggleAll = () => {
    const next = !showAll;
    setShowAll(next);
    writeChoice(CAUSES_OPEN_KEY, next);
  };
  const toggleRolled = () => {
    const next = !rolled;
    setRolled(next);
    writeChoice(CAUSES_ROLLED_KEY, next);
  };
  return (
    <section className={`card${rolled ? " pl-causes-folded" : ""}`} aria-labelledby="causes-h" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div className="pl-causes-head">
        <h2 id="causes-h" style={{ fontSize: 17, fontWeight: 600 }}>
          <button type="button" className="pl-causes-toggle" aria-expanded={!rolled} aria-controls="causes-body" onClick={toggleRolled}>
            <span className="pl-causes-title">What's holding work up ({total})</span>
            <span className="pl-causes-action">
              {rolled ? "Show" : "Hide"} <span className="pl-arrow" aria-hidden="true">{rolled ? "▾" : "▴"}</span>
            </span>
          </button>
        </h2>
      </div>
      <div id="causes-body" hidden={rolled} style={rolled ? { display: "none" } : { display: "flex", flexDirection: "column", gap: 10 }}>
      <ul className="pl-causes" id="causes-list">
        {shown.map((c) => {
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
      {total > CAUSES_SHOWN && (
        <button type="button" className="pl-causes-more" aria-expanded={showAll} aria-controls="causes-list" onClick={toggleAll}>
          <span className="pl-arrow" aria-hidden="true">{showAll ? "▴" : "▾"}</span>
          {showAll ? "Show fewer" : `Show all ${total}`}
        </button>
      )}
      </div>
    </section>
  );
}

export function Plan({ companies, companyId, go }: { companies: Company[]; companyId: string | undefined; go: (to: string) => void }) {
  const company = companies.find((c) => c.id === companyId) ?? companies[0];
  const plan = usePoll((signal) => (company ? api<PlanData>(`/api/companies/${company.id}/plan`, { signal }) : Promise.resolve(null)), 30_000, company?.id ?? "none");
  const p = plan.data;
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (p) setUpdatedAt(Date.now());
  }, [p]);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, []);
  const blocked = p?.nodes.filter((n) => n.blocked).length ?? 0;
  const updated = updatedAt
    ? `Last updated ${new Date(updatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} (${ageLabel(now - updatedAt)})`
    : "";
  return (
    <div className="plan-page">
      <header className="page-head">
        <div>
          <h1>Plan</h1>
          <p className="sub">Open tasks that wait on something, and what they wait on. Red lines still hold work up. Tap a card to light up its chain.</p>
        </div>
      </header>
      {plan.error && !away(plan.error) && <p className="error">{plan.error.message}</p>}
      {!company ? (
        <p>Create a company on the Kanban first.</p>
      ) : p && !p.nodes.length ? (
        <p className="muted">No open task waits on anything. Add what a task waits on from its page.</p>
      ) : p ? (
        <>
          <div className="pl-meta">
            <span className="muted pl-count" style={{ fontSize: 14 }}>
              {blocked} blocked task{blocked === 1 ? "" : "s"} across {p.nodes.length} items.
            </span>
            <span className="muted pl-updated" style={{ fontSize: 13 }}>{updated}</span>
            <button type="button" className="btn pl-refresh" onClick={() => plan.reload()}>
              Refresh
            </button>
          </div>
          <Causes plan={p} />
          <Graph plan={p} />
        </>
      ) : null}
    </div>
  );
}
