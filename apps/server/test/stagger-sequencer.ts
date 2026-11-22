import { basename } from "node:path";
import { BaseSequencer } from "vitest/node";
import type { TestSpecification } from "vitest/node";

// vitest starts the largest files first, so the biggest in-process-database files (self-deploy,
// merge-ci-gate, maintenance, watchdog) began together and made the first minute the check's memory
// peak (BOS-2215: self-deploy's worker alone measured 1.5 GB). The default order is kept, except that
// these files are spread out: one starts in the first round, the others a couple of rounds apart, so
// they never share the start line. The files that finish first free their worker for the next one.
export const HEAVY_FILES = ["self-deploy.test.ts", "merge-ci-gate.test.ts", "maintenance.test.ts", "watchdog.test.ts"];

// Moves each heavy item to positions 0, gap, 2*gap, ... of the order (in the order given by
// `heavy`), leaving every other item in its original relative order.
export function stagger<T>(sorted: T[], isHeavy: (item: T) => boolean, gap: number): T[] {
  const heavy = sorted.filter(isHeavy);
  const rest = sorted.filter((x) => !isHeavy(x));
  const out: T[] = [];
  let h = 0;
  let r = 0;
  while (h < heavy.length || r < rest.length) {
    const wantHeavy = h < heavy.length && (out.length % gap === 0 || r >= rest.length);
    out.push((wantHeavy ? heavy[h++] : rest[r++]) as T);
  }
  return out;
}

export default class StaggerSequencer extends BaseSequencer {
  async sort(files: TestSpecification[]): Promise<TestSpecification[]> {
    const sorted = await super.sort(files);
    const workers = Math.max(1, Number(this.ctx.config.maxWorkers) || 1);
    return stagger(sorted, (spec) => HEAVY_FILES.includes(basename(spec.moduleId)), workers * 2);
  }
}
