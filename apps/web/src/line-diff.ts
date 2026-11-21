// A small line diff for the wiki's version compare (BOS-2198): Myers' O(ND) algorithm after the shared
// start and end are trimmed off, so a long page with a few edits compares at once.
export type DiffLine = { kind: "same" | "add" | "del"; text: string };
export type DiffBlock = { kind: "lines"; lines: DiffLine[] } | { kind: "folded"; lines: DiffLine[] };

export function diffLines(a: string, b: string): DiffLine[] {
  const x = a === "" ? [] : a.split("\n");
  const y = b === "" ? [] : b.split("\n");
  let start = 0;
  while (start < x.length && start < y.length && x[start] === y[start]) start++;
  let endX = x.length;
  let endY = y.length;
  while (endX > start && endY > start && x[endX - 1] === y[endY - 1]) {
    endX--;
    endY--;
  }
  const out: DiffLine[] = x.slice(0, start).map((text) => ({ kind: "same", text }));
  return out.concat(
    myers(x.slice(start, endX), y.slice(start, endY)),
    x.slice(endX).map((text): DiffLine => ({ kind: "same", text })),
  );
}

function myers(a: string[], b: string[]): DiffLine[] {
  const n = a.length;
  const m = b.length;
  if (n === 0) return b.map((text) => ({ kind: "add", text }));
  if (m === 0) return a.map((text) => ({ kind: "del", text }));
  const max = n + m;
  const off = max;
  const v = new Int32Array(2 * max + 2);
  const trace: Int32Array[] = [];
  const at = (arr: Int32Array, k: number) => arr[off + k] as number;
  const A = (i: number) => a[i] as string;
  const B = (i: number) => b[i] as string;
  let found = false;
  for (let d = 0; d <= max && !found; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let xx = k === -d || (k !== d && at(v, k - 1) < at(v, k + 1)) ? at(v, k + 1) : at(v, k - 1) + 1;
      let yy = xx - k;
      while (xx < n && yy < m && A(xx) === B(yy)) {
        xx++;
        yy++;
      }
      v[off + k] = xx;
      if (xx >= n && yy >= m) {
        found = true;
        break;
      }
    }
  }
  // Walk back through the saved frontiers.
  const rev: DiffLine[] = [];
  let px = n;
  let py = m;
  for (let d = trace.length - 1; d > 0; d--) {
    const t = trace[d] as Int32Array;
    const k = px - py;
    const prevK = k === -d || (k !== d && at(t, k - 1) < at(t, k + 1)) ? k + 1 : k - 1;
    const prevX = at(t, prevK);
    const prevY = prevX - prevK;
    while (px > prevX && py > prevY) {
      rev.push({ kind: "same", text: A(px - 1) });
      px--;
      py--;
    }
    if (px === prevX) rev.push({ kind: "add", text: B(py - 1) });
    else rev.push({ kind: "del", text: A(px - 1) });
    px = prevX;
    py = prevY;
  }
  while (px > 0 && py > 0) {
    rev.push({ kind: "same", text: A(px - 1) });
    px--;
    py--;
  }
  return rev.reverse();
}

export function diffCounts(lines: DiffLine[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const l of lines) {
    if (l.kind === "add") added++;
    else if (l.kind === "del") removed++;
  }
  return { added, removed };
}

/** Group lines so a run of unchanged lines longer than 6 is folded whole (`context` lines can be kept beside a change). */
export function foldDiff(lines: DiffLine[], context = 0, min = 7): DiffBlock[] {
  const blocks: DiffBlock[] = [];
  let i = 0;
  const push = (kind: DiffBlock["kind"], ls: DiffLine[]) => {
    if (!ls.length) return;
    const last = blocks[blocks.length - 1];
    if (last && last.kind === kind) for (const l of ls) last.lines.push(l);
    else blocks.push({ kind, lines: ls.slice() });
  };
  while (i < lines.length) {
    const cur = lines[i] as DiffLine;
    if (cur.kind !== "same") {
      push("lines", [cur]);
      i++;
      continue;
    }
    let j = i;
    while (j < lines.length && (lines[j] as DiffLine).kind === "same") j++;
    const run = lines.slice(i, j);
    const head = i === 0 ? 0 : context;
    const tail = j === lines.length ? 0 : context;
    if (run.length - head - tail >= min) {
      push("lines", run.slice(0, head));
      push("folded", run.slice(head, run.length - tail));
      push("lines", run.slice(run.length - tail));
    } else push("lines", run);
    i = j;
  }
  return blocks;
}
