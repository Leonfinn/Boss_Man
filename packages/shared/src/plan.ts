// The plan view: tickets and what they wait on, as a graph. An edge runs from a blocker to the
// ticket waiting on it. A node is "open" while it still holds things up: a ticket not done, an
// engagement not signed off, a decision not answered.

export type PlanNode = { id: string; open: boolean };
export type PlanEdge = { from: string; to: string };

export type PlanLayout = {
  /** Column for each node: the longest chain of blockers in front of it. */
  layer: Record<string, number>;
  /** Order of nodes within each column, chosen to keep edges short. */
  columns: string[][];
  /** Nodes with an open blocker somewhere upstream. */
  blocked: Set<string>;
  /**
   * For each blocked node, the open nodes at the head of its chains: open, and not blocked
   * themselves. These are what has to move for it to start.
   */
  causes: Record<string, string[]>;
  /** For each open node, how many nodes downstream are waiting on it, directly or not. */
  holdingUp: Record<string, number>;
};

export function layoutPlan(nodes: PlanNode[], edges: PlanEdge[]): PlanLayout {
  const ids = new Set(nodes.map((n) => n.id));
  const open = new Map(nodes.map((n) => [n.id, n.open]));
  const es = edges.filter((e) => ids.has(e.from) && ids.has(e.to) && e.from !== e.to);
  const parents = new Map<string, string[]>();
  const children = new Map<string, string[]>();
  for (const id of ids) (parents.set(id, []), children.set(id, []));
  for (const e of es) (parents.get(e.to)!.push(e.from), children.get(e.from)!.push(e.to));

  // Longest-path layering. The server refuses cycles, but a guard keeps a bad row from hanging.
  const layer: Record<string, number> = {};
  const visiting = new Set<string>();
  const depth = (id: string): number => {
    if (layer[id] !== undefined) return layer[id]!;
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const d = Math.max(-1, ...parents.get(id)!.map(depth)) + 1;
    visiting.delete(id);
    layer[id] = d;
    return d;
  };
  for (const id of ids) depth(id);

  // Upstream open nodes, per node.
  const upstream = new Map<string, Set<string>>();
  const up = (id: string, seen = new Set<string>()): Set<string> => {
    if (upstream.has(id)) return upstream.get(id)!;
    const out = new Set<string>();
    if (seen.has(id)) return out;
    seen.add(id);
    for (const p of parents.get(id)!) {
      if (open.get(p)) out.add(p);
      for (const q of up(p, seen)) out.add(q);
    }
    upstream.set(id, out);
    return out;
  };
  const blocked = new Set<string>();
  for (const id of ids) if (up(id).size) blocked.add(id);

  const causes: Record<string, string[]> = {};
  const holdingUp: Record<string, number> = {};
  for (const id of ids) if (open.get(id)) holdingUp[id] = 0;
  for (const id of blocked) {
    const ups = [...up(id)];
    causes[id] = ups.filter((u) => !blocked.has(u)).sort();
    for (const u of ups) holdingUp[u] = (holdingUp[u] ?? 0) + 1;
  }

  // Columns, then a few barycentre sweeps to reduce crossings.
  const count = Math.max(-1, ...Object.values(layer)) + 1;
  const columns: string[][] = Array.from({ length: count }, () => []);
  for (const id of [...ids].sort()) columns[layer[id]!]!.push(id);
  const pos = new Map<string, number>();
  const index = () => columns.forEach((c) => c.forEach((id, i) => pos.set(id, i)));
  index();
  const bary = (id: string, near: string[]) => (near.length ? near.reduce((s, n) => s + pos.get(n)!, 0) / near.length : pos.get(id)!);
  for (let sweep = 0; sweep < 4; sweep++) {
    const down = sweep % 2 === 0;
    const order = down ? columns.keys() : [...columns.keys()].reverse();
    for (const c of order) {
      const col = columns[c]!;
      const score = new Map(col.map((id) => [id, bary(id, down ? parents.get(id)! : children.get(id)!)]));
      col.sort((a, b) => score.get(a)! - score.get(b)! || a.localeCompare(b));
      col.forEach((id, i) => pos.set(id, i));
    }
  }
  return { layer, columns, blocked, causes, holdingUp };
}
